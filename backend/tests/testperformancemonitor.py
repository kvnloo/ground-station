import queue
import threading

from monitoring.performancemonitor import PerformanceMonitor


class APRSDecoder:
    """Minimal process-decoder shape before its first child stats update."""

    def __init__(self):
        self.iq_queue = queue.Queue(maxsize=10)
        self.stats_lock = threading.Lock()
        self.stats = {}

    def is_alive(self):
        return True


def test_poll_decoders_keeps_starting_process_decoder_visible_without_stats():
    monitor = PerformanceMonitor.__new__(PerformanceMonitor)
    monitor.previous_snapshots = {}
    decoder = APRSDecoder()

    metrics = monitor._poll_decoders(
        "sdr-1",
        {"decoders": {"session-1": {1: {"instance": decoder}}}},
        time_delta=2.0,
    )

    entry = metrics["session-1_vfo1"]
    assert entry["type"] == "APRSDecoder"
    assert entry["is_alive"] is True
    assert entry["input_queue_size"] == 0
    assert entry["connections"] == [{"source_type": "iq_broadcaster", "source_id": "iq_sdr-1"}]
