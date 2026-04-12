// SPDX-License-Identifier: MIT
// Speakeasy — Text output via clipboard + virtual keyboard paste
//
// Sets the system clipboard to the desired text, then synthesizes
// Shift+Insert via Clutter.VirtualInputDevice to paste into the
// focused app. Shift+Insert is more universal than Ctrl+V — it works
// in terminals (VTE), most GUI apps, and avoids conflicts with apps
// that remap Ctrl+V.
//
// The previous clipboard contents are saved and restored afterward.
//
// This works natively on both Wayland and X11 GNOME Shell sessions
// without any external tools (wtype, xdotool, ydotool, etc.).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {sleep} from './utils.js';

// Delay (ms) between setting the clipboard and sending Shift+Insert,
// to ensure the clipboard content is committed.
const CLIPBOARD_SETTLE_MS = 50;

// Delay (ms) after paste before restoring the previous clipboard.
// Needs to be long enough for the target app to read the clipboard.
const RESTORE_DELAY_MS = 250;

/**
 * Output handles typing text into the focused application by setting
 * the clipboard and simulating Shift+Insert via a virtual keyboard.
 */
export class Output {
    constructor() {
        this._virtualDevice = null;
        this._settings = null;
        this._settingsChangedIds = [];
        this._pasteMethod = 'shift-insert';
    }

    /**
     * Configure from a GSettings object.
     * @param {Gio.Settings} settings
     */
    setSettings(settings) {
        this._settings = settings;
        this._loadSettings();

        this._settingsChangedIds.push(
            this._settings.connect('changed::paste-method', () => this._loadSettings())
        );
    }

    _loadSettings() {
        if (!this._settings)
            return;
        this._pasteMethod = this._settings.get_string('paste-method') || 'shift-insert';
    }

    /**
     * Initialize the virtual keyboard device.
     * @returns {boolean} true if ready
     */
    init() {
        try {
            const seat = global.stage.context.get_backend().get_default_seat();
            this._virtualDevice = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
            log('Speakeasy: virtual keyboard created for paste output');
            return true;
        } catch (e) {
            log(`Speakeasy: failed to create virtual keyboard: ${e.message}`);
            return false;
        }
    }

    /**
     * Output text by pasting it into the focused application.
     *
     * 1. Saves the current clipboard contents
     * 2. Sets the clipboard to the desired text
     * 3. Synthesizes the configured paste shortcut via virtual keyboard
     * 4. Restores the previous clipboard contents
     *
     * @param {string} text - The text to output
     * @returns {Promise<boolean>} Resolves to true on success
     */
    async typeText(text) {
        if (!this._virtualDevice) {
            log('Speakeasy: virtual keyboard not available');
            return false;
        }

        if (!text || text.trim() === '') {
            log('Speakeasy: nothing to type');
            return true;
        }

        log(`Speakeasy: pasting ${text.length} chars via clipboard (method: ${this._pasteMethod})`);

        const clipboard = St.Clipboard.get_default();

        // Save current clipboard contents
        const previousText = await this._getClipboardText(clipboard);

        // Set the clipboard to our text
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

        // Wait for the clipboard to settle, then paste
        await sleep(CLIPBOARD_SETTLE_MS);
        
        switch (this._pasteMethod) {
            case 'ctrl-v':
                this._sendCtrlV();
                break;
            case 'ctrl-shift-v':
                this._sendCtrlShiftV();
                break;
            case 'shift-insert':
            default:
                this._sendShiftInsert();
                break;
        }

        // Wait for the target app to read the clipboard, then restore
        await sleep(RESTORE_DELAY_MS);

        if (previousText !== null)
            clipboard.set_text(St.ClipboardType.CLIPBOARD, previousText);

        return true;
    }

    /**
     * Read the current clipboard text contents.
     * @param {St.Clipboard} clipboard
     * @returns {Promise<string|null>}
     */
    _getClipboardText(clipboard) {
        return new Promise(resolve => {
            clipboard.get_text(St.ClipboardType.CLIPBOARD,
                (_clipboard, text) => {
                    resolve(text || null);
                });
        });
    }

    /**
     * Synthesize a Ctrl+V keystroke.
     */
    _sendCtrlV() {
        const time = GLib.get_monotonic_time();
        const step = 100 * 1000;
        this._virtualDevice.notify_keyval(
            time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + step, Clutter.KEY_v, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + (step * 2), Clutter.KEY_v, Clutter.KeyState.RELEASED);
        this._virtualDevice.notify_keyval(
            time + (step * 3), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    /**
     * Synthesize a Ctrl+Shift+V keystroke.
     */
    _sendCtrlShiftV() {
        const time = GLib.get_monotonic_time();
        const step = 100 * 1000;
        this._virtualDevice.notify_keyval(
            time, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + step, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + (step * 2), Clutter.KEY_v, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + (step * 3), Clutter.KEY_v, Clutter.KeyState.RELEASED);
        this._virtualDevice.notify_keyval(
            time + (step * 4), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
        this._virtualDevice.notify_keyval(
            time + (step * 5), Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
    }

    /**
     * Synthesize a Shift+Insert keystroke via the virtual keyboard.
     * Timestamps are staggered by 100ms to ensure all backends process
     * the key sequence as distinct events.
     */
    _sendShiftInsert() {
        const time = GLib.get_monotonic_time();
        const step = 100 * 1000; // 100ms in microseconds
        this._virtualDevice.notify_keyval(
            time, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + step, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + (step * 2), Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
        this._virtualDevice.notify_keyval(
            time + (step * 3), Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    }

    destroy() {
        if (this._settings && this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = [];
        }
        this._settings = null;

        if (this._virtualDevice) {
            this._virtualDevice.run_dispose();
            this._virtualDevice = null;
        }
    }
}
