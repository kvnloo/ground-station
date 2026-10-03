import multiprocessing

import pytest

from monitoring.timing import TimestampedQueue, TimingCollector, bind_enabled_event


@pytest.fixture(autouse=True)
def reset_timing_event():
    """Keep the process-wide opt-in switch isolated from other tests."""
    bind_enabled_event(None)
    yield
    bind_enabled_event(None)


def test_timing_collector_is_disabled_until_monitoring_is_enabled():
    enabled_event = multiprocessing.Event()
    bind_enabled_event(enabled_event)
    collector = TimingCollector()

    collector.record_duration("processing", 15.0, realtime_seconds=0.1)

    assert collector.snapshot() == {"stages": {}}


def test_timing_collector_reports_bounded_percentile_summary():
    enabled_event = multiprocessing.Event()
    enabled_event.set()
    bind_enabled_event(enabled_event)
    collector = TimingCollector(sample_limit=3)

    for duration in (10.0, 20.0, 30.0, 40.0):
        collector.record_duration("processing", duration, realtime_seconds=0.1)

    summary = collector.snapshot()["stages"]["processing"]

    assert summary["count"] == 3
    assert summary["p50_ms"] == 30.0
    assert summary["p95_ms"] == 40.0
    assert summary["p99_ms"] == 40.0
    assert summary["max_ms"] == 40.0
    assert summary["p95_rtf"] == 0.4


def test_timestamped_queue_stamps_iq_messages_only_while_enabled():
    class Queue:
        def __init__(self):
            self.items = []

        def put_nowait(self, item):
            self.items.append(item)

    enabled_event = multiprocessing.Event()
    queue = Queue()
    timed_queue = TimestampedQueue(queue, enabled_event)

    timed_queue.put_nowait({"samples": []})
    assert "pipeline_captured_at_ns" not in queue.items[-1]

    enabled_event.set()
    timed_queue.put_nowait({"samples": []})
    assert queue.items[-1]["pipeline_captured_at_ns"] > 0
