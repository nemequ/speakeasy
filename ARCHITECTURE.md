# Speakeasy Architecture

## Overview

Speakeasy is a GNOME Shell 49 extension (GJS, ESM modules) that runs
inside the compositor process. It captures microphone audio, runs
streaming speech-to-text via VOSK, optionally cleans the text through
Anthropic's Claude API, and pastes the result into the focused
application via clipboard + simulated Shift+Insert.

The extension runs entirely within `gnome-shell` — there are no
external daemon processes. All components are JavaScript modules loaded
by GNOME Shell's GJS runtime.

## System Context

```
┌──────────────────────────────────────────────────────────────────┐
│                     GNOME Shell (Mutter)                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │             Speakeasy Extension (GJS/ESM)                  │  │
│  │                                                            │  │
│  │  extension.js ──┬── keybinding.js  (state machine)         │  │
│  │                 ├── recorder.js    (IPC to subprocess)     │  │
│  │                 ├── ai.js          (Anthropic API)         │  │
│  │                 ├── ollama.js      (Ollama local AI)       │  │
│  │                 ├── output.js      (clipboard paste)       │  │
│  │                 ├── ui/panelIcon.js        (panel icon)    │  │
│  │                 └── ui/recordingOverlay.js (overlay)       │  │
│  └──────────────────────────┬─────────────────────────────────┘  │
│                             │                                    │
│  Uses: GStreamer, Soup3, St, Clutter, Meta, Shell                │
└──────────┬──────────────────┼──────────────┬─────────────────────┘
           │                  │              │
           │    ┌─────────────▼───────────┐  │
           │    │  stt-subprocess.js      │  │
           │    │  (GStreamer + VOSK)      │  │
           │    │  runs out-of-process     │  │
           │    └─────────────────────────┘  │
           │                                 │
    PulseAudio/      Anthropic / Ollama   Focused App
    PipeWire         API (HTTPS)          (paste target)
    (microphone)
```

## Component Details

### extension.js — Orchestrator

The main entry point. Extends GNOME Shell's `Extension` class. Its
`enable()` method creates all components and wires them together; its
`disable()` tears everything down.

**Key wiring:**

1. `recorder.onFinalText()` → `ai.feedText()` — STT segments feed
   the AI buffer during recording
2. `keybinding.onCommitRecording()` → `ai.beginSession()` — when
   we're confident this is a real recording (not accidental), warm
   the AI prompt cache
3. `keybinding.onStopRecording()` → `_stopRecording()` — stop
   recorder, finalize AI, paste result
4. `keybinding.onDiscardRecording()` → `_discardRecording()` — stop
   recorder, cancel AI, delete audio, no output
5. `panelIcon.onToggleRecording()` — click-to-start/stop bypass for
   the keybinding state machine

**Verbose logging** (`verbose-logging` GSettings key): when enabled,
the chattier per-event log lines are emitted (state transitions,
individual STT segments, AI request internals). Visible via
`journalctl --user -g Speakeasy`. Audio retention is now controlled
separately by the `retain-audio` setting.

### keybinding.js — Push-to-Talk State Machine

Uses Mutter's `global.display.grab_accelerator()` API to intercept
a configurable trigger key.

#### Why Not Modifier Keys?

Mutter intercepts modifier key events (Ctrl, Alt, Super) before they
reach the stage or any extension API. There is no extension mechanism
for modifier-only keybindings. The `overlay-key` signal for Super is
hardcoded in Mutter's C code. Only non-modifier keys (Pause,
Scroll_Lock, F13, etc.) work with `grab_accelerator`.

#### Why Not accelerator-deactivated?

`grab_accelerator` provides an `accelerator-activated` signal that
fires on initial press AND on every key repeat (~30ms intervals). The
corresponding `accelerator-deactivated` signal **does not fire** on
GNOME 49 (at least in devkit sessions). We therefore synthesize
release events via gap detection.

#### Gap Detection

Since we only receive press/repeat events, we detect key release as
a gap with no events:

- `RELEASE_GAP_MS` (default 700ms): if no accelerator events arrive
  for this long, the key was released. Must be longer than the
  keyboard repeat delay (~250-600ms).
- `INTER_TAP_GAP_MS` (default 60ms): within a stream of repeat
  events (~30ms apart), a gap > 60ms means the key was released and
  re-pressed (double-tap). Gaps >= `REPEAT_DELAY_MS` (default 400ms)
  are the keyboard repeat delay within a single hold — NOT an
  inter-tap gap.

#### State Machine

```
                    key press (first event)
        ┌─────────┐ ────────────────────────▶ ┌───────────┐
        │  IDLE   │                            │ RECORDING │
        └────┬────┘                            └─────┬─────┘
             │                                       │
             │  2nd press                   release   │
             │  (double-tap                 detected  │
             │   window)              ┌──────────────┘
             │         ┌──────────────┤
             │         │              │
             │   ┌─────▼─────┐  held (≥5 repeats)?
             │   │  LOCKED   │  ├─ YES: → PROCESSING → output text
             │   │(recording)│  └─ NO:  → IDLE, start double-tap timer
             │   └─────┬─────┘
             │         │ key press
             │         ▼
             │   ┌───────────┐       ┌───────────────────────┐
             │   │PROCESSING │──────▶│ IDLE (processingDone) │
             │   └───────────┘       └───────────────────────┘
             │
             │  double-tap timer expires (no 2nd tap)
             └── discard recording, back to IDLE
```

**Hold-to-talk**: Press and hold → RECORDING. Release detected (gap
timeout, ≥5 repeat events = held) → PROCESSING → output text.

**Double-tap-to-lock**: Quick tap → RECORDING. Release (< 5 repeats =
tap) → IDLE + start double-tap timer. Second tap within window →
LOCKED. Tap again → PROCESSING → output text.

**Accidental tap**: Quick tap, no second tap within window → discard.

**Commit callback**: fires when we're confident this is a real
recording — either when repeat count crosses `HOLD_THRESHOLD` during
a hold, or on transition to LOCKED. Used to warm the AI prompt cache
in parallel with recording.

### recorder.js + stt-subprocess.js — GStreamer Split Pipeline

`recorder.js` is the in-process IPC client that spawns and
communicates with `stt-subprocess.js` via JSON lines over
stdin/stdout. The subprocess runs GStreamer pipelines out-of-process
to avoid blocking the compositor.

#### The Core Problem: Mic Privacy

GNOME Shell's privacy indicator shows whenever ANY PulseAudio source
output exists, even if corked (paused). The indicator is in
`js/ui/status/volume.js:InputStreamSlider._maybeShowInput()`:

```javascript
showInput = this._control.get_source_outputs().some(
    output => !skippedApps.includes(output.get_application_id()));
```

Only `org.gnome.VolumeControl` and `org.PulseAudio.pavucontrol` are
exempt. A `pulsesrc` in PAUSED state creates a corked stream that
triggers this indicator.

#### Why Not Just NULL→PLAYING?

Setting the whole pipeline to NULL releases the mic but requires
VOSK to reload its 1.8GB model on every start — 1.5-3 seconds of
latency that eats the beginning of speech.

#### Why Not READY as Idle State?

GStreamer READY state allocates resources but doesn't preroll.
However, VOSK breaks on the second recording cycle when using READY
as idle state, producing `g_object_unref` critical warnings and zero
STT results.

#### The Solution: interaudiosrc/interaudiosink

Two matched GStreamer elements that pass audio between separate
pipelines via a named channel, entirely within GStreamer's native
threads (no cross-thread JS callbacks):

```
STT Pipeline (permanent, PLAYING from init to destroy):
  interaudiosrc channel=speakeasy-stt
    → audio/x-raw,format=S16LE,rate=16000,channels=1
    → vosk name=SpeakeasyStt enable-denoise=true
    → fakesink

Capture Pipeline (per-recording, created on start, destroyed on stop):
  pulsesrc blocksize=3200
    → audio/x-raw,format=S16LE,rate=16000,channels=1
    → interaudiosink channel=speakeasy-stt sync=false

File Pipeline (per-recording, separate pulsesrc):
  pulsesrc blocksize=3200
    → audio/x-raw,format=S16LE,rate=16000,channels=1
    → queue leaky=downstream max-size-time=3000000000
    → opusenc bitrate=24000
    → oggmux
    → filesink location=/run/user/UID/speakeasy-YYYYMMDD-HHMMSS.opus
```

- **STT pipeline** stays in PLAYING permanently. `interaudiosrc`
  generates silence when no capture pipeline is connected. VOSK model
  stays loaded in memory. Zero PulseAudio streams when idle.
- **Capture pipeline** is created fresh on each `start()` and
  destroyed on `stop()`. `pulsesrc` only exists while recording,
  so the mic is fully released between recordings.
- **File pipeline** uses a separate `pulsesrc` (PulseAudio allows
  multiple clients on the same source). `queue leaky=downstream`
  makes it fault-tolerant — if disk I/O stalls, buffers are dropped
  rather than blocking STT. Files are Opus/Ogg (~180 KB/min).

#### Why Not webrtcdsp?

The GStreamer `webrtcdsp` element was tested for noise suppression
but suppressed all speech audio entirely — VOSK produced zero
results with it in the pipeline. VOSK's built-in `enable-denoise=true`
(RNNoise) is used instead.

#### Why Not appsrc/appsink?

An `appsrc`/`appsink` bridge between two pipelines was tested but
the `new-sample` signal fires on a GStreamer streaming thread. GJS
blocks cross-thread JavaScript calls, so the callback never
executes. `interaudiosrc`/`interaudiosink` handles everything within
GStreamer's native threads, avoiding this issue.

#### STT Backends

The recorder supports pluggable backends via the `stt-backend`
GSettings key:

- **vosk** (default, working): `gst-vosk` plugin. Streaming partial
  and final results via GStreamer bus messages with structure name
  `vosk` and field `current-result` (JSON).
- **whisper** (provisional): GStreamer 1.28.1 adds a native `whisper`
  element. The pipeline definition exists but is untested. The
  whisper element's property names (`model`, `model-path`,
  `language`) are best-effort guesses.

#### VOSK Bus Message Format

VOSK emits element messages on the GStreamer bus:
```
structure name: "vosk"
field "current-result": JSON string
```

Partial results: `{"partial": "hello wor"}`
Final results: `{"text": "hello world"}`
Alternative: `{"alternatives": [{"text": "hello world", "confidence": 0.95}]}`

#### Model Detection

`Recorder.detectVoskModelPath()` scans `~/.cache/vosk/` and
`/usr/share/vosk/` for directories starting with `vosk-model`,
preferring non-small models. Similarly for whisper models.

### ai.js — Multi-Turn Incremental Prompt Caching

#### Why Multi-Turn?

The Anthropic API is stateless (every request replays the full
conversation), but prompt caching means prefixes are not reprocessed.
By building a multi-turn conversation during recording, most of the
input is already cached by the time the user stops speaking —
reducing time-to-first-token on the final cleanup request.

#### Session Lifecycle

```
    beginSession()          feedText()           finalize()
    (on commit)             (VOSK finals)        (on stop)
         │                      │                    │
         ▼                      ▼                    ▼
    ┌─────────┐          ┌──────────┐          ┌─────────┐
    │ Framing  │  ─30s─▶ │ Flush    │  ─────▶  │ Final   │
    │ Request  │  timer  │ Chunk    │          │ Request │
    │          │         │ Request  │          │ (stream)│
    └─────────┘          └──────────┘          └─────────┘

    System prompt cached   Cache advances      Full text cached
    UUID generated         Conversation grows   Model outputs cleanup
    max_tokens=1           max_tokens=1         max_tokens=4096
```

1. **`beginSession()`** — called when recording is committed (hold
   confirmed or double-tap locked). Generates a UUID. Sends the
   framing message: "Everything until you see `<UUID>` is raw
   dictation." `max_tokens: 1`, response discarded (placeholder
   `"..."` stored). System prompt gets cached.

2. **`feedText(text)`** — called for each VOSK final text segment.
   Buffers text. Every 30 seconds, the buffer is flushed as an
   intermediate conversation turn (`max_tokens: 1`). Cache advances
   with each flush — the prefix of the conversation is read from
   cache at 10% cost.

3. **`finalize(onDelta)`** — called when recording stops. Sends
   remaining buffered text + the UUID as the final user message.
   The model generates the cleaned output, streamed back via SSE.
   Returns the full cleaned text, or `null` on failure.

4. **`cancelSession()`** — called on discard. Cancels in-flight
   HTTP requests, resets state.

#### Prompt Caching Details

- System prompt must be ≥ 4096 tokens for Haiku 4.5's cache
  threshold (the `prompts/system.txt` file is padded with examples
  to meet this).
- Top-level `cache_control: {type: "ephemeral"}` on every request
  enables automatic cache advancement.
- Explicit `cache_control` on the system prompt content block too.
- Cache reads cost 10% of base input price. Cache writes cost 125%.
- Typical cost per dictation: ~$0.001.

#### SSE Stream Parsing

The final request uses `stream: true`. The response is parsed as
Server-Sent Events:
- `event: content_block_delta` with `data.delta.type == "text_delta"`
  — contains a text chunk
- `event: message_stop` — end of response

SSE parsing uses `Soup3.Session.send_async()` → `GInputStream` →
`Gio.DataInputStream.read_line_async()` line by line.

#### Error Handling

- 3 retries with exponential backoff (200ms, 800ms, 3200ms)
- Intermediate request failures are non-fatal — text stays in the
  buffer and is included in the next flush or the final request
- Final request failure returns `null` — caller falls back to raw
  STT text
- Network errors, 5xx errors, and rate limits all trigger retry

#### External Prompt Files

Prompts are loaded at the start of each recording session (not at
extension enable time), so edits take effect without restarting
GNOME Shell:

1. Check GSettings path (`system-prompt-path` / `framing-prompt-path`)
2. If empty, load bundled file from `<extension>/prompts/system.txt`
   or `framing.txt`
3. If bundled file missing, use hardcoded fallback

The framing prompt uses `{{UUID}}` as a placeholder, replaced with
the session UUID at runtime.

### ollama.js — Local AI Cleanup

Alternative AI backend using a local Ollama server (OpenAI-compatible
API). Much simpler than the Anthropic backend: no multi-turn
conversation, no prompt caching, no chunk flushing. Accumulates raw
STT text during recording, then sends a single streaming request to
Ollama on stop.

Selectable via the `ai-backend` GSettings key (`'anthropic'` or
`'ollama'`). Both backends implement the same interface (`beginSession`,
`feedText`, `finalize`, `cancelSession`) so `extension.js` can swap
them transparently.

### output.js — Clipboard Paste

#### Why Not wtype?

`wtype` requires the `zwp_virtual_keyboard_v1` Wayland protocol.
GNOME Shell's compositor does not implement this protocol. `wtype`
fails with "Compositor does not support the virtual keyboard
protocol" on GNOME Wayland.

#### Why Not xdotool?

`xdotool` works through XWayland but triggers the Remote Desktop
portal permission popup on Wayland, which is unacceptable UX.

#### The Solution: St.Clipboard + VirtualInputDevice

Since we're inside the GNOME Shell process, we have direct access to:

- `St.Clipboard.get_default()` — the Shell's clipboard API
- `Clutter.VirtualInputDevice` — synthesize key events within the
  compositor

The output flow:

1. Save current clipboard text (`St.Clipboard.get_text()`)
2. Set clipboard to the transcribed text (`St.Clipboard.set_text()`)
3. Create a virtual keyboard device via
   `global.stage.context.get_backend().get_default_seat().create_virtual_device()`
4. Synthesize Shift+Insert (press Shift, press Insert, release
   Insert, release Shift) with 50ms delays between events
5. After a 200ms settle delay, restore the previous clipboard contents
6. Destroy the virtual device

#### Why Shift+Insert?

- More universal than Ctrl+V — works in terminals without special
  handling
- Avoids conflicts with applications that remap Ctrl+V
- No need for terminal detection logic (VTE apps set
  `Clutter.InputContentPurpose.TERMINAL` but non-VTE terminals don't)

### ui/panelIcon.js — Status Indicator

A `PanelMenu.Button` subclass that shows a microphone icon in the top
bar. The icon's style class changes based on state:
- `speakeasy-icon-idle` — grey
- `speakeasy-icon-recording` — red
- `speakeasy-icon-locked` — orange
- `speakeasy-icon-processing` — yellow

The dropdown menu contains:
- Toggle switch for click-to-start/stop
- Status label showing current state
- Show Transcripts (opens transcript history dialog)
- Preferences

### ui/recordingOverlay.js — Recording Overlay

A floating, draggable overlay displayed during recording and
processing. Shows:

- Microphone icon + real-time audio waveform visualization
- Auto-scrolling transcript area with finalized text (white) and
  partial/interim text (grey italic)
- Spinner + status text during post-transcription AI cleanup

Partial text is displayed via a persistent `St.Label` that is always
the last child in the transcript box. Final text segments are
inserted before it. When switching to processing mode, the partial
label is cleared.

### ui/transcriptDialog.js — Transcript History

Modal dialog showing past transcription results. Each entry displays
a timestamp and text content with a copy-to-clipboard button.  When
AI cleanup was used, a toggle button switches between cleaned and raw
STT text.

### prefs.js — Preferences UI

Uses libadwaita (`Adw`) for a native GNOME preferences dialog with
five pages: General, Speech Recognition, AI Cleanup, Advanced, and
Developer.

The accelerator picker uses a custom capture dialog: opens an
`Adw.AlertDialog`, attaches a `Gtk.EventControllerKey`, and captures
the next keypress as the new trigger accelerator.

## Data Flow

### Recording Session (with AI)

```
User presses key
    │
    ▼
keybinding.js: IDLE → RECORDING
    │
    ├── extension.js: _startRecording()
    │       recorder.start() → capture pipeline created
    │
    │   [user holds key — commit detected]
    │
    ├── keybinding.js: fires onCommitRecording
    │       extension.js → ai.beginSession()
    │           → HTTP POST (framing message, max_tokens=1)
    │           → system prompt cached
    │
    │   [user speaks — VOSK produces text segments]
    │
    ├── recorder → onFinalText(segment)
    │       extension.js → ai.feedText(segment)
    │       [every 30s: ai flushes buffer as intermediate turn]
    │
    │   [user releases key — release detected via gap timeout]
    │
    ▼
keybinding.js: RECORDING → PROCESSING
    │
    ├── extension.js: _stopRecording()
    │       recorder.stop() → returns accumulated text
    │       ai.finalize() → HTTP POST (remaining text + UUID)
    │           → streams SSE response
    │           → returns cleaned text
    │       output.typeText(cleanedText)
    │           → clipboard set
    │           → Shift+Insert synthesized
    │           → clipboard restored
    │
    ▼
keybinding.js: PROCESSING → IDLE
```

### Recording Session (without AI)

```
[same as above through recording]
    │
    ▼
extension.js: _stopRecording()
    │   ai.isAvailable() → false
    │   output.typeText(rawSttText)
    ▼
keybinding.js: PROCESSING → IDLE
```
