"""Socket commands for the filesystem-backed library inventory.

List and delete commands return normal RPC acknowledgements.  Broadcasts are
reserved for compact change notifications, so a browser never receives another
client's full library listing.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from common import auth as authsvc
from library.inventory import get_inventory


async def _emit_changed(sio: Any, revision: int, changes: List[Dict[str, str]]) -> None:
    """Tell authenticated clients which stable library IDs changed."""
    await sio.emit(
        "library.changed",
        {"revision": revision, "changes": changes},
        room=authsvc.AUTHENTICATED_SOCKET_ROOM,
    )


async def query_library(_sio: Any, data: Optional[Dict], _logger: Any, _sid: str) -> Dict[str, Any]:
    """Return one compact server-side page from the rebuildable inventory."""
    request = data if isinstance(data, dict) else {}
    result = await asyncio.to_thread(
        get_inventory().query,
        request.get("filters"),
        request.get("sortBy", "created"),
        request.get("sortOrder", "desc"),
        request.get("page", 1),
        request.get("pageSize", 25),
        request.get("sessionId"),
        request.get("observationId"),
    )
    return {"success": True, "data": result}


async def get_library_item(
    _sio: Any, data: Optional[Dict], _logger: Any, _sid: str
) -> Dict[str, Any]:
    """Return expensive nested metadata for one explicitly opened item."""
    item_id = (data or {}).get("id")
    if not isinstance(item_id, str) or not item_id:
        return {"success": False, "error": "id is required"}
    item = await asyncio.to_thread(get_inventory().detail, item_id)
    if item is None:
        return {"success": False, "error": "Library item not found"}
    return {"success": True, "data": item}


async def reconcile_library(
    sio: Any, _data: Optional[Dict], _logger: Any, _sid: str
) -> Dict[str, Any]:
    """Rebuild the process-local inventory after an external storage change."""
    revision = await asyncio.to_thread(get_inventory().rebuild)
    await _emit_changed(sio, revision, [{"operation": "reconciled", "id": "*"}])
    return {"success": True, "data": {"revision": revision}}


async def delete_library_items(
    sio: Any, data: Optional[Dict], _logger: Any, _sid: str
) -> Dict[str, Any]:
    """Delete one or more stable IDs and report success for every requested item."""
    request = data if isinstance(data, dict) else {}
    item_ids = request.get("ids")
    if (
        not isinstance(item_ids, list)
        or not item_ids
        or not all(isinstance(item_id, str) and item_id for item_id in item_ids)
    ):
        return {"success": False, "error": "ids must be a non-empty list of item IDs"}

    result = await asyncio.to_thread(get_inventory().delete, item_ids)
    changes = [
        {"operation": "deleted", "id": entry["id"]}
        for entry in result["results"]
        if entry["success"]
    ]
    if changes:
        await _emit_changed(sio, result["revision"], changes)
    return {"success": True, "data": result}


def register_handlers(registry: Any) -> None:
    """Register the new inventory protocol under the File Browser namespace."""
    registry.register_batch(
        {
            "filebrowser.query": (query_library, "api_call"),
            "filebrowser.item": (get_library_item, "api_call"),
            "filebrowser.reconcile": (reconcile_library, "api_call"),
            "filebrowser.delete": (delete_library_items, "api_call"),
        }
    )
