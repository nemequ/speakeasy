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

const APP_ID = 'local.speakeasy.test';
const SCHEMA_ID = 'org.gnome.shell.extensions.speakeasy';

// Resolve the project directory from this file's URL so the
// recorder can find stt-subprocess.js and the prompts/ folder.
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
        buffer.insert(end, `[${stamp}] ${text}\n\n`, -1);
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

    // ── Build the AI backend ──
    function makeAi() {
        const backend = settings.get_string('ai-backend');
        const ai = backend === 'ollama' ? new OllamaCleanup() : new AICleanup();
        ai.setExtensionDir(PROJECT_DIR);
        ai.setSettings(settings);
        ai.init();
        return ai;
    }
    let ai = makeAi();

    // ── Build the window ──
    const window = new Gtk.ApplicationWindow({
        application: app,
        title: 'Speakeasy (test app)',
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

    const backendLabel = new Gtk.Label({label: 'Backend:', xalign: 1});
    statusBox.append(backendLabel);

    const backendCombo = new Gtk.DropDown({
        model: Gtk.StringList.new(['Anthropic', 'Ollama', 'None']),
    });
    const currentBackend = settings.get_string('ai-backend');
    backendCombo.selected = currentBackend === 'ollama' ? 1 : 0;
    statusBox.append(backendCombo);

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
    const recoverBtn = new Gtk.Button({label: 'Recover from File...'});
    const clearBtn = new Gtk.Button({label: 'Clear views'});
    buttonBox.append(startBtn);
    buttonBox.append(stopBtn);
    buttonBox.append(discardBtn);
    buttonBox.append(recoverBtn);
    buttonBox.append(clearBtn);

    // ── Build the controller ──
    const output = new TextViewOutput(resultView.tv);

    function appendFinal(text) {
        const buffer = finalsView.tv.buffer;
        const end = buffer.get_end_iter();
        buffer.insert(end, `${text}\n`, -1);
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
            startBtn.sensitive = state === ControllerState.IDLE;
            stopBtn.sensitive = state === ControllerState.RECORDING;
            discardBtn.sensitive = state === ControllerState.RECORDING;
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
            // rms is in dB (negative). Map -60..0 dB → 0..1.
            const norm = Math.max(0, Math.min(1, (rms + 60) / 60));
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
            buffer.insert(end, `[error] ${msg}\n`, -1);
        },
        onLog: (msg) => print(`[gtk-app] ${msg}`),
    });

    // Wait for the recorder subprocess to be ready before allowing
    // start. The button is enabled by default; we just disable it
    // until ready and re-enable in the onReady callback.
    startBtn.sensitive = false;
    statusBox.set_tooltip_text('Loading STT model...');
    recorder.onReady(() => {
        print('[gtk-app] STT subprocess ready');
        statusBox.set_tooltip_text(null);
        startBtn.sensitive = controller.getState() === ControllerState.IDLE;
    });
    if (!recorder.init()) {
        print('[gtk-app] WARNING: STT subprocess failed to launch');
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

    // ── Recover from file ──
    //
    // Same flow as the Shell extension's "Recover from Audio File..."
    // menu entry, just driven from the GTK app's button. Reuses the
    // same FileTranscriber class. The result is appended to the
    // result view; if AI is available it also runs a cleanup pass.
    recoverBtn.connect('clicked', () => {
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
                return;  // user cancelled
            }
            if (!file)
                return;
            const path = file.get_path();
            startGtkRecovery(path);
        });
    });

    function startGtkRecovery(audioPath) {
        const buffer = resultView.tv.buffer;
        const insertHeader = (text) => {
            const end = buffer.get_end_iter();
            buffer.insert(end, text, -1);
        };

        insertHeader(`\n=== RECOVERY: ${GLib.path_get_basename(audioPath)} ===\n`);
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
                insertHeader(`\n--- recovered text (${finals_count} segments) ---\n${raw_text}\n`);

                // Save as a transcript JSON via the controller's helper
                const entry = controller.saveTranscript(
                    raw_text, raw_text, audioPath, false);
                if (entry) {
                    insertHeader(`(saved to ${entry.filePath})\n`);
                }
            },
            onError: (msg) => {
                stateLabel.set_markup(`<b>State:</b> recovery error`);
                insertHeader(`[recovery error] ${msg}\n`);
            },
        });
        transcriber.start(audioPath, null);
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
