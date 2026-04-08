// SPDX-License-Identifier: MIT
// Speakeasy — Crash-safe incremental session log
//
// Background: a long dictation session was lost when GJS hung in
// ai.finalize() on the stop path. The transcript JSON is only written
// at the very end of the stop flow (after AI cleanup and output), so
// any hang or crash in that flow loses every word the user spoke.
//
// This module solves that by appending each finalized STT segment to
// a JSON Lines file as soon as it lands, syncing each line to disk
// before returning. If the extension hangs, crashes, is OOM-killed,
// or the user runs out of patience and reboots, the .jsonl file
// already contains everything VOSK committed. On the next startup
// the orphan recovery scan converts those leftover .jsonl files into
// transcript JSONs.
//
// File layout:
//   $XDG_DATA_HOME/speakeasy/sessions/
//     session-${ISO_TIMESTAMP}.jsonl       <- in progress / orphan
//     completed/session-${ISO_TIMESTAMP}.jsonl   <- finalized cleanly
//
// Each line is a self-contained JSON object:
//   {"type":"start", "timestamp":"...", "audio_path":"...", "uuid":"..."}
//   {"type":"final", "timestamp":"...", "text":"..."}
//   {"type":"final", "timestamp":"...", "text":"..."}
//   ...
//   {"type":"stop",  "timestamp":"...", "raw_text":"...", "cleaned_text":"...", "ai_used":bool}
//
// Why JSON Lines:
//   - Append-only, so each write is atomic at the line level
//   - A truncated trailing line just becomes an unparseable last line;
//     all earlier lines are still readable
//   - Trivial to recover into a transcript JSON later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/**
 * Resolve and create the sessions directory.
 *
 * @param {string|null} customDir - Optional override path. Empty/null
 *   means use the default ($XDG_DATA_HOME/speakeasy/sessions).
 * @returns {string} Absolute path to the sessions directory
 */
export function getSessionsDir(customDir = null) {
    let dir = customDir;
    if (!dir || dir === '') {
        dir = GLib.build_filenamev([
            GLib.get_user_data_dir(), 'speakeasy', 'sessions',
        ]);
    }
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

/**
 * Resolve and create the completed-sessions subdirectory.
 *
 * @param {string} sessionsDir
 * @returns {string}
 */
function getCompletedDir(sessionsDir) {
    const completed = GLib.build_filenamev([sessionsDir, 'completed']);
    GLib.mkdir_with_parents(completed, 0o755);
    return completed;
}

/**
 * SessionLog — append-only crash-safe log of one dictation session.
 *
 * Lifecycle:
 *
 *   const log = new SessionLog(sessionsDir);
 *   log.start({audioPath, uuid});
 *   log.appendFinal('hello world');
 *   log.appendFinal('this is a test');
 *   log.stop({rawText, cleanedText, aiUsed});
 *   log.markCompleted();   // moves the file to completed/
 *
 * Each call writes a single JSON line and flushes the stream
 * before returning. If the process dies between calls, all
 * already-flushed lines are recoverable.
 */
export class SessionLog {
    /**
     * @param {string|null} sessionsDir - Directory override, or null
     *   for the default location.
     */
    constructor(sessionsDir = null) {
        this._sessionsDir = getSessionsDir(sessionsDir);
        this._path = null;
        this._stream = null;     // Gio.DataOutputStream
        this._fileStream = null; // underlying Gio.FileOutputStream (for flush)
        this._completed = false;
    }

    /**
     * Open a new log file and write the start record.
     *
     * @param {object} info
     * @param {string|null} [info.audioPath] - Path to the .opus audio
     *   file for this session, if known.
     * @param {string|null} [info.uuid] - Session UUID (matches the AI
     *   session UUID when AI is enabled).
     * @returns {string} Absolute path to the new log file
     */
    start({audioPath = null, uuid = null} = {}) {
        if (this._stream)
            this.close();

        const tsForFile = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `session-${tsForFile}.jsonl`;
        this._path = GLib.build_filenamev([this._sessionsDir, filename]);
        this._completed = false;

        const file = Gio.File.new_for_path(this._path);
        // create() with REPLACE_DESTINATION; we want a fresh file.
        this._fileStream = file.replace(
            null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
        this._stream = new Gio.DataOutputStream({
            base_stream: this._fileStream,
            // Close the underlying stream when this stream is closed.
            close_base_stream: true,
        });

        this._writeLine({
            type: 'start',
            timestamp: new Date().toISOString(),
            audio_path: audioPath ?? null,
            uuid: uuid ?? null,
        });
        log(`Speakeasy SessionLog: opened ${this._path}`);
        return this._path;
    }

    /**
     * Append a finalized STT segment. Each call is independently
     * durable: the line is written and the stream is flushed before
     * returning.
     *
     * @param {string} text - A finalized STT text segment
     */
    appendFinal(text) {
        if (!this._stream) {
            log('Speakeasy SessionLog: appendFinal() called with no open log');
            return;
        }
        if (typeof text !== 'string' || text === '')
            return;

        this._writeLine({
            type: 'final',
            timestamp: new Date().toISOString(),
            text,
        });
    }

    /**
     * Write the stop record. After this the log is "complete from
     * the writer's perspective" but is not yet moved to the
     * completed/ subdir — that happens in markCompleted(), after
     * the transcript JSON has been saved successfully.
     *
     * @param {object} info
     * @param {string} info.rawText
     * @param {string|null} [info.cleanedText]
     * @param {boolean} [info.aiUsed]
     */
    stop({rawText, cleanedText = null, aiUsed = false}) {
        if (!this._stream) {
            log('Speakeasy SessionLog: stop() called with no open log');
            return;
        }
        this._writeLine({
            type: 'stop',
            timestamp: new Date().toISOString(),
            raw_text: rawText ?? '',
            cleaned_text: cleanedText ?? null,
            ai_used: !!aiUsed,
        });
    }

    /**
     * Move the log file into completed/ to mark it as cleanly
     * finalized. Anything still in the top-level sessions/ directory
     * after a process restart is treated as an orphan and recovered
     * by recoverOrphans().
     *
     * Closes the stream before moving.
     */
    markCompleted() {
        if (!this._path) {
            log('Speakeasy SessionLog: markCompleted() called with no path');
            return;
        }
        this.close();

        try {
            const completedDir = getCompletedDir(this._sessionsDir);
            const filename = GLib.path_get_basename(this._path);
            const dest = GLib.build_filenamev([completedDir, filename]);

            const src = Gio.File.new_for_path(this._path);
            const destFile = Gio.File.new_for_path(dest);
            src.move(
                destFile,
                Gio.FileCopyFlags.OVERWRITE,
                null, null
            );
            this._completed = true;
            log(`Speakeasy SessionLog: marked completed: ${dest}`);
        } catch (e) {
            log(`Speakeasy SessionLog: markCompleted failed: ${e.message}`);
        }
    }

    /**
     * Close the stream without moving the file. Use this when
     * abandoning a session — the file stays in the top-level dir
     * and will be picked up by the next recoverOrphans() pass.
     */
    close() {
        if (this._stream) {
            try {
                this._stream.close(null);
            } catch (e) {
                log(`Speakeasy SessionLog: close error: ${e.message}`);
            }
            this._stream = null;
            this._fileStream = null;
        }
    }

    /**
     * Get the path of the currently open log file (or null).
     */
    getPath() {
        return this._path;
    }

    /**
     * Internal: serialize an object as a single JSON line, write it,
     * and flush the stream so the bytes are at least in the kernel
     * page cache before we return.
     *
     * NOTE: We use Gio.DataOutputStream's flush() rather than
     * fsync(). DataOutputStream.flush() forces a buffered write to
     * the underlying FileOutputStream, which immediately calls
     * write(2) — the bytes are then in the kernel page cache. We
     * don't go all the way to fsync() because:
     *   - GIO doesn't expose fsync directly
     *   - The cost of an fsync per line on a long session would
     *     dwarf the cost of the dictation itself
     *   - Recovery from a kernel crash is out of scope; we only
     *     need to survive an in-process hang or SIGKILL, both of
     *     which preserve the page cache.
     *
     * @param {object} obj
     */
    _writeLine(obj) {
        try {
            const line = `${JSON.stringify(obj)}\n`;
            this._stream.put_string(line, null);
            this._stream.flush(null);
        } catch (e) {
            log(`Speakeasy SessionLog: write failed: ${e.message}`);
        }
    }
}

/**
 * Parse a session log file into a transcript-shaped object.
 *
 * Used both at recovery time and by tests. Returns null if the file
 * is empty or has no usable content.
 *
 * @param {string} path - Absolute path to a .jsonl file
 * @returns {object|null} { rawText, cleanedText, aiUsed, finals,
 *   audioPath, startTimestamp, stopTimestamp, complete }
 */
export function parseSessionLog(path) {
    let contents;
    try {
        const file = Gio.File.new_for_path(path);
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;
        contents = new TextDecoder().decode(bytes);
    } catch (e) {
        log(`Speakeasy SessionLog: failed to read ${path}: ${e.message}`);
        return null;
    }

    const finals = [];
    let startTimestamp = null;
    let stopTimestamp = null;
    let audioPath = null;
    let rawText = null;
    let cleanedText = null;
    let aiUsed = false;
    let complete = false;

    const lines = contents.split('\n');
    for (const line of lines) {
        if (line.trim() === '')
            continue;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch (_e) {
            // A trailing torn line is expected on crash. Skip it.
            continue;
        }
        switch (obj.type) {
            case 'start':
                startTimestamp = obj.timestamp ?? null;
                audioPath = obj.audio_path ?? null;
                break;
            case 'final':
                if (typeof obj.text === 'string' && obj.text !== '')
                    finals.push(obj.text);
                break;
            case 'stop':
                stopTimestamp = obj.timestamp ?? null;
                rawText = obj.raw_text ?? null;
                cleanedText = obj.cleaned_text ?? null;
                aiUsed = !!obj.ai_used;
                complete = true;
                break;
            default:
                break;
        }
    }

    if (finals.length === 0 && !rawText)
        return null;

    // If the stop record is missing, synthesize raw_text from finals.
    if (rawText === null)
        rawText = finals.join(' ').trim();

    return {
        rawText,
        cleanedText,
        aiUsed,
        finals,
        audioPath,
        startTimestamp,
        stopTimestamp,
        complete,
    };
}

/**
 * Scan the sessions directory for orphaned .jsonl files (sessions
 * that were never marked completed) and convert each one into a
 * recovery transcript JSON in the given transcript directory.
 *
 * Recovered files are then moved to completed/ so they aren't
 * recovered again on the next startup.
 *
 * @param {string|null} sessionsDir - Sessions dir override
 * @param {string} transcriptDir - Where to write transcript JSONs
 * @returns {Array<object>} Array of recovery results, one per orphan
 */
export function recoverOrphans(sessionsDir, transcriptDir) {
    const dir = getSessionsDir(sessionsDir);
    const completedDir = getCompletedDir(dir);
    GLib.mkdir_with_parents(transcriptDir, 0o755);

    const results = [];

    let enumerator;
    try {
        const dirFile = Gio.File.new_for_path(dir);
        enumerator = dirFile.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null
        );
    } catch (e) {
        log(`Speakeasy SessionLog: recoverOrphans enumerate failed: ${e.message}`);
        return results;
    }

    while (true) {
        let info;
        try {
            info = enumerator.next_file(null);
        } catch (_e) {
            break;
        }
        if (!info)
            break;
        const name = info.get_name();
        const type = info.get_file_type();
        if (type !== Gio.FileType.REGULAR)
            continue;
        if (!name.endsWith('.jsonl'))
            continue;

        const path = GLib.build_filenamev([dir, name]);
        const parsed = parseSessionLog(path);
        if (!parsed) {
            log(`Speakeasy SessionLog: orphan ${name} had no usable content; skipping`);
            continue;
        }

        // Build a transcript JSON in the same shape as
        // extension.js _saveTranscript() produces, plus a
        // "recovered: true" marker.
        const transcript = {
            timestamp: parsed.stopTimestamp ?? parsed.startTimestamp ?? new Date().toISOString(),
            raw_text: parsed.rawText ?? '',
            cleaned_text: parsed.cleanedText,
            audio_path: parsed.audioPath,
            ai_enabled: parsed.aiUsed,
            recovered: true,
            recovered_from: name,
            recovered_complete: parsed.complete,
        };

        const tsForFile = transcript.timestamp.replace(/[:.]/g, '-');
        const transcriptFilename = `transcript-${tsForFile}-recovered.json`;
        const transcriptPath = GLib.build_filenamev([transcriptDir, transcriptFilename]);

        try {
            const tFile = Gio.File.new_for_path(transcriptPath);
            tFile.replace_contents(
                new TextEncoder().encode(JSON.stringify(transcript, null, 2)),
                null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null
            );
            log(`Speakeasy SessionLog: recovered orphan -> ${transcriptPath}`);

            // Move the orphan to completed/ so we don't reprocess it.
            const src = Gio.File.new_for_path(path);
            const dest = Gio.File.new_for_path(
                GLib.build_filenamev([completedDir, name]));
            src.move(dest, Gio.FileCopyFlags.OVERWRITE, null, null);

            results.push({
                source: path,
                transcript: transcriptPath,
                rawText: parsed.rawText,
                complete: parsed.complete,
            });
        } catch (e) {
            log(`Speakeasy SessionLog: recovery write failed for ${name}: ${e.message}`);
        }
    }

    enumerator.close(null);
    return results;
}
