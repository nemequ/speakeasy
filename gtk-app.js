#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Speakeasy — Standalone GTK test app
//
// A regular Gtk.Application that drives the same DictationController
// as the GNOME Shell extension. Lets you exercise and debug the
// recorder + STT subprocess + AI cleanup + transcript pipeline
// outside the compositor, where:
//
//   - the JS context can be killed and restarted in seconds
//   - hangs don't take the whole desktop down with them
//   - you can attach a debugger or profiler
//   - you don't need to log out to reload changed code
//
// What's missing vs the extension (intentionally):
//   - The trigger key. Use the on-window F5/F6 shortcuts or the
//     Start / Stop buttons.
//   - The recording overlay. The window itself shows the same info.
//   - Clipboard / virtual-keyboard paste. Cleaned text is appended
//     to the result text view in this window — that's enough to
//     verify the pipeline ran end-to-end.
//
// Run: gjs -m gtk-app.js   (or `make gtk`)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';

import {Recorder} from './recorder.js';
import {AICleanup} from './ai.js';
import {OllamaCleanup} from './ollama.js';
import {recoverOrphans} from './sessionLog.js';
import {DictationController, ControllerState} from './controller.js';
import {FileTranscriber} from './fileTranscribe.js';
import {runRecoveryCleanupWithFeedback} from './recoveryCleanup.js';
import {validateAudioPath} from './ui/pathValidation.js';
import {openTranscriptHistoryWindow} from './ui/transcriptHistoryWindow.js';
import {runTestRecording} from './testRecording.js';

const APP_ID = 'local.speakeasy.test';
const SCHEMA_ID = 'org.gnome.shell.extensions.speakeasy';

// Resolve the project directory from this file's URL so the
// recorder can find the speakeasy binary and the prompts/ folder.
const PROJECT_DIR = (() => {
    const [path] = GLib.filename_from_uri(import.meta.url);
    return GLib.path_get_dirname(path);
})();

// Load the GSettings schema from the local schemas/ dir, so the
// app works without `gnome-extensions install`.
function loadSettings() {
    const schemaDir = GLib.build_filenamev([PROJECT_DIR, 'schemas']);
    const source = Gio.SettingsSchemaSource.new_from_directory(
        schemaDir,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = source.lookup(SCHEMA_ID, false);
    if (!schema)
        throw new Error(`Schema ${SCHEMA_ID} not found in ${schemaDir} — run \`make schemas\` first.`);
    return new Gio.Settings({settings_schema: schema});
}

// ─── TextViewOutput ──────────────────────────────────────────────────
//
// The output target for the controller. The Shell extension uses a
// clipboard + virtual-keyboard implementation; for the test app we
// just append the cleaned text to a Gtk.TextView. That's enough to
// confirm the pipeline reached the output stage.

class TextViewOutput {
    constructor(textView) {
        this._textView = textView;
    }
    init() { return true; }
    async typeText(text) {
        const buffer = this._textView.buffer;
        const end = buffer.get_end_iter();
        const stamp = new Date().toLocaleTimeString();
        buffer.insert(end, `[${stamp}] ${text}

`, -1);
        // Scroll to bottom
        const mark = buffer.get_insert();
        this._textView.scroll_mark_onscreen(mark);
        return true;
    }
    destroy() {}
}

// ─── Application ────────────────────────────────────────────────────

const app = new Gtk.Application({
    application_id: APP_ID,
    flags: Gio.ApplicationFlags.FLAGS_NONE,
});

app.connect('activate', () => {
    const settings = loadSettings();

    // Migrate user to whisper backend if they are still on vosk or dlgo
    const currentStt = settings.get_string('stt-backend');
    if (currentStt === 'vosk' || currentStt === 'dlgo') {
        print(`[gtk-app] migrating stt-backend from ${currentStt} to whisper`);
        settings.set_string('stt-backend', 'whisper');
    }

    // Recover any orphan session logs from a previous crash.
    try {
        const transcriptDir = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'speakeasy', 'transcripts',
        ]);
        const recovered = recoverOrphans(null, transcriptDir);
        if (recovered.length > 0)
            print(`[gtk-app] recovered ${recovered.length} orphan session log(s)`);
    } catch (e) {
        print(`[gtk-app] orphan recovery failed (non-fatal): ${e.message}`);
    }

    // ── Build the recorder ──
    const recorder = new Recorder();
    recorder.setExtensionDir(PROJECT_DIR);
    recorder.setSettings(settings);

    // Register callback for AI-cleaned text from Rust core.
    // This text is appended directly to the results view, as the JS
    // AICleanup object is either a no-op or bypassed entirely when
    // the core handles live AI cleanup.
    recorder.onAiCleanedText((text) => {
        // Append to result view like the AI cleanup would
        const buffer = resultView.tv.buffer;
        const end = buffer.get_end_iter();
        const stamp = new Date().toLocaleTimeString();
        buffer.insert(end, `[${stamp}] (AI cleaned) ${text}

`, -1);
        const mark = buffer.get_insert();
        resultView.tv.scroll_mark_onscreen(mark);
    });

    // ── Build the AI backend ──
    // Create the real AI object, which is needed for recovery from file.
    function makeAi() {
        const backend = settings.get_string('ai-backend');
        const ai = backend === 'ollama' ? new OllamaCleanup() : new AICleanup();
        ai.setExtensionDir(PROJECT_DIR);
        ai.setSettings(settings);
        ai.init();
        return ai;
    }
    const realAi = makeAi(); // Always create the real object

    // Determine the AI object to pass to the DictationController for live use.
    // If the Rust core is configured with an AI backend (i.e., JS backend is NOT 'none'),
    // the JS AI object's feedText method is made a no-op to prevent double-cleaning.
    // The realAi object is kept available for recovery functionality.
    let controllerAi;
    const jsAiBackend = settings.get_string('ai-backend');

    if (jsAiBackend !== 'none') {
        // Rust core is active. Use a no-op AI for live dictation path.
        controllerAi = {
            ...realAi, // Inherit methods like finalize, which are needed for recovery
            feedText: async () => { /* No-op for live dictation */ },
            isAvailable: () => false, // Indicate it's not available for live use
        };
        print('[gtk-app] Live AI dictation path bypassed; Rust core is handling cleanup.');
    } else {
        // JS AI backend is 'none'. Pass the realAi object directly to the controller.
        controllerAi = realAi;
        print('[gtk-app] JS AI backend set to None.');
    }
    let ai = controllerAi; // Use controllerAi for DictationController constructor and setAi

    // ── Build the window ──
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Speakeasy \u2014 Debug Console',
        default_width: 800,
        default_height: 700,
    });

    const root = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12,
        spacing: 8,
    });
    window.set_child(root);

    // Disclaimer — make it obvious this isn't the normal way to use
    // Speakeasy. New users who open this by mistake should know the
    // real extension lives in the panel.
    const disclaimer = new Gtk.Label({
        label: 'This is a debug/test tool. The push-to-talk extension ' +
            'lives in the GNOME Shell panel.',
        xalign: 0,
        wrap: true,
        wrap_mode: 2,  // Pango.WrapMode.WORD_CHAR
        css_classes: ['dim-label'],
    });
    root.append(disclaimer);

    // Status bar with state + AI backend selector
    const statusBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
    });
    root.append(statusBox);

    const stateLabel = new Gtk.Label({
        label: '<b>State:</b> idle',
        use_markup: true,
        xalign: 0,
        hexpand: true,
    });
    statusBox.append(stateLabel);

    const backendLabel = new Gtk.Label({label: 'AI Backend:', xalign: 1});
    statusBox.append(backendLabel);

    const backendCombo = new Gtk.DropDown({
        model: Gtk.StringList.new(['Anthropic', 'Ollama', 'None']),
    });
    const currentBackend = settings.get_string('ai-backend');
    backendCombo.selected = currentBackend === 'ollama' ? 1 : 0;
    statusBox.append(backendCombo);

    // ── STT Backend ──
    const sttLabel = new Gtk.Label({label: 'STT Backend:', xalign: 1});
    statusBox.append(sttLabel);

    const sttCombo = new Gtk.DropDown({
        model: Gtk.StringList.new(['Whisper']), // Only Whisper is supported now
    });
    // Since there's only one option, its index is always 0.
    // The initial value from settings is handled by the subsequent logic.
    // sttCombo.selected = 0; 
    statusBox.append(sttCombo);

    const sttPathEntry = new Gtk.Entry({
        placeholder_text: 'Model path (empty for auto)',
        hexpand: true,
    });
    const updateSttPathValue = () => {
        // Only whisper-model-path is relevant now
        sttPathEntry.text = settings.get_string('whisper-model-path');
    };
    updateSttPathValue();
    root.append(sttPathEntry);

    sttCombo.connect('notify::selected', () => {
        const opts = ['whisper']; // Only Whisper is supported
        const sel = opts[sttCombo.selected];
        settings.set_string('stt-backend', sel);
        updateSttPathValue();
        // Trigger recorder re-init
        print(`[gtk-app] STT backend changed to ${sel}, please restart app to reload model`);
    });

    sttPathEntry.connect('activate', () => {
        settings.set_string('whisper-model-path', sttPathEntry.text);
        print(`[gtk-app] STT model path updated to ${sttPathEntry.text}`);
    });

    backendCombo.connect('notify::selected', () => {
        const opts = ['anthropic', 'ollama', 'none'];
        const sel = opts[backendCombo.selected];
        if (sel === 'none') {
            // No backend — feed straight through
            try { ai.destroy(); } catch (_e) { /* ignore */ }
            ai = {
                isAvailable: () => false,
                beginSession: () => {},
                feedText: () => {},
                cancelSession: () => {},
                async finalize() { return null; },
                destroy: () => {},
            };
        } else {
            settings.set_string('ai-backend', sel);
            try { ai.destroy(); } catch (_e) { /* ignore */ }
            ai = makeAi();
        }
        controller.setAi(ai);
    });

    // Audio level bar
    const levelBar = new Gtk.LevelBar({
        min_value: 0.0,
        max_value: 1.0,
        value: 0.0,
        margin_top: 4,
    });
    root.append(levelBar);

    // Partial label (live STT preview)
    const partialLabel = new Gtk.Label({
        label: '',
        xalign: 0,
        wrap: true,
        wrap_mode: 2,  // Pango.WrapMode.WORD_CHAR
        css_classes: ['dim-label'],
        margin_top: 4,
    });
    root.append(partialLabel);

    // Splitter: finals on top, cleaned output below
    const paned = new Gtk.Paned({
        orientation: Gtk.Orientation.VERTICAL,
        vexpand: true,
        position: 320,
    });
    root.append(paned);

    function makeTextView(label) {
        const frame = new Gtk.Frame({label});
        const scrolled = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
        });
        const tv = new Gtk.TextView({
            editable: false,
            cursor_visible: false,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            monospace: true,
            top_margin: 6,
            bottom_margin: 6,
            left_margin: 6,
            right_margin: 6,
        });
        scrolled.set_child(tv);
        frame.set_child(scrolled);
        return {frame, tv};
    }

    const finalsView = makeTextView('Live STT (finals)');
    paned.set_start_child(finalsView.frame);

    const resultView = makeTextView('Output (after AI cleanup)');
    paned.set_end_child(resultView.frame);

    // Buttons
    const buttonBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 8,
        homogeneous: true,
        margin_top: 4,
    });
    root.append(buttonBox);

    const startBtn = new Gtk.Button({
        label: 'Start (F5)',
        css_classes: ['suggested-action'],
    });
    const stopBtn = new Gtk.Button({label: 'Stop (F6)', sensitive: false});
    const discardBtn = new Gtk.Button({label: 'Discard (F7)', sensitive: false});
    const testBtn = new Gtk.Button({label: 'Test Recording (3s)'});
    const recoverBtn = new Gtk.Button({label: 'Recover from File...'});
    const historyBtn = new Gtk.Button({label: 'Show Transcripts'});
    const clearBtn = new Gtk.Button({label: 'Clear views'});
    buttonBox.append(startBtn);
    buttonBox.append(stopBtn);
    buttonBox.append(discardBtn);
    buttonBox.append(testBtn);
    buttonBox.append(recoverBtn);
    buttonBox.append(historyBtn);
    buttonBox.append(clearBtn);

    // Transcript history window
    const transcriptDir = GLib.build_filenamev([
        GLib.get_user_data_dir(), 'speakeasy', 'transcripts',
    ]);
    historyBtn.connect('clicked', () => {
        openTranscriptHistoryWindow({
            parent: window,
            transcriptDir,
            getAi: () => ai,
        });
    });

    // ── Build the controller ──
    const output = new TextViewOutput(resultView.tv);

    function appendFinal(text) {
        const buffer = finalsView.tv.buffer;
        const end = buffer.get_end_iter();
        buffer.insert(end, `${text}
`, -1);
        const mark = buffer.get_insert();
        finalsView.tv.scroll_mark_onscreen(mark);
    }

    const controller = new DictationController({
        recorder,
        ai,
        output,
        settings,
        onStateChanged: (state) => {
            stateLabel.set_markup(`<b>State:</b> ${state}`);
            // During the test recording we drive the buttons
            // manually — the helper owns start/stop, and we want
            // the other buttons locked out so the user can't
            // interfere. _testRunning is set by the Test button
            // handler below.
            if (!window._testRunning) {
                startBtn.sensitive = state === ControllerState.IDLE;
                stopBtn.sensitive = state === ControllerState.RECORDING;
                discardBtn.sensitive = state === ControllerState.RECORDING;
                testBtn.sensitive = state === ControllerState.IDLE;
            }
            if (state === ControllerState.IDLE)
                partialLabel.set_label('');
        },
        onPartialText: (text) => {
            partialLabel.set_label(text);
        },
        onFinalText: (text) => {
            partialLabel.set_label('');
            appendFinal(text);
        },
        onLevel: (rms, _peak) => {
            // The Rust core sends linear RMS scaled by 5x (0..~5).
            // Clamp to 0..1 for the level bar.
            const norm = Math.max(0, Math.min(1, rms));
            levelBar.value = norm;
        },
        onTranscript: (entry) => {
            print(`[gtk-app] transcript saved: ${entry.filePath}`);
        },
        onError: (msg) => {
            print(`[gtk-app] ERROR: ${msg}`);
            // Pop a transient toast-equivalent: prepend the message
            // to the result view so it's visible.
            const buffer = resultView.tv.buffer;
            const end = buffer.get_end_iter();
            buffer.insert(end, `[error] ${msg}
`, -1);
        },
        onLog: (msg) => print(`[gtk-app] ${msg}`),
    });

    // Helper to prepend an error message into the result view — the
    // GTK app has no MessageTray so this is where the user sees
    // startup failures (missing model, missing gst plugin, ready
    // watchdog timeout, etc.). Keeps the start button disabled so
    // the user doesn't try to record into a broken recorder.
    function showStartupError(msg) {
        print(`[gtk-app] STARTUP ERROR: ${msg}`);
        const buffer = resultView.tv.buffer;
        const end = buffer.get_end_iter();
        buffer.insert(end, `[startup error] ${msg}
`, -1);
        startBtn.sensitive = false;
        testBtn.sensitive = false;
        statusBox.set_tooltip_text(msg);
    }

    // Wait for the recorder subprocess to be ready before allowing
    // start. The button is enabled by default; we just disable it
    // until ready and re-enable in the onReady callback.
    startBtn.sensitive = false;
    testBtn.sensitive = false;
    statusBox.set_tooltip_text('Loading STT model...');
    recorder.onReady(() => {
        print('[gtk-app] STT subprocess ready');
        statusBox.set_tooltip_text(null);
        startBtn.sensitive = controller.getState() === ControllerState.IDLE;
        testBtn.sensitive = controller.getState() === ControllerState.IDLE;
    });
    recorder.onExit(msg => showStartupError(msg));
    recorder.onError(msg => showStartupError(`STT subprocess error: ${msg}`));
    if (!recorder.init()) {
        const reason = recorder.getLastInitFailureReason?.();
        showStartupError(reason?.message ??
            'STT subprocess failed to launch. See stderr for details.');
    } else {
        // 30s ready-timeout watchdog: same semantics as the Shell
        // extension. If the model doesn't load in 30s, surface a
        // visible error in the result view and keep the start
        // button disabled.
        recorder.armReadyWatchdog?.(30, () => {
            showStartupError(
                'STT model failed to load within 30 seconds. ' +
                'The subprocess may be hung or crashing. Check stderr.');
        });
    }

    // Buttons
    startBtn.connect('clicked', () => {
        const ok = controller.start();
        if (ok)
            controller.commit();  // toggle implies intent — commit immediately
    });
    stopBtn.connect('clicked', () => { void controller.stop(); });
    discardBtn.connect('clicked', () => { controller.discard(); });
    clearBtn.connect('clicked', () => {
        finalsView.tv.buffer.set_text('', -1);
        resultView.tv.buffer.set_text('', -1);
        partialLabel.set_label('');
    });

    // ── Test Recording button ──
    //
    // Automated 3-second recording that drives the whole pipeline
    // (mic -> STT -> AI cleanup -> TextViewOutput) so a new user
    // can confirm everything is wired up without committing to a
    // real dictation. The result flows through the existing
    // controller callbacks — we just own the button labels and
    // disable the other buttons while the test is in flight.
    const TEST_DURATION_SECS = 3;
    testBtn.connect('clicked', () => {
        // Pre-flight: recorder must be ready. The button is already
        // desensitized while the model loads, but a defense-in-depth
        // check keeps the error visible in the result view if
        // something slips through.
        if (!recorder.isReady?.()) {
            const buffer = resultView.tv.buffer;
            const end = buffer.get_end_iter();
            buffer.insert(end,
                `[test recording] recorder not ready yet — wait for the STT model to load
`,
                -1);
            return;
        }
        if (controller.getState() !== ControllerState.IDLE) {
            const buffer = resultView.tv.buffer;
            const end = buffer.get_end_iter();
            buffer.insert(end,
                `[test recording] controller busy (state: ${controller.getState()})
`,
                -1);
            return;
        }

        window._testRunning = true;
        const prevTestLabel = testBtn.label;
        startBtn.sensitive = false;
        stopBtn.sensitive = false;
        discardBtn.sensitive = false;
        recoverBtn.sensitive = false;
        testBtn.sensitive = false;
        testBtn.label = `Recording... (${TEST_DURATION_SECS}s)`;

        const unlock = () => {
            window._testRunning = false;
            testBtn.label = prevTestLabel;
            const idle = controller.getState() === ControllerState.IDLE;
            startBtn.sensitive = idle;
            stopBtn.sensitive = !idle && controller.getState() === ControllerState.RECORDING;
            discardBtn.sensitive = !idle && controller.getState() === ControllerState.RECORDING;
            testBtn.sensitive = idle;
            recoverBtn.sensitive = !activeRecoveryTranscriber;
        };

        runTestRecording(controller, TEST_DURATION_SECS, {
            scheduler: (cb, secs) => {
                GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
                    testBtn.label = 'Processing...';
                    // Fire the stop and restore UI once the whole
                    // stop()+AI cleanup pipeline resolves. The
                    // cleaned text will have already been appended
                    // to the result view by TextViewOutput.
                    Promise.resolve(cb()).finally(unlock);
                    return GLib.SOURCE_REMOVE;
                });
            },
        }).then((result) => {
            if (!result.started) {
                const buffer = resultView.tv.buffer;
                const end = buffer.get_end_iter();
                buffer.insert(end,
                    `[test recording] failed to start: ${result.reason ?? 'unknown'}
`,
                    -1);
                unlock();
            }
        }).catch((e) => {
            const buffer = resultView.tv.buffer;
            const end = buffer.get_end_iter();
            buffer.insert(end, `[test recording] error: ${e.message}
`, -1);
            unlock();
        });
    });

    // ── Recover from file ──
    //
    // Same flow as the Shell extension's "Recover from Audio File..."
    // menu entry, just driven from the GTK app's button. Reuses the
    // same FileTranscriber class. The result is appended to the
    // result view; if AI is available it also runs a cleanup pass.
    //
    // Tracked so we can refuse to start a second recovery while the
    // first one is still running (mirrors _activeTranscriber in the
    // Shell extension). The button is grayed out while set.
    let activeRecoveryTranscriber = null;

    recoverBtn.connect('clicked', () => {
        // Defense in depth — the button should be insensitive while
        // a recovery is in flight, but dispatch races are cheap to
        // guard against.
        if (activeRecoveryTranscriber) {
            print('[gtk-app] recovery already in progress, ignoring click');
            return;
        }
        recoverBtn.sensitive = false;
        const dialog = new Gtk.FileDialog({
            title: 'Choose audio file to transcribe',
        });
        // Default to ~/.local/share/speakeasy/audio/
        try {
            const audioDir = GLib.build_filenamev([
                GLib.get_user_data_dir(), 'speakeasy', 'audio',
            ]);
            GLib.mkdir_with_parents(audioDir, 0o755);
            dialog.set_initial_folder(Gio.File.new_for_path(audioDir));
        } catch (_e) { /* ignore */ }

        const audioFilter = new Gtk.FileFilter({name: 'Audio files'});
        for (const ext of ['opus', 'wav', 'mp3', 'flac', 'ogg', 'm4a'])
            audioFilter.add_pattern(`*.${ext}`);
        const allFilter = new Gtk.FileFilter({name: 'All files'});
        allFilter.add_pattern('*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(audioFilter);
        filters.append(allFilter);
        dialog.filters = filters;
        dialog.default_filter = audioFilter;

        dialog.open(window, null, (source, result) => {
            let file;
            try {
                file = source.open_finish(result);
            } catch (_e) {
                // user cancelled
                recoverBtn.sensitive = true;
                return;
            }
            if (!file) {
                recoverBtn.sensitive = true;
                return;
            }
            const path = file.get_path();

            // Pre-flight the path — Gtk.FileDialog usually gives us
            // a real file but guard anyway so the error is visible
            // in the result view rather than buried in a subprocess
            // stderr line.
            const {ok, error} = validateAudioPath(path);
            if (!ok) {
                const buffer = resultView.tv.buffer;
                const end = buffer.get_end_iter();
                buffer.insert(end, `[recovery error] ${error}
`, -1);
                recoverBtn.sensitive = true;
                return;
            }
            startGtkRecovery(path);
        });
    });

    function startGtkRecovery(audioPath) {
        const buffer = resultView.tv.buffer;
        const insertHeader = (text) => {
            const end = buffer.get_end_iter();
            buffer.insert(end, text, -1);
        };

        insertHeader(`
=== RECOVERY: ${GLib.path_get_basename(audioPath)} ===
`);
        stateLabel.set_markup('<b>State:</b> recovering...');

        let totalFinals = 0;
        const transcriber = new FileTranscriber({
            extensionDir: PROJECT_DIR,
            // Reuse the live recorder's resolved model path so the
            // subprocess doesn't re-run auto-detection.
            modelPath: recorder.getModelPath?.() ?? null,
            onLoading: () => {
                stateLabel.set_markup('<b>State:</b> recovery — loading model');
            },
            onReady: () => {
                stateLabel.set_markup('<b>State:</b> recovery — transcribing');
            },
            onProgress: ({pos_secs, dur_secs, finals}) => {
                totalFinals = finals;
                const fmt = (s) => {
                    const m = Math.floor(s / 60);
                    const sec = (s % 60).toString().padStart(2, '0');
                    return `${m}:${sec}`;
                };
                const label = dur_secs > 0
                    ? `recovery — ${fmt(pos_secs)} / ${fmt(dur_secs)} (${finals} segments)`
                    : `recovery — ${fmt(pos_secs)} (${finals} segments)`;
                stateLabel.set_markup(`<b>State:</b> ${label}`);
            },
            onPartial: (text) => partialLabel.set_label(text),
            onFinal: (text) => {
                appendFinal(text);
                partialLabel.set_label('');
            },
            onDone: ({raw_text, finals_count}) => {
                stateLabel.set_markup(
                    `<b>State:</b> recovery done — ${finals_count} segments, ${raw_text.length} chars`);
                partialLabel.set_label('');
                insertHeader(`
--- recovered text (${finals_count} segments) ---
${raw_text}
`);

                // Save as a transcript JSON via the controller's helper
                const entry = controller.saveTranscript(
                    raw_text, raw_text, audioPath, false);
                if (entry) {
                    insertHeader(`(saved to ${entry.filePath})
`);
                    entry.recovered = true;
                    entry.audioPath = audioPath;

                    // Kick off an AI cleanup pass if the current
                    // backend is available. Mirrors the Shell
                    // extension's post-save behaviour so the GTK
                    // test app shows the cleaned text too.
                    if (ai && ai.isAvailable && ai.isAvailable()) {
                        runRecoveryCleanupWithFeedback(entry, ai, {
                            onStart: () => {
                                insertHeader(`[AI cleaning recovered transcript...]
`);
                            },
                            onDone: (e) => {
                                insertHeader(`[AI cleanup complete]
--- cleaned text ---
${e.cleanedText}
`);
                            },
                            onError: (err) => {
                                const msg = err ? err.message : 'empty result';
                                insertHeader(`[AI cleanup failed: ${msg} — raw text kept]
`);
                            },
                        });
                    }
                }

                activeRecoveryTranscriber = null;
                recoverBtn.sensitive = true;
            },
            onError: (msg) => {
                stateLabel.set_markup(`<b>State:</b> recovery error`);
                insertHeader(`[recovery error] ${msg}
`);
                activeRecoveryTranscriber = null;
                recoverBtn.sensitive = true;
            },
        });
        activeRecoveryTranscriber = transcriber;
        if (!transcriber.start(audioPath, null)) {
            insertHeader(`[recovery error] failed to start FileTranscriber
`);
            activeRecoveryTranscriber = null;
            recoverBtn.sensitive = true;
        }
    }

    // Window-local F5/F6/F7 shortcuts
    const shortcutController = new Gtk.ShortcutController();
    shortcutController.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('F5'),
        action: Gtk.CallbackAction.new(() => { startBtn.activate(); return true; }),
    }));
    shortcutController.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('F6'),
        action: Gtk.CallbackAction.new(() => { stopBtn.activate(); return true; }),
    }));
    shortcutController.add_shortcut(new Gtk.Shortcut({
        trigger: Gtk.ShortcutTrigger.parse_string('F7'),
        action: Gtk.CallbackAction.new(() => { discardBtn.activate(); return true; }),
    }));
    window.add_controller(shortcutController);

    window.connect('close-request', () => {
        // Best-effort cleanup. Don't await — Gtk doesn't allow that
        // here, and the subprocess gets cleaned up by the recorder.
        try { controller.discard(); } catch (_e) { /* ignore */ }
        try { recorder.destroy(); } catch (_e) { /* ignore */ }
        try { ai.destroy(); } catch (_e) { /* ignore */ }
        try { controller.dispose(); } catch (_e) { /* ignore */ }
        return false;
    });

    window.present();
});

app.run([imports.system.programInvocationName, ...imports.system.programArgs]);
