// SPDX-License-Identifier: MIT
// Speakeasy — Recovery dialog for transcribing existing audio files
//
// This dialog drives the FileTranscriber subprocess and shows the
// user live progress + the recovered text. It exists because the
// 2026-04-08 incident proved that audio files can outlive a hung
// transcription, and the existing rescue procedure required typing
// shell commands. This is the button-click version.
//
// The flow (orchestrated by extension.js):
//   1. User clicks "Recover from audio file..." in the panel menu
//   2. Extension spawns `zenity --file-selection` to pick the file
//      (modal Gtk file pickers don't work well from inside the Shell)
//   3. Extension opens this dialog and starts a FileTranscriber
//   4. Dialog shows progress: percentage + finals count + last partial
//   5. On done: dialog shows the recovered text and a Save button
//   6. Save: dialog calls back to the extension which installs the
//      transcript JSON via DictationController.saveTranscript()
//      and (optionally) runs AI cleanup
//
// Note that the actual transcription runs in a SEPARATE gjs process
// (FileTranscriber) — never in-process. This is by design: VOSK
// loads ~6 GB and pegging gnome-shell's main loop with that work
// would freeze the compositor.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

const State = Object.freeze({
    RUNNING: 'running',
    DONE: 'done',
    ERROR: 'error',
    CANCELLED: 'cancelled',
});

/**
 * Modal dialog that shows progress while a FileTranscriber processes
 * an audio file, then offers a Save action to install the result
 * into the live transcript history.
 */
export const RecoveryDialog = GObject.registerClass(
class SpeakeasyRecoveryDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} opts
     * @param {string} opts.audioPath  - Path being transcribed (display only)
     * @param {function(string,object)} opts.onSave - Called with
     *   (rawText, doneInfo) when the user clicks Save. The extension
     *   uses this to write the transcript JSON.
     * @param {function} opts.onCancel - Called when the user clicks Cancel.
     *   The extension is responsible for tearing down the FileTranscriber.
     */
    _init({audioPath, onSave, onCancel}) {
        super._init({styleClass: 'speakeasy-recovery-dialog'});

        this._audioPath = audioPath;
        this._onSave = onSave;
        this._onCancel = onCancel;
        this._state = State.RUNNING;
        this._rawText = '';
        this._doneInfo = null;

        // ── Title ──
        const title = new St.Label({
            text: 'Recover Transcript',
            style_class: 'speakeasy-recovery-title',
            x_expand: true,
        });
        this.contentLayout.add_child(title);

        // ── Filename label ──
        this._fileLabel = new St.Label({
            text: GLib.path_get_basename(audioPath),
            style_class: 'speakeasy-recovery-filename',
            x_expand: true,
        });
        this.contentLayout.add_child(this._fileLabel);

        // ── Status label ──
        this._statusLabel = new St.Label({
            text: 'Loading STT model...',
            style_class: 'speakeasy-recovery-status',
            x_expand: true,
        });
        this.contentLayout.add_child(this._statusLabel);

        // ── Progress label (e.g. "12:34 / 53:45 — 187 segments") ──
        this._progressLabel = new St.Label({
            text: '',
            style_class: 'speakeasy-recovery-progress',
            x_expand: true,
        });
        this.contentLayout.add_child(this._progressLabel);

        // ── Live partial preview (greyed) ──
        this._partialLabel = new St.Label({
            text: '',
            style_class: 'speakeasy-recovery-partial',
            x_expand: true,
        });
        this._partialLabel.clutter_text.set_line_wrap(true);
        this._partialLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._partialLabel.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        this.contentLayout.add_child(this._partialLabel);

        // ── Result preview (shown after done) ──
        this._resultScroll = new St.ScrollView({
            style_class: 'speakeasy-recovery-result-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        this._resultScroll.visible = false;

        this._resultLabel = new St.Label({
            text: '',
            style_class: 'speakeasy-recovery-result',
            reactive: true,
        });
        this._resultLabel.clutter_text.set_selectable(true);
        this._resultLabel.clutter_text.set_line_wrap(true);
        this._resultLabel.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        this._resultScroll.set_child(this._resultLabel);
        this.contentLayout.add_child(this._resultScroll);

        // ── Buttons ──
        // Cancel is always present.
        this._cancelButton = this.addButton({
            label: 'Cancel',
            action: () => {
                if (this._state === State.RUNNING) {
                    this._state = State.CANCELLED;
                    if (this._onCancel)
                        this._onCancel();
                }
                this.close();
            },
        });

        // Save is added when transcription is done.
        this._saveButton = null;
    }

    // ─── FileTranscriber callback wiring ───────────────────────────

    /**
     * The extension wires these methods up to the FileTranscriber
     * callbacks. They update the dialog content as events arrive.
     */

    onLoading() {
        this._statusLabel.text = 'Loading STT model...';
    }

    onReady() {
        this._statusLabel.text = 'Transcribing...';
    }

    onProgress({pos_secs, dur_secs, finals}) {
        if (this._state !== State.RUNNING)
            return;
        this._statusLabel.text = 'Transcribing...';
        const fmt = (s) => {
            const m = Math.floor(s / 60);
            const sec = (s % 60).toString().padStart(2, '0');
            return `${m}:${sec}`;
        };
        if (dur_secs > 0) {
            const pct = Math.floor((pos_secs / dur_secs) * 100);
            this._progressLabel.text =
                `${fmt(pos_secs)} / ${fmt(dur_secs)}  (${pct}%)  —  ${finals} segments`;
        } else {
            this._progressLabel.text =
                `${fmt(pos_secs)}  —  ${finals} segments`;
        }
    }

    onPartial(text) {
        if (this._state !== State.RUNNING)
            return;
        // Show only the last ~120 chars so the dialog doesn't reflow.
        const trimmed = text.length > 120 ? `…${text.slice(-117)}` : text;
        this._partialLabel.text = trimmed;
    }

    onFinal(_text) {
        // Final segments don't update a single label — they
        // accumulate inside the subprocess and arrive in bulk via
        // onDone. We just clear the partial preview here.
        if (this._state !== State.RUNNING)
            return;
        this._partialLabel.text = '';
    }

    onDone({raw_text, finals_count}) {
        if (this._state !== State.RUNNING)
            return;
        this._state = State.DONE;
        this._rawText = raw_text ?? '';
        this._doneInfo = {raw_text, finals_count};

        this._statusLabel.text = `Done. Recovered ${finals_count} segments, ${this._rawText.length} characters.`;
        this._progressLabel.text = '';
        this._partialLabel.text = '';

        // Show the result preview
        this._resultScroll.visible = true;
        this._resultLabel.text = this._rawText.length > 0
            ? this._rawText
            : '(no speech recognized)';

        // Add the Save button if we have something worth saving
        if (this._rawText.length > 0 && !this._saveButton) {
            this._saveButton = this.addButton({
                label: 'Save Transcript',
                action: () => {
                    if (this._onSave)
                        this._onSave(this._rawText, this._doneInfo);
                    this.close();
                },
                default: true,
            });
        }
    }

    onError(message) {
        if (this._state !== State.RUNNING)
            return;
        this._state = State.ERROR;
        this._statusLabel.text = `Error: ${message}`;
        this._progressLabel.text = '';
        this._partialLabel.text = '';
    }
});
