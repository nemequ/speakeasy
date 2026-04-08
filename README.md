# Speakeasy — GNOME Shell Dictation Extension

Voice dictation for GNOME Shell 49 (Wayland) with AI text cleanup.
Hold a key to dictate, or double-tap to lock recording on and walk
away from the keyboard. When you're done, the transcribed text is
cleaned up and pasted into whatever application has focus.

## What It Does

Speakeasy is a GNOME Shell extension that provides:

- **Push-to-talk dictation** via a configurable hotkey (default: Pause)
- **Hold-to-talk**: hold the key, speak, release to output text
- **Double-tap-to-lock**: tap twice to lock recording on, tap again to stop
- **Streaming speech-to-text** via VOSK (gst-vosk GStreamer plugin)
- **AI text cleanup** via Anthropic Claude (Haiku 4.5) with prompt caching
- **Privacy-respecting mic handling**: microphone is fully released when not recording
- **Text output via clipboard paste** (Shift+Insert) — works in all Wayland apps
- **Audio retention**: raw audio saved for retry on transcription failure
- **Developer mode**: save transcripts and audio for QA/prompt tuning

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
- Trigger key (opens a capture dialog)
- Output method
- Max transcript history entries

**Speech Recognition**:
- STT backend (VOSK / Whisper — whisper requires GStreamer 1.28.1+)
- VOSK model path (auto-detected from `~/.cache/vosk/`)
- Whisper model path and language

**AI Cleanup**:
- Enable/disable toggle
- Anthropic API key
- Model selection (default: `claude-haiku-4-5-20250807`)

**Developer**:
- Developer mode toggle (saves transcripts + keeps audio)
- Transcript save directory (default: `~/.local/share/speakeasy/transcripts`)
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
├── extension.js            # Main entry point — wires all components
├── keybinding.js           # Push-to-talk state machine (hold/double-tap/discard)
├── recorder.js             # GStreamer pipeline IPC client
├── stt-subprocess.js       # STT subprocess (GStreamer + VOSK/Whisper, runs out-of-process)
├── ai.js                   # Anthropic API client (multi-turn, prompt caching, SSE)
├── ollama.js               # Ollama local AI client (OpenAI-compatible API)
├── output.js               # Clipboard paste via St.Clipboard + Shift+Insert
├── utils.js                # Shared utilities (async sleep helper)
├── warm-cache.py           # Startup helper — warms GStreamer registry + VOSK model page cache
├── prefs.js                # Extension preferences UI (Adw/libadwaita)
├── stylesheet.css          # Panel icon state colors, overlay and transcript dialog styles
├── ui/
│   ├── panelIcon.js        # Top bar indicator (mic icon, toggle, status label)
│   ├── recordingOverlay.js # Floating recording overlay (waveform, live transcript)
│   └── transcriptDialog.js # Modal dialog for transcript history
├── schemas/
│   ├── org.gnome.shell.extensions.speakeasy.gschema.xml
│   └── gschemas.compiled
├── prompts/
│   ├── system.txt          # AI system prompt (~4096+ tokens for cache threshold)
│   └── framing.txt         # Per-session framing message ({{UUID}} placeholder)
└── tests/
    ├── test-recorder.js    # VOSK/Whisper parsing and model detection tests
    ├── test-ai.js          # AICleanup and OllamaCleanup unit tests
    ├── test-keybinding.js  # Keybinding state machine tests
    └── test-ollama.js      # Standalone Ollama integration test harness
```

## Current Status

### Working
- VOSK speech-to-text with streaming partial/final results
- Hold-to-talk and double-tap-to-lock keybinding
- Accidental single-tap discard
- AI cleanup via Anthropic API with multi-turn prompt caching
- Local AI cleanup via Ollama (OpenAI-compatible API)
- Clipboard paste output (Shift+Insert)
- Recording overlay with waveform visualization and live transcript
- Transcript history dialog (accessible from panel menu)
- Audio retention (Opus/Ogg) on transcription failure
- Developer mode transcript saving
- External prompt files (reloaded per session)
- Preferences UI (General, STT, AI, Advanced timing, Developer)

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
