# Speakeasy — GNOME Shell Dictation Extension

Voice dictation for GNOME Shell 49 (Wayland) with AI text cleanup.
Hold a key to dictate, or double-tap to lock recording on and walk
away from the keyboard. When you're done, the transcribed text is
cleaned up and pasted into whatever application has focus.

## What It Does

Speakeasy is a GNOME Shell extension that provides:

- **Push-to-talk dictation** via one or more configurable hotkeys
  (default: Pause). Bind several keys at once — useful for users
  with multiple keyboards or for routing a Steam Deck back-grip
  button through Steam Input.
- **Hold-to-talk**: hold the key, speak, release to output text.
- **Double-tap-to-lock**: tap twice to lock recording on, tap again
  to stop.
- **Streaming speech-to-text** via VOSK (gst-vosk GStreamer plugin),
  with a separate STT subprocess so the heavy model load never
  blocks the compositor.
- **AI text cleanup** via Anthropic Claude (default Haiku 4.5) with
  multi-turn prompt caching, or via a local Ollama server.
- **Privacy-respecting mic handling**: microphone is fully released
  when not recording.
- **Text output via clipboard paste** (Shift+Insert) — works in
  all Wayland apps.
- **Crash-safe per-session log**: every committed STT segment is
  written to a JSON Lines file before any other processing, so a
  hang or crash in the AI/output/save chain never loses what the
  user already said. Orphan logs are automatically converted into
  recovery transcripts on the next startup.
- **Recovery from existing audio files**: a panel menu entry
  ("Recover from Audio File...") lets the user re-transcribe any
  Opus / WAV / MP3 / FLAC / Ogg / M4A file through the same VOSK
  pipeline. Optional AI cleanup pass runs in the background after
  save.
- **Bounded AI requests**: configurable HTTP timeout and a
  conversation-history cap protect the stop-recording path from a
  hung or unbounded AI backend.
- **Stop watchdog**: if the STT subprocess wedges on the stop
  command (e.g. VOSK's flush gets stuck), the parent SIGKILLs it
  after a configurable timeout, synthesizes the result from
  already-committed segments, and respawns the subprocess.
- **Audio retention** as an independent toggle: keep the .opus
  recording on disk after a successful session.
- **Standalone GTK test app**: run the same dictation pipeline as
  a regular Gtk.Application (`make gtk`) for debugging without
  having to log out of GNOME Shell.

## System Requirements

- **GNOME Shell 49** (Fedora 43+)
- **GStreamer 1.26+** with the `gst-vosk` plugin (`gstreamer1-plugin-vosk` on Fedora)
- **A VOSK model** — the large English model is recommended:
  `~/.cache/vosk/vosk-model-en-us-0.22/` (1.8 GB)
- **PipeWire/PulseAudio** (standard on modern Fedora)
- **Anthropic API key** (optional, for AI cleanup — without it, raw STT output is used)

### Installing Dependencies (Fedora)

```sh
# GStreamer VOSK plugin
sudo dnf install gstreamer1-plugin-vosk

# Download the large English VOSK model
mkdir -p ~/.cache/vosk
wget -c https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip -O /tmp/vosk-model.zip
unzip -q /tmp/vosk-model.zip -d ~/.cache/vosk/
rm /tmp/vosk-model.zip
```

The small model (`vosk-model-small-en-us-0.15`, ~40 MB) works too but
produces lower-quality output. With AI cleanup enabled, the quality
difference matters less.

## Installation

The extension is installed at:
```
~/.local/share/gnome-shell/extensions/speakeasy@speakeasy.local/
```

Enable it:
```sh
gnome-extensions enable speakeasy@speakeasy.local
```

After enabling for the first time, log out and back in (GNOME Shell on
Wayland does not reload extension JavaScript on enable/disable — it
caches ESM modules).

## Usage

### Panel Icon

A microphone icon appears in the GNOME Shell top bar:
- **Grey**: idle
- **Red**: recording
- **Orange**: locked (double-tap mode)
- **Yellow**: processing (transcribing/AI cleanup)

Click the icon for a dropdown menu with a toggle switch to start/stop
recording.

### Keybinding (Default: Pause Key)

| Action | What Happens |
|--------|-------------|
| **Hold key, speak, release** | Records while held, outputs text on release |
| **Tap, tap** (double-tap) | Locks recording on — hands-free dictation |
| **Tap while locked** | Stops recording and outputs text |
| **Single tap, no follow-up** | Discards (accidental tap protection) |

The trigger key is configurable in the extension preferences. Only
non-modifier keys work (Pause, Scroll_Lock, F13, etc.) — GNOME Shell's
Mutter compositor consumes modifier-only key events before extensions
can intercept them.

### AI Cleanup

When an Anthropic API key is configured, raw STT output is cleaned up
by Claude Haiku 4.5 before being pasted. The AI:

- Fixes capitalization and punctuation
- Removes filler words ("um", "uh", "like")
- Corrects obvious mishearings
- Preserves the speaker's intent and word choice

The system prompt and framing prompt are loaded from external files in
the `prompts/` directory and can be edited without restarting GNOME
Shell — they're re-read at the start of each recording session.

Without an API key, raw VOSK output is pasted directly (lowercase, no
punctuation).

## Configuration

Open preferences via:
```sh
gnome-extensions prefs speakeasy@speakeasy.local
```

Or from the GNOME Extensions app.

### Settings Pages

**General**:
- Trigger keys (one or more — list view with add/remove)
- Max transcript history entries
- Storage:
  - Retain audio recordings (keeps the .opus file after success)
  - Audio directory (default: `~/.local/share/speakeasy/audio`)
  - Transcript directory (default: `~/.local/share/speakeasy/transcripts`)

**Speech Recognition**:
- STT backend (VOSK / Whisper — whisper requires GStreamer 1.28.1+)
- VOSK model path (auto-detected from `~/.cache/vosk/`)
- Whisper model path and language
- Audio input device (PulseAudio/PipeWire source picker)

**AI Cleanup**:
- Enable/disable toggle
- Backend (Anthropic / Ollama)
- Anthropic: API key, model, proxy URL + CA cert
- Ollama: server URL + model
- Robustness:
  - Request timeout (seconds) — bounds any single AI HTTP call
  - History cap (turn pairs) — bounds the conversation size

**Advanced (timing)**:
- Keybinding timing parameters (release gap, inter-tap gap,
  repeat delay, double-tap window, hold threshold)
- Stop watchdog timeout (seconds)

**Developer**:
- Verbose logging toggle (extra per-event log lines)
- Custom system prompt file path
- Custom framing prompt file path

### GSettings Keys

All settings live under `org.gnome.shell.extensions.speakeasy`. Key
settings can be changed from the command line:

```sh
# Set the trigger keys (one or more — pressing any of them activates push-to-talk)
GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/speakeasy@speakeasy.local/schemas/ \
  gsettings set org.gnome.shell.extensions.speakeasy trigger-accels "['Scroll_Lock', 'Pause']"

# Set the Anthropic API key
GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/speakeasy@speakeasy.local/schemas/ \
  gsettings set org.gnome.shell.extensions.speakeasy anthropic-api-key 'sk-ant-...'

# Enable verbose logging
GSETTINGS_SCHEMA_DIR=~/.local/share/gnome-shell/extensions/speakeasy@speakeasy.local/schemas/ \
  gsettings set org.gnome.shell.extensions.speakeasy verbose-logging true
```

## File Structure

```
speakeasy@speakeasy.local/
├── metadata.json           # Extension metadata (GNOME 49, uuid, version)
├── extension.js            # Shell entry point — wires DictationController to UI
├── controller.js           # Portable DictationController — recorder/AI/output orchestration
├── keybinding.js           # Push-to-talk state machine (hold/double-tap/discard)
├── recorder.js             # STT subprocess IPC client + stop watchdog
├── stt-subprocess.js       # STT subprocess (GStreamer + VOSK/Whisper, runs out-of-process)
├── sessionLog.js           # Crash-safe per-session JSONL log + orphan recovery
├── ai.js                   # Anthropic API client (multi-turn, prompt caching, SSE)
├── ollama.js               # Ollama local AI client (OpenAI-compatible API)
├── output.js               # Clipboard paste via St.Clipboard + Shift+Insert
├── fileTranscribe.js       # Out-of-process file transcriber driver (NDJSON IPC)
├── gtk-app.js              # Standalone GTK test app (drives the same controller)
├── utils.js                # Shared utilities (async sleep helper)
├── warm-cache.py           # Startup helper — warms GStreamer registry + VOSK model page cache
├── prefs.js                # Extension preferences UI (Adw/libadwaita)
├── stylesheet.css          # Panel icon, overlays, dialogs
├── ui/
│   ├── panelIcon.js        # Top bar indicator (mic icon, menu)
│   ├── recordingOverlay.js # Floating recording overlay (waveform, live transcript)
│   ├── transcriptDialog.js # Modal: transcript history with per-row raw/cleaned toggle
│   ├── recoveryDialog.js   # Modal: live progress for "Recover from Audio File..."
│   └── pathPromptDialog.js # Modal: fallback path entry when no file picker is installed
├── tools/
│   └── transcribe-file.js  # Standalone CLI transcribe tool, also driven by fileTranscribe.js
├── schemas/
│   ├── org.gnome.shell.extensions.speakeasy.gschema.xml
│   └── gschemas.compiled
├── prompts/
│   ├── system.txt          # AI system prompt (~4096+ tokens for cache threshold)
│   └── framing.txt         # Per-session framing message ({{UUID}} placeholder)
└── tests/
    ├── test-ai.js                  # AICleanup + OllamaCleanup unit tests
    ├── test-ai-integration.js      # Full AI session lifecycle vs mock HTTP server
    ├── test-controller.js          # DictationController orchestration tests
    ├── test-file-transcribe.js     # FileTranscriber NDJSON parser tests
    ├── test-keybinding.js          # Keybinding state machine tests
    ├── test-ollama.js              # Standalone Ollama smoke test
    ├── test-recorder-watchdog.js   # Recorder stop watchdog regression tests
    └── test-session-log.js         # SessionLog write/parse/recover tests
```

`make test` runs the unit tests; `make gtk` launches the standalone
GTK test app for debugging without restarting GNOME Shell. Run
`make help` for the full list of targets.

## Current Status

### Working
- VOSK speech-to-text with streaming partial/final results
- Hold-to-talk and double-tap-to-lock keybinding (multi-key trigger)
- Accidental single-tap discard
- AI cleanup via Anthropic API with multi-turn prompt caching
  (bounded request size + HTTP timeout)
- Local AI cleanup via Ollama (OpenAI-compatible API)
- Clipboard paste output (Shift+Insert)
- Recording overlay with waveform visualization and live transcript
- Transcript history dialog with per-row raw/cleaned toggle
- Crash-safe per-session JSONL log + automatic orphan recovery
- Recover-from-audio-file UI (zenity / kdialog / inline path prompt)
- Audio retention to a persistent location (independent toggle)
- Stop watchdog with automatic STT subprocess respawn
- External prompt files (reloaded per session)
- Preferences UI (General, STT, AI, Advanced, Developer)
- Standalone GTK test app (`make gtk`)

### Not Yet Implemented
- Whisper STT backend — provisional pipeline definition exists, waiting
  for GStreamer 1.28.1+ (which adds a native `whisper` element)
- Streaming output (type text as AI generates it)

## Status

This project is entirely AI-coded and works for the author's setup
(Fedora 43, GNOME Shell 49, Wayland). Your mileage may vary. It is
not currently submitted to the GNOME Shell extension registry and there
are no immediate plans to stabilize it for broader distribution.

That said, if someone wants to pick this up and run with it, you're
more than welcome to.

## License

MIT — see [COPYING](COPYING).
