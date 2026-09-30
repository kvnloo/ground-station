# Copyright (c) 2025 Efstratios Goudelis
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

import asyncio
import logging
from datetime import datetime, timezone

import pytest

from db.models import OrbitalSources
from handlers.entities import orbitalsources
from tlesync.state import sync_state_manager


class _DummySessionContext:
    async def __aenter__(self):
        return object()

    async def __aexit__(self, exc_type, exc, traceback):
        return False


@pytest.mark.asyncio
async def test_fetch_sync_state_includes_next_scheduled_sync(monkeypatch):
    """API payload should include runtime scheduler metadata for UI display."""
    sync_state_manager.reset()
    sync_state_manager.update(status="idle", progress=0, message="")

    monkeypatch.setattr(orbitalsources, "should_hydrate_orbital_sync_state", lambda _: False)
    monkeypatch.setattr(
        orbitalsources,
        "get_orbital_sync_next_run_time",
        lambda: "2026-06-29T10:00:00+00:00",
    )

    response = await orbitalsources.fetch_sync_state(
        sio=None,
        data=None,
        logger=logging.getLogger(__name__),
        sid="test",
    )

    assert response["success"] is True
    assert response["data"]["next_scheduled_sync_at"] == "2026-06-29T10:00:00+00:00"
    assert response["data"]["status"] == "idle"
    sync_state_manager.reset()


@pytest.mark.asyncio
async def test_fetch_sync_state_keeps_scheduler_metadata_out_of_runtime_state(monkeypatch):
    """
    Scheduler-derived next-run metadata is returned to clients but should remain
    out of persisted/runtime sync_state_manager state.
    """
    sync_state_manager.reset()
    sync_state_manager.update(status="complete", progress=100, success=True)

    monkeypatch.setattr(orbitalsources, "should_hydrate_orbital_sync_state", lambda _: False)
    monkeypatch.setattr(
        orbitalsources,
        "get_orbital_sync_next_run_time",
        lambda: "2026-06-30T10:00:00+00:00",
    )

    response = await orbitalsources.fetch_sync_state(
        sio=None,
        data=None,
        logger=logging.getLogger(__name__),
        sid="test",
    )

    assert response["data"]["next_scheduled_sync_at"] == "2026-06-30T10:00:00+00:00"
    assert "next_scheduled_sync_at" not in sync_state_manager.get_state()
    sync_state_manager.reset()


@pytest.mark.asyncio
async def test_submit_orbital_source_returns_crud_validation_error(monkeypatch):
    """The socket response must preserve validation text for the edit dialog."""
    monkeypatch.setattr(orbitalsources, "AsyncSessionLocal", _DummySessionContext)

    async def _add_source(_session, _data):
        return {"success": False, "error": "CelesTrak sources must use https://celestrak.org"}

    async def _fetch_sources(_session):
        return {"success": True, "data": []}

    monkeypatch.setattr(orbitalsources.orbital_sources_crud, "add_orbital_source", _add_source)
    monkeypatch.setattr(orbitalsources.orbital_sources_crud, "fetch_orbital_source", _fetch_sources)

    response = await orbitalsources.submit_orbital_source(
        sio=None,
        data={"url": "http://celestrak.org"},
        logger=logging.getLogger(__name__),
        sid="test",
    )

    assert response["success"] is False
    assert response["error"] == "CelesTrak sources must use https://celestrak.org"


@pytest.mark.asyncio
async def test_orbital_source_timestamps_are_evaluated_per_record_and_update(db_session):
    """Source timestamps must be generated when rows are inserted or changed."""
    first = OrbitalSources(
        name="First source",
        identifier="first-source",
        url="https://example.test/first.txt",
    )
    db_session.add(first)
    await db_session.commit()
    first_added = first.added
    first_updated = first.updated

    await asyncio.sleep(0.01)

    second = OrbitalSources(
        name="Second source",
        identifier="second-source",
        url="https://example.test/second.txt",
    )
    db_session.add(second)
    await db_session.commit()

    assert first_added.tzinfo == timezone.utc
    assert first_updated.tzinfo == timezone.utc
    assert second.added > first_added
    assert second.updated > first_updated

    await asyncio.sleep(0.01)
    first.name = "Updated source"
    await db_session.commit()
    await db_session.refresh(first)

    assert first.updated > first_updated
    assert first.updated <= datetime.now(timezone.utc)
