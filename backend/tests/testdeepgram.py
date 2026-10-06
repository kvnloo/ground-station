# Copyright (c) 2026 Efstratios Goudelis

import asyncio
import queue

import pytest

from audio.deepgramtranscriptionworker import DeepgramTranscriptionWorker


class _BlockingSocket:
    def __init__(self):
        self.send_started = asyncio.Event()
        self.release_send = asyncio.Event()
        self.messages = []
        self.close_count = 0

    async def send(self, message):
        self.messages.append(message)
        self.send_started.set()
        await self.release_send.wait()

    async def close(self):
        self.close_count += 1


class _SocketServer:
    async def emit(self, *_args, **_kwargs):
        return None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_overlapping_disconnects_close_deepgram_socket_once(caplog):
    worker = DeepgramTranscriptionWorker(
        transcription_queue=queue.Queue(),
        sio=None,
        loop=asyncio.get_running_loop(),
        api_key="test-key",
        session_id="test-session",
        vfo_number=1,
    )
    socket = _BlockingSocket()
    worker.websocket = socket
    worker.connected = True

    first = asyncio.create_task(worker._disconnect())
    await asyncio.wait_for(socket.send_started.wait(), timeout=1)
    second = asyncio.create_task(worker._disconnect())
    await asyncio.sleep(0)
    socket.release_send.set()
    await asyncio.gather(first, second)

    assert socket.messages == ['{"type": "CloseStream"}']
    assert socket.close_count == 1
    assert worker.websocket is None
    assert worker.connected is False
    assert "Error closing Deepgram connection" not in caplog.text


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stop_closes_deepgram_socket_during_worker_cleanup():
    worker = DeepgramTranscriptionWorker(
        transcription_queue=queue.Queue(),
        sio=_SocketServer(),
        loop=asyncio.get_running_loop(),
        api_key="test-key",
        session_id="test-session",
        vfo_number=1,
    )
    socket = _BlockingSocket()
    socket.release_send.set()

    worker.start()
    try:
        assert await asyncio.to_thread(worker._provider_loop_ready.wait, 2)
        worker.websocket = socket
        worker.connected = True
        worker.stop()
        await asyncio.to_thread(worker.join, 3)

        assert not worker.is_alive()
        assert socket.messages == ['{"type": "CloseStream"}']
        assert socket.close_count == 1
        assert worker.websocket is None
    finally:
        if worker.is_alive():
            worker.stop()
            await asyncio.to_thread(worker.join, 3)
