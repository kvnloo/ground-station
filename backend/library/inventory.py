"""Rebuildable in-memory catalogue for user-visible filesystem artifacts.

The catalogue deliberately has no persistence layer.  It is reconstructed
from ``data/`` at startup and after storage mutations, leaving the filesystem
as the only durable source of truth.
"""

from __future__ import annotations

import json
import shutil
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import quote

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"}
DECODED_PATTERNS = ("*.png", "*.jpg", "*.jpeg", "*.txt", "*.bin")


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _sigmf_summary(path: Path) -> Dict[str, Any]:
    metadata = _read_json(path)
    global_meta = metadata.get("global")
    global_meta = global_meta if isinstance(global_meta, dict) else {}
    captures = metadata.get("captures")
    first_capture = captures[0] if isinstance(captures, list) and captures else {}
    first_capture = first_capture if isinstance(first_capture, dict) else {}
    return {
        "datatype": global_meta.get("core:datatype"),
        "sample_rate": global_meta.get("core:sample_rate"),
        "description": global_meta.get("core:description"),
        "recorder": global_meta.get("core:recorder"),
        "recording_in_progress": bool(global_meta.get("gs:recording_in_progress", False)),
        "start_time": global_meta.get("gs:start_time"),
        "finalized_time": global_meta.get("gs:finalized_time"),
        "session_id": global_meta.get("gs:session_id"),
        "observation_id": global_meta.get("gs:observation_id"),
        "target_satellite_norad_id": global_meta.get("gs:target_satellite_norad_id"),
        "target_satellite_name": global_meta.get("gs:target_satellite_name"),
        "center_frequency": first_capture.get("core:frequency"),
    }


def _transcription_summary(path: Path) -> Dict[str, Any]:
    """Read only the comment header; transcript bodies never enter the index."""
    result: Dict[str, Any] = {}
    try:
        with path.open("r") as file:
            for line in file:
                line = line.strip()
                if not line.startswith("#"):
                    break
                if line.startswith("# Provider:"):
                    result["provider"] = line.split(":", 1)[1].strip()
                elif line.startswith("# Session:"):
                    result["session_id"] = line.split(":", 1)[1].strip()
                elif line.startswith("# Language:"):
                    result["language"] = line.split(":", 1)[1].strip()
                elif line.startswith("# Translate To:"):
                    result["translate_to"] = line.split(":", 1)[1].strip()
    except OSError:
        return {}
    return result


@dataclass(frozen=True)
class LibraryRoots:
    """Storage roots owned by the application library."""

    backend: Path

    @property
    def data(self) -> Path:
        return self.backend / "data"

    @property
    def recordings(self) -> Path:
        return self.data / "recordings"

    @property
    def snapshots(self) -> Path:
        return self.data / "snapshots"

    @property
    def decoded(self) -> Path:
        return self.data / "decoded"

    @property
    def audio(self) -> Path:
        return self.data / "audio"

    @property
    def transcriptions(self) -> Path:
        return self.data / "transcriptions"

    @property
    def observations(self) -> Path:
        return self.data / "observations"


class LibraryInventory:
    """A thread-safe, rebuildable catalogue of compact library summaries."""

    def __init__(self, backend_dir: Path):
        self.roots = LibraryRoots(Path(backend_dir).resolve())
        self._items: Dict[str, Dict[str, Any]] = {}
        self._revision = 0
        self._ready = False
        self._lock = threading.RLock()

    @property
    def revision(self) -> int:
        with self._lock:
            return self._revision

    def rebuild(self) -> int:
        """Reconcile the process-local catalogue with the filesystem."""
        items: Dict[str, Dict[str, Any]] = {}
        self._scan_recordings(items)
        self._scan_snapshots(items)
        self._scan_decoded(items)
        self._scan_audio(items)
        self._scan_transcriptions(items)
        self._scan_observations(items)
        with self._lock:
            if not self._ready or items != self._items:
                self._items = items
                self._revision += 1
            self._ready = True
            return self._revision

    def query(
        self,
        filters: Optional[Dict[str, bool]] = None,
        sort_by: str = "created",
        sort_order: str = "desc",
        page: int = 1,
        page_size: int = 25,
        session_id: Optional[str] = None,
        observation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return one compact, sorted page without touching the filesystem."""
        if not self._ready:
            self.rebuild()
        page = max(1, int(page))
        page_size = max(1, min(int(page_size), 100))
        with self._lock:
            items = [
                self._public(item)
                for item in self._items.values()
                if self._matches(item, filters, session_id, observation_id)
            ]
            revision = self._revision
        allowed_sorts = {"name", "size", "created", "modified", "sample_rate"}
        sort_by = sort_by if sort_by in allowed_sorts else "created"
        reverse = sort_order != "asc"

        def key(item: Dict[str, Any]) -> Any:
            if sort_by == "name":
                return str(item.get("display_name") or item.get("name") or "").casefold()
            if sort_by == "size":
                return item.get("data_size") or item.get("size") or 0
            if sort_by == "sample_rate":
                return item.get("metadata", {}).get("sample_rate") or item.get("sample_rate") or 0
            return item.get(sort_by) or ""

        items.sort(key=key, reverse=reverse)
        total = len(items)
        last_page = max(1, (total + page_size - 1) // page_size)
        page = min(page, last_page)
        start = (page - 1) * page_size
        return {
            "items": items[start : start + page_size],
            "total": total,
            "page": page,
            "page_size": page_size,
            "revision": revision,
            "has_more": start + page_size < total,
            "diskUsage": self._disk_usage(),
        }

    def get(self, item_id: str) -> Optional[Dict[str, Any]]:
        if not self._ready:
            self.rebuild()
        with self._lock:
            item = self._items.get(item_id)
            return self._public(item) if item else None

    def detail(self, item_id: str) -> Optional[Dict[str, Any]]:
        """Build heavyweight detail only after a user opens an item."""
        if not self._ready:
            self.rebuild()
        with self._lock:
            item = self._items.get(item_id)
            internal = dict(item) if item else None
        if not internal:
            return None
        path = Path(str(internal["_path"]))
        if internal.get("folder_kind") == "observation":
            return self._observation_detail(self._public(internal), path)
        if internal.get("type") == "decoded_folder":
            return self._decoded_folder_detail(self._public(internal), path)
        return self._public(internal)

    def delete(self, item_ids: Iterable[str]) -> Dict[str, Any]:
        """Delete indexed items, then rebuild once to guarantee consistency."""
        if not self._ready:
            self.rebuild()
        results: List[Dict[str, Any]] = []
        with self._lock:
            requested = [(item_id, self._items.get(item_id)) for item_id in item_ids]
        for item_id, item in requested:
            if not item:
                results.append({"id": item_id, "success": False, "error": "Item not found"})
                continue
            try:
                self._delete_item(item)
                results.append({"id": item_id, "success": True})
            except OSError as exc:
                results.append({"id": item_id, "success": False, "error": str(exc)})
        revision = self.rebuild() if any(result["success"] for result in results) else self.revision
        return {"results": results, "revision": revision}

    def _matches(
        self,
        item: Dict[str, Any],
        filters: Optional[Dict[str, bool]],
        session_id: Optional[str],
        observation_id: Optional[str],
    ) -> bool:
        if session_id or observation_id:
            identifiers = (str(item.get("name") or ""), str(item.get("filename") or ""))
            matches_session = bool(session_id and item.get("session_id") == session_id)
            matches_observation = bool(
                observation_id
                and (
                    item.get("observation_id") == observation_id
                    or any(observation_id in identifier for identifier in identifiers)
                )
            )
            if not matches_session and not matches_observation:
                return False
        if not filters:
            return True
        enabled = {
            "recording": filters.get("showRecordings", True),
            "snapshot": filters.get("showSnapshots", True),
            "decoded": filters.get("showDecoded", True),
            "decoded_folder": filters.get("showDecoded", True),
            "audio": filters.get("showAudio", True),
            "transcription": filters.get("showTranscriptions", True),
        }
        return enabled.get(str(item.get("type")), True)

    def _disk_usage(self) -> Dict[str, int]:
        try:
            usage = shutil.disk_usage(self.roots.data)
            return {"total": usage.total, "used": usage.used, "available": usage.free}
        except OSError:
            return {"total": 0, "used": 0, "available": 0}

    def _add(self, items: Dict[str, Dict[str, Any]], item: Dict[str, Any], path: Path) -> None:
        item["_path"] = str(path)
        items[str(item["id"])] = item

    @staticmethod
    def _public(item: Dict[str, Any]) -> Dict[str, Any]:
        """Never expose implementation paths outside the storage service."""
        return {key: value for key, value in item.items() if key != "_path"}

    def _scan_recordings(self, items: Dict[str, Dict[str, Any]]) -> None:
        root = self.roots.recordings
        if not root.is_dir():
            return
        for meta in root.glob("*.sigmf-meta"):
            data = meta.with_suffix(".sigmf-data")
            if not data.is_file():
                continue
            stat = data.stat()
            metadata = _sigmf_summary(meta)
            name = meta.stem
            snapshot = root / f"{name}.png"
            thumbnail = root / "thumbnails" / f"{name}.jpg"
            self._add(
                items,
                {
                    "id": f"recording:{name}",
                    "type": "recording",
                    "name": name,
                    "display_name": name,
                    "data_file": data.name,
                    "meta_file": meta.name,
                    "data_size": stat.st_size,
                    "meta_size": meta.stat().st_size,
                    "created": _iso(stat.st_ctime),
                    "modified": _iso(stat.st_mtime),
                    "metadata": metadata,
                    "session_id": metadata.get("session_id"),
                    "recording_in_progress": metadata.get("recording_in_progress", False),
                    "snapshot": self._snapshot_info(snapshot, "/recordings", thumbnail),
                    "download_urls": {
                        "data": f"/recordings/{quote(data.name)}",
                        "meta": f"/recordings/{quote(meta.name)}",
                    },
                },
                data,
            )

    def _scan_snapshots(self, items: Dict[str, Dict[str, Any]]) -> None:
        root = self.roots.snapshots
        if not root.is_dir():
            return
        for path in root.glob("*.png"):
            stat = path.stat()
            thumbnail = root / "thumbnails" / f"{path.stem}.jpg"
            self._add(
                items,
                {
                    "id": f"snapshot:{path.name}",
                    "type": "snapshot",
                    "name": path.stem,
                    "display_name": path.stem,
                    "filename": path.name,
                    "size": stat.st_size,
                    "created": _iso(stat.st_ctime),
                    "modified": _iso(stat.st_mtime),
                    "url": f"/snapshots/{quote(path.name)}",
                    "thumbnail_url": (
                        f"/snapshots/thumbnails/{quote(thumbnail.name)}"
                        if thumbnail.is_file()
                        else None
                    ),
                },
                path,
            )

    def _scan_decoded(self, items: Dict[str, Dict[str, Any]]) -> None:
        root = self.roots.decoded
        if not root.is_dir():
            return
        for folder in root.iterdir():
            if not folder.is_dir() or ".satdump_" not in folder.name:
                continue
            stat = folder.stat()
            # Folder cards and size sorting need the same byte total shown in
            # the detail view, including files in nested SatDump output folders.
            total_size = sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())
            dataset = _read_json(folder / "dataset.json")
            folder_parts = folder.name.split(".")
            pipeline = folder_parts[1].replace("satdump_", "") if len(folder_parts) > 1 else None
            self._add(
                items,
                {
                    "id": f"decoded_folder:{folder.name}",
                    "type": "decoded_folder",
                    "name": folder.stem,
                    "display_name": folder.stem,
                    "foldername": folder.name,
                    "size": total_size,
                    "created": _iso(stat.st_ctime),
                    "modified": _iso(stat.st_mtime),
                    "url": f"/decoded/{quote(folder.name)}",
                    "thumbnail_url": (
                        f"/decoded/{quote(folder.name)}/thumbnail.jpg"
                        if (folder / "thumbnail.jpg").is_file()
                        else None
                    ),
                    "satellite_name": dataset.get("satellite", "Unknown"),
                    "pipeline": pipeline,
                    "products": dataset.get("products", []),
                    "image_count": None,
                    "metadata": dataset,
                },
                folder,
            )
        for pattern in DECODED_PATTERNS:
            for path in root.glob(pattern):
                if not path.is_file():
                    continue
                stat = path.stat()
                metadata = _read_json(path.with_suffix(".json"))
                decoder: Dict[str, Any] = {}
                decoder_value = metadata.get("decoder")
                if isinstance(decoder_value, dict):
                    decoder = decoder_value
                satellite: Dict[str, Any] = {}
                satellite_value = metadata.get("satellite")
                if isinstance(satellite_value, dict):
                    satellite = satellite_value
                self._add(
                    items,
                    {
                        "id": f"decoded:{path.name}",
                        "type": "decoded",
                        "name": path.stem,
                        "display_name": path.stem,
                        "filename": path.name,
                        "size": stat.st_size,
                        "created": _iso(stat.st_ctime),
                        "modified": _iso(stat.st_mtime),
                        "url": f"/decoded/{quote(path.name)}",
                        "file_type": path.suffix.lower(),
                        "decoder_type": str(decoder.get("type") or "").upper() or None,
                        "satellite_name": satellite.get("name"),
                        "satellite_norad_id": satellite.get("norad_id"),
                        "session_id": decoder.get("session_id"),
                        "observation_id": metadata.get("observation_id"),
                    },
                    path,
                )

    def _scan_audio(self, items: Dict[str, Dict[str, Any]]) -> None:
        root = self.roots.audio
        if not root.is_dir():
            return
        for path in root.glob("*.wav"):
            stat = path.stat()
            metadata = _read_json(path.with_suffix(".json"))
            self._add(
                items,
                {
                    "id": f"audio:{path.name}",
                    "type": "audio",
                    "name": path.stem,
                    "display_name": path.stem,
                    "filename": path.name,
                    "size": stat.st_size,
                    "created": _iso(stat.st_ctime),
                    "modified": _iso(stat.st_mtime),
                    "url": f"/audio/{quote(path.name)}",
                    "file_type": ".wav",
                    "vfo_number": metadata.get("vfo_number"),
                    "demodulator_type": metadata.get("demodulator_type", ""),
                    "satellite_name": metadata.get("target_satellite_name"),
                    "satellite_norad_id": metadata.get("target_satellite_norad_id"),
                    "duration_seconds": metadata.get("duration_seconds"),
                    "sample_rate": metadata.get("sample_rate"),
                    "status": metadata.get("status", "unknown"),
                    "session_id": metadata.get("session_id"),
                    "observation_id": metadata.get("observation_id"),
                    "metadata": metadata,
                },
                path,
            )

    def _scan_transcriptions(self, items: Dict[str, Dict[str, Any]]) -> None:
        root = self.roots.transcriptions
        if not root.is_dir():
            return
        for path in root.glob("*.txt"):
            stat = path.stat()
            metadata = _transcription_summary(path)
            self._add(
                items,
                {
                    "id": f"transcription:{path.name}",
                    "type": "transcription",
                    "name": path.stem,
                    "display_name": path.stem,
                    "filename": path.name,
                    "size": stat.st_size,
                    "created": _iso(stat.st_ctime),
                    "modified": _iso(stat.st_mtime),
                    "url": f"/transcriptions/{quote(path.name)}",
                    "file_type": ".txt",
                    **metadata,
                },
                path,
            )

    def _scan_observations(self, items: Dict[str, Dict[str, Any]]) -> None:
        root = self.roots.observations
        if not root.is_dir():
            return
        for folder in root.glob("*.gsobs"):
            if not folder.is_dir():
                continue
            stat = folder.stat()
            manifest = _read_json(folder / "manifest.json")
            satellite: Dict[str, Any] = {}
            satellite_value = manifest.get("satellite")
            if isinstance(satellite_value, dict):
                satellite = satellite_value
            thumbnail = next(
                (path for path in (folder / "recordings").glob("*_waterfall_thumb.png")), None
            )
            # Count and size only files the dialog presents as artifacts;
            # manifests, sidecars, and thumbnails are implementation metadata.
            # This traversal already powers the artifact count, so including
            # byte totals here gives cards an accurate size without a second walk.
            manifest_path = folder / "manifest.json"
            artifact_count = 0
            total_size = 0
            for path in folder.rglob("*"):
                if (
                    not path.is_file()
                    or path == manifest_path
                    or path.suffix.lower() == ".json"
                    or "thumbnails" in path.relative_to(folder).parent.parts
                ):
                    continue
                artifact_count += 1
                total_size += path.stat().st_size
            self._add(
                items,
                {
                    "id": f"observation:{folder.name}",
                    "type": "decoded_folder",
                    "folder_kind": "observation",
                    "name": folder.stem,
                    "display_name": folder.stem,
                    "foldername": folder.name,
                    "size": total_size,
                    "created": _iso(stat.st_ctime),
                    "modified": _iso(stat.st_mtime),
                    "url": f"/observations/{quote(folder.name)}",
                    "download_url": f"/api/observations/{quote(folder.name)}/download",
                    "thumbnail_url": (
                        f"/observations/{quote(folder.name)}/recordings/{quote(thumbnail.name)}"
                        if thumbnail
                        else None
                    ),
                    "satellite_name": satellite.get("name", "Unknown"),
                    "satellite_id": satellite.get("norad_id"),
                    "observation_status": manifest.get("status", "unknown"),
                    "observation_in_progress": bool(manifest.get("in_progress", False)),
                    "artifact_count": artifact_count,
                },
                folder,
            )

    def _snapshot_info(self, path: Path, mount: str, thumbnail: Path) -> Optional[Dict[str, Any]]:
        if not path.is_file():
            return None

        # WaterfallGenerator writes this preview beside the full-resolution
        # waterfall. Prefer it because older observation bundles do not have a
        # generated JPEG cache, and falling back to ``path`` would make the UI
        # decode the original multi-megapixel PNG just to fill a small card.
        waterfall_thumbnail = path.with_name(f"{path.stem}_waterfall_thumb.png")
        if waterfall_thumbnail.is_file():
            thumbnail_url = f"{mount}/{quote(waterfall_thumbnail.name)}"
        elif thumbnail.is_file():
            thumbnail_url = f"{mount}/thumbnails/{quote(thumbnail.name)}"
        else:
            thumbnail_url = None

        return {
            "filename": path.name,
            "url": f"{mount}/{quote(path.name)}",
            "thumbnail_url": thumbnail_url,
            "size": path.stat().st_size,
        }

    def _decoded_folder_detail(self, item: Dict[str, Any], folder: Path) -> Dict[str, Any]:
        """Expand a decoded folder's images and metadata when it is opened."""
        images: List[Dict[str, Any]] = []
        total_size = 0
        for path in folder.rglob("*"):
            if not path.is_file():
                continue
            stat = path.stat()
            total_size += stat.st_size
            if path.suffix.lower() in IMAGE_EXTENSIONS:
                relative = path.relative_to(folder).as_posix()
                images.append(
                    {
                        "filename": path.name,
                        "path": relative,
                        "size": stat.st_size,
                        "url": f"/decoded/{quote(folder.name)}/{quote(relative)}",
                    }
                )
        item.update(
            {
                "size": total_size,
                "images": images,
                "image_count": len(images),
                "metadata": _read_json(folder / "dataset.json"),
                "telemetry": _read_json(folder / "telemetry.json"),
            }
        )
        return item

    def _observation_detail(self, item: Dict[str, Any], folder: Path) -> Dict[str, Any]:
        """Expand an observation bundle only when its details dialog opens."""
        manifest_path = folder / "manifest.json"
        artifacts: List[Dict[str, Any]] = []
        images: List[Dict[str, Any]] = []
        total_size = 0
        recording_root = folder / "recordings"
        recording_owner_by_path: Dict[str, str] = {}

        # Recordings are represented by one card each. Keep their individual
        # data, metadata, waterfall, and waterfall preview out of the generic
        # artifact/image grids, where the full waterfall would otherwise be
        # requested and decoded a second time during dialog scrolling.
        if recording_root.is_dir():
            for meta in recording_root.glob("*.sigmf-meta"):
                data = meta.with_suffix(".sigmf-data")
                if not data.is_file():
                    continue
                name = meta.stem
                for member in (
                    data,
                    meta,
                    recording_root / f"{name}.png",
                    recording_root / f"{name}_waterfall_thumb.png",
                ):
                    if member.is_file():
                        recording_owner_by_path[member.relative_to(folder).as_posix()] = name

        for path in folder.rglob("*"):
            if not path.is_file() or path == manifest_path or path.suffix.lower() == ".json":
                continue
            relative = path.relative_to(folder)
            if "thumbnails" in relative.parent.parts:
                continue
            stat = path.stat()
            relative_path = relative.as_posix()
            generated_thumbnail = path.parent / "thumbnails" / f"{path.stem}.jpg"
            artifact = {
                "name": path.name,
                "path": relative_path,
                "url": f"/observations/{quote(folder.name)}/{quote(relative_path)}",
                "size": stat.st_size,
                "kind": relative.parts[0] if relative.parts else "file",
                "file_type": path.suffix.lower(),
                "recording_name": recording_owner_by_path.get(relative_path),
            }
            if path.suffix.lower() in IMAGE_EXTENSIONS and generated_thumbnail.is_file():
                thumbnail_relative = generated_thumbnail.relative_to(folder).as_posix()
                artifact["thumbnail_url"] = (
                    f"/observations/{quote(folder.name)}/{quote(thumbnail_relative)}"
                )
            artifacts.append(artifact)
            total_size += stat.st_size
            if path.suffix.lower() in IMAGE_EXTENSIONS:
                images.append(artifact)

        recordings: List[Dict[str, Any]] = []
        if recording_root.is_dir():
            for meta in recording_root.glob("*.sigmf-meta"):
                data = meta.with_suffix(".sigmf-data")
                if not data.is_file():
                    continue
                stat = data.stat()
                name = meta.stem
                metadata = _sigmf_summary(meta)
                recordings.append(
                    {
                        "type": "recording",
                        "name": name,
                        "data_file": data.name,
                        "meta_file": meta.name,
                        "data_size": stat.st_size,
                        "meta_size": meta.stat().st_size,
                        "created": _iso(stat.st_ctime),
                        "modified": _iso(stat.st_mtime),
                        "metadata": metadata,
                        "recording_in_progress": metadata.get("recording_in_progress", False),
                        "snapshot": self._snapshot_info(
                            recording_root / f"{name}.png",
                            f"/observations/{quote(folder.name)}/recordings",
                            recording_root / "thumbnails" / f"{name}.jpg",
                        ),
                        "download_urls": {
                            "data": f"/observations/{quote(folder.name)}/recordings/{quote(data.name)}",
                            "meta": f"/observations/{quote(folder.name)}/recordings/{quote(meta.name)}",
                        },
                    }
                )
        item.update(
            {
                "size": total_size,
                "images": images,
                "artifacts": artifacts,
                "artifact_count": len(artifacts),
                "image_count": len(images),
                "recordings": recordings,
                "recording_count": len(recordings),
                "metadata": _read_json(manifest_path),
            }
        )
        return item

    def _delete_item(self, item: Dict[str, Any]) -> None:
        path = Path(str(item["_path"])).resolve()
        item_type = str(item.get("type"))
        allowed_roots = {
            "recording": self.roots.recordings,
            "snapshot": self.roots.snapshots,
            "decoded": self.roots.decoded,
            "decoded_folder": self.roots.decoded,
            "audio": self.roots.audio,
            "transcription": self.roots.transcriptions,
        }
        root = (
            self.roots.observations
            if item.get("folder_kind") == "observation"
            else allowed_roots.get(item_type)
        )
        if root is None:
            raise OSError("Unsupported library item")
        try:
            path.relative_to(root.resolve())
        except ValueError as exc:
            raise OSError("Refusing to delete a path outside the library") from exc
        if not path.exists():
            raise OSError("Item not found")
        if item_type == "recording":
            base = path.with_suffix("")
            for associated in (
                base.with_suffix(".sigmf-data"),
                base.with_suffix(".sigmf-meta"),
                base.with_suffix(".png"),
                base.parent / "thumbnails" / f"{base.name}.jpg",
            ):
                if associated.is_file():
                    associated.unlink()
            return
        if path.is_dir():
            shutil.rmtree(path)
        elif path.is_file():
            path.unlink()
            if item_type == "audio":
                sidecar = path.with_suffix(".json")
                if sidecar.is_file():
                    sidecar.unlink()


_inventories: Dict[Path, LibraryInventory] = {}
_inventories_lock = threading.Lock()


def get_inventory(backend_dir: Optional[Path] = None) -> LibraryInventory:
    """Return the process-local inventory for a backend root."""
    root = (backend_dir or Path(__file__).resolve().parents[1]).resolve()
    with _inventories_lock:
        inventory = _inventories.get(root)
        if inventory is None:
            inventory = LibraryInventory(root)
            _inventories[root] = inventory
        return inventory
