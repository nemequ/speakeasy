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
     * 3. Synthesizes Shift+Insert via virtual keyboard
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

        log(`Speakeasy: pasting ${text.length} chars via clipboard`);

        const clipboard = St.Clipboard.get_default();

        // Save current clipboard contents
        const previousText = await this._getClipboardText(clipboard);

        // Set the clipboard to our text
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);

        // Wait for the clipboard to settle, then paste
        await sleep(CLIPBOARD_SETTLE_MS);
        this._sendShiftInsert();

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
     * Synthesize a Shift+Insert keystroke via the virtual keyboard.
     * Timestamps are staggered by 1ms to ensure all backends process
     * the key sequence as distinct events.
     */
    _sendShiftInsert() {
        const time = GLib.get_monotonic_time();
        this._virtualDevice.notify_keyval(
            time, Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + 1000, Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
        this._virtualDevice.notify_keyval(
            time + 2000, Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
        this._virtualDevice.notify_keyval(
            time + 3000, Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
    }

    destroy() {
        if (this._virtualDevice) {
            this._virtualDevice.run_dispose();
            this._virtualDevice = null;
        }
    }
}
