import asyncio
import concurrent.futures
import os
import queue
import tempfile
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, Optional, Set

import socketio
from engineio.payload import Payload
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from audio.audiobroadcaster import AudioBroadcaster
from audio.audiostreamer import WebAudioStreamer
from celestial.syncstate import hydrate_celestial_sync_state
from common import auth as authsvc
from common.arguments import arguments
from common.audio_queue_config import get_audio_queue_config
from common.logger import logger
from db import AsyncSessionLocal, engine
from db.migrations import run_migrations
from db.models import Locations
from handlers.entities.control import restore_full_backup_file
from library.inventory import get_inventory
from observations import events as obs_events
from observations.bundle import prune_finalized_empty_observation_bundles
from observations.events import emit_scheduled_observations_changed as _emit
from observations.events import set_socketio_instance
from observations.executor import (
    RESTART_INTERRUPTION_REASON,
    SHUTDOWN_INTERRUPTION_REASON,
    ObservationExecutor,
)
from observations.sync import ObservationSchedulerSync
from pipeline.orchestration.processmanager import process_manager
from server import runtimestate, shutdown
from server.firsttime import first_time_initialization, run_initial_sync
from server.scheduler import (
    run_initial_observation_generation,
    schedule_celestial_sync_warmup_job,
    start_scheduler,
    stop_scheduler,
)
from server.sessionsnapshot import start_session_runtime_emitter
from server.spapaths import is_static_asset_request, resolve_static_asset_path
from server.systeminfo import start_system_info_emitter
from server.version import UpdateCheckError, get_full_version_info, get_update_check
from tasks.manager import BackgroundTaskManager
from tasks.registry import get_task
from tlesync.persist import load_orbital_sync_state
from tlesync.state import sync_state_manager
from tracker.instances import emit_tracker_instances, restore_tracker_instances_from_db
from tracker.messages import handle_command_updates, handle_tracker_messages
from tracker.operations import OperationRegistry, operations

# Increase payload limits to handle large waterfall PNG images and maintenance uploads.
Payload.max_decode_packets = 50
# Socket.IO is not used for full database restore uploads. Keep a bounded limit for
# realtime traffic such as waterfall images and smaller maintenance messages.
SOCKET_IO_MAX_PAYLOAD_BYTES = 384 * 1024 * 1024  # 384MB
# Long-running maintenance requests can keep a socket in-flight; allow longer heartbeat
# windows for the separate full-backup download operation.
SOCKET_IO_PING_INTERVAL_SECONDS = 25
SOCKET_IO_PING_TIMEOUT_SECONDS = 120
# Default is 100KB (100000 bytes), increase for large realtime payloads.
Payload.max_decode_packet_size = SOCKET_IO_MAX_PAYLOAD_BYTES
FULL_RESTORE_MAX_FILE_SIZE_BYTES = 1024 * 1024 * 1024  # 1GB
AUTH_COOKIE_MAX_AGE_DEFAULT_SECONDS = 15 * 24 * 60 * 60
AUTH_COOKIE_MAX_AGE_KEEP_ACTIVE_SECONDS = 365 * 24 * 60 * 60

# At the top of the file, add a global to track background tasks
background_tasks: Set[asyncio.Task] = set()

# Module-level variable to track if initial sync is needed
_needs_initial_sync: bool = False

# Audio distribution system
# Demodulators write to audio_queue, AudioBroadcaster distributes to multiple consumers
audio_cfg = get_audio_queue_config()
audio_queue: queue.Queue = queue.Queue(maxsize=audio_cfg.global_audio_queue_size)
audio_broadcaster: AudioBroadcaster = AudioBroadcaster(audio_queue)
runtimestate.audio_queue = audio_queue

# Background task manager (initialized after sio is created)
background_task_manager: BackgroundTaskManager = None
runtimestate.process_manager = process_manager
_LIBRARY_RECONCILIATION_SECONDS = 60


async def _reconcile_library_periodically() -> None:
    """Repair the in-memory inventory after out-of-process filesystem changes."""
    inventory = get_inventory()
    try:
        while True:
            await asyncio.sleep(_LIBRARY_RECONCILIATION_SECONDS)
            previous_revision = inventory.revision
            revision = await asyncio.to_thread(inventory.rebuild)
            if revision != previous_revision:
                await sio.emit(
                    "library.changed",
                    {"revision": revision, "changes": [{"operation": "reconciled", "id": "*"}]},
                    room=authsvc.AUTHENTICATED_SOCKET_ROOM,
                )
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Filesystem library reconciliation stopped unexpectedly")


@asynccontextmanager
async def lifespan(fastapiapp: FastAPI):
    """Custom lifespan for FastAPI."""
    global background_task_manager

    logger.info("FastAPI lifespan startup...")
    # In an async context, prefer get_running_loop() (get_event_loop() is deprecated when no loop set)
    event_loop = asyncio.get_running_loop()

    # A previous process can finish SatDump after LOS has retained its bundle,
    # leaving only the manifest once the disposable IQ input is removed.
    try:
        removed_bundles = prune_finalized_empty_observation_bundles(Path(__file__).parents[1])
        if removed_bundles:
            logger.info(
                "Removed %s finalized empty observation bundle(s) at startup", removed_bundles
            )
    except Exception:
        # Observation cleanup must not prevent the station from starting.
        logger.exception("Failed to prune finalized empty observation bundles at startup")

    # The filesystem remains the durable library.  Build its process-local,
    # rebuildable query index after startup filesystem maintenance so browser
    # requests never need a cold scan or receive a stale pruned bundle.
    try:
        library_revision = await asyncio.to_thread(get_inventory().rebuild)
        logger.info("Filesystem library inventory ready at revision %s", library_revision)
    except Exception:
        logger.exception("Failed to build filesystem library inventory at startup")
    library_reconciler = asyncio.create_task(_reconcile_library_periodically())
    background_tasks.add(library_reconciler)

    # Set socketio instance for observations events
    set_socketio_instance(sio)

    # Initialize background task manager
    background_task_manager = BackgroundTaskManager(sio)
    runtimestate.background_task_manager = background_task_manager
    logger.info("BackgroundTaskManager initialized")

    # Hydrate last orbital sync snapshot so status survives process restarts.
    try:
        async with AsyncSessionLocal() as dbsession:
            persisted_sync_state = await load_orbital_sync_state(dbsession)
        if persisted_sync_state:
            sync_state_manager.set_state(persisted_sync_state, touch_timestamp=False)
    except Exception:
        logger.exception("Failed to hydrate orbital sync state at startup")

    # Hydrate the last whole celestial sync result for post-restart UI continuity.
    try:
        await hydrate_celestial_sync_state()
    except Exception:
        logger.exception("Failed to hydrate celestial ephemeris sync state at startup")

    # Trim stale auth-session history at startup. Active sessions are excluded by policy.
    try:
        trim_result = await authsvc.trim_inactive_auth_sessions(keep_last=300)
        logger.info(
            "Auth session history trim complete: deleted=%s, keep_last=%s",
            trim_result.get("deleted"),
            trim_result.get("kept"),
        )
    except Exception:
        # Startup should continue even if retention cleanup fails.
        logger.exception("Auth session history trim failed at startup")

    # Start audio broadcaster
    audio_broadcaster.start()
    shutdown.audio_broadcaster = audio_broadcaster

    # Subscribe consumers to broadcaster
    playback_queue = audio_broadcaster.subscribe(
        "playback", maxsize=audio_cfg.web_audio_playback_queue_size
    )
    shutdown.audio_consumer = WebAudioStreamer(playback_queue, sio, event_loop)
    shutdown.audio_consumer.start()
    runtimestate.audio_consumer = shutdown.audio_consumer

    # Initialize ProcessManager with event loop for TranscriptionManager
    process_manager.set_event_loop(event_loop)
    logger.info("ProcessManager initialized with event loop")

    # Keep operation outcomes across reconnects and backend restarts. The journal
    # follows the configured DB, including installations using an absolute path.
    recovered = OperationRegistry(Path(arguments.db).with_suffix(".commands.json"))
    operations.__dict__.update(recovered.__dict__)
    asyncio.create_task(handle_command_updates(sio))
    asyncio.create_task(handle_tracker_messages(sio))
    await restore_tracker_instances_from_db()
    await emit_tracker_instances(sio)

    # SoapySDR discovery (runs as background tasks)
    if arguments.runonce_soapy_discovery:
        # Single discovery at startup
        logger.info("Starting one-time SoapySDR discovery at startup...")

        discovery_func = get_task("soapysdr_discovery")
        await background_task_manager.start_task(
            func=discovery_func, kwargs={"mode": "single"}, name="SoapySDR Discovery (startup)"
        )
    if arguments.enable_soapy_discovery:
        # Continuous monitoring mode
        logger.info("Starting continuous SoapySDR discovery monitoring...")

        discovery_func = get_task("soapysdr_discovery")
        await background_task_manager.start_task(
            func=discovery_func,
            kwargs={"mode": "monitor", "refresh_interval": 120},
            name="SoapySDR Discovery (monitor)",
        )

    # Schedule initial sync if needed.
    # During first-time setup we defer this background sync so the setup wizard
    # can explicitly start and display finalization status to the user.
    if _needs_initial_sync:
        setup_required = await authsvc.is_setup_required(force_refresh=True)
        if setup_required:
            logger.info("Deferring startup initial orbital sync because setup is still required.")
        else:
            asyncio.create_task(run_initial_sync(background_task_manager))

    # Start the background task scheduler
    scheduler = start_scheduler(sio, process_manager, background_task_manager)
    schedule_celestial_sync_warmup_job(background_task_manager, sio)

    # Initialize observation executor and scheduler sync
    observation_executor = ObservationExecutor(process_manager, sio)
    observation_sync = ObservationSchedulerSync(scheduler, observation_executor)

    # Store observation_sync globally for use in handlers
    obs_events.observation_sync = observation_sync

    # Runtime workers cannot be resumed safely after a process restart. Reconcile
    # durable RUNNING rows before generation and scheduler synchronization so
    # they cannot remain orphaned indefinitely.
    interruption_stats = await observation_executor.interrupt_running_observations(
        RESTART_INTERRUPTION_REASON
    )
    if interruption_stats["found"]:
        logger.warning(
            "Reconciled interrupted observations at startup: found=%s failed=%s "
            "timed_out=%s errors=%s",
            interruption_stats["found"],
            interruption_stats["failed"],
            interruption_stats["timed_out"],
            interruption_stats["errors"],
        )

    # Run initial observation generation
    asyncio.create_task(run_initial_observation_generation())

    # Sync all observations to APScheduler after a brief delay
    # (allows initial generation to complete first)
    async def sync_observations_after_delay():
        await asyncio.sleep(2)
        logger.info("Syncing scheduled observations to APScheduler...")
        result = await observation_sync.sync_all_observations()
        if result["success"]:
            stats = result.get("stats", {})
            logger.info(
                f"Observation sync complete: {stats.get('scheduled', 0)} scheduled, "
                f"{stats.get('skipped_disabled', 0)} disabled, "
                f"{stats.get('skipped_status', 0)} wrong status, "
                f"{stats.get('skipped_past', 0)} past events"
            )
        else:
            logger.error(f"Observation sync failed: {result.get('error')}")

    asyncio.create_task(sync_observations_after_delay())

    # Start performance monitoring
    process_manager.start_monitoring()
    logger.info("Performance monitoring started (metrics emission every 2s)")

    # Start live system-info emitter task (registers into background_tasks)
    start_system_info_emitter(sio, background_tasks)

    # Start session runtime snapshot emitter task (registers into background_tasks)
    start_session_runtime_emitter(sio, background_tasks)

    try:
        yield
    finally:
        logger.info("FastAPI lifespan cleanup...")
        # Prevent new scheduled work while active observations transition to a
        # durable failed state and release their runtime resources.
        try:
            scheduler.pause()
        except Exception:
            logger.exception("Failed to pause scheduler during shutdown")

        try:
            interruption_stats = await observation_executor.interrupt_running_observations(
                SHUTDOWN_INTERRUPTION_REASON
            )
            if interruption_stats["found"]:
                logger.info(
                    "Interrupted observations during shutdown: found=%s failed=%s "
                    "timed_out=%s errors=%s",
                    interruption_stats["found"],
                    interruption_stats["failed"],
                    interruption_stats["timed_out"],
                    interruption_stats["errors"],
                )
        except Exception:
            logger.exception("Failed to reconcile running observations during shutdown")

        # Shutdown background task manager
        if background_task_manager:
            await background_task_manager.shutdown()
        # Cancel background tasks we created
        for task in list(background_tasks):
            task.cancel()
        background_tasks.clear()
        await shutdown.cleanup_sessions()
        stop_scheduler()
        shutdown.cleanup_everything()
        process_manager.shutdown()


sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=True,
    engineio_logger=True,
    binary=True,
    max_http_buffer_size=SOCKET_IO_MAX_PAYLOAD_BYTES,
    ping_interval=SOCKET_IO_PING_INTERVAL_SECONDS,
    ping_timeout=SOCKET_IO_PING_TIMEOUT_SECONDS,
)


async def emit_scheduled_observations_changed():
    """Emit event to all clients that scheduled observations have changed."""
    await _emit()


app = FastAPI(
    lifespan=lifespan,
    title="Ground Station API",
    description="API for satellite tracking, SDR control, and radio communication",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

process_manager.set_sio(sio)


def _auth_cookie_secure(request: Request) -> bool:
    return str(request.url.scheme).lower() == "https"


def _set_auth_session_cookie(
    response: Response, request: Request, token: str, max_age_seconds: int
) -> None:
    response.set_cookie(
        key=authsvc.AUTH_SESSION_COOKIE_NAME,
        value=str(token),
        max_age=max(int(max_age_seconds), 1),
        httponly=True,
        samesite="strict",
        secure=_auth_cookie_secure(request),
        path="/",
    )


def _clear_auth_session_cookie(response: Response, request: Request) -> None:
    response.delete_cookie(
        key=authsvc.AUTH_SESSION_COOKIE_NAME,
        path="/",
        samesite="strict",
        secure=_auth_cookie_secure(request),
    )


def _extract_request_token(request: Request, allow_cookie_token: bool = True) -> Optional[str]:
    auth_header = request.headers.get("authorization")
    token: Optional[str] = authsvc.extract_bearer_token(auth_header)
    if token:
        return token

    if not allow_cookie_token:
        return None

    cookie_token: Optional[str] = authsvc.extract_cookie_token(
        request.cookies.get(authsvc.AUTH_SESSION_COOKIE_NAME)
    )
    return cookie_token


def _client_ip_from_request(request: Request) -> Optional[str]:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return str(xff.split(",")[0].strip())
    if request.client:
        return str(request.client.host)
    return None


async def _load_station_identity() -> Optional[Dict[str, Optional[str]]]:
    """Load a lightweight station identity payload for pre-auth UI surfaces."""
    try:
        async with AsyncSessionLocal() as session:
            # Mirror location ordering used across the app when a single "active" location is needed.
            location_row = (
                await session.execute(
                    select(Locations)
                    .order_by(Locations.updated.desc(), Locations.added.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if location_row is None:
                return None

            station_name = str(location_row.name or "").strip() or None
            callsign = str(location_row.callsign or "").strip().upper() or None
            return {
                "name": station_name,
                "callsign": callsign,
            }
    except Exception:
        # Pre-auth station identity is best-effort only; auth bootstrap must still work when unavailable.
        logger.debug("Failed to load station identity for auth status", exc_info=True)
        return None


async def _require_request_auth(
    request: Request,
    require_auth: bool = True,
    require_admin: bool = False,
    allow_cookie_token: bool = True,
    touch_last_seen: bool = True,
) -> Optional[Dict[str, Any]]:
    token = _extract_request_token(request, allow_cookie_token=allow_cookie_token)
    auth_context = (
        await authsvc.authenticate_token(token, touch_last_seen=touch_last_seen) if token else None
    )

    if require_auth and not auth_context:
        raise HTTPException(status_code=401, detail="Authentication required.")

    if require_admin and not authsvc.is_admin_role((auth_context or {}).get("role")):
        raise HTTPException(status_code=403, detail="Admin access is required.")

    return auth_context


class AuthenticatedStaticFiles:
    """Wrap StaticFiles and enforce runtime auth for sensitive data directories."""

    def __init__(self, directory: str, html: bool) -> None:
        self._static_files = StaticFiles(directory=directory, html=html)

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self._static_files(scope, receive, send)
            return

        request = Request(scope, receive=receive)
        try:
            # Browser media requests cannot set Authorization headers, so cookie auth is required.
            # Skip last-seen writes for asset requests to avoid a DB write on every image/audio fetch.
            await _require_request_auth(
                request,
                require_auth=True,
                require_admin=False,
                allow_cookie_token=True,
                touch_last_seen=False,
            )
        except HTTPException as exc:
            response = JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
            await response(scope, receive, send)
            return

        await self._static_files(scope, receive, send)


@app.get("/api/auth/status")
async def auth_status(request: Request):
    """Return setup/authentication status for frontend app bootstrapping."""
    setup_mode = await authsvc.resolve_setup_mode()
    setup_required = setup_mode != authsvc.SETUP_MODE_NONE
    station_identity = await _load_station_identity()
    auth_context = await _require_request_auth(
        request,
        require_auth=False,
        require_admin=False,
        allow_cookie_token=True,
        touch_last_seen=False,
    )
    return {
        "setup_required": setup_required,
        "setup_mode": setup_mode,
        "authenticated": bool(auth_context),
        "user": auth_context,
        "station": station_identity,
    }


@app.post("/api/auth/setup-admin")
async def setup_admin(request: Request, response: Response):
    """One-time bootstrap endpoint to create the initial admin account."""
    payload = await request.json()
    username = str(payload.get("username") or "")
    password = str(payload.get("password") or "")

    result = await authsvc.bootstrap_admin(
        username=username,
        password=password,
        client_ip=_client_ip_from_request(request),
        user_agent=request.headers.get("user-agent"),
    )
    if not result.get("success"):
        message = str(result.get("error") or "Failed to initialize admin account.")
        status_code = 409 if "already completed" in message.lower() else 400
        raise HTTPException(status_code=status_code, detail=message)
    token = authsvc.extract_cookie_token(result.get("token"))
    if token:
        _set_auth_session_cookie(
            response=response,
            request=request,
            token=token,
            max_age_seconds=AUTH_COOKIE_MAX_AGE_DEFAULT_SECONDS,
        )

    return {
        "success": bool(result.get("success")),
        "user": result.get("user"),
    }


@app.post("/api/auth/login")
async def auth_login(request: Request, response: Response):
    """Login endpoint that sets an HttpOnly auth session cookie."""
    payload = await request.json()
    username = str(payload.get("username") or "")
    password = str(payload.get("password") or "")
    keep_session_active = authsvc.coerce_keep_session_active(
        payload.get("keep_session_active", payload.get("keepSessionActive"))
    )
    result = await authsvc.login(
        username=username,
        password=password,
        client_ip=_client_ip_from_request(request),
        user_agent=request.headers.get("user-agent"),
        keep_session_active=keep_session_active,
    )
    if not result.get("success"):
        raise HTTPException(status_code=401, detail=str(result.get("error") or "Login failed."))

    token = authsvc.extract_cookie_token(result.get("token"))
    if token:
        ttl_seconds = (
            AUTH_COOKIE_MAX_AGE_KEEP_ACTIVE_SECONDS
            if keep_session_active
            else AUTH_COOKIE_MAX_AGE_DEFAULT_SECONDS
        )
        _set_auth_session_cookie(
            response=response,
            request=request,
            token=token,
            max_age_seconds=ttl_seconds,
        )

    return {
        "success": bool(result.get("success")),
        "user": result.get("user"),
    }


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    """Revoke the current auth session token and clear cookie state."""
    token = _extract_request_token(request, allow_cookie_token=True)
    if token:
        await authsvc.logout(token, reason="logout")
    _clear_auth_session_cookie(response=response, request=request)
    return {"success": True}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    """Return current user context from the authenticated request session."""
    auth_context = await _require_request_auth(request, require_auth=True, require_admin=False)
    return {"success": True, "data": auth_context}


@app.get("/api/auth/users")
async def auth_list_users(request: Request):
    """Admin endpoint: list all users."""
    await _require_request_auth(request, require_auth=True, require_admin=True)
    return await authsvc.list_users()


@app.post("/api/auth/users")
async def auth_create_user(request: Request):
    """Admin endpoint: create a new user account."""
    auth_context = await _require_request_auth(request, require_auth=True, require_admin=True)
    if auth_context is None:
        raise HTTPException(status_code=401, detail="Authentication required.")
    payload = await request.json()
    result = await authsvc.create_user(
        username=str(payload.get("username") or ""),
        password=str(payload.get("password") or ""),
        role=str(payload.get("role") or ""),
        actor_user_id=str(auth_context.get("user_id")),
    )
    if not result.get("success"):
        raise HTTPException(
            status_code=400, detail=str(result.get("error") or "Failed to create user.")
        )
    return result


@app.patch("/api/auth/users/{user_id}")
async def auth_update_user(user_id: str, request: Request):
    """Admin endpoint: update role and activation state for a user."""
    auth_context = await _require_request_auth(request, require_auth=True, require_admin=True)
    if auth_context is None:
        raise HTTPException(status_code=401, detail="Authentication required.")
    payload = await request.json()
    role = payload.get("role", None)
    is_active = payload.get("is_active", None)
    result = await authsvc.update_user(
        user_id=user_id,
        role=role,
        is_active=is_active,
        actor_user_id=str(auth_context.get("user_id")),
    )
    if not result.get("success"):
        raise HTTPException(
            status_code=400, detail=str(result.get("error") or "Failed to update user.")
        )
    return result


@app.post("/api/auth/users/{user_id}/reset-password")
async def auth_reset_user_password(user_id: str, request: Request):
    """Admin endpoint: reset a user password and revoke active sessions."""
    auth_context = await _require_request_auth(request, require_auth=True, require_admin=True)
    if auth_context is None:
        raise HTTPException(status_code=401, detail="Authentication required.")
    payload = await request.json()
    result = await authsvc.reset_user_password(
        user_id=user_id,
        new_password=str(payload.get("password") or ""),
        actor_user_id=str(auth_context.get("user_id")),
    )
    if not result.get("success"):
        raise HTTPException(
            status_code=400,
            detail=str(result.get("error") or "Failed to reset user password."),
        )
    return result


@app.delete("/api/auth/users/{user_id}")
async def auth_delete_user(user_id: str, request: Request):
    """Admin endpoint: delete a user account."""
    auth_context = await _require_request_auth(request, require_auth=True, require_admin=True)
    if auth_context is None:
        raise HTTPException(status_code=401, detail="Authentication required.")
    result = await authsvc.delete_user(
        user_id=user_id,
        actor_user_id=str(auth_context.get("user_id")),
    )
    if not result.get("success"):
        raise HTTPException(
            status_code=400, detail=str(result.get("error") or "Failed to delete user.")
        )
    return result


@app.post("/api/database/restore")
async def restore_database_backup(request: Request):
    """Restore an admin-uploaded SQL backup without placing it in browser or Socket.IO memory."""
    await _require_request_auth(request, require_auth=True, require_admin=True)
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid backup upload size.") from exc
        if declared_size > FULL_RESTORE_MAX_FILE_SIZE_BYTES:
            raise HTTPException(
                status_code=413, detail="Backup file exceeds the 1GB restore limit."
            )

    drop_tables = str(request.query_params.get("drop_tables", "true")).lower() not in {
        "0",
        "false",
        "no",
    }
    temp_file = tempfile.NamedTemporaryFile(prefix="gs-restore-", suffix=".sql", delete=False)
    temp_path = Path(temp_file.name)
    bytes_received = 0

    try:
        async for chunk in request.stream():
            bytes_received += len(chunk)
            if bytes_received > FULL_RESTORE_MAX_FILE_SIZE_BYTES:
                raise HTTPException(
                    status_code=413, detail="Backup file exceeds the 1GB restore limit."
                )
            await asyncio.to_thread(temp_file.write, chunk)
        await asyncio.to_thread(temp_file.close)

        if bytes_received == 0:
            raise HTTPException(status_code=400, detail="Backup file is empty.")

        restore_reply = await restore_full_backup_file(sio, temp_path, drop_tables, logger)
        if not restore_reply.get("success"):
            raise HTTPException(
                status_code=400,
                detail=str(restore_reply.get("error") or "Failed to restore database backup."),
            )
        return restore_reply
    finally:
        if not temp_file.closed:
            temp_file.close()
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            logger.warning("Failed to remove temporary database restore upload: %s", temp_path)


# Mount data directories for recordings, snapshots, decoded data (SSTV, AFSK, Morse, etc.), and audio
# Ensure these directories exist before mounting
backend_dir = os.path.dirname(os.path.abspath(__file__))
satellites_dir = os.path.join(backend_dir, "..", "images", "satellites")
bodies_dir = os.path.join(backend_dir, "..", "images", "bodies")
missions_dir = os.path.join(backend_dir, "..", "images", "missions")
recordings_dir = os.path.join(backend_dir, "..", "data", "recordings")
snapshots_dir = os.path.join(backend_dir, "..", "data", "snapshots")
decoded_dir = os.path.join(backend_dir, "..", "data", "decoded")
audio_dir = os.path.join(backend_dir, "..", "data", "audio")
transcriptions_dir = os.path.join(backend_dir, "..", "data", "transcriptions")
observations_dir = os.path.join(backend_dir, "..", "data", "observations")

# Create directories if they don't exist
os.makedirs(satellites_dir, exist_ok=True)
os.makedirs(bodies_dir, exist_ok=True)
os.makedirs(missions_dir, exist_ok=True)
os.makedirs(recordings_dir, exist_ok=True)
os.makedirs(snapshots_dir, exist_ok=True)
os.makedirs(decoded_dir, exist_ok=True)
os.makedirs(audio_dir, exist_ok=True)
os.makedirs(transcriptions_dir, exist_ok=True)
os.makedirs(observations_dir, exist_ok=True)

# Use html=True to enable directory browsing
app.mount("/satimages", StaticFiles(directory=satellites_dir, html=True), name="satimages")
app.mount(
    "/recordings", AuthenticatedStaticFiles(directory=recordings_dir, html=True), name="recordings"
)
app.mount(
    "/observations",
    AuthenticatedStaticFiles(directory=observations_dir, html=False),
    name="observations",
)
app.mount("/snapshots", StaticFiles(directory=snapshots_dir, html=True), name="snapshots")
app.mount("/decoded", AuthenticatedStaticFiles(directory=decoded_dir, html=True), name="decoded")
app.mount("/audio", AuthenticatedStaticFiles(directory=audio_dir, html=True), name="audio")
# Note: html=False for transcriptions to ensure .txt files are served with correct content-type
app.mount(
    "/transcriptions",
    AuthenticatedStaticFiles(directory=transcriptions_dir, html=False),
    name="transcriptions",
)
app.mount("/body-icons", StaticFiles(directory=bodies_dir, html=True), name="body-icons")
app.mount("/mission-icons", StaticFiles(directory=missions_dir, html=True), name="mission-icons")


# Add the version API endpoint BEFORE the catch-all route
@app.get("/api/version")
async def get_version():
    """Return the current version information of the application."""
    try:
        version_info = get_full_version_info()
        return version_info
    except Exception as e:
        logger.error(f"Error retrieving version information: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Failed to retrieve version information: {str(e)}"
        )


@app.get("/api/update-check")
async def update_check(refresh: bool = False):
    """Return update availability based on GitHub releases."""
    try:
        return await get_update_check(force_refresh=refresh)
    except UpdateCheckError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:
        logger.error(f"Error retrieving update information: {str(e)}")
        raise HTTPException(
            status_code=500, detail=f"Failed to retrieve update information: {str(e)}"
        )


def _resolve_decoded_folder(decoded_root: Path, foldername: str) -> Path:
    folder_path = (decoded_root / foldername).resolve()
    try:
        folder_path.relative_to(decoded_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid folder path")
    if not folder_path.exists() or not folder_path.is_dir():
        raise HTTPException(status_code=404, detail="Decoded folder not found")
    return folder_path


def _resolve_observation_bundle(observations_root: Path, foldername: str) -> Path:
    """Resolve a .gsobs directory without allowing a path outside the bundle root."""
    if not foldername.endswith(".gsobs"):
        raise HTTPException(status_code=400, detail="Invalid observation bundle")
    folder_path = (observations_root / foldername).resolve()
    try:
        folder_path.relative_to(observations_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid observation bundle path")
    if not folder_path.exists() or not folder_path.is_dir():
        raise HTTPException(status_code=404, detail="Observation bundle not found")
    return folder_path


@app.get("/api/decoded/{foldername}/download")
async def download_decoded_folder(
    foldername: str, request: Request, background_tasks: BackgroundTasks
):
    await _require_request_auth(request, require_auth=True, require_admin=False)
    decoded_root = Path(decoded_dir).resolve()
    folder_path = _resolve_decoded_folder(decoded_root, foldername)
    temp_zip = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    temp_zip.close()

    try:
        with zipfile.ZipFile(temp_zip.name, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in folder_path.rglob("*"):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(folder_path).as_posix())
    except Exception as exc:
        if os.path.exists(temp_zip.name):
            os.remove(temp_zip.name)
        raise HTTPException(status_code=500, detail=f"Failed to create archive: {exc}")

    background_tasks.add_task(os.remove, temp_zip.name)
    return FileResponse(
        temp_zip.name,
        media_type="application/zip",
        filename=f"{foldername}.zip",
        background=background_tasks,
    )


@app.get("/api/observations/{foldername}/download")
async def download_observation_bundle(
    foldername: str, request: Request, background_tasks: BackgroundTasks
):
    """Return an automated-observation bundle as one ZIP download."""
    await _require_request_auth(request, require_auth=True, require_admin=False)
    bundle_path = _resolve_observation_bundle(Path(observations_dir).resolve(), foldername)
    temp_zip = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    temp_zip.close()
    try:
        with zipfile.ZipFile(temp_zip.name, "w", zipfile.ZIP_DEFLATED) as archive:
            for file_path in bundle_path.rglob("*"):
                if file_path.is_file():
                    archive.write(file_path, file_path.relative_to(bundle_path).as_posix())
    except Exception as exc:
        if os.path.exists(temp_zip.name):
            os.remove(temp_zip.name)
        raise HTTPException(status_code=500, detail=f"Failed to create archive: {exc}")

    background_tasks.add_task(os.remove, temp_zip.name)
    return FileResponse(
        temp_zip.name,
        media_type="application/zip",
        filename=f"{foldername}.zip",
        background=background_tasks,
    )


# This catch-all route comes AFTER specific API routes
@app.get("/{full_path:path}")
async def serve_spa(request: Request, full_path: str):
    static_files_dir = os.environ.get("STATIC_FILES_DIR", "../../frontend/dist")
    base_dir = Path(static_files_dir).resolve()

    if is_static_asset_request(full_path):
        # Normalize and enforce containment to prevent path traversal.
        try:
            file_path = resolve_static_asset_path(base_dir, full_path)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid path")
        return FileResponse(str(file_path))

    return FileResponse(str(base_dir / "index.html"))


async def init_db():
    """Initialize database and run migrations."""
    global _needs_initial_sync

    logger.info("Initializing database...")

    # Ensure required data directories exist
    logger.info("Ensuring data directories exist...")
    backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    data_dirs = [
        os.path.join(backend_dir, "data", "db"),
        os.path.join(backend_dir, "data", "recordings"),
        os.path.join(backend_dir, "data", "snapshots"),
        os.path.join(
            backend_dir, "data", "decoded"
        ),  # For SSTV images, AFSK packets, Morse audio, etc.
        os.path.join(backend_dir, "data", "audio"),  # For audio recordings
        os.path.join(backend_dir, "data", "configs"),  # For satellite decoder configurations
        os.path.join(backend_dir, "data", "uhd_images"),  # For UHD FPGA images
        os.path.join(backend_dir, "data", "uhd_config"),  # For UHD configuration files
        os.path.join(backend_dir, "data", "transcriptions"),  # For transcription text files
    ]
    for directory in data_dirs:
        os.makedirs(directory, exist_ok=True)
        logger.debug(f"Ensured directory exists: {directory}")

    # Check if database exists by trying to query metadata
    database_existed = False
    try:
        async with engine.begin() as conn:
            # Try to get table names - if this succeeds, database exists
            result = await conn.run_sync(
                lambda sync_conn: engine.dialect.get_table_names(sync_conn)
            )
            database_existed = len(result) > 0
    except Exception:
        # Database doesn't exist or is empty
        database_existed = False

    # Run Alembic migrations to ensure schema is up to date
    try:
        # Run migrations in a thread pool to avoid event loop conflicts
        # Use the currently running loop (compatible with Python 3.12+)
        loop = asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor() as executor:
            await loop.run_in_executor(executor, run_migrations)

    except Exception as e:
        logger.error(f"Error running database migrations: {e}")
        logger.exception(e)
        raise

    # If database didn't exist before, populate with initial data
    if not database_existed:
        logger.info("Database initialized (new, populated with initial data)")
        await first_time_initialization()
        _needs_initial_sync = True
    else:
        logger.info("Database initialized (existing, migrations applied)")
