# Ground Station - SSTV Decoder v2 (Process-based with integrated FM demodulation)
# Developed by Claude (Anthropic AI) for the Ground Station project
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

import base64
import io
import json
import logging
import os
import queue
import time
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from typing import Any, Callable, Dict

import numpy as np
import psutil
from PIL import Image
from scipy import signal
from scipy.signal.windows import hann

# Optional process title support (parity with other decoders)
try:
    import setproctitle

    HAS_SETPROCTITLE = True
except Exception:
    HAS_SETPROCTITLE = False

from demodulators.basedecoderprocess import BaseDecoderProcess
from demodulators.sstvdsp import AudioResampler, ToneData

logger = logging.getLogger("sstvdecoder")


class DecoderStatus(Enum):
    """Decoder status values."""

    IDLE = "idle"
    LISTENING = "listening"
    CAPTURING = "capturing"
    PROCESSING = "processing"
    SLEEPING = "sleeping"  # VFO out of SDR bandwidth
    COMPLETED = "completed"
    ERROR = "error"


class SSTVMode(Enum):
    """SSTV mode definitions"""

    SCOTTIE_S1 = {
        "vis_code": 60,
        "name": "Scottie 1",
        "width": 320,
        "height": 256,
        "sync_pulse": 0.009,
        "sync_porch": 0.0015,
        "sep_pulse": 0.0015,
        "scan_time": 0.138240,
        "pixel_time": 0.138240 / 320,
        "chan_count": 3,
        "chan_sync": 2,
        "color_mode": "GBR",
        "window_factor": 3.82,
        "line_time": 0.009 + 3 * (0.0015 + 0.138240),
    }

    MARTIN_M1 = {
        "vis_code": 44,
        "name": "Martin 1",
        "width": 320,
        "height": 256,
        "sync_pulse": 0.004862,
        "sync_porch": 0.000572,
        "sep_pulse": 0.000572,
        "scan_time": 0.146432,
        "pixel_time": 0.146432 / 320,
        "chan_count": 3,
        "chan_sync": 0,
        "color_mode": "GBR",
        "window_factor": 3.82,
        "line_time": 0.004862 + 0.000572 + 3 * (0.000572 + 0.146432),
    }

    ROBOT_36 = {
        "vis_code": 8,
        "name": "Robot 36",
        "width": 320,
        "height": 240,
        "sync_pulse": 0.009,
        "sync_porch": 0.003,
        "sep_pulse": 0.004500,
        "sep_porch": 0.001500,
        "scan_time": 0.088,
        "half_scan_time": 0.044,
        "pixel_time": 0.088 / 320,
        "chan_count": 2,
        "chan_sync": 0,
        "color_mode": "YUV",
        "window_factor": 7.70,
        "line_time": 0.009 + 0.003 + (0.004500 + 0.088) + 0.001500 + 0.044,
    }

    SCOTTIE_S2 = {
        "vis_code": 56,
        "name": "Scottie 2",
        "width": 320,
        "height": 256,
        "sync_pulse": 0.009,
        "sync_porch": 0.0015,
        "sep_pulse": 0.0015,
        "scan_time": 0.088064,
        "pixel_time": 0.088064 / 320,
        "chan_count": 3,
        "chan_sync": 2,
        "color_mode": "GBR",
        "window_factor": 3.82,
        "line_time": 0.009 + 3 * (0.0015 + 0.088064),
    }

    SCOTTIE_DX = {
        "vis_code": 76,
        "name": "Scottie DX",
        "width": 320,
        "height": 256,
        "sync_pulse": 0.009,
        "sync_porch": 0.0015,
        "sep_pulse": 0.0015,
        "scan_time": 0.345600,
        "pixel_time": 0.345600 / 320,
        "chan_count": 3,
        "chan_sync": 2,
        "color_mode": "GBR",
        "window_factor": 3.82,
        "line_time": 0.009 + 3 * (0.0015 + 0.345600),
    }

    WRAASE_SC2_180 = {
        "vis_code": 55,
        "name": "Wraase SC2-180",
        "width": 320,
        "height": 256,
        "sync_pulse": 0.009,
        "sync_porch": 0.0015,
        "sep_pulse": 0.0015,
        "scan_time": 0.235,
        "pixel_time": 0.235 / 320,
        "chan_count": 3,
        "chan_sync": 2,
        "color_mode": "GBR",
        "window_factor": 3.82,
        "line_time": 0.009 + 3 * (0.0015 + 0.235),
    }

    MARTIN_M2 = {
        "vis_code": 40,
        "name": "Martin 2",
        "width": 320,
        "height": 256,
        "sync_pulse": 0.004862,
        "sync_porch": 0.000572,
        "sep_pulse": 0.000572,
        "scan_time": 0.073216,
        "pixel_time": 0.073216 / 320,
        "chan_count": 3,
        "chan_sync": 0,
        "color_mode": "GBR",
        "window_factor": 3.82,
        "line_time": 0.004862 + 0.000572 + 3 * (0.000572 + 0.073216),
    }


SSTV_FORCED_MODES = {
    "robot36": SSTVMode.ROBOT_36,
    "martin_m1": SSTVMode.MARTIN_M1,
    "martin_m2": SSTVMode.MARTIN_M2,
    "scottie_s1": SSTVMode.SCOTTIE_S1,
    "scottie_s2": SSTVMode.SCOTTIE_S2,
    "scottie_dx": SSTVMode.SCOTTIE_DX,
    "wraase_sc2_180": SSTVMode.WRAASE_SC2_180,
}


def resolve_forced_mode(configured_mode: Any) -> SSTVMode | None:
    """Resolve a configured mode key, reserving ``auto`` for VIS detection."""
    normalized_mode = str(configured_mode or "auto").strip().lower()
    if normalized_mode == "auto":
        return None

    forced_mode = SSTV_FORCED_MODES.get(normalized_mode)
    if forced_mode is None:
        supported = ", ".join(sorted(SSTV_FORCED_MODES))
        raise ValueError(
            f"Unsupported forced SSTV mode '{normalized_mode}'. Supported modes: {supported}"
        )
    return forced_mode


# VIS code constants
VIS_BIT_SIZE = 0.030
BREAK_OFFSET = 0.300
LEADER_OFFSET = 0.010 + BREAK_OFFSET
VIS_START_OFFSET = 0.300 + LEADER_OFFSET
HDR_SIZE = 0.030 + VIS_START_OFFSET
HDR_WINDOW_SIZE = 0.010


def calc_lum(freq):
    """Converts SSTV pixel frequency range into 0-255 luminance byte"""
    lum = int(round((freq - 1500) / 3.1372549))
    return min(max(lum, 0), 255)


class SSTVDecoder(BaseDecoderProcess):
    """Process-based SSTV decoder with integrated FM demodulation"""

    def __init__(
        self,
        iq_queue,
        data_queue,
        session_id,
        config,  # Pre-resolved DecoderConfig from DecoderConfigService (contains all params + metadata)
        vfo=None,
        sample_rate=44100,
        output_dir="data/decoded",
        **kwargs,
    ):
        super().__init__(
            iq_queue=iq_queue,
            data_queue=data_queue,
            session_id=session_id,
            config=config,
            output_dir=output_dir,
            vfo=vfo,
        )

        self.audio_sample_rate = sample_rate
        self._progress_callback: Callable[[int, int, str], None] | None = None
        self.audio_buffer = np.array([], dtype=np.float32)
        self.mode: SSTVMode | None = None
        self.forced_mode: SSTVMode | None = resolve_forced_mode(
            getattr(config, "sstv_mode", "auto")
        )

        # Extract satellite and transmitter metadata from config (same pattern as FSKDecoder)
        self.satellite = config.satellite or {}
        self.transmitter = config.transmitter or {}

        # FM demodulator state
        self.last_sample = None
        self.sdr_sample_rate = None
        self.decimation_filter = None
        self.audio_filter = None
        self._reset_stream()

        # Cached VFO state from IQ messages
        self.cached_vfo_state = None

        # Sleeping state when VFO is out of SDR bandwidth
        self.is_sleeping = False
        self.sleep_reason = None

        os.makedirs(self.output_dir, exist_ok=True)
        mode_name = (
            f"{self.forced_mode.value['name']} (forced)"
            if self.forced_mode is not None
            else "Auto-detect (VIS)"
        )
        logger.info(
            f"SSTV decoder v2 initialized for session {session_id}, VFO {vfo}, mode: {mode_name}"
        )

        # Log satellite and transmitter details for testing/debugging
        if self.satellite:
            logger.info(f"Satellite details: {self.satellite}")
        else:
            logger.info("No satellite details provided")

        if self.transmitter:
            logger.info(f"Transmitter details: {self.transmitter}")
        else:
            logger.info("No transmitter details provided")

    def _get_decoder_type_for_init(self) -> str:
        return "SSTV"

    # ========== FM Demodulation Methods (copied from FMDemodulator) ==========

    def _frequency_translate(self, samples, offset_freq, sample_rate):
        """Tune IQ while preserving oscillator phase across chunks and retunes."""
        phase = getattr(self, "_tuning_phase", 0.0)
        step = -2 * np.pi * offset_freq / sample_rate
        shift = np.exp(1j * (phase + step * np.arange(len(samples))))
        self._tuning_phase = (phase + step * len(samples)) % (2 * np.pi)
        return samples * shift

    def _design_decimation_filter(self, sdr_rate, bandwidth):
        """Design cascaded decimation filters for efficient multi-stage decimation."""
        target_rate = 200e3
        total_decimation = int(sdr_rate / target_rate)
        total_decimation = max(1, total_decimation)

        stages = []

        if total_decimation <= 10:
            nyquist = sdr_rate / 2.0
            cutoff = bandwidth / 2.0
            normalized_cutoff = min(0.4, cutoff / nyquist)
            b, a = signal.butter(4, normalized_cutoff, btype="low")
            stages.append(((b, a), total_decimation))
        else:
            stage1_decimation = 5
            nyquist1 = sdr_rate / 2.0
            cutoff1 = (sdr_rate / stage1_decimation) * 0.4
            normalized_cutoff1 = min(0.4, max(0.01, cutoff1 / nyquist1))
            b1, a1 = signal.butter(4, normalized_cutoff1, btype="low")
            stages.append(((b1, a1), stage1_decimation))

            stage2_decimation = total_decimation // stage1_decimation
            if stage2_decimation > 1:
                rate_after_stage1 = sdr_rate / stage1_decimation
                nyquist2 = rate_after_stage1 / 2.0
                cutoff2 = min(bandwidth / 2.0, (rate_after_stage1 / stage2_decimation) * 0.4)
                normalized_cutoff2 = min(0.4, cutoff2 / nyquist2)
                b2, a2 = signal.butter(4, normalized_cutoff2, btype="low")
                stages.append(((b2, a2), stage2_decimation))

        # The requested factor need not be divisible by the first stage's factor.
        return stages, int(np.prod([factor for _, factor in stages]))

    def _reset_stream(self):
        """Forget DSP and capture state after a gap or a receiver reconfiguration."""
        pending = getattr(self, "_frame_future", None)
        if pending is not None:
            pending.cancel()
        self._frame_future = None
        self._stream_generation = getattr(self, "_stream_generation", 0) + 1
        self._tuning_phase = 0.0
        self.last_sample = None
        self.sdr_sample_rate = None
        self._stream_bandwidth = None
        self._expected_sample = None
        self._stream_center = None
        self._tone_offset = 0.0
        self._tone_cache = None
        self._capture_duration = None
        self.audio_buffer = np.empty(0, dtype=np.float32)
        self.mode = None

    def _process_iq_audio(self, samples, sdr_rate, bandwidth, offset):
        """Stateful RF FM demodulation and conversion to the audio sample clock."""
        if self.sdr_sample_rate != sdr_rate or self._stream_bandwidth != bandwidth:
            self._reset_stream()
            self.sdr_sample_rate = sdr_rate
            self._stream_bandwidth = bandwidth
            stages, factor = self._design_decimation_filter(sdr_rate, bandwidth)
            self.decimation_filter = stages, factor
            self._decimation_states = [
                np.zeros(max(len(a), len(b)) - 1, complex) for (b, a), _ in stages
            ]
            self._decimation_phases = [0] * len(stages)
            intermediate_rate = sdr_rate / factor
            self.audio_filter = self._design_audio_filter(intermediate_rate, bandwidth)
            self._audio_state = np.zeros(len(self.audio_filter) - 1)
            self._resampler = AudioResampler(intermediate_rate, self.audio_sample_rate)
            logger.info(
                "SSTV DSP: SDR=%s Hz, decimation=%s, RF bandwidth=%s Hz",
                sdr_rate,
                factor,
                bandwidth,
            )

        assert self.decimation_filter is not None
        assert self.audio_filter is not None
        decimated = self._frequency_translate(samples, offset, sdr_rate)
        for index, ((b, a), factor) in enumerate(self.decimation_filter[0]):
            if not len(decimated):
                return np.empty(0, dtype=np.float32)
            filtered, self._decimation_states[index] = signal.lfilter(
                b, a, decimated, zi=self._decimation_states[index]
            )
            phase = self._decimation_phases[index]
            self._decimation_phases[index] = (phase - len(filtered)) % factor
            decimated = filtered[phase::factor]
        if not len(decimated):
            return np.empty(0, dtype=np.float32)
        demodulated = self._fm_demodulate(decimated)
        audio, self._audio_state = signal.lfilter(
            self.audio_filter, [1.0], demodulated, zi=self._audio_state
        )
        # SSTV is data carried by audio tones; broadcast FM de-emphasis is inappropriate here.
        return self._resampler.process(audio).astype(np.float32)

    def _design_audio_filter(self, intermediate_rate, vfo_bandwidth):
        """Design audio low-pass filter based on VFO bandwidth."""
        if vfo_bandwidth < 25e3:
            cutoff = min(3e3, vfo_bandwidth * 0.3)
        elif vfo_bandwidth < 100e3:
            cutoff = vfo_bandwidth * 0.15
        else:
            cutoff = min(15e3, vfo_bandwidth * 0.15)

        # Keep SSTV tone range (1200-2300 Hz) intact even if VFO BW is small.
        cutoff = max(cutoff, 3000)
        nyquist = intermediate_rate / 2.0
        normalized_cutoff = cutoff / nyquist
        normalized_cutoff = min(0.45, max(0.01, normalized_cutoff))

        numtaps = 101
        filter_taps = signal.firwin(numtaps, normalized_cutoff, window="hamming")
        return filter_taps

    def _is_vfo_in_sdr_bandwidth(self, vfo_center, sdr_center, sdr_sample_rate):
        """
        Check if VFO center frequency is within SDR bandwidth (with small edge margin).

        Returns tuple: (is_in_band, offset_from_sdr_center, margin_hz)
        """
        offset = vfo_center - sdr_center
        half_sdr_bandwidth = sdr_sample_rate / 2
        usable_bandwidth = half_sdr_bandwidth * 0.98  # 2% margin for roll-off
        is_in_band = abs(offset) <= usable_bandwidth
        margin_hz = usable_bandwidth - abs(offset)
        return is_in_band, offset, margin_hz

    def _fm_demodulate(self, samples):
        """Demodulate FM using phase differentiation."""
        diff = samples[1:] * np.conj(samples[:-1])
        demodulated = np.angle(diff)

        if self.last_sample is not None:
            first_diff = samples[0] * np.conj(self.last_sample)
            demodulated = np.concatenate(([np.angle(first_diff)], demodulated))
        else:
            demodulated = np.concatenate(([0], demodulated))

        self.last_sample = samples[-1]
        return demodulated

    def _send_status_update(self, status, mode_name=None, info=None):
        """Send status update to UI"""
        # Build decoder configuration info (clear FSK-specific fields)
        config_info = {
            "baudrate": None,  # SSTV doesn't use baudrate
            "deviation_hz": None,  # SSTV doesn't use deviation
            "framing": None,  # SSTV doesn't use framing
            "transmitter": (
                self.cached_vfo_state.get("transmitter_description", "VFO Signal")
                if self.cached_vfo_state
                else "VFO Signal"
            ),
            "transmitter_mode": "SSTV",
            "transmitter_downlink_mhz": (
                round(self.cached_vfo_state.get("center_freq", 0) / 1e6, 3)
                if self.cached_vfo_state
                else None
            ),
            "packets_decoded": None,  # SSTV decodes images, not packets
            "signal_power_dbfs": None,
            "signal_power_avg_dbfs": None,
            "signal_power_max_dbfs": None,
            "signal_power_min_dbfs": None,
            "buffer_samples": None,
        }

        # Merge with any additional info passed in
        if info:
            config_info.update(info)

        msg = {
            "type": "decoder-status",
            "decoder_id": self.decoder_id,
            "status": status.value,
            "mode": mode_name,
            "decoder_type": "sstv",
            "session_id": self.session_id,
            "vfo": self.vfo,
            "timestamp": time.time(),
            "info": config_info,
        }
        try:
            self.data_queue.put(msg, block=False)
            with self.stats_lock:
                self.stats["data_messages_out"] = int(self.stats.get("data_messages_out") or 0) + 1
        except queue.Full:
            logger.warning("Data queue full, dropping status update")

    def _send_stats_update(self):
        """Send statistics update to UI and performance monitor"""
        # Full performance stats for monitoring (thread-safe copy)
        with self.stats_lock:
            perf_stats: Dict[str, Any] = self.stats.copy()
            ingest_sps = perf_stats.get("ingest_samples_per_sec", 0.0)
            ingest_cps = perf_stats.get("ingest_chunks_per_sec", 0.0)

        # UI-friendly stats (include ingest rates so UI can display flow even when sleeping)
        ui_stats = {
            "images_decoded": self.stats.get("images_decoded", 0),
            "audio_sample_rate": self.audio_sample_rate,
            "is_sleeping": getattr(self, "is_sleeping", False),
            # Coerce possibly None values to float before rounding/dividing for mypy safety
            "ingest_samples_per_sec": round(float(ingest_sps or 0.0), 1),
            "ingest_chunks_per_sec": round(float(ingest_cps or 0.0), 2),
            "ingest_kSps": round(float(ingest_sps or 0.0) / 1e3, 2),
        }

        # Add sleeping state to performance stats
        perf_stats["is_sleeping"] = getattr(self, "is_sleeping", False)

        # Compute authoritative 1 Hz rates at the decoder side (no smoothing)
        # Initialize prev holders on first use
        if not hasattr(self, "_rates_prev_ts"):
            self._rates_prev_ts = None
            self._rates_prev_counters = {
                "iq_chunks_in": 0,
                # SSTVDecoder tracks iq_samples_in
                "samples_in": 0,
                "data_messages_out": 0,
            }

        now_ts = time.time()
        prev_ts = self._rates_prev_ts
        dt: float | None
        if prev_ts is None:
            dt = None
        else:
            dt = now_ts - float(prev_ts)
        try:
            curr_iq_chunks = int(perf_stats.get("iq_chunks_in", 0) or 0)
            curr_samples = int(
                perf_stats.get("samples_in", 0) or perf_stats.get("iq_samples_in", 0) or 0
            )
            curr_msgs_out = int(perf_stats.get("data_messages_out", 0) or 0)

            if dt and dt > 0:
                rates = {
                    "iq_chunks_in_per_sec": (
                        curr_iq_chunks - self._rates_prev_counters.get("iq_chunks_in", 0)
                    )
                    / dt,
                    "samples_in_per_sec": (
                        curr_samples - self._rates_prev_counters.get("samples_in", 0)
                    )
                    / dt,
                    "data_messages_out_per_sec": (
                        curr_msgs_out - self._rates_prev_counters.get("data_messages_out", 0)
                    )
                    / dt,
                }
            else:
                rates = {
                    "iq_chunks_in_per_sec": 0.0,
                    "samples_in_per_sec": 0.0,
                    "data_messages_out_per_sec": 0.0,
                }
        except Exception:
            rates = {
                "iq_chunks_in_per_sec": 0.0,
                "samples_in_per_sec": 0.0,
                "data_messages_out_per_sec": 0.0,
            }

        # Mirror rates into perf_stats for persistence/consumers
        perf_stats["rates"] = rates

        # Update previous snapshot for next tick
        self._rates_prev_ts = now_ts
        self._rates_prev_counters = {
            "iq_chunks_in": int(perf_stats.get("iq_chunks_in", 0) or 0),
            "samples_in": int(
                perf_stats.get("samples_in", 0) or perf_stats.get("iq_samples_in", 0) or 0
            ),
            "data_messages_out": int(perf_stats.get("data_messages_out", 0) or 0),
        }

        msg = {
            "type": "decoder-stats",
            "decoder_type": "sstv",
            "session_id": self.session_id,
            "vfo": self.vfo,
            "timestamp": time.time(),
            "stats": ui_stats,  # UI-friendly stats
            "perf_stats": perf_stats,  # Full performance stats for PerformanceMonitor
            "rates": rates,  # Authoritative rates computed at decoder side
        }
        try:
            self.data_queue.put(msg, block=False)
            with self.stats_lock:
                self.stats["data_messages_out"] = int(self.stats.get("data_messages_out") or 0) + 1
        except queue.Full:
            pass

    # ========== SSTV Decode Methods (from original sstvdecoder.py) ==========

    def _peak_fft_freq(self, data):
        """Estimate header tones with a band-limited, interpolated Hann spectrum."""
        if len(data) < 4:
            return 0.0
        centered = np.asarray(data) - np.mean(data)
        if np.max(np.abs(centered)) < 1e-9:
            return 0.0
        size = max(4096, 1 << (len(data) - 1).bit_length())
        spectrum = np.abs(np.fft.rfft(centered * hann(len(data)), n=size))
        first = max(1, int(850 * size / self.audio_sample_rate))
        stop = min(len(spectrum) - 1, int(2800 * size / self.audio_sample_rate))
        peak = first + int(np.argmax(spectrum[first:stop]))
        # Parabolic interpolation of a densely sampled log spectrum avoids coarse-bin bias.
        left, centre, right = np.log(np.maximum(spectrum[peak - 1 : peak + 2], 1e-30))
        curvature = left - 2 * centre + right
        correction = 0.5 * (left - right) / curvature if curvature else 0.0
        return (peak + np.clip(correction, -0.5, 0.5)) * self.audio_sample_rate / size

    def _find_header(self):
        """Find SSTV calibration header"""
        header_size = round(HDR_SIZE * self.audio_sample_rate)
        window_size = round(HDR_WINDOW_SIZE * self.audio_sample_rate)

        leader_1_search = window_size
        break_sample = round(BREAK_OFFSET * self.audio_sample_rate)
        break_search = break_sample + window_size
        leader_2_sample = round(LEADER_OFFSET * self.audio_sample_rate)
        leader_2_search = leader_2_sample + window_size
        vis_start_sample = round(VIS_START_OFFSET * self.audio_sample_rate)
        vis_start_search = vis_start_sample + window_size

        jump_size = round(0.002 * self.audio_sample_rate)

        for current_sample in range(0, len(self.audio_buffer) - header_size, jump_size):
            search_end = current_sample + header_size
            search_area = self.audio_buffer[current_sample:search_end]

            leader_1_area = search_area[0:leader_1_search]
            break_area = search_area[break_sample:break_search]
            leader_2_area = search_area[leader_2_sample:leader_2_search]
            vis_start_area = search_area[vis_start_sample:vis_start_search]

            leader = self._peak_fft_freq(leader_1_area)
            if abs(leader - 1900) > 100:
                continue
            second_leader = self._peak_fft_freq(leader_2_area)
            offset = (leader + second_leader) / 2 - 1900
            if (
                abs(second_leader - leader) < 25
                and abs(self._peak_fft_freq(break_area) - 1200 - offset) < 40
                and abs(self._peak_fft_freq(vis_start_area) - 1200 - offset) < 40
            ):
                self._tone_offset = offset
                return current_sample + header_size
        return None

    def _decode_vis(self, vis_start):
        """Decode VIS code"""
        bit_size = round(VIS_BIT_SIZE * self.audio_sample_rate)
        vis_bits = []
        vis_freqs = []

        offset = getattr(self, "_tone_offset", 0.0)
        margin = round(0.006 * self.audio_sample_rate)
        for bit_idx in range(8):
            bit_offset = vis_start + bit_idx * bit_size
            section = self.audio_buffer[bit_offset + margin : bit_offset + bit_size - margin]
            freq = self._peak_fft_freq(section) - offset
            if min(abs(freq - 1100), abs(freq - 1300)) > 45:
                return None
            vis_freqs.append(freq)
            vis_bits.append(int(freq < 1200))

        parity = sum(vis_bits) % 2 == 0
        if not parity:
            logger.warning(f"VIS parity error, bits: {vis_bits}")
            return None

        stop = vis_start + 8 * bit_size
        if (
            abs(
                self._peak_fft_freq(self.audio_buffer[stop + margin : stop + bit_size - margin])
                - offset
                - 1200
            )
            > 45
        ):
            return None

        vis_value = 0
        for bit in vis_bits[6::-1]:
            vis_value = (vis_value << 1) | bit

        for mode in SSTVMode:
            if mode.value["vis_code"] == vis_value:
                mode_spec = mode.value
                logger.info(f"Detected: {mode_spec['name']} (VIS: {vis_value})")
                return mode

        logger.error(f"Unsupported VIS: {vis_value}")
        return None

    def _select_mode(self, vis_start):
        """Use the configured forced mode or detect the transmitted VIS mode."""
        if self.forced_mode is not None:
            logger.info(
                f"Using forced SSTV mode {self.forced_mode.value['name']}; ignoring transmitted VIS"
            )
            return self.forced_mode
        return self._decode_vis(vis_start)

    def _tones(self):
        """Cache the frequency trace only while this exact audio buffer is in use."""
        cached = getattr(self, "_tone_cache", None)
        if cached is None or cached[0] is not self.audio_buffer:
            cached = self.audio_buffer, ToneData(self.audio_buffer, self.audio_sample_rate)
            self._tone_cache = cached
        return cached[1]

    def _align_sync(self, align_start, start_of_sync=True):
        """Find a qualified pulse close to the expected boundary, or report no lock."""
        if self.mode is None or not len(self.audio_buffer):
            return None
        duration = self.mode.value["sync_pulse"]
        samples = duration * self.audio_sample_rate
        starts, ends = self._tones().sync_pulses(duration, getattr(self, "_tone_offset", 0.0))
        # VIS stop and the first image sync can form one long 1200 Hz interval.
        first_sync = (starts <= align_start) & (ends > align_start)
        valid = ((ends - starts) < samples * 1.6) | first_sync
        distance = np.abs(ends - samples - align_start)
        valid &= distance < 0.018 * self.audio_sample_rate
        if not np.any(valid):
            return None
        end = ends[np.flatnonzero(valid)[np.argmin(distance[valid])]]
        return round(end - samples) if start_of_sync else int(end)

    def _decode_robot(self, image_start):
        """Decode Robot 36 using line timing and the transmitted Cr/Cb identifiers."""
        assert self.mode is SSTVMode.ROBOT_36
        mode = self.mode.value
        rate = self.audio_sample_rate
        tones = self._tones()
        offset = getattr(self, "_tone_offset", 0.0)
        nominal = mode["line_time"] * rate
        sync = mode["sync_pulse"] * rate
        starts, ends = tones.sync_pulses(mode["sync_pulse"], offset)
        widths = ends - starts
        # Include the first sync when it is contiguous with the VIS stop bit.
        valid = (widths < sync * 1.6) | (
            (starts <= image_start) & (np.abs(ends - image_start - sync) < 0.012 * rate)
        )
        ends = ends[valid]
        height, width = mode["height"], mode["width"]
        line_positions = []
        matches = []
        period = nominal
        predicted = image_start
        previous = None
        for line in range(height):
            distance = np.abs(ends - sync - predicted)
            if len(distance) and np.min(distance) < 0.018 * rate:
                position = float(ends[np.argmin(distance)] - sync)
                matches.append((line, position))
                if previous is not None:
                    old_line, old_position = previous
                    measured = (position - old_position) / (line - old_line)
                    period = np.clip(0.8 * period + 0.2 * measured, nominal * 0.99, nominal * 1.01)
                previous = line, position
            else:
                # A missing pulse keeps its place in the picture; it must not swap chroma.
                position = predicted
            line_positions.append(position)
            predicted = position + period

        if len(matches) >= 4:
            indices, positions = np.array(matches).T
            period, origin = np.polyfit(indices, positions, 1)
            if abs(period / nominal - 1) < 0.01:
                # Fitting the sample clock avoids content-dependent per-line edge jitter.
                line_positions = origin + np.arange(height) * period
            else:
                period = nominal

        scans = np.zeros((height, width))
        chroma = np.full((height, width), 128.0)
        roles = np.empty(height, dtype=int)  # 0 = Cr, 1 = Cb
        available = np.zeros(height, dtype=bool)
        for line, position in enumerate(line_positions):
            if line % 5 == 0:
                self._send_progress_update(line, height, mode["name"])
            scale = period / nominal
            y_start = position + (mode["sync_pulse"] + mode["sync_porch"]) * rate * scale
            separator = y_start + mode["scan_time"] * rate * scale
            c_start = separator + (mode["sep_pulse"] + mode["sep_porch"]) * rate * scale
            c_end = c_start + mode["half_scan_time"] * rate * scale
            roles[line] = 1 - roles[line - 1] if line else 0
            if c_end > len(self.audio_buffer):
                continue
            # Measure in the centre of each known tone, away from filter transients.
            first, stop = int(position + 0.002 * rate), int(position + 0.007 * rate)
            if 0 <= first < stop <= len(tones.frequency):
                correction = float(np.median(tones.frequency[first:stop])) - 1200
                if abs(correction - offset) < 60:
                    line_offset = correction
                else:
                    line_offset = offset
            else:
                line_offset = offset
            first, stop = int(separator + 0.0015 * rate), int(separator + 0.003 * rate)
            identifier = float(np.median(tones.frequency[first:stop])) - line_offset
            if abs(identifier - 1500) < 150:
                roles[line] = 0
            elif abs(identifier - 2300) < 150:
                roles[line] = 1
            scans[line] = tones.level(y_start, separator, width, line_offset, default=0)
            chroma[line] = tones.level(c_start, c_end, width, line_offset)
            available[line] = True

        image_data = np.full((height, 3, width), 128.0)
        image_data[:, 0] = scans
        for line in range(height):
            for role, channel in [(0, 2), (1, 1)]:
                candidates = np.flatnonzero((roles == role) & available)
                if not len(candidates):
                    continue
                # Prefer the following Cb for Cr and the preceding Cr for Cb.
                target = line if roles[line] == role else line + (1 if role == 1 else -1)
                nearest = candidates[np.argmin(np.abs(candidates - target))]
                if abs(nearest - line) <= 2:
                    image_data[line, channel] = chroma[nearest]
        self._decoded_end_pos = round(float(line_positions[-1]) + period)
        return image_data

    def _send_progress_update(self, current_line, total_lines, mode_name):
        """Send decoding progress update to UI"""
        callback = getattr(self, "_progress_callback", None)
        if callback is not None:
            callback(current_line, total_lines, mode_name)
            return
        progress = int((current_line / total_lines) * 100)
        msg = {
            "type": "decoder-progress",
            "decoder_id": self.decoder_id,
            "progress": progress,
            "session_id": self.session_id,
            "vfo": self.vfo,
            "timestamp": time.time(),
            "info": {"current_line": current_line, "total_lines": total_lines, "mode": mode_name},
        }
        try:
            self.data_queue.put(msg, block=False)
            with self.stats_lock:
                self.stats["data_messages_out"] = int(self.stats.get("data_messages_out") or 0) + 1
        except queue.Full:
            logger.warning("Data queue full, dropping progress update")

    def _decode_image_data(self, image_start):
        """Decode Robot scans or the existing GBR mode layout."""
        if self.mode is None:
            return None
        if self.mode is SSTVMode.ROBOT_36:
            return self._decode_robot(image_start)
        mode = self.mode.value
        rate = self.audio_sample_rate
        width, height = mode["width"], mode["height"]
        image_data = np.zeros((height, 3, width), dtype=np.uint8)
        channel_time = mode["sep_pulse"] + mode["scan_time"]
        first = mode["sync_pulse"] + mode["sync_porch"]
        offsets = [first, first + channel_time, first + 2 * channel_time]
        seq_start = image_start
        if mode["chan_sync"] == 2:
            offsets = [offsets[1], offsets[2], offsets[0]]
            aligned = self._align_sync(image_start, start_of_sync=False)
            if aligned is not None:
                seq_start = aligned
        for line in range(height):
            if line % 5 == 0:
                self._send_progress_update(line, height, mode["name"])
            if mode["chan_sync"] == 2 and line == 0:
                seq_start -= round((offsets[2] + mode["scan_time"]) * rate)
            for channel in range(3):
                if channel == mode["chan_sync"]:
                    if line or channel:
                        seq_start += round(mode["line_time"] * rate)
                    aligned = self._align_sync(seq_start)
                    # An unqualified pulse uses predicted timing rather than searching into pixels.
                    if aligned is not None:
                        seq_start = aligned
                start = seq_start + offsets[channel] * rate
                stop = start + mode["scan_time"] * rate
                image_data[line, channel] = np.rint(
                    self._tones().level(
                        start, stop, width, getattr(self, "_tone_offset", 0.0), default=0
                    )
                ).astype(np.uint8)
        self._decoded_end_pos = round(image_start + self._image_duration() * rate)
        return image_data

    def _draw_image(self, image_data):
        """Render decoded channels without discarding right-edge chroma."""
        if self.mode is None or image_data is None:
            return None
        data = np.asarray(image_data, dtype=np.float64)
        if self.mode is SSTVMode.ROBOT_36:
            y, cb, cr = data[:, 0], data[:, 1] - 128, data[:, 2] - 128
            # Full-range BT.601 agrees with the existing receiver and QSSTV convention.
            rgb = np.stack(
                (y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb), axis=-1
            )
        else:
            rgb = data[:, [2, 0, 1]].transpose(0, 2, 1)
        return Image.fromarray(np.rint(rgb).clip(0, 255).astype(np.uint8))

    def _image_duration(self):
        """Use each mode's real line layout, including Scottie's initial sync."""
        assert self.mode is not None
        mode: Dict[str, Any] = self.mode.value
        return mode["height"] * mode["line_time"] + (
            mode["sync_pulse"] if mode["chan_sync"] == 2 else 0
        )

    def _forced_robot_start(self):
        """Acquire a forced Robot capture from a qualified train without a VIS header."""
        if (
            self.forced_mode is not SSTVMode.ROBOT_36
            or len(self.audio_buffer) < self.audio_sample_rate
        ):
            return None
        rate = self.audio_sample_rate
        tones = self._tones()
        starts, ends = tones.sync_pulses(0.009)
        ends = ends[(ends - starts) < 0.014 * rate]
        for index in range(len(ends) - 3):
            train = ends[index : index + 4]
            if np.max(np.abs(np.diff(train) / rate - 0.15)) > 0.002:
                continue
            start = int(train[0] - 0.009 * rate)
            identifier = tones.frequency[int(start + 0.1015 * rate) : int(start + 0.103 * rate)]
            if not len(identifier):
                continue
            marker = float(np.median(identifier))
            if min(abs(marker - 1500), abs(marker - 2300)) < 100:
                return max(0, start)
        return None

    def _consume_audio_buffer(self):
        """Process one frame and retain all following audio for the next acquisition."""
        pending = self._frame_future
        if pending is not None:
            if not pending.done():
                return False
            image, end = pending.result()
            self._frame_future = None
            self._finish_frame(image, end)
            return True
        if len(self.audio_buffer) < self.audio_sample_rate:
            return False
        if self.mode is None:
            header_end = self._find_header()
            if header_end is None:
                image_start = self._forced_robot_start()
                if image_start is None:
                    maximum = round(self.audio_sample_rate * 2)
                    if len(self.audio_buffer) > maximum:
                        self.audio_buffer = self.audio_buffer[-maximum:].copy()
                        self._tone_cache = None
                    return False
                self.mode = self.forced_mode
                self._tone_offset = 0.0
            else:
                image_start = header_end + round(VIS_BIT_SIZE * 9 * self.audio_sample_rate)
                if image_start > len(self.audio_buffer):
                    return False
                self.mode = self._select_mode(header_end)
                if self.mode is None:
                    self.audio_buffer = self.audio_buffer[image_start:].copy()
                    self._tone_cache = None
                    return True
            self.decode_start_pos = image_start
            self.header_found_time = time.time()
            self._capture_duration = None
            assert self.mode is not None
            self._send_status_update(DecoderStatus.CAPTURING, self.mode.value["name"])
            self._send_progress_update(0, self.mode.value["height"], self.mode.value["name"])

        assert self.mode is not None
        duration = self._image_duration()
        if self.mode is SSTVMode.ROBOT_36:
            available = len(self.audio_buffer) - self.decode_start_pos
            if self._capture_duration is None and available >= self.audio_sample_rate * 1.5:
                # Learn the transmitter clock early, so a slower frame's tail is not cut off.
                begin = self.decode_start_pos
                stop = begin + round(self.audio_sample_rate * 1.5)
                tones = ToneData(self.audio_buffer[begin:stop], self.audio_sample_rate)
                starts, ends = tones.sync_pulses(0.009, self._tone_offset)
                ends = ends[ends - starts < 0.014 * self.audio_sample_rate]
                intervals = np.diff(ends) / self.audio_sample_rate
                intervals = intervals[np.abs(intervals / 0.15 - 1) < 0.01]
                if len(intervals) >= 3:
                    self._capture_duration = float(np.median(intervals)) * 240
            if self._capture_duration is not None:
                duration = self._capture_duration
        needed = round((duration + 0.03) * self.audio_sample_rate)
        if len(self.audio_buffer) - self.decode_start_pos < needed:
            if time.time() - self.header_found_time < duration + 2:
                return False
            logger.warning("Timeout waiting for SSTV frame; decoding available audio")
        self._send_status_update(DecoderStatus.PROCESSING, self.mode.value["name"])
        arguments = (
            self.audio_buffer,
            self.mode,
            self.decode_start_pos,
            self._tone_offset,
            self._stream_generation,
        )
        executor = getattr(self, "_frame_executor", None)
        if executor is not None:
            # The worker owns this immutable buffer; the receiver appends into a new array.
            self._frame_future = executor.submit(self._decode_frame, *arguments)
            return False
        image, end = self._decode_frame(*arguments)
        self._finish_frame(image, end)
        return True

    def _decode_frame(self, audio, mode, image_start, offset, generation):
        """Decode an isolated snapshot while the process continues ingesting IQ."""
        snapshot = SSTVDecoder.__new__(SSTVDecoder)
        snapshot.audio_buffer = audio
        snapshot.audio_sample_rate = self.audio_sample_rate
        snapshot.mode = mode
        snapshot._tone_offset = offset
        snapshot._tone_cache = None

        def progress(*arguments):
            # A cancelled capture must not overwrite progress for a new receiver state.
            if self._stream_generation == generation:
                self._send_progress_update(*arguments)

        snapshot._progress_callback = progress
        data = snapshot._decode_image_data(image_start)
        return snapshot._draw_image(data), snapshot._decoded_end_pos

    def _finish_frame(self, image, end):
        assert self.mode is not None
        name = self.mode.value["name"]
        self._send_progress_update(self.mode.value["height"], self.mode.value["height"], name)
        self._send_completed_image(image, name)
        with self.stats_lock:
            self.stats["images_decoded"] = int(self.stats.get("images_decoded") or 0) + 1

        consumed = min(len(self.audio_buffer), max(self.decode_start_pos, end))
        self.audio_buffer = self.audio_buffer[consumed:].copy()
        self._tone_cache = None
        self._tone_offset = 0.0
        self.mode = None
        self._send_status_update(DecoderStatus.LISTENING)

    def _send_completed_image(self, image, mode_name):
        """Save and send completed image to UI"""
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"sstv_{mode_name.replace(' ', '_')}_{timestamp}.png"
        filepath = os.path.join(self.output_dir, filename)
        image.save(filepath)
        logger.info(f"Saved: {filepath}")

        filesize = os.path.getsize(filepath)
        decode_timestamp = time.time()

        # Build metadata from cached VFO state
        metadata = {
            "image": {
                "filename": filename,
                "filepath": filepath,
                "format": "image/png",
                "width": image.width,
                "height": image.height,
                "mode": mode_name,
                "filesize": filesize,
                "timestamp": decode_timestamp,
                "timestamp_iso": time.strftime(
                    "%Y-%m-%dT%H:%M:%S%z", time.localtime(decode_timestamp)
                ),
            },
            "decoder": {
                "type": "sstv",
                "session_id": self.session_id,
                "mode": mode_name,
            },
            "signal": {
                "frequency_hz": (
                    self.cached_vfo_state.get("center_freq") if self.cached_vfo_state else None
                ),
                "frequency_mhz": (
                    self.cached_vfo_state.get("center_freq") / 1e6
                    if self.cached_vfo_state
                    else None
                ),
                "sample_rate_hz": self.audio_sample_rate,
            },
            "vfo": {
                "id": self.vfo,
                "center_freq_hz": (
                    self.cached_vfo_state.get("center_freq") if self.cached_vfo_state else None
                ),
                "center_freq_mhz": (
                    self.cached_vfo_state.get("center_freq") / 1e6
                    if self.cached_vfo_state
                    else None
                ),
                "bandwidth_hz": (
                    self.cached_vfo_state.get("bandwidth") if self.cached_vfo_state else None
                ),
                "bandwidth_khz": (
                    self.cached_vfo_state.get("bandwidth") / 1e3 if self.cached_vfo_state else None
                ),
                "active": self.cached_vfo_state.get("active") if self.cached_vfo_state else None,
            },
            "satellite": self.satellite if self.satellite else None,
            "transmitter": self.transmitter if self.transmitter else None,
        }

        metadata_filename = filename.replace(".png", ".json")
        metadata_filepath = os.path.join(self.output_dir, metadata_filename)
        with open(metadata_filepath, "w") as f:
            json.dump(metadata, f, indent=2)
        logger.info(f"Saved metadata: {metadata_filepath}")

        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        img_base64 = base64.b64encode(buffer.getvalue()).decode()

        msg = {
            "type": "decoder-output",
            "decoder_type": "sstv",
            "session_id": self.session_id,
            "vfo": self.vfo,
            "timestamp": decode_timestamp,
            "output": {
                "format": "image/png",
                "filename": filename,
                "filepath": filepath,
                "metadata_filename": metadata_filename,
                "metadata_filepath": metadata_filepath,
                "image_data": img_base64,
                "mode": mode_name,
                "width": image.width,
                "height": image.height,
                "filesize": filesize,
            },
        }
        try:
            self.data_queue.put(msg, block=False)
            with self.stats_lock:
                self.stats["data_messages_out"] = int(self.stats.get("data_messages_out") or 0) + 1
        except queue.Full:
            pass

    def run(self):
        """Main process loop - receives IQ, demodulates FM, decodes SSTV"""
        # Set process title for easier discovery via `ps`/`pgrep`
        if HAS_SETPROCTITLE:
            try:
                setproctitle.setproctitle(f"Ground Station - SSTV Decoder (VFO {self.vfo})")
            except Exception:
                pass
        logger.info(f"SSTV decoder v2 process started for {self.session_id}")

        # Initialize stats in subprocess
        self.stats = {
            "iq_chunks_in": 0,
            "iq_samples_in": 0,
            "audio_samples_generated": 0,
            "images_decoded": 0,
            "data_messages_out": 0,
            "queue_timeouts": 0,
            "last_activity": None,
            "errors": 0,
            "cpu_percent": 0.0,
            "memory_mb": 0.0,
            "memory_percent": 0.0,
            # Ingest-side flow metrics (updated every stats tick)
            "ingest_samples_per_sec": 0.0,
            "ingest_chunks_per_sec": 0.0,
            # Out-of-band accounting
            "samples_dropped_out_of_band": 0,
        }

        self._send_status_update(DecoderStatus.LISTENING)

        # CPU and memory monitoring
        process = psutil.Process()
        last_cpu_check = time.time()
        cpu_check_interval = 0.5  # Update CPU usage every 0.5 seconds

        # Stats tracking
        last_stats_time = time.time()
        stats_interval = 1.0  # Send stats every 1 second

        # Track ingest rates regardless of decoding state (in-band or out-of-band)
        ingest_window_start = time.time()
        ingest_samples_accum = 0
        ingest_chunks_accum = 0

        self._frame_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="sstv-frame")

        try:
            while self.running.value == 1:
                # Update CPU and memory usage periodically
                current_time = time.time()
                if current_time - last_cpu_check >= cpu_check_interval:
                    try:
                        cpu_percent = process.cpu_percent()
                        mem_info = process.memory_info()
                        memory_mb = mem_info.rss / (1024 * 1024)
                        memory_percent = process.memory_percent()

                        with self.stats_lock:
                            self.stats["cpu_percent"] = cpu_percent
                            self.stats["memory_mb"] = memory_mb
                            self.stats["memory_percent"] = memory_percent
                        last_cpu_check = current_time
                    except Exception as e:
                        logger.debug(f"Error updating CPU/memory usage: {e}")
                # Per-iteration work; ensure stats tick executes even on `continue`
                try:
                    # Read IQ samples from iq_queue
                    try:
                        iq_message = self.iq_queue.get(timeout=0.1)
                    except queue.Empty:
                        with self.stats_lock:
                            self.stats["queue_timeouts"] = (
                                int(self.stats.get("queue_timeouts") or 0) + 1
                            )
                        iq_message = None

                    if iq_message is None:
                        # nothing to process this iteration
                        pass
                    else:
                        with self.stats_lock:
                            self.stats["iq_chunks_in"] = (
                                int(self.stats.get("iq_chunks_in") or 0) + 1
                            )
                            self.stats["last_activity"] = time.time()

                        # Extract IQ samples and metadata
                        samples = iq_message.get("samples")
                        sdr_center = iq_message.get(
                            "logical_center_freq_hz", iq_message.get("center_freq")
                        )
                        sdr_rate = iq_message.get("sample_rate")

                        if samples is None or len(samples) == 0:
                            continue

                        with self.stats_lock:
                            self.stats["iq_samples_in"] = int(
                                self.stats.get("iq_samples_in") or 0
                            ) + len(samples)

                        # Update ingest accumulators (count what we pull, even if we skip processing)
                        ingest_samples_accum += len(samples)
                        ingest_chunks_accum += 1

                        # Get VFO parameters from IQ message
                        vfo_states = iq_message.get("vfo_states", {})
                        vfo_state_dict = vfo_states.get(self.vfo)

                        if not vfo_state_dict or not vfo_state_dict.get("active", False):
                            self._reset_stream()
                            continue  # VFO not active

                        # Cache VFO state for metadata
                        self.cached_vfo_state = vfo_state_dict

                        vfo_center = vfo_state_dict.get("center_freq", 0)
                        vfo_bandwidth = vfo_state_dict.get("bandwidth", 12500)  # 12.5kHz for SSTV

                        # Validate VFO center is within SDR bandwidth
                        is_in_band, vfo_offset, margin = self._is_vfo_in_sdr_bandwidth(
                            vfo_center, sdr_center, sdr_rate
                        )

                        if not is_in_band:
                            # VFO is outside SDR bandwidth - enter sleeping state
                            with self.stats_lock:
                                # Safely increment (mypy-safe in case initial value is None)
                                current_dropped = int(
                                    (self.stats.get("samples_dropped_out_of_band", 0) or 0)
                                )
                                self.stats["samples_dropped_out_of_band"] = current_dropped + len(
                                    samples
                                )

                            if not self.is_sleeping:
                                self.is_sleeping = True
                                sdr_bw_mhz = sdr_rate / 1e6
                                self.sleep_reason = (
                                    f"VFO out of SDR bandwidth: VFO={vfo_center/1e6:.3f}MHz, "
                                    f"SDR={sdr_center/1e6:.3f}MHz±{sdr_bw_mhz/2:.2f}MHz, "
                                    f"offset={vfo_offset/1e3:.1f}kHz, exceeded by {abs(margin)/1e3:.1f}kHz"
                                )
                                logger.warning(self.sleep_reason)
                                self._send_status_update(
                                    DecoderStatus.SLEEPING,
                                    mode_name=None,
                                    info={
                                        "reason": "vfo_out_of_sdr_bandwidth",
                                        "vfo_center_mhz": round(vfo_center / 1e6, 3),
                                        "sdr_center_mhz": round(sdr_center / 1e6, 3),
                                        "sdr_bandwidth_mhz": round(sdr_rate / 1e6, 2),
                                        "vfo_offset_khz": round(vfo_offset / 1e3, 1),
                                        "exceeded_by_khz": round(abs(margin) / 1e3, 1),
                                        "samples_dropped": self.stats[
                                            "samples_dropped_out_of_band"
                                        ],
                                    },
                                )
                            continue  # Skip DSP for this chunk

                        # If we were sleeping and now back in band, resume
                        if self.is_sleeping:
                            self.is_sleeping = False
                            self._reset_stream()
                            logger.info(
                                f"VFO back in SDR bandwidth, resuming: VFO={vfo_center/1e6:.3f}MHz, "
                                f"SDR={sdr_center/1e6:.3f}MHz, offset={vfo_offset/1e3:.1f}kHz"
                            )
                            # For SSTV, LISTENING is the idle state
                            self._send_status_update(
                                DecoderStatus.LISTENING,
                                mode_name=None,
                                info={
                                    "resumed_from_sleep": True,
                                    "vfo_center_mhz": round(vfo_center / 1e6, 3),
                                    "sdr_center_mhz": round(sdr_center / 1e6, 3),
                                },
                            )

                        sample_start = iq_message.get("stream_start_sample")
                        expected = self._expected_sample
                        gap = (
                            sample_start is not None
                            and expected is not None
                            and sample_start != expected
                        )
                        # Small tracking updates keep the picture; a different channel does not.
                        moved = (
                            self._stream_center is not None
                            and abs(self._stream_center - sdr_center) > vfo_bandwidth / 2
                        )
                        retuned = (
                            abs(vfo_center - getattr(self, "_stream_vfo_center", vfo_center))
                            > vfo_bandwidth / 2
                        )
                        previous_mode = self.mode
                        if gap or moved or retuned:
                            logger.info("Resetting SSTV capture after IQ discontinuity or retune")
                            self._reset_stream()
                        audio = self._process_iq_audio(
                            samples, sdr_rate, vfo_bandwidth, vfo_center - sdr_center
                        )
                        self._stream_center = sdr_center
                        self._stream_vfo_center = vfo_center
                        self._expected_sample = (
                            sample_start + len(samples) if sample_start is not None else None
                        )
                        if previous_mode is not None and self.mode is None:
                            self._send_status_update(DecoderStatus.LISTENING)
                        if len(audio):
                            with self.stats_lock:
                                self.stats["audio_samples_generated"] = int(
                                    self.stats.get("audio_samples_generated") or 0
                                ) + len(audio)
                            self.audio_buffer = np.concatenate((self.audio_buffer, audio))
                            self._tone_cache = None
                finally:
                    # Time-based stats tick (every ~1s), compute ingest rates regardless of processing state
                    current_time = time.time()
                    if current_time - last_stats_time >= stats_interval:
                        dt = current_time - ingest_window_start
                        if dt > 0:
                            ingest_sps = ingest_samples_accum / dt
                            ingest_cps = ingest_chunks_accum / dt
                        else:
                            ingest_sps = 0.0
                            ingest_cps = 0.0

                        with self.stats_lock:
                            self.stats["ingest_samples_per_sec"] = ingest_sps
                            self.stats["ingest_chunks_per_sec"] = ingest_cps

                        # Reset window
                        ingest_window_start = current_time
                        ingest_samples_accum = 0
                        ingest_chunks_accum = 0

                        self._send_stats_update()
                        last_stats_time = current_time

                # Poll completed frames while reception and DSP continue on this process thread.
                while self._consume_audio_buffer():
                    if self.running.value != 1:
                        break

        except Exception as e:
            logger.error(f"SSTV decoder error: {e}")
            logger.exception(e)
            with self.stats_lock:
                self.stats["errors"] = int(self.stats.get("errors") or 0) + 1
            self._send_status_update(DecoderStatus.ERROR)

        self._frame_executor.shutdown(wait=True, cancel_futures=True)
        logger.info(f"SSTV decoder v2 process stopped for {self.session_id}")

        # Send final status with restart flag if applicable (parity with FSK decoder)
        try:
            final_status = "restart_requested" if self.should_restart() else "closed"
            msg = {
                "type": "decoder-status",
                "status": final_status,
                "decoder_type": "sstv",
                "decoder_id": self.decoder_id,
                "session_id": self.session_id,
                "vfo": self.vfo,
                "timestamp": time.time(),
                "shm_segments": self.get_shm_segment_count(),
                "restart_requested": self.should_restart(),
            }
            self.data_queue.put(msg, block=False)
        except queue.Full:
            pass
