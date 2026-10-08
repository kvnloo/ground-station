# Copyright (c) 2026 Efstratios Goudelis
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.

import queue

import numpy as np
import pytest
from scipy import signal

from demodulators.fmdemodulator import FMDemodulator

pytestmark = pytest.mark.unit


def make_demodulator():
    return FMDemodulator(queue.Queue(), queue.Queue(), "test-fm-squelch", vfo_number=1)


@pytest.mark.parametrize("bandwidth", [10000, 12500])
def test_discriminator_hiss_rejects_empty_channel_and_accepts_voice(bandwidth):
    demodulator = make_demodulator()
    sample_rate = 200000
    demodulator._configure_hiss_filters(sample_rate, bandwidth)
    rng = np.random.default_rng(4)
    count = sample_rate // 2
    channel_filter = signal.butter(4, bandwidth / 2, fs=sample_rate, output="sos")

    empty_iq = signal.sosfilt(channel_filter, rng.normal(size=count) + 1j * rng.normal(size=count))
    empty_audio = demodulator._fm_demodulate(empty_iq)
    for chunk in np.array_split(empty_audio, 25):
        demodulator._update_hiss_gate(chunk, sample_rate)
    assert demodulator.hiss_gate_open is False
    assert demodulator.hiss_snr_db < 4.0

    times = np.arange(count) / sample_rate
    speech = 0.5 * np.sin(2 * np.pi * 900 * times) + 0.3 * np.sin(2 * np.pi * 1400 * times)
    voice_iq = np.exp(1j * np.cumsum(2 * np.pi * 3500 * speech / sample_rate))
    voice_iq += 0.3 * (rng.normal(size=count) + 1j * rng.normal(size=count))
    voice_iq = signal.sosfilt(channel_filter, voice_iq)
    voice_audio = demodulator._fm_demodulate(voice_iq)
    for chunk in np.array_split(voice_audio, 25):
        demodulator._update_hiss_gate(chunk, sample_rate)
    assert demodulator.hiss_gate_open is True
    assert demodulator.hiss_snr_db >= 4.0


def test_hiss_must_qualify_vad_votes_and_close_delay_still_applies():
    demodulator = make_demodulator()
    demodulator._detect_voice_frame = lambda frame: True
    frame = np.zeros(882, dtype=np.float32)  # One 20 ms output frame.

    for _ in range(10):
        demodulator._update_voice_squelch_state(frame, "high", 100, False)
    assert demodulator.voice_squelch_open is False

    for _ in range(2):
        demodulator._update_voice_squelch_state(frame, "high", 100, True)
    assert demodulator.voice_squelch_open is True

    for _ in range(5):
        demodulator._update_voice_squelch_state(frame, "high", 100, False)
    assert demodulator.voice_squelch_open is False

    demodulator._reset_voice_squelch_state()
    for _ in range(3):
        demodulator._update_voice_squelch_state(frame, "low", 100, True)
    assert demodulator.voice_squelch_open is False
    demodulator._update_voice_squelch_state(frame, "low", 100, True)
    assert demodulator.voice_squelch_open is True


def test_narrow_channel_uses_vad_without_unavailable_hiss_band():
    demodulator = make_demodulator()
    demodulator._configure_hiss_filters(200000, 3300)

    assert demodulator.hiss_noise_filter is None
    assert demodulator._update_hiss_gate(np.zeros(4000), 200000) is True


def test_frequency_translation_has_no_chunk_boundary_phase_jump():
    demodulator = make_demodulator()
    sample_rate = 200000
    indices = np.arange(8037)
    carrier = np.exp(2j * np.pi * 3700 * indices / sample_rate)

    translated = np.concatenate(
        [
            demodulator._frequency_translate(carrier[:4000], 2800, sample_rate),
            demodulator._frequency_translate(carrier[4000:], 2800, sample_rate),
        ]
    )

    expected = np.exp(2j * np.pi * 900 * indices / sample_rate)
    np.testing.assert_allclose(translated, expected, atol=1e-11)
