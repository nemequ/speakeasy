// SPDX-License-Identifier: MIT
// Speakeasy — shared transcript history helper.
//
// Pure data layer used by:
//   - extension.js (Shell extension)
//   - gtk-app.js (standalone test app)
//   - tests/test-transcript-store.js
//
// Everything here is synchronous and has no GNOME Shell dependency,
// so it's easy to unit-test under plain gjs.
//
// The Shell extension keeps its own async loader (_loadNextTranscriptBatch)
// so it can enumerate in small batches and not block the compositor.
// That loader and the sync loader here both funnel raw JSON through
// entryFromJson() so the in-memory entry shape stays identical.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Translate one on-disk transcript JSON object into the in-memory
 * entry shape used by the UI dialogs and extension.js' _transcripts
 * array. The shape is intentionally stable — the dialog code depends
 * on these exact field names.
 *
 * @param {object} data - parsed JSON object
 * @param {string} filePath - absolute path the JSON was loaded from
 * @returns {object} entry
 */
export function entryFromJson(data, filePath) {
    return {
        timestamp: data.timestamp,
        rawText: data.raw_text ?? '',
        cleanedText: data.cleaned_text ?? '',
        aiEnabled: data.ai_enabled ?? false,
        recovered: data.recovered ?? false,
        audioPath: data.audio_path ?? null,
        filePath,
    };
}

/**
 * Synchronously load every transcript JSON file in the given directory.
 * Sorted ascending by timestamp to match the in-memory order used by
 * extension.js (oldest first, newest last).
 *
 * Returns an empty array if the directory does not exist or is
 * unreadable; individual malformed files are silently skipped.
 *
 * @param {string} dirPath
 * @returns {Array<object>} entries
 */
export function loadTranscriptsSync(dirPath) {
    const entries = [];
    const dir = Gio.File.new_for_path(dirPath);
    if (!dir.query_exists(null))
        return entries;

    let enumerator;
    try {
        enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch (_e) {
        return entries;
    }

    try {
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith('.json'))
                continue;
            const path = GLib.build_filenamev([dirPath, name]);
            try {
                const file = Gio.File.new_for_path(path);
                const [ok, contents] = file.load_contents(null);
                if (!ok) continue;
                const data = JSON.parse(new TextDecoder().decode(contents));
                entries.push(entryFromJson(data, path));
            } catch (_e) {
                // Skip unreadable/malformed files
            }
        }
    } finally {
        try { enumerator.close(null); } catch (_e) { /* ignore */ }
    }

    entries.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
    return entries;
}

/**
 * Delete the JSON file backing a transcript entry from disk. The
 * in-memory array removal is the caller's responsibility.
 *
 * @param {object} entry - must have a filePath
 * @returns {boolean} true if a file was deleted
 */
export function deleteTranscript(entry) {
    if (!entry || !entry.filePath)
        return false;
    try {
        const file = Gio.File.new_for_path(entry.filePath);
        return file.delete(null);
    } catch (_e) {
        return false;
    }
}

/**
 * Feed a transcript's raw text through an AI cleanup instance and
 * update both the in-memory entry and the saved JSON with the
 * result. Used for the "Re-run cleanup" action in the transcript
 * history dialog.
 *
 * Caller owns the AI instance lifecycle. Pass an isolated instance
 * if a live dictation session might be running concurrently (the
 * Shell extension does this via _createIsolatedAi()).
 *
 * @param {object} entry - in-memory entry (mutated in place)
 * @param {object} ai - AI cleanup instance (beginSession/feedText/finalize)
 * @returns {Promise<boolean>} true on success
 */
export async function rerunAiCleanup(entry, ai) {
    if (!entry || !ai)
        return false;
    const rawText = entry.rawText ?? '';
    if (!rawText.trim())
        return false;

    let cleaned;
    try {
        await ai.beginSession();
        ai.feedText(rawText);
        cleaned = await ai.finalize(null);
    } catch (_e) {
        return false;
    }
    if (!cleaned || cleaned.trim() === '')
        return false;

    // Rewrite the JSON file preserving existing fields we know about.
    const updated = {
        timestamp: entry.timestamp,
        raw_text: rawText,
        cleaned_text: cleaned,
        audio_path: entry.audioPath ?? null,
        ai_enabled: true,
    };
    if (entry.recovered)
        updated.recovered = true;

    try {
        const file = Gio.File.new_for_path(entry.filePath);
        file.replace_contents(
            new TextEncoder().encode(JSON.stringify(updated, null, 2)),
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } catch (_e) {
        return false;
    }

    entry.cleanedText = cleaned;
    entry.aiEnabled = true;
    return true;
}
