# Copyright (c) 2026 Efstratios Goudelis

import asyncio
import logging
import queue

import pytest

from pipeline.orchestration.processlifecycle import ProcessLifecycleManager


class _SocketServer:
    async def emit(self, *_args, **_kwargs):
        return None

    async def leave_room(self, *_args, **_kwargs):
        return None


class _Manager:
    def stop_demodulator(self, *_args, **_kwargs):
        return None

    def stop_recorder(self, *_args, **_kwargs):
        return None

    def stop_decoder(self, *_args, **_kwargs):
        return None


class _Broadcaster:
    def stop(self):
        return None

    def join(self, timeout=None):
        return timeout


class _StoppedProcess:
    pid = 42

    def is_alive(self):
        return False


def _new_manager(processes=None):
    basic_manager = _Manager()
    return ProcessLifecycleManager(
        processes if processes is not None else {},
        _SocketServer(),
        basic_manager,
        basic_manager,
        basic_manager,
    )


@pytest.mark.asyncio
async def test_sdr_readiness_requires_stream_activation_and_samples():
    manager = _new_manager()
    process_info = {
        "streaming_started": False,
        "worker_stats": {"samples_read": 0},
        "ready_waiters": [],
    }

    ready = manager._create_ready_waiter(process_info)
    process_info["streaming_started"] = True
    manager._resolve_ready_waiters(process_info)
    assert ready.done() is False

    process_info["worker_stats"] = {"samples_read": 1024}
    manager._resolve_ready_waiters(process_info)

    assert await ready == {"success": True}
    assert process_info["startup_ready"] is True


@pytest.mark.asyncio
async def test_sdr_readiness_propagates_worker_error():
    manager = _new_manager()
    process_info = {
        "streaming_started": True,
        "worker_stats": {"samples_read": 0},
        "ready_waiters": [],
    }
    ready = manager._create_ready_waiter(process_info)

    manager._fail_ready_waiters(process_info, "device open failed")

    with pytest.raises(RuntimeError, match="device open failed"):
        await manager._wait_until_sdr_ready("sdr-1", process_info, ready)


def test_decoder_error_status_is_logged(caplog):
    manager = _new_manager()

    with caplog.at_level(logging.ERROR, logger="process-lifecycle"):
        manager._log_decoder_error_status(
            {
                "status": "error",
                "decoder_type": "aprs",
                "session_id": "session-1",
                "vfo": 2,
                "info": {"error": "GNU Radio filter binding failed"},
            }
        )

    assert "Decoder aprs failed for session session-1 VFO 2" in caplog.text
    assert "GNU Radio filter binding failed" in caplog.text


def test_exited_decoder_process_is_logged_once(caplog):
    class _FailedDecoder:
        exitcode = 1

        @staticmethod
        def is_alive():
            return False

    process_info = {
        "decoders": {
            "session-1": {
                2: {
                    "instance": _FailedDecoder(),
                    "decoder_type": "APRSDecoder",
                }
            }
        }
    }
    manager = _new_manager()

    with caplog.at_level(logging.ERROR, logger="process-lifecycle"):
        manager._log_exited_decoder_processes("sdr-1", process_info)
        manager._log_exited_decoder_processes("sdr-1", process_info)

    assert caplog.text.count("Decoder APRSDecoder failed") == 1
    assert "exit code 1" in caplog.text


@pytest.mark.asyncio
async def test_active_internal_session_receives_worker_failure():
    messages = queue.Queue()
    messages.put({"type": "error", "message": "USB transfer failed"})
    messages.put({"type": "terminated"})
    stop_event = asyncio.Event()
    process_info = {
        "process": _StoppedProcess(),
        "fft_process": None,
        "data_queue": messages,
        "stop_event": stop_event,
        "clients": {"internal:obs-1:sdr-1"},
        "iq_broadcaster": _Broadcaster(),
        "streaming_started": True,
        "startup_ready": True,
        "ready_waiters": [],
        "worker_stats": {"samples_read": 1024},
        "failure_reported": False,
    }
    processes = {"sdr-1": process_info}
    manager = _new_manager(processes)
    failures = []

    async def _record_failure(sdr_id, clients, message):
        failures.append((sdr_id, clients, message))

    manager.set_sdr_failure_handler(_record_failure)
    await manager._monitor_data_queue("sdr-1", expected_process_pid=42)
    await asyncio.sleep(0)

    assert failures == [("sdr-1", {"internal:obs-1:sdr-1"}, "USB transfer failed")]
    assert "sdr-1" not in processes
