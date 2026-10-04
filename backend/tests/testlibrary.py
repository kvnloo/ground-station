"""Tests for the rebuildable filesystem library catalogue."""

import json
import logging
from pathlib import Path

import pytest

from handlers.entities import filebrowser, library
from library.inventory import LibraryInventory


def _write(path: Path, content: bytes | str = b"") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, str):
        path.write_text(content)
    else:
        path.write_bytes(content)
    return path


@pytest.fixture
def inventory(tmp_path):
    backend = tmp_path / "backend"
    recordings = backend / "data" / "recordings"
    _write(recordings / "capture.sigmf-data", b"iq")
    _write(
        recordings / "capture.sigmf-meta",
        json.dumps(
            {
                "global": {
                    "core:sample_rate": 48_000,
                    "gs:session_id": "session-1",
                    "gs:recording_in_progress": False,
                },
                "captures": [{"core:frequency": 137_100_000}],
            }
        ),
    )
    _write(backend / "data" / "snapshots" / "waterfall.png", b"png")
    _write(backend / "data" / "decoded" / "packet.bin", b"packet")
    _write(
        backend / "data" / "decoded" / "packet.json",
        json.dumps({"decoder": {"type": "ax25", "session_id": "session-1"}}),
    )
    _write(backend / "data" / "audio" / "voice.wav", b"wav")
    _write(backend / "data" / "audio" / "voice.json", json.dumps({"sample_rate": 12_000}))
    _write(
        backend / "data" / "transcriptions" / "voice.txt",
        "# Provider: local\n# Session: session-1\n# Language: en\n\nhello\n",
    )
    _write(
        backend / "data" / "observations" / "NOAA.gsobs" / "manifest.json",
        json.dumps({"satellite": {"name": "NOAA 19"}, "status": "complete"}),
    )
    _write(backend / "data" / "observations" / "NOAA.gsobs" / "decoded" / "image.png", b"png")
    _write(
        backend / "data" / "observations" / "NOAA.gsobs" / "transcriptions" / "voice.txt",
        "transcript",
    )
    result = LibraryInventory(backend)
    result.rebuild()
    return result


def test_inventory_returns_compact_server_side_pages(inventory):
    page = inventory.query(sort_by="name", sort_order="asc", page=1, page_size=2)

    assert page["total"] == 6
    assert len(page["items"]) == 2
    assert page["has_more"] is True
    assert all("_path" not in item for item in page["items"])
    assert {item["id"].split(":", 1)[0] for item in page["items"]} <= {
        "recording",
        "snapshot",
        "decoded",
        "audio",
        "transcription",
        "observation",
    }

    last_page = inventory.query(page=99, page_size=2)
    assert last_page["page"] == 3
    assert len(last_page["items"]) == 2


def test_inventory_filters_without_rescanning_filesystem(inventory):
    page = inventory.query(
        filters={
            "showRecordings": False,
            "showSnapshots": False,
            "showDecoded": False,
            "showAudio": True,
            "showTranscriptions": False,
        }
    )

    assert page["total"] == 1
    assert page["items"][0]["id"] == "audio:voice.wav"


def test_inventory_filters_a_single_observation_session(inventory):
    page = inventory.query(session_id="session-1")

    assert {item["id"] for item in page["items"]} == {
        "recording:capture",
        "decoded:packet.bin",
        "transcription:voice.txt",
    }

    by_observation = inventory.query(observation_id="packet")
    assert [item["id"] for item in by_observation["items"]] == ["decoded:packet.bin"]


def test_observation_summary_includes_the_visible_artifact_count(inventory):
    page = inventory.query()
    observation = next(item for item in page["items"] if item["id"] == "observation:NOAA.gsobs")

    assert observation["artifact_count"] == 2


def test_observation_detail_uses_waterfall_previews_and_groups_recording_files(inventory):
    folder = inventory.roots.observations / "NOAA.gsobs"
    recording_root = folder / "recordings"
    _write(recording_root / "capture.sigmf-data", b"iq")
    _write(recording_root / "capture.sigmf-meta", json.dumps({"global": {}}))
    _write(recording_root / "capture.png", b"full waterfall")
    _write(recording_root / "capture_waterfall_thumb.png", b"waterfall preview")
    _write(folder / "decoded" / "product.png", b"full image")
    _write(folder / "decoded" / "thumbnails" / "product.jpg", b"image preview")
    inventory.rebuild()

    detail = inventory.detail("observation:NOAA.gsobs")
    recording = detail["recordings"][0]
    artifacts = {artifact["path"]: artifact for artifact in detail["artifacts"]}
    product = next(image for image in detail["images"] if image["path"] == "decoded/product.png")

    assert recording["snapshot"]["thumbnail_url"].endswith(
        "/recordings/capture_waterfall_thumb.png"
    )
    assert artifacts["recordings/capture.png"]["recording_name"] == "capture"
    assert artifacts["recordings/capture_waterfall_thumb.png"]["recording_name"] == "capture"
    assert artifacts["recordings/capture.sigmf-data"]["recording_name"] == "capture"
    assert product["thumbnail_url"].endswith("/decoded/thumbnails/product.jpg")


def test_rebuild_only_advances_revision_when_filesystem_changes(inventory):
    revision = inventory.revision

    assert inventory.rebuild() == revision
    _write(inventory.roots.snapshots / "external.png", b"png")

    assert inventory.rebuild() == revision + 1
    assert inventory.query()["total"] == 7


def test_inventory_deletes_recording_companions_and_rebuilds(inventory):
    result = inventory.delete(["recording:capture"])

    assert result["results"] == [{"id": "recording:capture", "success": True}]
    assert inventory.query()["total"] == 5
    recording_root = inventory.roots.recordings
    assert not (recording_root / "capture.sigmf-data").exists()
    assert not (recording_root / "capture.sigmf-meta").exists()


@pytest.mark.asyncio
async def test_library_delete_command_acknowledges_per_item_result(inventory, monkeypatch):
    monkeypatch.setattr(library, "get_inventory", lambda: inventory)

    class FakeSio:
        def __init__(self):
            self.events = []

        async def emit(self, event, payload, room=None):
            self.events.append((event, payload, room))

    sio = FakeSio()
    reply = await library.delete_library_items(
        sio, {"ids": ["snapshot:waterfall.png", "missing:item"]}, None, "sid"
    )

    assert reply["success"] is True
    assert reply["data"]["results"] == [
        {"id": "snapshot:waterfall.png", "success": True},
        {"id": "missing:item", "success": False, "error": "Item not found"},
    ]
    assert sio.events[0][0] == "library.changed"


@pytest.mark.asyncio
async def test_transcription_file_creation_rebuilds_and_notifies_library(monkeypatch):
    calls = []

    class FakeInventory:
        def rebuild(self):
            calls.append("rebuild")
            return 7

    class FakeSio:
        def __init__(self):
            self.events = []

        async def emit(self, event, payload, room=None):
            self.events.append((event, payload, room))

    monkeypatch.setattr(filebrowser, "get_inventory", lambda: FakeInventory())
    sio = FakeSio()

    await filebrowser.emit_file_browser_state(
        sio, {"action": "transcription-file-created"}, logger=logging.getLogger(__name__)
    )

    assert calls == ["rebuild"]
    assert sio.events[0][0] == "library.changed"
