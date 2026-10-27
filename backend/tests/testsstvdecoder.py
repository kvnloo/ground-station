import queue
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from PIL import Image

from demodulators.sstvdecoder import SSTVDecoder, SSTVMode, resolve_forced_mode
from demodulators.sstvdsp import AudioResampler
from pipeline.config.decoderconfigservice import DecoderConfigService


def test_sstv_config_keeps_forced_mode():
    config = DecoderConfigService().get_config(
        decoder_type="sstv", overrides={"sstv_mode": "scottie_s2"}
    )

    assert config.sstv_mode == "scottie_s2"


def test_forced_mode_bypasses_vis_detection():
    decoder = SSTVDecoder.__new__(SSTVDecoder)
    decoder.forced_mode = SSTVMode.SCOTTIE_S2
    decoder._decode_vis = lambda _vis_start: pytest.fail("VIS detection should be bypassed")

    assert decoder._select_mode(123) is SSTVMode.SCOTTIE_S2


def test_auto_mode_uses_vis_detection():
    decoder = SSTVDecoder.__new__(SSTVDecoder)
    decoder.forced_mode = None
    decoder._decode_vis = lambda _vis_start: SSTVMode.ROBOT_36

    assert decoder._select_mode(123) is SSTVMode.ROBOT_36


def test_rejects_unknown_forced_mode():
    with pytest.raises(ValueError, match="Unsupported forced SSTV mode"):
        resolve_forced_mode("pd120")


@pytest.mark.parametrize("counter", [None, 0, 7])
def test_progress_update_identifies_decoder_instance(counter):
    decoder = SSTVDecoder.__new__(SSTVDecoder)
    decoder.decoder_id = "sstv-run-2"
    decoder.session_id = "session-1"
    decoder.vfo = 2
    decoder.data_queue = queue.Queue()
    decoder.stats_lock = threading.Lock()
    decoder.stats = {"data_messages_out": counter}

    decoder._send_progress_update(25, 100, "robot36")

    message = decoder.data_queue.get_nowait()
    assert message["decoder_id"] == "sstv-run-2"
    assert message["progress"] == 25
    assert decoder.stats["data_messages_out"] == (counter or 0) + 1


def _decoder(rate=12000):
    decoder = SSTVDecoder.__new__(SSTVDecoder)
    decoder.audio_sample_rate = rate
    decoder._reset_stream()
    decoder.forced_mode = None
    decoder.stats_lock = threading.Lock()
    decoder.stats = {"images_decoded": 0}
    decoder._send_progress_update = lambda *args: None
    decoder._send_status_update = lambda *args: None
    decoder.images = []
    decoder._send_completed_image = lambda image, name: decoder.images.append(image)
    return decoder


class _Transmission:
    """Independent continuous-phase SSTV test transmitter; durations are milliseconds."""

    def __init__(self, rate=12000, clock=1.0, offset=0.0):
        self.rate, self.clock, self.offset = rate, clock, offset
        self.elapsed = 0.0
        self.count = 0
        self.sections = []

    def tone(self, frequency, milliseconds):
        self.elapsed += milliseconds * 0.001 * self.clock
        stop = round(self.elapsed * self.rate)
        count = stop - self.count
        frequencies = np.atleast_1d(frequency)
        indices = np.minimum(len(frequencies) - 1, np.arange(count) * len(frequencies) // count)
        self.sections.append(frequencies[indices] + self.offset)
        self.count = stop

    def header(self, vis=8, bad_parity=False, stop=1200):
        self.tone(1900, 300)
        self.tone(1200, 10)
        self.tone(1900, 300)
        self.tone(1200, 30)
        code = vis | (((vis.bit_count() % 2) ^ bad_parity) << 7)
        for bit in range(8):
            self.tone(1100 if code & (1 << bit) else 1300, 30)
        self.tone(stop, 30)

    def audio(self):
        return np.sin(np.cumsum(np.concatenate(self.sections)) * (2 * np.pi / self.rate))


def _robot_transmission(clock=1.0, offset=0.0, missing_sync=None, omitted_line=None):
    colors = np.array(
        [
            (255, 255, 255),
            (255, 255, 0),
            (0, 255, 255),
            (0, 255, 0),
            (255, 0, 255),
            (255, 0, 0),
            (0, 0, 0),
            (0, 0, 255),
        ],
        dtype=np.uint8,
    )
    pixels = np.tile(colors[np.arange(320) // 40], (240, 1, 1))
    pixels[160:200] = np.linspace(0, 255, 320).astype(np.uint8)[None, :, None]
    pixels[200:240] = ((np.arange(320) // 2 % 2) * 255).astype(np.uint8)[None, :, None]
    channels = np.asarray(Image.fromarray(pixels).convert("YCbCr"))
    tx = _Transmission(clock=clock, offset=offset)
    tx.tone(1900, 100)
    tx.header()
    for row in range(240):
        if row == omitted_line:
            continue
        tx.tone(1500 if row == missing_sync else 1200, 9)
        tx.tone(1500, 3)
        tx.tone(1500 + channels[row, :, 0] * (800 / 255), 88)
        tx.tone(1500 if row % 2 == 0 else 2300, 4.5)
        tx.tone(1900, 1.5)
        tx.tone(1500 + channels[row, :, 2 - row % 2] * (800 / 255), 44)
    tx.tone(1900, 300)
    return tx.audio(), pixels


@pytest.mark.parametrize("frequency", [1500, 1600, 1700, 1900, 2100, 2200, 2300])
def test_clean_tone_estimates_are_not_biased(frequency):
    decoder = _decoder(44100)
    for phase in [0, 1, 2]:
        audio = np.sin(2 * np.pi * frequency * np.arange(93) / 44100 + phase)
        assert abs(decoder._peak_fft_freq(audio) - frequency) < 2


@pytest.mark.parametrize("frequency", [0, 1200, 1900])
def test_sync_requires_a_real_pulse(frequency):
    decoder = _decoder()
    decoder.mode = SSTVMode.ROBOT_36
    decoder.audio_buffer = np.sin(2 * np.pi * frequency * np.arange(12000) / 12000)
    assert decoder._align_sync(0) is None


@pytest.mark.parametrize("bad_parity,stop", [(True, 1200), (False, 1900)])
def test_vis_rejects_damaged_framing(bad_parity, stop):
    tx = _Transmission()
    tx.tone(1900, 100)
    tx.header(bad_parity=bad_parity, stop=stop)
    tx.tone(1900, 100)
    decoder = _decoder()
    decoder.audio_buffer = tx.audio()
    header = decoder._find_header()
    assert header is not None
    assert decoder._decode_vis(header) is None


@pytest.mark.parametrize(
    "clock,offset,missing_sync", [(1.0, 0, None), (1.0015, 70, 73), (0.9985, -70, 105)]
)
def test_robot_picture_detail_color_and_clock_recovery(clock, offset, missing_sync):
    audio, source = _robot_transmission(clock, offset, missing_sync)
    decoder = _decoder()
    decoder.audio_buffer = audio
    assert decoder._consume_audio_buffer()
    assert decoder.stats["images_decoded"] == 1
    result = np.asarray(decoder.images[0]).astype(float)
    centres = np.arange(8) * 40 + 20
    assert np.max(np.abs(result[40, centres] - source[40, centres])) < 10
    # The final blue bar must remain blue through the last column.
    assert result[40, -1, 2] > 220
    assert result[40, -1, 0] < 25
    assert np.max(np.abs(result[40, centres] - result[41, centres])) < 5
    ramp = result[180, 15:305].mean(axis=1)
    assert np.abs(ramp - source[180, 15:305, 0]).mean() < 4
    stripes = result[220, 16:304].mean(axis=1)
    white = source[220, 16:304, 0] > 128
    assert stripes[white].mean() - stripes[~white].mean() > 65


def test_robot_identifiers_recover_color_after_an_omitted_line():
    audio, source = _robot_transmission(omitted_line=60)
    decoder = _decoder()
    decoder.audio_buffer = audio
    assert decoder._consume_audio_buffer()
    result = np.asarray(decoder.images[0]).astype(float)
    centres = np.arange(8) * 40 + 20
    assert np.max(np.abs(result[100, centres] - source[101, centres])) < 10


def test_consecutive_robot_frames_retain_the_following_header():
    audio, _ = _robot_transmission()
    decoder = _decoder()
    decoder.audio_buffer = np.r_[audio, audio]
    assert decoder._consume_audio_buffer()
    assert decoder._consume_audio_buffer()
    assert len(decoder.images) == 2
    np.testing.assert_allclose(np.asarray(decoder.images[0]), np.asarray(decoder.images[1]), atol=2)


def test_forced_robot_acquires_a_sync_train_without_vis():
    audio, _ = _robot_transmission()
    decoder = _decoder()
    decoder.forced_mode = SSTVMode.ROBOT_36
    decoder.audio_buffer = audio[round(1.01 * 12000) :]
    assert decoder._consume_audio_buffer()
    assert len(decoder.images) == 1


@pytest.mark.parametrize("input_rate", [200000, 240000, 213333.33333333334, 44100])
def test_resampler_keeps_its_clock_and_history_between_chunks(input_rate):
    source = np.random.default_rng(123).normal(size=17003)
    whole = AudioResampler(input_rate, 44100).process(source)
    stream = AudioResampler(input_rate, 44100)
    chunks = [stream.process(source[start : start + 137]) for start in range(0, len(source), 137)]
    np.testing.assert_allclose(np.concatenate(chunks), whole, atol=1e-12)
    assert abs(len(whole) - len(source) * 44100 / input_rate) <= 1


@pytest.mark.parametrize("rate", [1000000, 2048000, 2400000, 3200000])
def test_iq_demodulation_is_independent_of_chunk_boundaries(rate):
    count = round(rate * 0.12)
    time = np.arange(count) / rate
    audio = np.sin(2 * np.pi * 1900 * time)
    phase = 2 * np.pi * (12345 * time + 2500 * np.cumsum(audio) / rate)
    samples = np.exp(1j * phase)
    decoder = _decoder(44100)
    expected = decoder._process_iq_audio(samples, rate, 12500, 12345)
    decoder = _decoder(44100)
    chunks = [
        decoder._process_iq_audio(samples[start : start + 16381], rate, 12500, 12345)
        for start in range(0, len(samples), 16381)
    ]
    actual = np.concatenate(chunks)
    np.testing.assert_allclose(actual, expected, atol=1e-7)
    assert abs(len(actual) - count * 44100 / rate) < 2
    assert abs(decoder._peak_fft_freq(actual[1000:]) - 1900) < 2


def test_receiver_rate_changes_reset_capture_state():
    decoder = _decoder(44100)
    decoder._process_iq_audio(np.ones(1000, complex), 2400000, 12500, 0)
    decoder.mode = SSTVMode.ROBOT_36
    decoder.audio_buffer = np.ones(100)
    decoder._process_iq_audio(np.ones(1000, complex), 3200000, 12500, 0)
    assert decoder.mode is None
    assert not len(decoder.audio_buffer)


@pytest.mark.parametrize("mode", [SSTVMode.MARTIN_M1, SSTVMode.SCOTTIE_S2])
def test_rgb_modes_preserve_channel_order_and_line_layout(mode):
    tx = _Transmission()
    tx.tone(1900, 100)
    tx.header(vis=mode.value["vis_code"])
    color = [64, 144, 224]
    if mode is SSTVMode.SCOTTIE_S2:
        tx.tone(1200, 9)
    for _ in range(256):
        if mode is SSTVMode.MARTIN_M1:
            tx.tone(1200, 4.862)
            tx.tone(1500, 0.572)
            for channel in [1, 2, 0]:
                tx.tone(1500 + color[channel] * 800 / 255, 146.432)
                tx.tone(1500, 0.572)
        else:
            for channel in [1, 2]:
                tx.tone(1500, 1.5)
                tx.tone(1500 + color[channel] * 800 / 255, 88.064)
            tx.tone(1200, 9)
            tx.tone(1500, 1.5)
            tx.tone(1500 + color[0] * 800 / 255, 88.064)
    tx.tone(1900, 200)
    decoder = _decoder()
    decoder.audio_buffer = tx.audio()
    assert decoder._consume_audio_buffer()
    result = np.asarray(decoder.images[0]).astype(float)
    np.testing.assert_allclose(
        result[:, 10:-10], np.broadcast_to(color, result[:, 10:-10].shape), atol=3
    )


def test_robot_remains_usable_with_audio_noise():
    audio, source = _robot_transmission()
    decoder = _decoder()
    decoder.audio_buffer = audio + np.random.default_rng(12).normal(0, 0.05, len(audio))
    assert decoder._consume_audio_buffer()
    result = np.asarray(decoder.images[0]).astype(float)
    centres = np.arange(8) * 40 + 20
    assert np.abs(result[20:100, centres] - source[20:100, centres]).mean() < 8


def test_streamed_slow_robot_waits_for_the_final_scan():
    audio, _ = _robot_transmission(clock=1.005)
    decoder = _decoder()
    early = round((1.01 * 1.005 + 36.04) * decoder.audio_sample_rate)
    decoder.audio_buffer = audio[:early]
    assert not decoder._consume_audio_buffer()
    assert not decoder.images
    decoder.audio_buffer = audio
    assert decoder._consume_audio_buffer()
    result = np.asarray(decoder.images[0])
    assert result[-1, 16:304].max() > 200


def test_frame_worker_keeps_audio_received_during_decoding():
    decoder = _decoder()
    audio, _ = _robot_transmission()
    decoder.audio_buffer = audio
    with ThreadPoolExecutor(max_workers=1) as executor:
        decoder._frame_executor = executor
        assert not decoder._consume_audio_buffer()
        pending = decoder._frame_future
        assert pending is not None
        following = np.full(12000, 0.25)
        decoder.audio_buffer = np.r_[decoder.audio_buffer, following]
        pending.result(timeout=10)
        assert decoder._consume_audio_buffer()
        assert len(decoder.images) == 1
        np.testing.assert_array_equal(decoder.audio_buffer[-12000:], following)


def test_reset_discards_an_old_frame_worker_result():
    decoder = _decoder()
    decoder.audio_buffer, _ = _robot_transmission()
    with ThreadPoolExecutor(max_workers=1) as executor:
        decoder._frame_executor = executor
        assert not decoder._consume_audio_buffer()
        decoder._reset_stream()
    assert not decoder._consume_audio_buffer()
    assert not decoder.images
