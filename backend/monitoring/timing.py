"""Low-overhead, opt-in timing summaries for real-time pipeline components."""

from __future__ import annotations

from collections import deque
from math import ceil
from threading import Lock
from time import perf_counter_ns
from typing import Any, Optional

_enabled_event: Any = None


def bind_enabled_event(event: Any) -> None:
    """Bind the shared monitoring event in the main or a child process."""
    global _enabled_event
    _enabled_event = event


def get_enabled_event() -> Any:
    """Return the event shared with child pipeline processes."""
    return _enabled_event


def is_enabled() -> bool:
    """Return whether detailed timing collection is currently requested."""
    return bool(_enabled_event and _enabled_event.is_set())


def timestamp_ns() -> Optional[int]:
    """Return a monotonic timestamp only while detailed monitoring is enabled."""
    if not is_enabled():
        return None
    return perf_counter_ns()


class TimestampedQueue:
    """Add one monotonic capture timestamp as workers publish an IQ message."""

    def __init__(self, queue: Any, enabled_event: Any) -> None:
        self._queue = queue
        self._enabled_event = enabled_event

    def put(self, item: Any, *args: Any, **kwargs: Any) -> Any:
        self._stamp(item)
        return self._queue.put(item, *args, **kwargs)

    def put_nowait(self, item: Any) -> Any:
        self._stamp(item)
        return self._queue.put_nowait(item)

    def _stamp(self, item: Any) -> None:
        if self._enabled_event and self._enabled_event.is_set() and isinstance(item, dict):
            item.setdefault("pipeline_captured_at_ns", perf_counter_ns())

    def __getattr__(self, name: str) -> Any:
        """Preserve the multiprocessing queue interface used by SDR workers."""
        return getattr(self._queue, name)


class TimingCollector:
    """Keep bounded duration and real-time-factor samples for one component."""

    def __init__(self, sample_limit: int = 256) -> None:
        self._sample_limit = sample_limit
        self._lock = Lock()
        self._samples: dict[str, deque[float]] = {}
        self._rtf_samples: dict[str, deque[float]] = {}

    def start(self) -> Optional[int]:
        """Start a span, avoiding clock reads while monitoring is disabled."""
        return timestamp_ns()

    def record_since(
        self,
        stage: str,
        started_ns: Optional[int],
        realtime_seconds: Optional[float] = None,
    ) -> None:
        """Record an elapsed span when it was started while monitoring was enabled."""
        if started_ns is None:
            return
        self.record_duration(
            stage, (perf_counter_ns() - started_ns) / 1_000_000.0, realtime_seconds
        )

    def record_duration(
        self,
        stage: str,
        duration_ms: float,
        realtime_seconds: Optional[float] = None,
    ) -> None:
        """Record a duration in milliseconds and, where meaningful, its RTF."""
        if not is_enabled() or duration_ms < 0:
            return

        with self._lock:
            samples = self._samples.setdefault(stage, deque(maxlen=self._sample_limit))
            samples.append(duration_ms)
            if realtime_seconds and realtime_seconds > 0:
                rtf_samples = self._rtf_samples.setdefault(stage, deque(maxlen=self._sample_limit))
                rtf_samples.append((duration_ms / 1_000.0) / realtime_seconds)

    def snapshot(self) -> dict[str, Any]:
        """Return compact rolling summaries safe to include in metrics payloads."""
        with self._lock:
            stages = {}
            for stage, samples in self._samples.items():
                if not samples:
                    continue
                ordered = sorted(samples)
                summary: dict[str, Any] = {
                    "count": len(ordered),
                    "mean_ms": round(sum(ordered) / len(ordered), 3),
                    "p50_ms": round(self._percentile(ordered, 0.50), 3),
                    "p95_ms": round(self._percentile(ordered, 0.95), 3),
                    "p99_ms": round(self._percentile(ordered, 0.99), 3),
                    "max_ms": round(ordered[-1], 3),
                }
                rtf_samples = self._rtf_samples.get(stage)
                if rtf_samples:
                    ordered_rtf = sorted(rtf_samples)
                    summary["p95_rtf"] = round(self._percentile(ordered_rtf, 0.95), 4)
                stages[stage] = summary
        return {"stages": stages}

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float:
        """Return nearest-rank percentile for the bounded rolling sample set."""
        index = max(0, min(len(values) - 1, ceil(len(values) * percentile) - 1))
        return values[index]
