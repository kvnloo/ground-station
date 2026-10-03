# Backend performance audit and optimization plan

## Purpose

This document is the working record for making the real-time backend faster
without trading away audio quality, decoder correctness, or predictable
latency. It defines the measurements required before a change is made, the
areas to audit, and the evidence required to accept an optimization.

The goal is sustained real-time processing with headroom. Low average CPU is
not sufficient: a pipeline is unhealthy when an occasional slow chunk causes
queues to grow, audio to stutter, IQ to be dropped, or an event-loop backlog
to accumulate.

## Current pipeline map

```text
SDR worker / SigMF playback
  ├─ IQ queue ──> FFT process ──> FFT results ──> UI
  └─ IQ queue ──> IQ broadcaster ──> per-VFO IQ queues
                                      ├─ demodulators ──> audio queues
                                      │                    ├─ web audio streamer ──> Socket.IO ──> browser
                                      │                    └─ audio broadcasters ──> decoders / transcription
                                      └─ IQ recorders and IQ-based decoders
```

The SDR worker and FFT processor run in separate processes. The IQ broadcaster,
demodulators, and web-audio streamer are threads in the main backend process.
Profile the main process and each child process separately; one process profile
does not represent the full pipeline.

## Existing observability

The performance monitor already publishes, when monitoring is enabled:

- Queue depth and maximum queue size.
- Chunk and sample throughput.
- Queue drops, timeout counts, errors, thread/process health, and selected
  worker/FFT CPU and memory measurements.
- Per-subscriber IQ and audio-broadcaster activity.

Its entry point is `backend/monitoring/performancemonitor.py`. Metrics are
emitted to the UI by `ProcessManager` every two seconds. These are excellent
signals for whether a pipeline keeps up, but they do not identify the costly
operation inside a DSP chunk.

## Performance vocabulary

- **Chunk latency:** wall-clock time spent processing one input chunk.
- **P50/P95/P99:** percentiles. P95 is the value at or below which 95% of
  chunks finish; the slowest 5% take longer. Use P95 for operational decisions,
  because real-time glitches are usually caused by slow outliers.
- **Real-time factor (RTF):** `processing_seconds / input_audio_seconds`.
  An RTF of 0.25 means a stage consumes one quarter of its available real-time
  budget. An RTF near or above 1.0 causes backlog under sustained input.
- **Queue age:** time from the input chunk's capture timestamp to the time its
  consumer starts processing it. It exposes latency even when queue depth is
  temporarily small.
- **Headroom:** capacity remaining at peak load. Assess it with P95 RTF,
  queue age, and drops together, not CPU percentage alone.

## Baseline protocol

Every optimization starts with a comparable baseline. Prefer a fixed SigMF
recording so RF conditions and source rate are repeatable. Record the exact
capture, sample rate, FFT size/overlap/averaging, active VFOs, demodulator and
squelch configuration, browser-client count, and test duration.

Run each scenario for at least 45 seconds after a short warm-up:

| ID | Scenario | What it isolates |
| --- | --- | --- |
| B1 | SDR/SigMF input with no active consumers | Acquisition and IQ publish cost |
| B2 | FFT only | FFT process and FFT result transport |
| B3 | One FM VFO, carrier squelch | Core mono audio DSP |
| B4 | One FM VFO, voice/hybrid squelch | VAD and squelch cost |
| B5 | Two or more VFOs | Per-VFO DSP and IQ fan-out scaling |
| B6 | Browser audio connected | Audio serialization, Socket.IO, and browser backpressure |
| B7 | Active decoders/transcription | Audio broadcast and decoder contention |

For every run, retain the configuration and these results: CPU per process and
thread, P95 stage times and RTF, queue depth/age, drops, input/output sample
rates, and a profiler artifact when a process is CPU-bound.

## Profiling playbook

Use the existing UI metrics first. A rising queue, queue age, or drop count
identifies the downstream boundary to investigate. Then use system tools while
the reproducible workload is active.

### Locate hot processes and threads

```bash
ps -eLo pid,ppid,tid,psr,pcpu,pmem,comm,args --sort=-pcpu | head -40
pidstat -t -p <main-backend-pid> 1
top -H -p <main-backend-pid>
```

`top -H` and `pidstat -t` are essential for the main process because its DSP
work is split across threads. Repeat process-level profiling for the SDR worker
and FFT process.

### Python and native call stacks

Use `py-spy` for a low-overhead, attachable profile. It can show Python stacks
and, with `--native`, time in NumPy, SciPy, Socket.IO, and system libraries.

```bash
backend/venv/bin/py-spy top --pid <pid> --threads --native
backend/venv/bin/py-spy record --pid <pid> --threads --native \
  --duration 45 --rate 100 --output /tmp/ground-station-<pid>.svg
```

`py-spy` is not currently part of the backend development dependencies. Install
it in the backend venv when this audit work begins; do not add it to production
runtime dependencies.

### Native CPU and scheduler evidence

Use Linux `perf` when a profile points into compiled code, process
serialization, cache misses, or scheduling. These commands may require the
host's normal perf permissions.

```bash
sudo perf stat -p <pid> \
  -e task-clock,context-switches,cpu-migrations,page-faults,cycles,instructions,cache-misses \
  -- sleep 45

sudo perf record -F 199 -g --call-graph dwarf -p <pid> -- sleep 45
perf report
```

Do not use `cProfile` as the primary tool for this pipeline. It does not cover
other processes and can misattribute or obscure time spent in NumPy/SciPy C
extensions. It remains useful for a small, isolated pure-Python benchmark.

## Instrumentation to add

Add opt-in, chunk-level spans with `time.perf_counter_ns()`. Never time every
sample. When monitoring is disabled, the hot path should do no timestamping or
allocation for metrics.

Each component should export a bounded summary rather than every observation:

- chunk count, input/output samples, bytes, errors, and drops;
- total time, mean, maximum, and P50/P95/P99 duration;
- P50/P95 real-time factor and queue age;
- current and peak queue depth; and
- pending work where an operation is deliberately fire-and-forget.

Use a bounded histogram or bounded rolling sample reservoir for percentiles.
Do not retain an unbounded list of chunk durations in a long-running backend.

### Required timing boundaries

| Component | Spans and counters |
| --- | --- |
| SDR worker | source read/callback, sample conversion, each outbound IQ queue put, source errors and drops |
| IQ broadcaster | source-queue wait/age, VFO-state lookup and enrichment, per-subscriber enqueue, subscriber drops, total fan-out time |
| FFT process | queue age, window/config preparation, segment loop, FFT/power conversion, averager, output queue put |
| AM/FM/SSB demodulator | queue age, translation, filter/decimation, demodulation, audio filtering/de-emphasis, resampling, squelch/VAD, buffering, audio queue put |
| Audio broadcaster | source wait/age, per-subscriber fan-out, drops |
| Web audio streamer | VFO lookup, gain/clip, payload encoding, emit scheduling, emit completion, pending-emission count |
| Decoder/transcription worker | queue age, conversion/resampling, local DSP, provider serialization/network wait, drops |

Attach a monotonic `captured_at_ns` timestamp at the earliest practical worker
boundary and carry it with the message. This makes end-to-end latency and
per-queue age measurable. Use `perf_counter_ns()` for durations; wall-clock
time can jump.

The current performance monitor and the existing component `stats` dictionaries
should transport these summaries to the UI. Add a focused performance view that
shows P95 RTF, queue age, queue utilization, and drops per component/VFO.

## Audit backlog

The following are candidates, not presumed fixes. Profile them in the stated
order and accept a change only after the baseline protocol shows an improvement.

### P0: Measure and protect real-time behavior

Status: partially complete. Opt-in bounded timing summaries now cover IQ fan-out,
FFT processing, FM/AM/SSB DSP stages, and web-audio preparation/emit scheduling.
The existing performance dialog shows P95 processing time, RTF, queue age,
end-to-end audio age, and Socket.IO pending emits. SDR-worker outbound IQ
handoffs now attach a shared monotonic timestamp while monitoring is enabled;
this measures queue and pipeline age from the worker handoff, rather than the
hardware callback itself. Decoder, recorder/transcription, and FM-stereo
instrumentation remain pending.

- [x] Add the opt-in chunk timing and bounded percentile summaries above for
  IQ fan-out, FFT, FM/AM/SSB, and web audio.
- [x] Carry monotonic handoff timestamps from SDR-worker outbound IQ queues
  through IQ broadcaster, FM/AM/SSB, and web-audio queues to report queue and
  end-to-end age.
- [x] Show P95 RTF, queue age, queue utilization, drops, and pending emits in
  the existing performance view for instrumented components.
- [ ] Add a repeatable SigMF benchmark profile and record baseline artifacts.
- [ ] Set initial service-level targets after collecting baseline data. A useful
  starting proposal is P95 RTF below 0.50 for continuously active stages, no
  sustained queue growth, and zero avoidable drops in the target scenario.

### P1: High-frequency allocation and serialization

- [ ] Audit browser audio payload construction. `WebAudioStreamer` currently
  performs `float32` conversion, clipping, `tolist()`, and JSON payload
  construction for each chunk. Measure encoding and emit-completion latency.
- [ ] Prototype Socket.IO binary `float32` audio payloads with separate compact
  metadata. Validate browser compatibility, payload framing, audio quality, and
  measured CPU/network reduction before replacing the JSON list format.
- [ ] Audit `np.concatenate()` and slice-based buffering in demodulators and
  VAD paths. Replace only measured copy hotspots with a bounded ring buffer or
  chunk deque that preserves output chunk boundaries.
- [ ] Track pending Socket.IO emit futures. A steadily growing count identifies
  event-loop or client/network backpressure that an enqueue-only metric hides.

### P1: FFT and DSP work

- [ ] Cache FFT windows, window-power corrections, normalizations, and any
  config-derived values by FFT size/window/overlap configuration. The current
  FFT worker builds the window for every input chunk.
- [ ] Measure FFT segment count and time per segment. Treat FFT size, overlap,
  overlap depth, and averaging as a single cost/quality configuration.
- [ ] Measure each FM/AM/SSB DSP stage independently before changing filters or
  resamplers. In FM this includes frequency translation, cascaded filtering,
  phase demodulation, de-emphasis, and `signal.resample`.
- [ ] Evaluate a phase-continuous complex oscillator for frequency translation.
  The current implementation allocates an `arange` and complex exponential for
  each chunk. Preserve phase continuity and verify spectral/audio correctness
  at chunk boundaries.
- [ ] Evaluate streaming/polyphase resampling only after measurement. It may
  reduce cost relative to FFT-based resampling, but must preserve rate accuracy,
  filter response, and continuity between chunks.
- [ ] Profile voice/hybrid squelch separately. It includes resampling, VAD
  framing, an FFT-based feature calculation, and repeated buffer operations.
  Cache static windows and frequency-bin masks where the profiler confirms
  their cost.

### P2: Fan-out, queues, and contention

- [ ] Measure IQ broadcaster cost as subscriber count rises. It currently
  creates a message copy and serializes VFO state for every subscriber while
  holding the subscriber lock.
- [ ] Cache or version VFO metadata only if profiling shows repeated state
  serialization is material. State changes must invalidate the cache correctly.
- [ ] Reduce lock scope only after validating subscription/unsubscription and
  message-delivery semantics under concurrent changes.
- [ ] Quantify multiprocessing-queue serialization and copying for process
  subscribers. Investigate shared memory only if it is a demonstrated dominant
  cost; it adds ownership and lifecycle complexity.
- [ ] Validate queue sizes from latency targets rather than increasing them to
  conceal overload. Bounded queues should preferentially drop stale real-time
  data and make drops visible.

### P2: Scheduling and native-library behavior

- [ ] Use `perf stat` to check context switches, migrations, and cache misses
  under multi-VFO load.
- [ ] Inspect native-library thread counts before changing BLAS/OpenMP settings.
  Avoid oversubscription, but do not force thread counts without measured
  evidence because NumPy/SciPy operations may release the GIL.
- [ ] Compare per-thread CPU against queue age. A low-CPU consumer with a
  growing queue may be blocked on I/O, locks, or the event loop rather than DSP.

### P3: Reliability under load

- [ ] Add benchmark/regression coverage for buffer bounds, queue drops, and
  end-to-end order/continuity of audio chunks.
- [ ] Test changes with hardware input as well as SigMF playback; hardware
  callback pacing and driver behavior can differ.
- [ ] Run an extended soak test with the expected maximum VFO, browser, decoder,
  and transcription load. Record memory growth, P99 queue age, drops, and
  recovery after a slow client disconnects.

## Candidate code locations

| Area | Primary location | Why it is a candidate |
| --- | --- | --- |
| FFT | `backend/fft/processor.py` | Window creation and multi-segment FFT/power loop per input chunk |
| IQ fan-out | `backend/pipeline/streaming/iqbroadcaster.py` | Per-subscriber message enrichment/copy and queue puts |
| FM audio DSP | `backend/demodulators/fmdemodulator.py` | Translation, filters, resampling, VAD, and audio buffering |
| AM/SSB DSP | `backend/demodulators/amdemodulator.py`, `backend/demodulators/ssbdemodulator.py` | Equivalent translation/filter/resampling paths |
| Stereo FM | `backend/demodulators/fmstereodemodulator.py` | Additional pilot and stereo filter stages |
| Web audio | `backend/audio/audiostreamer.py` | NumPy-to-list conversion and Socket.IO payload/emit path |
| Audio fan-out | `backend/audio/audiobroadcaster.py` | Consumer fan-out and queue-drop behavior |
| Transcription | `backend/audio/transcriptionworker.py` | Audio concatenation, resampling, normalization, and provider streaming |

## Change acceptance checklist

Before merging a performance change:

- [ ] State the workload, baseline commit, and exact configuration.
- [ ] Include before/after P50/P95/P99 duration and RTF for the affected stage.
- [ ] Include queue age/depth and drops before/after.
- [ ] Include CPU by relevant process/thread and a profiler artifact when the
  change targets CPU.
- [ ] Confirm output correctness: sample rate, audio continuity, spectrum,
  demodulation/decoder behavior, and VFO routing.
- [ ] Run relevant backend tests and a manual real-time playback test.
- [ ] Explain any quality/latency/memory trade-off and retain the benchmark data
  with the pull request or issue.

## Decision log

Record completed work here so later audits do not repeat it.

| Date | Scenario | Finding | Change | Before / after evidence | Decision |
| --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — |
