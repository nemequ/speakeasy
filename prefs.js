// SPDX-License-Identifier: MIT
// Speakeasy — Extension preferences UI

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SpeakeasyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keep a reference so GSettings bindings aren't GC'd
        window._speakeasySettings = settings;

        window.add(this._buildGeneralPage(settings));
        window.add(this._buildSttPage(settings));
        window.add(this._buildAiPage(settings));
        window.add(this._buildTimingPage(settings));
        window.add(this._buildDeveloperPage(settings));
    }

    // ─── General page ────────────────────────────────────────────────

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });

        // ── Keybinding group ──
        const keybindGroup = new Adw.PreferencesGroup({
            title: _('Keybindings'),
            description: _('One or more push-to-talk trigger keys. ' +
                'Pressing any of them activates recording — useful when ' +
                'you switch between keyboards or want to bind a Steam ' +
                'Deck button via Steam Input.'),
        });
        page.add(keybindGroup);

        // Header row with "Add Key" button
        const addKeyRow = new Adw.ActionRow({
            title: _('Trigger Keys'),
        });
        const addKeyButton = new Gtk.Button({
            label: _('Add Key'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        addKeyButton.connect('clicked', () => {
            this._showAccelDialog(settings, addKeyButton);
        });
        addKeyRow.add_suffix(addKeyButton);
        keybindGroup.add(addKeyRow);

        // Track dynamically-added rows so we can rebuild on change
        let accelRows = [];
        const rebuildAccelRows = () => {
            for (const row of accelRows)
                keybindGroup.remove(row);
            accelRows = [];

            const accels = settings.get_strv('trigger-accels');
            if (accels.length === 0) {
                const emptyRow = new Adw.ActionRow({
                    title: _('No trigger keys configured'),
                    subtitle: _('Click "Add Key" to bind one.'),
                });
                keybindGroup.add(emptyRow);
                accelRows.push(emptyRow);
                return;
            }

            for (let i = 0; i < accels.length; i++) {
                const accel = accels[i];
                const idx = i;
                const row = new Adw.ActionRow({
                    title: accel,
                });
                const removeButton = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Remove this trigger key'),
                    css_classes: ['flat'],
                });
                removeButton.connect('clicked', () => {
                    const current = settings.get_strv('trigger-accels');
                    current.splice(idx, 1);
                    settings.set_strv('trigger-accels', current);
                });
                row.add_suffix(removeButton);
                keybindGroup.add(row);
                accelRows.push(row);
            }
        };
        rebuildAccelRows();
        settings.connect('changed::trigger-accels', rebuildAccelRows);

        // ── History group ──
        const historyGroup = new Adw.PreferencesGroup({
            title: _('History'),
        });
        page.add(historyGroup);

        const maxTranscriptsRow = new Adw.SpinRow({
            title: _('Max Transcript History'),
            subtitle: _('Maximum number of transcripts to keep.'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_uint('max-transcripts'),
            }),
        });
        settings.bind('max-transcripts', maxTranscriptsRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        historyGroup.add(maxTranscriptsRow);

        // ── Storage group ──
        // Audio retention is now decoupled from verbose-logging.
        // Files are written to a persistent location either way; this
        // toggle controls whether they survive past the end of a
        // successful transcription.
        const storageGroup = new Adw.PreferencesGroup({
            title: _('Storage'),
            description: _('Where transcripts and (optionally) audio ' +
                'recordings are written.'),
        });
        page.add(storageGroup);

        const retainAudioRow = new Adw.SwitchRow({
            title: _('Retain Audio Recordings'),
            subtitle: _('Keep the .opus audio file after a successful ' +
                'transcription. Useful for QA and recovering audio after ' +
                'a crash. Off by default.'),
        });
        settings.bind('retain-audio', retainAudioRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        storageGroup.add(retainAudioRow);

        // paste-method is schema'd as an enum, so it's a *string* to
        // GSettings ('shift-insert' etc.) but Adw.ComboRow's 'selected'
        // is a guint. Binding directly crashes with a type mismatch,
        // so convert manually like audio-input-device does below.
        const pasteMethodNicks = ['shift-insert', 'ctrl-v', 'ctrl-shift-v'];
        const pasteMethodRow = new Adw.ComboRow({
            title: _('Paste Method'),
            subtitle: _('Keyboard shortcut used to insert text into the focused application.'),
            model: new Gtk.StringList({
                strings: [
                    _('Universal (Shift+Insert)'),
                    _('Standard (Ctrl+V)'),
                    _('Terminal (Ctrl+Shift+V)'),
                ],
            }),
        });
        const currentPaste = settings.get_string('paste-method');
        const pasteIdx = pasteMethodNicks.indexOf(currentPaste);
        pasteMethodRow.selected = pasteIdx >= 0 ? pasteIdx : 0;
        pasteMethodRow.connect('notify::selected', () => {
            const sel = pasteMethodRow.selected;
            if (sel >= 0 && sel < pasteMethodNicks.length)
                settings.set_string('paste-method', pasteMethodNicks[sel]);
        });
        settings.connect('changed::paste-method', () => {
            const val = settings.get_string('paste-method');
            const i = pasteMethodNicks.indexOf(val);
            if (i >= 0 && pasteMethodRow.selected !== i)
                pasteMethodRow.selected = i;
        });
        storageGroup.add(pasteMethodRow);

        const audioDirRow = new Adw.EntryRow({
            title: _('Audio Directory'),
        });
        settings.bind('audio-dir', audioDirRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        const audioBrowseButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse for audio directory'),
        });
        audioBrowseButton.connect('clicked', () => {
            this._browseFolder(audioDirRow, settings, 'audio-dir');
        });
        audioDirRow.add_suffix(audioBrowseButton);
        storageGroup.add(audioDirRow);

        const audioHint = new Adw.ActionRow({
            title: _('Leave empty for ~/.local/share/speakeasy/audio'),
            css_classes: ['dim-label'],
        });
        storageGroup.add(audioHint);

        const transcriptDirRow = new Adw.EntryRow({
            title: _('Transcript Directory'),
        });
        settings.bind('transcript-dir', transcriptDirRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        const transcriptBrowseButton = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse for transcript directory'),
        });
        transcriptBrowseButton.connect('clicked', () => {
            this._browseFolder(transcriptDirRow, settings, 'transcript-dir');
        });
        transcriptDirRow.add_suffix(transcriptBrowseButton);
        storageGroup.add(transcriptDirRow);

        const transcriptHint = new Adw.ActionRow({
            title: _('Leave empty for ~/.local/share/speakeasy/transcripts'),
            css_classes: ['dim-label'],
        });
        storageGroup.add(transcriptHint);

        // ── Health check / Test Recording ──
        //
        // New-user sanity check: open the standalone GTK debug
        // console in a subprocess so the user can exercise the
        // whole pipeline (mic -> STT -> AI cleanup) without
        // committing to a real dictation. The prefs window runs in
        // a separate process from the live extension, so we can't
        // reuse the extension's recorder/AI instances — the GTK app
        // builds its own. That's heavy (a second whisper model load)
        // but acceptable for an explicit "test the pipeline" action.
        const healthGroup = new Adw.PreferencesGroup({
            title: _('Health Check'),
            description: _('Verify the microphone, STT model, and AI ' +
                'cleanup pipeline are wired up correctly. Opens the ' +
                'Speakeasy Debug Console in a separate window.'),
        });
        page.add(healthGroup);

        const testRow = new Adw.ActionRow({
            title: _('Test Recording'),
            subtitle: _('Launches the Debug Console. Click ' +
                '"Test Recording (3s)" there to run a short end-to-end test.'),
        });
        const testButton = new Gtk.Button({
            label: _('Open Debug Console'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => {
            this._launchDebugConsole();
        });
        testRow.add_suffix(testButton);
        healthGroup.add(testRow);

        return page;
    }

    /**
     * Spawn the standalone GTK debug app in a subprocess. The prefs
     * window process stays responsive — we don't wait on the child.
     */
    _launchDebugConsole() {
        try {
            const gtkAppPath = GLib.build_filenamev([this.path, 'gtk-app.js']);
            const subproc = Gio.Subprocess.new(
                ['gjs', '-m', gtkAppPath],
                Gio.SubprocessFlags.NONE
            );
            // Detach: we don't care about the exit status here.
            subproc.wait_async(null, (_proc, _res) => { /* ignored */ });
            log(`Speakeasy prefs: launched debug console: ${gtkAppPath}`);
        } catch (e) {
            log(`Speakeasy prefs: failed to launch debug console: ${e.message}`);
        }
    }

    // ─── STT page ────────────────────────────────────────────────────

    _buildSttPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Speech Recognition'),
            icon_name: 'audio-input-microphone-symbolic',
        });

        // ── Audio input group ──
        const audioGroup = new Adw.PreferencesGroup({
            title: _('Audio Input'),
            description: _('Select the microphone to use for recording.'),
        });
        page.add(audioGroup);

        const audioDeviceRow = new Adw.ComboRow({
            title: _('Input Device'),
            subtitle: _('System default if not set'),
        });

        // Populate with available PulseAudio/PipeWire sources
        this._populateAudioDevices(audioDeviceRow, settings);

        audioGroup.add(audioDeviceRow);

        // ── Whisper group ──
        const whisperGroup = new Adw.PreferencesGroup({
            title: _('Whisper'),
            description: _('Settings for the Whisper speech recognition backend.'),
        });
        page.add(whisperGroup);

        const whisperPathRow = new Adw.EntryRow({
            title: _('Model Path'),
        });
        settings.bind('whisper-model-path', whisperPathRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);

        const whisperBrowseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse for Whisper model file'),
        });
        whisperBrowseButton.connect('clicked', () => {
            this._browseFile(whisperPathRow, settings, 'whisper-model-path');
        });
        whisperPathRow.add_suffix(whisperBrowseButton);
        whisperGroup.add(whisperPathRow);

        const whisperLangRow = new Adw.EntryRow({
            title: _('Language'),
        });
        settings.bind('whisper-language', whisperLangRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        whisperGroup.add(whisperLangRow);

        return page;
    }

    // ─── AI page ─────────────────────────────────────────────────────

    _buildAiPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('AI Cleanup'),
            icon_name: 'starred-symbolic',
        });

        // The core currently ships a single AI backend: a local
        // candle-based llama loader. 'ai-backend' is a string so
        // future backends can slot in, but from the UI it's a
        // simple on/off — 'llama' when enabled, 'none' when not.
        const backendGroup = new Adw.PreferencesGroup({
            title: _('AI Backend'),
            description: _('Clean up raw speech recognition output with a ' +
                'local GGUF model. Runs entirely offline via candle.'),
        });
        page.add(backendGroup);

        const enabledRow = new Adw.SwitchRow({
            title: _('Enable AI Cleanup'),
            subtitle: _('Send STT output through the local model before typing.'),
            active: settings.get_string('ai-backend') === 'llama',
        });
        enabledRow.connect('notify::active', () => {
            settings.set_string('ai-backend',
                enabledRow.active ? 'llama' : 'none');
        });
        settings.connect('changed::ai-backend', () => {
            const active = settings.get_string('ai-backend') === 'llama';
            if (enabledRow.active !== active) enabledRow.active = active;
        });
        backendGroup.add(enabledRow);

        const modelGroup = new Adw.PreferencesGroup({
            title: _('Local Model'),
            description: _('GGUF weights the llama backend loads on start.'),
        });
        page.add(modelGroup);

        const modelPathRow = new Adw.EntryRow({
            title: _('Model Path'),
        });
        settings.bind('ai-model', modelPathRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        const modelBrowseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse for GGUF model file'),
        });
        modelBrowseButton.connect('clicked', () => {
            this._browseFile(modelPathRow, settings, 'ai-model');
        });
        modelPathRow.add_suffix(modelBrowseButton);
        modelGroup.add(modelPathRow);

        const modelHint = new Adw.ActionRow({
            title: _('Leave empty to auto-detect from ~/.cache/speakeasy'),
            css_classes: ['dim-label'],
        });
        modelGroup.add(modelHint);

        return page;
    }

    // ─── Timing page (Advanced) ──────────────────────────────────────

    _buildTimingPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Advanced'),
            icon_name: 'preferences-other-symbolic',
        });

        const timingGroup = new Adw.PreferencesGroup({
            title: _('Keybinding Timing'),
            description: _('Fine-tune hold-to-talk and double-tap detection. ' +
                'These values depend on your keyboard repeat rate and delay.'),
        });
        page.add(timingGroup);

        // release-gap-ms
        const releaseGapRow = new Adw.SpinRow({
            title: _('Release Gap (ms)'),
            subtitle: _('Time with no key events before key is considered released. Must exceed keyboard repeat delay.'),
            adjustment: new Gtk.Adjustment({
                lower: 300, upper: 2000, step_increment: 50, page_increment: 100,
                value: settings.get_uint('release-gap-ms'),
            }),
        });
        settings.bind('release-gap-ms', releaseGapRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(releaseGapRow);

        // inter-tap-gap-ms
        const interTapRow = new Adw.SpinRow({
            title: _('Inter-Tap Gap Min (ms)'),
            subtitle: _('Minimum gap between events to detect release-and-repress.'),
            adjustment: new Gtk.Adjustment({
                lower: 30, upper: 200, step_increment: 5, page_increment: 20,
                value: settings.get_uint('inter-tap-gap-ms'),
            }),
        });
        settings.bind('inter-tap-gap-ms', interTapRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(interTapRow);

        // repeat-delay-ms
        const repeatDelayRow = new Adw.SpinRow({
            title: _('Repeat Delay Threshold (ms)'),
            subtitle: _('Gaps longer than this are keyboard repeat delay, not inter-tap.'),
            adjustment: new Gtk.Adjustment({
                lower: 200, upper: 800, step_increment: 25, page_increment: 50,
                value: settings.get_uint('repeat-delay-ms'),
            }),
        });
        settings.bind('repeat-delay-ms', repeatDelayRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(repeatDelayRow);

        // double-tap-window-ms
        const doubleTapRow = new Adw.SpinRow({
            title: _('Double-Tap Window (ms)'),
            subtitle: _('Time to wait for a second tap before discarding.'),
            adjustment: new Gtk.Adjustment({
                lower: 200, upper: 1000, step_increment: 50, page_increment: 100,
                value: settings.get_uint('double-tap-window-ms'),
            }),
        });
        settings.bind('double-tap-window-ms', doubleTapRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(doubleTapRow);

        // hold-threshold
        const holdThresholdRow = new Adw.SpinRow({
            title: _('Hold Threshold (events)'),
            subtitle: _('Minimum key-repeat events to consider a hold vs. tap.'),
            adjustment: new Gtk.Adjustment({
                lower: 2, upper: 20, step_increment: 1, page_increment: 5,
                value: settings.get_uint('hold-threshold'),
            }),
        });
        settings.bind('hold-threshold', holdThresholdRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        timingGroup.add(holdThresholdRow);

        return page;
    }

    // ─── Developer page ────────────────────────────────────────────

    _buildDeveloperPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Developer'),
            icon_name: 'applications-engineering-symbolic',
        });

        // ── Diagnostics group ──
        const devGroup = new Adw.PreferencesGroup({
            title: _('Diagnostics'),
            description: _('Logging and on-disk locations for debugging.'),
        });
        page.add(devGroup);

        const verboseRow = new Adw.SwitchRow({
            title: _('Verbose Logging'),
            subtitle: _('Emit extra per-event log lines (state transitions, ' +
                'STT segments, AI internals). Visible via `journalctl --user ' +
                '-g Speakeasy`.'),
        });
        settings.bind('verbose-logging', verboseRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        devGroup.add(verboseRow);

        // Separate dim-label row pointing the user at the log output.
        // The SwitchRow's subtitle already describes what the toggle
        // does; this row is a hint for "where do I read the output?".
        const verboseHint = new Adw.ActionRow({
            title: _('View output via: journalctl --user -g Speakeasy  ' +
                '(or in GNOME Logs / gnome-system-log)'),
            css_classes: ['dim-label'],
        });
        devGroup.add(verboseHint);

        // ── Prompt files group ──
        const promptGroup = new Adw.PreferencesGroup({
            title: _('Prompt Files'),
            description: _('Override AI prompts with external text files. ' +
                'Re-read at the start of each recording session — ' +
                'no restart needed.'),
        });
        page.add(promptGroup);

        // System prompt path
        const systemPromptRow = new Adw.EntryRow({
            title: _('System Prompt File'),
        });
        settings.bind('system-prompt-path', systemPromptRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);

        const systemBrowseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse for system prompt file'),
        });
        systemBrowseButton.connect('clicked', () => {
            this._browseFile(systemPromptRow, settings, 'system-prompt-path');
        });
        systemPromptRow.add_suffix(systemBrowseButton);
        promptGroup.add(systemPromptRow);

        const systemHint = new Adw.ActionRow({
            title: _('Leave empty to use the bundled default prompt'),
            css_classes: ['dim-label'],
        });
        promptGroup.add(systemHint);

        // Framing prompt path
        const framingPromptRow = new Adw.EntryRow({
            title: _('Framing Prompt File'),
        });
        settings.bind('framing-prompt-path', framingPromptRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);

        const framingBrowseButton = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Browse for framing prompt file'),
        });
        framingBrowseButton.connect('clicked', () => {
            this._browseFile(framingPromptRow, settings, 'framing-prompt-path');
        });
        framingPromptRow.add_suffix(framingBrowseButton);
        promptGroup.add(framingPromptRow);

        const framingHint = new Adw.ActionRow({
            title: _('Use {{UUID}} placeholder. Leave empty for default.'),
            css_classes: ['dim-label'],
        });
        promptGroup.add(framingHint);

        return page;
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    /**
     * Show a dialog to capture an accelerator keypress and append it
     * to the trigger-accels list. Duplicate accels are ignored.
     */
    _showAccelDialog(settings, button) {
        const window = button.get_root();

        const dialog = new Adw.AlertDialog({
            heading: _('Press a Key'),
            body: _('Press the key you want to add as a push-to-talk trigger.\n' +
                    'Modifier-only keys (Ctrl, Alt, Super) are not supported.'),
        });
        dialog.add_response('cancel', _('Cancel'));

        const keyController = new Gtk.EventControllerKey();
        let captured = false;
        keyController.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            if (captured)
                return;

            // Ignore pure modifier presses
            const isModifier =
                keyval === 0xffe1 || keyval === 0xffe2 ||  // Shift
                keyval === 0xffe3 || keyval === 0xffe4 ||  // Ctrl
                keyval === 0xffe7 || keyval === 0xffe8 ||  // Meta
                keyval === 0xffe9 || keyval === 0xffea ||  // Alt
                keyval === 0xffeb || keyval === 0xffec;    // Super
            if (isModifier)
                return;

            captured = true;
            const cleanState = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, cleanState);

            if (accel) {
                const current = settings.get_strv('trigger-accels');
                if (!current.includes(accel)) {
                    current.push(accel);
                    settings.set_strv('trigger-accels', current);
                    log(`Speakeasy prefs: trigger key added "${accel}"`);
                } else {
                    log(`Speakeasy prefs: trigger key "${accel}" already bound — ignoring`);
                }
            }

            dialog.force_close();
        });

        // Adw.AlertDialog is a widget — add the key controller directly
        dialog.add_controller(keyController);

        dialog.choose(window, null, null);
    }

    /**
     * Populate an Adw.ComboRow with available PulseAudio/PipeWire
     * audio input sources.  The first entry is always "System Default".
     */
    _populateAudioDevices(comboRow, settings) {
        const names = [''];          // device names ('' = default)
        const labels = ['System Default'];

        // Enumerate sources via pactl
        try {
            const [ok, stdout] = GLib.spawn_command_line_sync(
                'pactl list sources short');
            if (ok && stdout) {
                const lines = new TextDecoder().decode(stdout).trim().split('\n');
                for (const line of lines) {
                    const parts = line.split('\t');
                    if (parts.length < 2)
                        continue;
                    const name = parts[1];
                    // Skip monitor sources (output loopbacks)
                    if (name.includes('.monitor'))
                        continue;
                    names.push(name);
                    // Build a readable label from the device name
                    const label = name
                        .replace(/^alsa_input\./, '')
                        .replace(/^alsa_output\./, '')
                        .replace(/\./g, ' ')
                        .replace(/__/g, ' — ')
                        .replace(/_/g, ' ');
                    labels.push(label);
                }
            }
        } catch (e) {
            log(`Speakeasy prefs: failed to enumerate audio devices: ${e.message}`);
        }

        comboRow.model = Gtk.StringList.new(labels);

        // Select current device
        const current = settings.get_string('audio-input-device');
        const idx = names.indexOf(current);
        comboRow.selected = idx >= 0 ? idx : 0;

        comboRow.connect('notify::selected', () => {
            const sel = comboRow.selected;
            if (sel >= 0 && sel < names.length)
                settings.set_string('audio-input-device', names[sel]);
        });

        settings.connect('changed::audio-input-device', () => {
            const val = settings.get_string('audio-input-device');
            const i = names.indexOf(val);
            if (i >= 0)
                comboRow.selected = i;
        });
    }

    /**
     * Browse for a folder and set the result in settings.
     */
    _browseFolder(row, settings, key) {
        const window = row.get_root();
        const dialog = new Gtk.FileDialog({
            title: _('Select Model Directory'),
        });
        dialog.select_folder(window, null, (source, result) => {
            try {
                const folder = source.select_folder_finish(result);
                if (folder) {
                    const path = folder.get_path();
                    settings.set_string(key, path);
                    row.text = path;
                }
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    log(`Speakeasy prefs: folder browse error: ${e.message}`);
            }
        });
    }

    /**
     * Browse for a file and set the result in settings.
     */
    _browseFile(row, settings, key) {
        const window = row.get_root();
        const dialog = new Gtk.FileDialog({
            title: _('Select Model File'),
        });
        dialog.open(window, null, (source, result) => {
            try {
                const file = source.open_finish(result);
                if (file) {
                    const path = file.get_path();
                    settings.set_string(key, path);
                    row.text = path;
                }
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    log(`Speakeasy prefs: file browse error: ${e.message}`);
            }
        });
    }
}
