# Copyright (c) 2026 Efstratios Goudelis

import asyncio
import json
import queue
import threading
import time
from types import SimpleNamespace

import numpy as np
import pytest
from google.genai import errors

from audio import geminitranscriptionworker as geminimodule
from audio.geminitranscriptionworker import GeminiTranscriptionWorker


def _worker(translate_to="none", language="pt-BR", output_dir=None):
    return GeminiTranscriptionWorker(
        transcription_queue=queue.Queue(),
        sio=None,
        loop=asyncio.get_running_loop(),
        api_key="test-key",
        session_id="test-session",
        vfo_number=1,
        language=language,
        translate_to=translate_to,
        output_dir=output_dir,
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_only_accepts_final_source_transcription():
    source = SimpleNamespace(text="Observa aí, ó", finished=True)
    narration = SimpleNamespace(parts=[SimpleNamespace(text="**Transcribing and Translating**")])
    response = SimpleNamespace(
        server_content=SimpleNamespace(
            input_transcription=source,
            output_transcription=SimpleNamespace(text="Παρατήρησε εκεί."),
            interim_input_transcription=SimpleNamespace(text="Observa"),
            model_turn=narration,
        )
    )

    source_worker = _worker()
    translation_worker = _worker("el")

    assert source_worker._extract_transcription_from_response(response) == "Observa aí, ó"
    assert translation_worker._extract_transcription_from_response(response) == "Observa aí, ó"
    assert translation_worker._determine_source_language("Observa aí, ó") == "pt-BR"

    narration_only = SimpleNamespace(
        server_content=SimpleNamespace(
            model_turn=narration,
            interim_input_transcription=SimpleNamespace(text="Observa"),
            output_transcription=SimpleNamespace(text="Παρατήρησε εκεί."),
        )
    )
    assert source_worker._extract_transcription_from_response(narration_only) == ""
    assert translation_worker._extract_transcription_from_response(narration_only) == ""

    noise = SimpleNamespace(server_content=SimpleNamespace(input_transcription={"text": "<noise>"}))
    assert source_worker._extract_transcription_from_response(noise) == ""


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "language,expected_hint",
    [("pt-BR", ["pt-BR"]), ("el", ["el-GR"]), ("auto", None)],
)
async def test_gemini_live_config_uses_vfo_language_hint(monkeypatch, language, expected_hint):
    captured = []
    session = SimpleNamespace()

    class _SessionContext:
        async def __aenter__(self):
            return session

        async def __aexit__(self, *_args):
            return None

    def connect(*, model, config):
        captured.append((model, config))
        return _SessionContext()

    client = SimpleNamespace(aio=SimpleNamespace(live=SimpleNamespace(connect=connect)))
    keys = []

    def new_client(*, api_key):
        keys.append(api_key)
        return client

    monkeypatch.setattr(geminimodule, "genai", SimpleNamespace(Client=new_client))
    monkeypatch.setattr(geminimodule, "GEMINI_AVAILABLE", True)

    worker = _worker("el", language=language)
    await worker._connect()

    model, config = captured[0]
    assert model == "gemini-3.5-transcribe-live"
    assert config["response_modalities"] == ["TEXT"]
    assert config["input_audio_transcription"].get("language_codes") == expected_hint
    assert "output_audio_transcription" not in config
    assert keys == ["test-key"]
    await worker._disconnect()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_sends_raw_pcm_as_realtime_audio():
    sent = []

    async def send_realtime_input(*, audio):
        sent.append(audio)

    worker = _worker()
    worker.input_sample_rate = 16000
    worker.gemini_session = SimpleNamespace(send_realtime_input=send_realtime_input)

    payload = worker._prepare_audio_payload(np.array([0.0, 0.5, -0.5], dtype=np.float32))
    await worker._send_audio_to_provider(payload)

    assert isinstance(payload, bytes)
    assert sent == [{"data": payload, "mime_type": "audio/pcm;rate=16000"}]
    assert worker.chunk_duration == 0.1
    assert worker.silence_threshold == 0.0

    static = worker._prepare_audio_payload(np.array([0.0, 0.01, -0.01], dtype=np.float32))
    assert np.max(np.abs(np.frombuffer(static, dtype=np.int16))) < 2000


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_translates_final_speech_with_same_client_key():
    calls = []

    async def generate_content(*, model, contents, config):
        calls.append((model, json.loads(contents), config))
        return SimpleNamespace(text='{"translation": "Παρατήρησε εκεί."}')

    worker = _worker("el")
    worker.gemini_client = SimpleNamespace(
        aio=SimpleNamespace(models=SimpleNamespace(generate_content=generate_content))
    )
    translated = await worker._translate_text("Observa aí, ó")

    assert translated == "Παρατήρησε εκεί."
    assert calls[0][0] == "gemini-3.8-flash"
    assert calls[0][1] == {"speech": "Observa aí, ó"}
    assert "Brazilian Portuguese" in calls[0][2].system_instruction
    assert "Greek" in calls[0][2].system_instruction
    assert calls[0][2].automatic_function_calling.disable is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_unavailable_translation_model_falls_back_once(monkeypatch, caplog):
    worker = _worker("el")
    requests = []
    reported_errors = []
    emitted = []

    async def translate(text):
        requests.append(text)
        raise errors.ClientError(
            404,
            {"error": {"status": "NOT_FOUND", "message": "Model unavailable"}},
        )

    async def report(error):
        reported_errors.append(error)

    async def emit_transcription(*, text, language, is_final):
        emitted.append((text, language, is_final))

    monkeypatch.setattr(worker, "_translate_text", translate)
    monkeypatch.setattr(worker, "_send_error_to_ui", report)
    monkeypatch.setattr(worker, "_emit_transcription", emit_transcription)

    await worker._queue_translation("primeiro")
    await worker._queue_translation("segundo")
    await asyncio.gather(*worker._translation_tasks)

    assert requests == ["primeiro"]
    assert len(reported_errors) == 1
    assert emitted == [("primeiro", "pt-BR", True), ("segundo", "pt-BR", True)]
    assert caplog.text.count("Gemini translation model gemini-3.8-flash unavailable") == 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_translations_emit_in_speech_order(monkeypatch):
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    emitted = []
    worker = _worker("el")

    async def translate(text):
        if text == "first":
            first_started.set()
            await release_first.wait()
        return text.upper()

    async def emit_transcription(*, text, language, is_final):
        emitted.append((text, language, is_final))

    monkeypatch.setattr(worker, "_translate_text", translate)
    monkeypatch.setattr(worker, "_emit_transcription", emit_transcription)
    await worker._queue_translation("first")
    await asyncio.wait_for(first_started.wait(), timeout=1)
    await worker._queue_translation("second")
    await asyncio.sleep(0)
    assert emitted == []

    release_first.set()
    await asyncio.gather(*worker._translation_tasks)
    assert emitted == [("FIRST", "el", True), ("SECOND", "el", True)]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_receiver_translates_only_final_speech(monkeypatch):
    emitted = []
    worker = _worker("el")
    worker.connected = True
    worker.gemini_session = SimpleNamespace()
    interim = SimpleNamespace(
        server_content=SimpleNamespace(interim_input_transcription=SimpleNamespace(text="Observa"))
    )
    final = SimpleNamespace(
        server_content=SimpleNamespace(input_transcription=SimpleNamespace(text="Observa aí"))
    )

    async def responses():
        yield interim
        yield final
        worker.running = False

    async def translate(_text):
        return "Παρατήρησε εκεί"

    async def emit_transcription(*, text, language, is_final):
        emitted.append((text, language, is_final))

    monkeypatch.setattr(worker, "_iter_provider_responses", responses)
    monkeypatch.setattr(worker, "_translate_text", translate)
    monkeypatch.setattr(worker, "_emit_transcription", emit_transcription)

    await worker._receive_loop()
    await asyncio.gather(*worker._translation_tasks)

    assert emitted == [("Παρατήρησε εκεί", "el", True)]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_renews_expired_session_before_next_audio(monkeypatch):
    worker = _worker()
    worker.connected = True
    worker.session_started_at = time.monotonic() - worker.session_renew_after_seconds - 1
    worker.gemini_session = SimpleNamespace()
    events = []

    class _OldContext:
        async def __aexit__(self, *_args):
            events.append("close")

    async def connect():
        events.append("connect")
        worker.connected = True
        worker.gemini_session = SimpleNamespace()

    async def send(_payload):
        events.append("send")

    async def receive():
        await asyncio.sleep(3600)

    worker.gemini_session_context = _OldContext()
    monkeypatch.setattr(worker, "_connect", connect)
    monkeypatch.setattr(worker, "_send_audio_to_provider", send)
    monkeypatch.setattr(worker, "_receive_loop", receive)
    monkeypatch.setattr(worker, "_send_status_to_ui", lambda _status: None)

    await worker._stream_audio(b"pcm")
    worker.running = False
    await worker._cleanup_provider_resources()

    assert events == ["close", "connect", "send"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gemini_stop_finishes_translation_before_closing_file(monkeypatch, tmp_path):
    worker = _worker("el", output_dir=str(tmp_path))
    started = threading.Event()
    release = threading.Event()

    async def translate(_text):
        started.set()
        await asyncio.to_thread(release.wait)
        return "Παρατήρησε εκεί"

    async def emit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(worker, "_translate_text", translate)
    monkeypatch.setattr(worker, "_safe_sio_emit", emit)
    monkeypatch.setattr(worker, "_notify_library_file_created", lambda: None)
    monkeypatch.setattr(worker, "_send_status_to_ui", lambda _status: None)

    worker.start()
    try:
        assert await asyncio.to_thread(worker._provider_loop_ready.wait, 2)
        scheduled = asyncio.run_coroutine_threadsafe(
            worker._queue_translation("Observa aí"), worker.provider_loop
        )
        await asyncio.wrap_future(scheduled)
        assert await asyncio.to_thread(started.wait, 2)

        worker.stop()
        release.set()
        await asyncio.to_thread(worker.join, 3)

        assert not worker.is_alive()
        files = list(tmp_path.glob("*.txt"))
        assert len(files) == 1
        content = files[0].read_text(encoding="utf-8")
        assert "Παρατήρησε εκεί" in content
        assert "# Ended:" in content
    finally:
        release.set()
        if worker.is_alive():
            worker.stop()
            await asyncio.to_thread(worker.join, 3)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_overlapping_gemini_disconnects_exit_session_once():
    started = asyncio.Event()
    release = asyncio.Event()
    exits = []

    class _SessionContext:
        async def __aexit__(self, *_args):
            exits.append(True)
            started.set()
            await release.wait()

    worker = _worker()
    worker.gemini_session_context = _SessionContext()
    worker.gemini_session = SimpleNamespace()
    worker.connected = True

    first = asyncio.create_task(worker._disconnect())
    await asyncio.wait_for(started.wait(), timeout=1)
    second = asyncio.create_task(worker._disconnect())
    await asyncio.sleep(0)
    release.set()
    await asyncio.gather(first, second)

    assert len(exits) == 1
    assert worker.gemini_session is None
    assert worker.connected is False
