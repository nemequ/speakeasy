// SPDX-License-Identifier: MIT
// Speakeasy — Pure validation helpers for the recovery file picker
//
// These helpers live in their own module so they can be imported by
// unit tests without pulling in St / modalDialog (which can't be
// loaded outside gnome-shell). Used by ui/pathPromptDialog.js and by
// extension.js's recovery flow to catch missing/unreadable files
// before a FileTranscriber is spawned.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Validate a user-entered path for the "recover from audio file" flow.
 *
 * Returns an object `{ok: boolean, error: string|null}`:
 *   - ok: true, error: null — the path points at an existing, readable
 *     regular file.
 *   - ok: false, error: "..."  — human-readable reason why the input
 *     can't be handed off to FileTranscriber.
 *
 * Leading/trailing whitespace is stripped before the check so
 * copy/pasted paths with stray newlines Just Work.
 *
 * @param {string|null|undefined} rawPath
 * @returns {{ok: boolean, error: string|null}}
 */
export function validateAudioPath(rawPath) {
    if (rawPath === null || rawPath === undefined)
        return {ok: false, error: 'Please enter an audio file path.'};
    if (typeof rawPath !== 'string')
        return {ok: false, error: 'Please enter an audio file path.'};

    const path = rawPath.trim();
    if (path === '')
        return {ok: false, error: 'Please enter an audio file path.'};

    // GLib.file_test with EXISTS to get a clear "not found" message,
    // then IS_REGULAR to reject directories/symlinks-to-dir, then a
    // real open() to confirm it's actually readable by us.
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return {ok: false, error: `File not found: ${path}`};

    if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
        return {ok: false, error: `Not a regular file: ${path}`};

    // Readability probe — stat the file via Gio and check the
    // access::can-read attribute. Avoids reading the whole file,
    // which for audio recovery could easily be hundreds of MB.
    try {
        const file = Gio.File.new_for_path(path);
        const info = file.query_info(
            'access::can-read',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
        if (!info.get_attribute_boolean('access::can-read'))
            return {ok: false, error: `Cannot read: ${path}`};
    } catch (e) {
        return {ok: false, error: `Cannot read: ${path}`};
    }

    return {ok: true, error: null};
}
