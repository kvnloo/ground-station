"""Satellite removal must clean up orbits without relying on SQLite cascades."""

import logging
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import select, update
from sqlalchemy.sql.dml import Delete

from crud.satellites import delete_satellite
from crud.tlesources import delete_satellite_tle_sources
from db.models import (
    Groups,
    OrbitalSources,
    SatelliteGroupType,
    SatelliteOrbits,
    Satellites,
    Transmitters,
)
from tlesync.utils import update_satellite_group_with_removal_detection

TARGET_ID = 67290
OTHER_ID = 25544
LOGGER = logging.getLogger(__name__)


@pytest_asyncio.fixture(params=[False, True], ids=["foreign-keys-off", "foreign-keys-on"])
async def satellite_catalog(db_engine, db_session, request):
    # Test the deployed SQLite configuration as well as enforced foreign keys.
    async with db_engine.connect() as connection:
        await connection.exec_driver_sql(f"PRAGMA foreign_keys = {int(request.param)}")
        enabled = await connection.exec_driver_sql("PRAGMA foreign_keys")
        assert enabled.scalar_one() == int(request.param)

    db_session.add_all(
        [
            Satellites(norad_id=TARGET_ID, name="SAKHACUBE-CHOLBON", source="tlesync"),
            Satellites(norad_id=OTHER_ID, name="ISS", source="tlesync"),
        ]
    )
    # Insert parents first so the fixture also works with foreign keys enabled.
    await db_session.flush()
    db_session.add_all(
        [
            SatelliteOrbits(
                satellite_norad_id=TARGET_ID,
                central_body="earth",
                model_kind="tle",
                tle1="1 67290U 25313AU  26273.48817398  .00005070  00000-0  19662-3 0  9995",
                tle2="2 67290  97.3838 347.2777 0008389 354.0988   6.0151 15.26542203 42038",
            ),
            *[
                SatelliteOrbits(
                    satellite_norad_id=TARGET_ID,
                    central_body=body,
                    model_kind="omm",
                    omm_payload={"NORAD_CAT_ID": TARGET_ID},
                )
                for body in ("moon", "mars")
            ],
            SatelliteOrbits(
                satellite_norad_id=OTHER_ID,
                central_body="earth",
                model_kind="omm",
                omm_payload={"NORAD_CAT_ID": OTHER_ID},
            ),
            Transmitters(id="target-transmitter", norad_cat_id=TARGET_ID, status="active"),
            Transmitters(id="other-transmitter", norad_cat_id=OTHER_ID, status="active"),
            Groups(
                name="Amateur",
                identifier="amateur",
                type=SatelliteGroupType.SYSTEM,
                satellite_ids=[TARGET_ID, OTHER_ID],
            ),
        ]
    )
    await db_session.commit()
    db_session.expunge_all()
    return db_session


async def _remove_satellite(session, deletion_path):
    if deletion_path == "manual":
        result = await delete_satellite(session, TARGET_ID)
        assert result["success"] is True
    else:
        result = await update_satellite_group_with_removal_detection(
            session, "amateur", [OTHER_ID], "Amateur", LOGGER
        )
        assert [satellite["norad_id"] for satellite in result["satellites"]] == [TARGET_ID]
        await session.commit()


async def _catalog_snapshot(session):
    """Read persisted rows, including group membership, without the ORM identity cache."""
    return {
        "satellites": list(
            (await session.scalars(select(Satellites.norad_id).order_by(Satellites.norad_id))).all()
        ),
        "orbits": (
            await session.execute(
                select(SatelliteOrbits.satellite_norad_id, SatelliteOrbits.central_body).order_by(
                    SatelliteOrbits.satellite_norad_id, SatelliteOrbits.central_body
                )
            )
        ).all(),
        "transmitters": list(
            (await session.scalars(select(Transmitters.id).order_by(Transmitters.id))).all()
        ),
        "groups": (
            await session.execute(
                select(Groups.identifier, Groups.satellite_ids).order_by(Groups.identifier)
            )
        ).all(),
    }


@pytest.mark.unit
@pytest.mark.parametrize("deletion_path", ["manual", "sync"])
async def test_removal_deletes_all_orbits_and_preserves_other_satellites(
    satellite_catalog, deletion_path
):
    session = satellite_catalog

    await _remove_satellite(session, deletion_path)

    assert await _catalog_snapshot(session) == {
        "satellites": [OTHER_ID],
        "orbits": [(OTHER_ID, "earth")],
        "transmitters": ["other-transmitter"],
        "groups": [("amateur", [OTHER_ID])],
    }


@pytest.mark.unit
async def test_sync_preserves_orbits_when_another_source_still_contains_satellite(
    satellite_catalog,
):
    session = satellite_catalog
    session.add(
        Groups(
            name="Active",
            identifier="active",
            type=SatelliteGroupType.SYSTEM,
            satellite_ids=[TARGET_ID],
        )
    )
    await session.commit()
    before = await _catalog_snapshot(session)

    removed = await update_satellite_group_with_removal_detection(
        session, "amateur", [OTHER_ID], "Amateur", LOGGER
    )
    await session.commit()

    assert removed == {"satellites": [], "transmitters": []}
    before["groups"] = [("active", [TARGET_ID]), ("amateur", [OTHER_ID])]
    assert await _catalog_snapshot(session) == before


@pytest_asyncio.fixture
async def source_catalog(satellite_catalog):
    session = satellite_catalog
    group = await session.scalar(select(Groups).where(Groups.identifier == "amateur"))
    group.satellite_ids = [TARGET_ID]
    source_id = uuid.uuid4()
    session.add(
        OrbitalSources(
            id=source_id,
            name="Amateur",
            identifier="amateur",
            url="https://example.com/amateur.csv",
        )
    )
    await session.flush()
    # A retained satellite can still have orbit data last supplied by this source.
    await session.execute(update(SatelliteOrbits).values(source_id=source_id))
    await session.commit()
    session.expunge_all()
    return session, source_id


@pytest.mark.unit
async def test_source_deletion_removes_member_orbits_and_detaches_retained_orbits(source_catalog):
    session, source_id = source_catalog

    result = await delete_satellite_tle_sources(session, [str(source_id)])

    assert result["success"] is True
    assert result["deletion_summary"][0]["satellites_deleted"] == 1
    assert await _catalog_snapshot(session) == {
        "satellites": [OTHER_ID],
        "orbits": [(OTHER_ID, "earth")],
        "transmitters": ["other-transmitter"],
        "groups": [],
    }
    assert (await session.scalars(select(OrbitalSources.id))).all() == []
    assert (await session.scalars(select(SatelliteOrbits.source_id))).all() == [None]


@pytest.mark.unit
async def test_source_deletion_rolls_back_orbit_cleanup_if_commit_fails(
    source_catalog, monkeypatch
):
    session, source_id = source_catalog
    before = await _catalog_snapshot(session)

    async def fail_commit():
        raise RuntimeError("Source deletion failed")

    monkeypatch.setattr(session, "commit", fail_commit)

    result = await delete_satellite_tle_sources(session, [str(source_id)])

    assert result["success"] is False
    assert result["error"] == "Source deletion failed"
    assert await _catalog_snapshot(session) == before
    assert (await session.scalars(select(OrbitalSources.id))).all() == [source_id]
    assert (await session.scalars(select(SatelliteOrbits.source_id))).all() == [source_id] * 4


@pytest.mark.unit
@pytest.mark.parametrize("deletion_path", ["manual", "sync"])
async def test_removal_rolls_back_orbit_cleanup_if_satellite_deletion_fails(
    satellite_catalog, deletion_path, monkeypatch
):
    session = satellite_catalog
    before = await _catalog_snapshot(session)
    execute = session.execute

    async def fail_satellite_deletion(statement, *args, **kwargs):
        if isinstance(statement, Delete) and statement.table.name == "satellites":
            raise RuntimeError("Satellite deletion failed")
        return await execute(statement, *args, **kwargs)

    monkeypatch.setattr(session, "execute", fail_satellite_deletion)

    if deletion_path == "manual":
        result = await delete_satellite(session, TARGET_ID)
        assert result["success"] is False
        assert result["error"] == "Satellite deletion failed"
    else:
        with pytest.raises(RuntimeError, match="Satellite deletion failed"):
            await update_satellite_group_with_removal_detection(
                session, "amateur", [OTHER_ID], "Amateur", LOGGER
            )
        # Sync owns its transaction and rolls it back when removal fails.
        await session.rollback()

    assert await _catalog_snapshot(session) == before
