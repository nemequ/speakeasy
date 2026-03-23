# Speakeasy Development Guide

## Environment

- **OS**: Fedora 43
- **GNOME Shell**: 49.4
- **GJS**: 1.86.0
- **Mutter**: 49.4
- **GStreamer**: 1.26.10
- **Extension format**: ESM modules (`import ... from 'gi://...'`)

## Development Workflow

### Nested GNOME Shell (devkit)

The fastest way to iterate on extension code without logging out:

```sh
# Basic — logs to terminal, close window to stop
dbus-run-session gnome-shell --devkit --wayland

# With a different trigger key (avoids conflict with host session)
dbus-run-session bash -c \
  "gsettings set org.gnome.shell.extensions.speakeasy trigger-accel 'Scroll_Lock' \
   && gnome-shell --devkit --wayland"
```

Requires `mutter-devel` package (`sudo dnf install mutter-devel`).

The devkit runs a nested GNOME Shell in a window on your desktop.
The extension loads from the same `~/.local/share/gnome-shell/extensions/`
directory. All logs print to the terminal. Close the window (or
Ctrl+C) to stop, edit code, relaunch.

**Devkit limitations:**
- `wtype` does not work (compositor doesn't support virtual keyboard
  protocol) — output will fail, but transcription can be verified
  from logs
- Clipboard paste via `St.Clipboard`/`Clutter.VirtualInputDevice`
  works within the nested session but not back to the host
- Both host and nested sessions grab the same trigger key — disable
  the extension in the host or use a different key for the nested
  session

### Schema Compilation

After modifying the GSettings XML schema:

```sh
glib-compile-schemas schemas/
```

The compiled schema must be up to date before the extension loads.

### Reloading Code

**GNOME Shell on Wayland does NOT reload extension JavaScript on
disable/enable.** ESM modules are cached by the JS engine. You must
restart GNOME Shell:

- **Devkit**: close and relaunch the nested session
- **Real session**: log out and back in

**NEVER run `killall -HUP gnome-shell` on Wayland** — it causes a
black screen requiring a full reboot.

### Standalone Testing

Unit tests can be run outside GNOME Shell:

```sh
make test                           # run all tests
gjs -m tests/test-recorder.js      # VOSK/Whisper parsing tests
gjs -m tests/test-ai.js            # AICleanup + OllamaCleanup tests
gjs -m tests/test-keybinding.js    # keybinding state machine tests
gjs -m tests/test-ollama.js        # standalone Ollama integration test
```

The output module (`St.Clipboard`, `Clutter.VirtualInputDevice`)
cannot be tested outside GNOME Shell — those APIs only exist inside
the compositor process.

### Viewing Logs

```sh
# Real session
journalctl --user -f -g Speakeasy

# Devkit session — logs print directly to terminal
```

## GJS/GNOME Shell API Gotchas

These are things that behave differently from what you might expect
or from typical JavaScript. Every one of these was discovered the
hard way during development.

### GObject Property Access

GJS's `GObject.get_property(name)` requires two arguments (GObject
style), not one. Use the direct property accessor instead:

```javascript
// WRONG — throws "At least 2 arguments required"
const value = element.get_property('current-final-results');

// CORRECT — use underscore-separated property name
const value = element.current_final_results;
```

### Soup3 API

```javascript
// WRONG — constructor may not work in all GJS versions
const msg = new Soup.Message({method: 'POST', uri: uri});

// CORRECT — use factory method
const msg = Soup.Message.new_from_uri('POST', uri);

// WRONG — method doesn't exist in Soup3
const status = msg.get_status();

// CORRECT — use property
const status = msg.status_code;
```

### MessageTray Notifications

```javascript
// WRONG — removed in GNOME 45+
Main.notify('Title', 'Body');

// CORRECT — create source and notification objects
const source = new MessageTray.Source({
    title: 'Speakeasy',
    iconName: 'audio-input-microphone-symbolic',
});
Main.messageTray.add(source);
const notification = new MessageTray.Notification({
    source,
    title: 'Speakeasy',
    body: 'Some message',
});
source.addNotification(notification);
```

### PopupMenu Items

```javascript
// WRONG — methods don't exist
item.setToggleState(true);
item.setSensitive(false);

// CORRECT — use properties
item.state = true;
item.sensitive = false;
```

### Adw.AlertDialog (GNOME 49)

```javascript
// WRONG — AlertDialog has no get_content_area()
const area = dialog.get_content_area();
area.add_controller(keyController);

// CORRECT — add controller directly to dialog
dialog.add_controller(keyController);

// WRONG — close() may not exist on AlertDialog
dialog.close();

// CORRECT
dialog.force_close();
```

### Virtual Input Device

```javascript
// WRONG — may not exist in the shell context
const seat = Clutter.get_default_backend().get_default_seat();

// CORRECT — use the Shell's own path
const seat = global.stage.context.get_backend().get_default_seat();
const vkbd = seat.create_virtual_device(
    Clutter.InputDeviceType.KEYBOARD_DEVICE);
```

### Prefs.js Import Path

GNOME 49 uses capital letters in the resource path:

```javascript
// CORRECT for GNOME 49
import {ExtensionPreferences} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
```

### GStreamer Threading

GStreamer `new-sample` and similar signals fire on streaming threads,
not the GLib main loop. GJS blocks cross-thread JavaScript calls.
Do not use `appsrc`/`appsink` for pipeline bridging — use
`interaudiosrc`/`interaudiosink` which handle everything in native
GStreamer threads.

### GLib.Bytes Construction

```javascript
// May need different forms depending on GJS version
const bytes = new GLib.Bytes(new TextEncoder().encode(jsonStr));
// or
const bytes = GLib.Bytes.new(new TextEncoder().encode(jsonStr));
```

## Decision Log

Key design decisions and why they were made.

### Why a GNOME Shell Extension (not a standalone app)?

GNOME Wayland prevents applications from creating always-on-top
floating overlays, intercepting keyboard events globally, or
controlling window position. A Shell extension runs inside the
compositor and can:
- Intercept key press/release events via `grab_accelerator`
- Draw persistent panel indicators and overlay widgets via `St`
- Access the clipboard and synthesize key events directly

A Python daemon with D-Bus was originally planned but abandoned
once we realized the extension could handle everything.

### Why VOSK (not Whisper)?

- VOSK has a GStreamer plugin available in Fedora repos now
- Streaming partial results during recording
- CPU-based, no GPU required
- GStreamer 1.28.1 will add a native `whisper` element — the code
  has a provisional pipeline definition ready to activate

### Why Clipboard Paste (not wtype)?

- `wtype` requires `zwp_virtual_keyboard_v1` which GNOME Shell
  does not implement
- `xdotool` triggers the Remote Desktop portal permission popup
- Clipboard + virtual keyboard works natively inside the Shell
  process with no external dependencies

### Why Shift+Insert (not Ctrl+V)?

- Works in terminals without special-casing
- Avoids conflicts with apps that remap Ctrl+V
- No need for terminal detection logic
- Discovered via research into how `clipboard-indicator` extension
  handles this

### Why Split Pipeline (interaudio)?

Need to keep VOSK model loaded (avoids 1.5-3s reload latency) while
fully releasing the microphone when idle (privacy indicator). Tested
alternatives:

| Approach | Result |
|----------|--------|
| Pipeline PAUSED idle | VOSK works, but corked PulseAudio stream triggers mic indicator |
| Pipeline READY idle | VOSK breaks on 2nd recording cycle |
| Pipeline NULL idle | 1.5-3s startup latency |
| pulsesrc NULL (rest PAUSED) | Breaks data flow, VOSK gets nothing |
| pipewiresrc | Same behavior as pulsesrc, 3s NULL→PLAYING |
| appsrc/appsink bridge | GJS blocks cross-thread callbacks |
| **interaudiosrc/interaudiosink** | Works: model stays loaded, mic fully released, ~700ms startup |

### Why 700ms Release Gap?

The keyboard repeat delay (time between initial press and first
repeat) is typically 250-600ms. Our gap detection timeout must be
longer than this to avoid false release detection during a hold.
700ms provides margin. The tradeoff: after releasing the key, you
must wait 700ms before the next tap registers. For dictation this
is fine — recordings last seconds, not milliseconds.

### Why Multi-Turn AI (not single-shot)?

Anthropic's prompt caching means previously-seen conversation
prefixes are read at 10% cost. By streaming STT chunks as
intermediate conversation turns during recording, most input is
already cached when the user stops speaking. The final request's
time-to-first-token is minimized because only the last small chunk
needs processing.

### Why External Prompt Files?

GNOME Shell on Wayland requires logout/login to reload extension
JavaScript. Prompt files are re-read at the start of each recording
session, so you can tune prompts without restarting the desktop.

### Why Opus for Audio Retention?

~180 KB/min vs ~1.9 MB/min for WAV. Both `opusenc` and `oggmux`
are in `gst-plugins-good` (always available). The `queue
leaky=downstream` on the file branch makes it fault-tolerant —
if disk I/O stalls, buffers are dropped rather than blocking the
STT pipeline.

### nerd-dictation / ibus-speech-to-text

Both were explored before building Speakeasy:

- **nerd-dictation**: works on X11 but needs `xdotool`/`wtype` for
  output, no overlay, no AI cleanup, no Wayland keybinding support
- **ibus-speech-to-text** (Fedora 42+ feature): unreliable — engine
  started before model was installed, locale setting issues, engine
  recognized speech but didn't commit text to applications. Abandoned.

## Remaining Work

### Future
- Whisper STT backend (when GStreamer 1.28.1+ is available)
- Streaming output (type text as AI generates it, if a reliable
  character-by-character output method is found)
- Retry-from-audio in transcript history

## Keybinding Timing Parameters

All configurable via GSettings and the Advanced preferences page:

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `release-gap-ms` | 700 | Silence duration to detect key release |
| `inter-tap-gap-ms` | 60 | Min gap between repeat events to detect re-press |
| `repeat-delay-ms` | 400 | Upper bound for inter-tap detection (above = repeat delay, not re-press) |
| `double-tap-window-ms` | 500 | Time to wait for 2nd tap before discarding |
| `hold-threshold` | 5 | Min repeat events to consider a press a "hold" vs "tap" |
