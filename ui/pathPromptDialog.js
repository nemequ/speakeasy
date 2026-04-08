// SPDX-License-Identifier: MIT
// Speakeasy — Inline path entry prompt
//
// A small ModalDialog that asks the user to type or paste an
// absolute file path. Used as the last-resort fallback for the
// "Recover from Audio File..." flow when neither zenity nor
// kdialog is installed. We can't host a real Gtk.FileDialog from
// inside gnome-shell, so the fallback is a plain text input.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {validateAudioPath} from './pathValidation.js';

// Re-export so callers that already import from pathPromptDialog.js
// can reach the validator without adding a second import.
export {validateAudioPath};

export const PathPromptDialog = GObject.registerClass(
class SpeakeasyPathPromptDialog extends ModalDialog.ModalDialog {
    /**
     * @param {object} opts
     * @param {string} opts.title
     * @param {string} opts.message
     * @param {string} [opts.initialPath]
     * @param {function(string)} opts.onAccept - Called with the
     *   entered path when the user clicks OK or hits Enter. May
     *   be an empty string if the user accepted with no input.
     * @param {function} opts.onCancel - Called when the user
     *   clicks Cancel or closes the dialog without accepting.
     */
    _init({title, message, initialPath = '', onAccept, onCancel}) {
        super._init({styleClass: 'speakeasy-path-prompt-dialog'});

        this._onAccept = onAccept;
        this._onCancel = onCancel;
        this._accepted = false;

        const titleLabel = new St.Label({
            text: title,
            style_class: 'speakeasy-path-prompt-title',
            x_expand: true,
        });
        this.contentLayout.add_child(titleLabel);

        const messageLabel = new St.Label({
            text: message,
            style_class: 'speakeasy-path-prompt-message',
            x_expand: true,
        });
        messageLabel.clutter_text.set_line_wrap(true);
        this.contentLayout.add_child(messageLabel);

        this._entry = new St.Entry({
            text: initialPath,
            style_class: 'speakeasy-path-prompt-entry',
            x_expand: true,
            can_focus: true,
        });
        // Hitting Enter accepts the dialog.
        this._entry.clutter_text.connect('activate', () => {
            this._accept();
        });
        this.contentLayout.add_child(this._entry);

        // Inline error label — hidden until the user enters a bad
        // path. Validation happens on _accept() so the user can fix
        // a typo without re-triggering the whole recovery flow.
        this._errorLabel = new St.Label({
            text: '',
            style_class: 'speakeasy-path-prompt-error',
            x_expand: true,
            visible: false,
        });
        this._errorLabel.clutter_text.set_line_wrap(true);
        this.contentLayout.add_child(this._errorLabel);

        this.addButton({
            label: 'Cancel',
            action: () => {
                if (!this._accepted && this._onCancel)
                    this._onCancel();
                this.close();
            },
        });

        this.addButton({
            label: 'OK',
            action: () => this._accept(),
            default: true,
        });

        // Focus the entry on open
        this.connect('opened', () => {
            this._entry.grab_key_focus();
            this._entry.clutter_text.set_cursor_position(-1);
        });
    }

    _accept() {
        if (this._accepted)
            return;
        const text = this._entry.get_text().trim();

        // Validate before closing — if the file is missing or
        // unreadable, show an inline error and keep the dialog open
        // so the user can fix the path. Only Cancel closes on error.
        const {ok, error} = validateAudioPath(text);
        if (!ok) {
            this._errorLabel.text = error;
            this._errorLabel.visible = true;
            // Re-focus the entry so the user can immediately edit.
            this._entry.grab_key_focus();
            return;
        }

        this._accepted = true;
        if (this._onAccept)
            this._onAccept(text);
        this.close();
    }
});
