// SPDX-License-Identifier: MIT
// Speakeasy — Panel indicator icon

import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {State} from '../keybinding.js';

/**
 * Panel indicator button that shows microphone status in the top bar.
 *
 * - Idle:       grey mic icon
 * - Recording:  red mic icon (hold-to-talk)
 * - Locked:     red mic icon (double-tap locked)
 * - Processing: yellow mic icon
 */
export const PanelIcon = GObject.registerClass(
class SpeakeasyPanelIcon extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Speakeasy', false);

        this._updatingState = false;

        // Icon in the panel
        this._icon = new St.Icon({
            icon_name: 'audio-input-microphone-symbolic',
            style_class: 'system-status-icon speakeasy-icon-idle',
        });
        this.add_child(this._icon);

        // Toggle switch for recording
        this._toggleItem = new PopupMenu.PopupSwitchMenuItem('Recording', false);
        this._toggleItem.connect('toggled', (_item, active) => {
            // Ignore toggled signals caused by setState()
            if (this._updatingState)
                return;
            if (this._onToggleRecording)
                this._onToggleRecording(active);
        });
        this.menu.addMenuItem(this._toggleItem);

        // Status label
        this._statusItem = new PopupMenu.PopupMenuItem('Idle', {reactive: false});
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._transcriptsItem = new PopupMenu.PopupMenuItem('Show Transcripts');
        this._transcriptsItem.connect('activate', () => {
            if (this._onShowTranscripts)
                this._onShowTranscripts();
        });
        this.menu.addMenuItem(this._transcriptsItem);

        this._prefsItem = new PopupMenu.PopupMenuItem('Preferences');
        this._prefsItem.connect('activate', () => {
            if (this._onShowPreferences)
                this._onShowPreferences();
        });
        this.menu.addMenuItem(this._prefsItem);

        // Callbacks
        this._onToggleRecording = null;
        this._onShowTranscripts = null;
        this._onShowPreferences = null;
    }

    /**
     * Set callback for when the recording toggle is switched.
     * @param {function(boolean)} callback - Called with true to start, false to stop
     */
    onToggleRecording(callback) {
        this._onToggleRecording = callback;
    }

    /**
     * Set callback for when "Show Transcripts" is clicked.
     * @param {function} callback
     */
    onShowTranscripts(callback) {
        this._onShowTranscripts = callback;
    }

    /**
     * Set callback for when "Preferences" is clicked.
     * @param {function} callback
     */
    onShowPreferences(callback) {
        this._onShowPreferences = callback;
    }

    /**
     * Update the icon and status label based on state.
     * @param {string} state - One of State.*
     */
    setState(state) {
        // Remove all state classes
        this._icon.remove_style_class_name('speakeasy-icon-idle');
        this._icon.remove_style_class_name('speakeasy-icon-recording');
        this._icon.remove_style_class_name('speakeasy-icon-locked');
        this._icon.remove_style_class_name('speakeasy-icon-processing');

        // Guard against re-entrant toggle signals
        this._updatingState = true;

        switch (state) {
            case State.IDLE:
                this._icon.add_style_class_name('speakeasy-icon-idle');
                this._statusItem.label.set_text('Idle');
                this._toggleItem.state = false;
                this._toggleItem.sensitive = true;
                break;

            case State.RECORDING:
                this._icon.add_style_class_name('speakeasy-icon-recording');
                this._statusItem.label.set_text('Recording...');
                this._toggleItem.state = true;
                this._toggleItem.sensitive = true;
                break;

            case State.LOCKED:
                this._icon.add_style_class_name('speakeasy-icon-locked');
                this._statusItem.label.set_text('Recording (locked)');
                this._toggleItem.state = true;
                this._toggleItem.sensitive = true;
                break;

            case State.PROCESSING:
                this._icon.add_style_class_name('speakeasy-icon-processing');
                this._statusItem.label.set_text('Processing...');
                this._toggleItem.state = false;
                this._toggleItem.sensitive = false;
                break;
        }

        this._updatingState = false;
    }

    /**
     * Set partial text preview in the menu (optional live feedback).
     * @param {string} text
     */
    setPartialText(text) {
        if (text && text.length > 60)
            text = `...${text.slice(-57)}`;

        if (text)
            this._statusItem.label.set_text(`Recording: ${text}`);
    }

    destroy() {
        super.destroy();
    }
});
