import logging
from unittest.mock import AsyncMock

import pytest

from handlers.entities import sdr as sdrhandlers
from hardware import parameters as sdrparameters


class _DbSession:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, *_args):
        return False


class _SocketServer:
    def __init__(self):
        self.entered = []
        self.left = []

    async def enter_room(self, session_id, room):
        self.entered.append((session_id, room))

    async def leave_room(self, session_id, room):
        self.left.append((session_id, room))


def _set_active_sdr(monkeypatch):
    process_info = {
        "clients": {"internal:obs-123"},
        "config": {"center_freq": 145_800_000, "sample_rate": 2_048_000, "gain": 20},
    }
    monkeypatch.setattr(sdrhandlers, "AsyncSessionLocal", _DbSession)
    monkeypatch.setattr(sdrhandlers.process_manager, "processes", {"sdr-a": process_info})
    monkeypatch.setattr(
        sdrhandlers.process_manager, "is_sdr_process_running", lambda sdr_id: sdr_id == "sdr-a"
    )
    return process_info


def test_lists_other_clients():
    original_processes = sdrhandlers.process_manager.processes
    sdrhandlers.process_manager.processes = {
        "sdr-a": {
            "clients": {"caller-session", "other-session", "internal:obs-123"},
        }
    }
    try:
        other_clients = sdrhandlers._list_other_sdr_clients("sdr-a", "caller-session")
    finally:
        sdrhandlers.process_manager.processes = original_processes

    assert other_clients == ["internal:obs-123", "other-session"]


def test_builds_conflict_payload_with_internal_flag(monkeypatch):
    monkeypatch.setattr(
        sdrhandlers.session_tracker,
        "get_session_metadata",
        lambda sid: {"username": "observer"} if sid == "other-session" else {},
    )

    conflict = sdrhandlers._build_sdr_in_use_conflict(
        "sdr-a",
        ["internal:obs-123", "other-session"],
        operation="start-streaming",
    )

    assert conflict["error_code"] == sdrhandlers.SDR_IN_USE_CONFLICT_CODE
    assert conflict["sdr_id"] == "sdr-a"
    assert conflict["other_session_count"] == 2
    assert conflict["includes_internal_observation"] is True
    assert any(
        session.get("session_id") == "other-session" and session.get("username") == "observer"
        for session in conflict["other_sessions"]
    )


@pytest.mark.asyncio
async def test_watch_joins_fft_room_without_configuring_or_claiming_worker(monkeypatch):
    process_info = _set_active_sdr(monkeypatch)
    monkeypatch.setitem(
        sdrparameters.sdr_parameters_cache,
        ("sdr-a", ""),
        {"gain_values": [0, 10, 20], "antennas": {"rx": ["RX", "AUX"], "tx": []}},
    )
    sio = _SocketServer()
    configure = AsyncMock()
    monkeypatch.setattr(sdrhandlers.session_service, "configure_sdr", configure)

    inspection = await sdrhandlers.sdr_command_routing(
        sio, "inspect-sdr", {"selectedSDRId": "sdr-a"}, logging.getLogger(__name__), "viewer"
    )
    watched = await sdrhandlers.sdr_command_routing(
        sio, "watch-sdr", {"selectedSDRId": "sdr-a"}, logging.getLogger(__name__), "viewer"
    )

    assert inspection["data"]["conflict"]["includes_internal_observation"] is True
    assert watched["success"] is True
    assert watched["data"]["config"]["center_freq"] == 145_800_000
    assert watched["data"]["parameters"]["gain_values"] == [0, 10, 20]
    assert sio.entered == [("viewer", "sdr-a")]
    assert process_info["clients"] == {"internal:obs-123"}
    assert process_info["watchers"] == {"viewer"}
    configure.assert_not_awaited()

    await sdrhandlers.sdr_command_routing(
        sio, "unwatch-sdr", {"selectedSDRId": "sdr-a"}, logging.getLogger(__name__), "viewer"
    )
    assert sio.left == [("viewer", "sdr-a")]
    assert process_info["watchers"] == set()


@pytest.mark.asyncio
async def test_watch_keeps_worker_capabilities_after_saved_sdr_is_edited(monkeypatch):
    process_info = _set_active_sdr(monkeypatch)
    process_info["parameters"] = {"gain_values": [0, 10, 20]}
    monkeypatch.setattr(sdrparameters, "sdr_parameters_cache", {})

    watched = await sdrhandlers.sdr_command_routing(
        _SocketServer(),
        "watch-sdr",
        {"selectedSDRId": "sdr-a"},
        logging.getLogger(__name__),
        "viewer",
    )

    assert watched["success"] is True
    assert watched["data"]["parameters"] == process_info["parameters"]


@pytest.mark.asyncio
async def test_controller_cannot_watch_or_unwatch_its_active_room(monkeypatch):
    process_info = _set_active_sdr(monkeypatch)
    process_info["clients"].add("controller")
    sio = _SocketServer()

    watched = await sdrhandlers.sdr_command_routing(
        sio, "watch-sdr", {"selectedSDRId": "sdr-a"}, logging.getLogger(__name__), "controller"
    )
    unwatched = await sdrhandlers.sdr_command_routing(
        sio, "unwatch-sdr", {"selectedSDRId": "sdr-a"}, logging.getLogger(__name__), "controller"
    )

    assert watched["success"] is False
    assert unwatched["success"] is False
    assert process_info["clients"] == {"internal:obs-123", "controller"}
    assert sio.entered == []
    assert sio.left == []


@pytest.mark.asyncio
async def test_any_configure_request_needs_takeover_while_observation_uses_sdr(monkeypatch):
    _set_active_sdr(monkeypatch)
    sio = _SocketServer()
    configure = AsyncMock()
    monkeypatch.setattr(sdrhandlers.session_service, "configure_sdr", configure)
    monkeypatch.setattr(
        sdrhandlers.crud.hardware,
        "fetch_sdr",
        AsyncMock(
            return_value={
                "success": True,
                "data": {
                    "id": "sdr-a",
                    "type": "rtlsdrusbv3",
                    "serial": "123",
                    "frequency_min": 24,
                    "frequency_max": 1766,
                },
            }
        ),
    )

    # Even with the same center frequency, a new sample rate would disrupt capture.
    response = await sdrhandlers.sdr_command_routing(
        sio,
        "configure-sdr",
        {"selectedSDRId": "sdr-a", "centerFrequency": 145_800_000, "sampleRate": 1_024_000},
        logging.getLogger(__name__),
        "viewer",
    )

    assert response["error_code"] == "sdr_in_use_conflict"
    assert response["data"]["operation"] == "configure-sdr"
    configure.assert_not_awaited()

    update = AsyncMock()
    monkeypatch.setattr(sdrhandlers.process_manager, "update_configuration", update)
    approved = await sdrhandlers.sdr_command_routing(
        sio,
        "configure-sdr",
        {
            "selectedSDRId": "sdr-a",
            "centerFrequency": 145_800_000,
            "sampleRate": 1_024_000,
            "forceTakeover": True,
        },
        logging.getLogger(__name__),
        "viewer",
    )
    assert approved["success"] is True
    configure.assert_awaited_once()
    update.assert_awaited_once()


@pytest.mark.asyncio
async def test_playback_seek_requires_takeover_from_watcher(monkeypatch):
    _set_active_sdr(monkeypatch)
    process_info = sdrhandlers.process_manager.processes.pop("sdr-a")
    sdrhandlers.process_manager.processes["sigmf-playback"] = process_info
    monkeypatch.setattr(
        sdrhandlers.process_manager,
        "is_sdr_process_running",
        lambda sdr_id: sdr_id == "sigmf-playback",
    )
    update = AsyncMock()
    monkeypatch.setattr(sdrhandlers.process_manager, "update_configuration", update)
    monkeypatch.setattr(sdrhandlers.session_service, "session_exists", lambda _sid: False)

    response = await sdrhandlers.sdr_command_routing(
        _SocketServer(),
        "seek-playback",
        {"selectedSDRId": "sigmf-playback", "positionSeconds": 10},
        logging.getLogger(__name__),
        "viewer",
    )
    assert response["error_code"] == "sdr_in_use_conflict"
    update.assert_not_awaited()

    approved = await sdrhandlers.sdr_command_routing(
        _SocketServer(),
        "seek-playback",
        {"selectedSDRId": "sigmf-playback", "positionSeconds": 10, "forceTakeover": True},
        logging.getLogger(__name__),
        "viewer",
    )
    assert approved["success"] is True
    update.assert_awaited_once()
