// SPDX-License-Identifier: MIT
// Speakeasy — AI text cleanup via Anthropic Claude API
//
// Multi-turn conversation with incremental prompt caching:
//
//  1. beginSession() — on recording commit (hold confirmed / double-tap locked)
//     Sends initial framing message + system prompt. Cache is written.
//
//  2. feedText()     — called as VOSK produces final text segments.
//     Buffers text; flushed to the API every ~30s as intermediate turns.
//     Each flush advances the cache prefix — previous turns become cheap reads.
//
//  3. finalize()     — on recording stop.
//     Sends the remaining buffered text + the UUID signal. The model generates
//     the cleaned-up output, streamed via SSE → wtype.
//
// The UUID (generated per session) acts as the end-of-dictation signal.
// The model is instructed: "everything until you see <UUID> is raw dictation;
// when you see it, output only the cleaned text."
//
// Automatic prompt caching (top-level cache_control) ensures the growing
// conversation prefix is cached. The system prompt (≥4096 tokens) is
// cached on the first request; subsequent requests read it from cache
// at 10% cost. Intermediate turns also get cached as the conversation grows.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {sleep} from './utils.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// How often (ms) to flush accumulated STT text as an intermediate turn.
const CHUNK_FLUSH_INTERVAL_MS = 30000;

// Retry parameters for HTTP requests.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 200;  // 200ms, 800ms, 3200ms

// Default request timeout in seconds. Overridden by GSettings.
// 0 = no timeout (not recommended — a hung request blocks the stop
// path indefinitely, which is exactly the bug that lost the user's
// long dictation session).
const DEFAULT_REQUEST_TIMEOUT_SECS = 60;

// Default cap on conversation history (turn pairs). Overridden by
// GSettings. The framing pair is always preserved; oldest chunk
// pairs are dropped first when the cap is exceeded. Bounds the
// request body size for long sessions.
const DEFAULT_MAX_HISTORY_TURNS = 20;

// Placeholder for intermediate assistant turns. We set max_tokens=1
// so the model generates ~1 token, but we don't read it — we store
// this fixed string in the conversation history instead.
const ASSISTANT_PLACEHOLDER = '...';

// Default framing message template. {{UUID}} is replaced with the session UUID.
const DEFAULT_FRAMING_TEMPLATE =
    'What follows is raw output from a speech recognition engine. ' +
    'It will be lowercase, without punctuation, and may contain filler ' +
    'words, self-corrections, and false starts. All text up to the marker ' +
    '"{{UUID}}" is raw dictation that needs cleanup. When you see that ' +
    'marker, output a properly capitalized, punctuated, and coherent ' +
    'version of everything that was dictated.';


/**
 * @interface AIBackend
 *
 * All AI cleanup backends must implement these methods so that
 * extension.js can swap backends transparently:
 *
 * - setExtensionDir(dir: string): void
 *     Set the extension directory (for resolving bundled prompt files).
 *
 * - setSettings(settings: Gio.Settings): void
 *     Configure from GSettings and listen for changes.
 *
 * - init(): boolean
 *     Initialize resources (HTTP session, etc.). Returns true if ready.
 *
 * - isAvailable(): boolean
 *     Check if the backend is configured and ready to accept requests.
 *
 * - getDebugInfo(): object
 *     Return diagnostic key-value pairs for debug logging.
 *
 * - beginSession(): void | Promise<void>
 *     Start a new recording session. May perform async warmup.
 *
 * - feedText(text: string): void
 *     Feed a finalized STT text segment into the session buffer.
 *
 * - finalize(onDelta: function|null): Promise<string|null>
 *     Finalize the session, returning cleaned text or null on failure.
 *
 * - cancelSession(): void
 *     Cancel the current session. Discard all state.
 *
 * - destroy(): void
 *     Release all resources (disconnect settings, close HTTP session).
 */

/**
 * AICleanup manages a multi-turn conversation with the Anthropic API
 * for cleaning up raw STT text. Implements the AIBackend interface.
 *
 * Usage (driven by extension.js):
 *
 *   const ai = new AICleanup();
 *   ai.setSettings(settings);
 *   ai.init();
 *
 *   // On recording commit:
 *   await ai.beginSession();
 *
 *   // During recording, as VOSK final segments arrive:
 *   ai.feedText(segment);
 *
 *   // On recording stop:
 *   const cleaned = await ai.finalize((delta) => wtype(delta));
 *
 *   // On discard:
 *   ai.cancelSession();
 */
export class AICleanup {
    constructor() {
        this._session = null;   // Soup.Session
        this._apiKey = '';
        this._model = 'claude-haiku-4-5';
        this._enabled = true;
        this._settings = null;
        this._settingsChangedIds = [];

        // Robustness knobs (loaded from settings, reapplied on change)
        this._requestTimeoutSecs = DEFAULT_REQUEST_TIMEOUT_SECS;
        this._maxHistoryTurns = DEFAULT_MAX_HISTORY_TURNS;

        // Extension directory — used to resolve bundled prompt files
        this._extensionDir = null;

        // Prompt file paths from settings (empty = use bundled defaults)
        this._systemPromptPath = '';
        this._framingPromptPath = '';

        // Prompt cache: loaded text + the resolved file path and mtime
        // used to produce it. Re-read only when the file actually changes.
        this._systemPrompt = null;
        this._systemPromptFile = null;   // resolved path we last read from
        this._systemPromptMtime = 0;     // mtime (seconds) of that file

        this._framingTemplate = null;
        this._framingTemplateFile = null;
        this._framingTemplateMtime = 0;

        // Per-recording session state
        this._sessionUuid = null;
        this._conversationHistory = [];  // [{role, content}, ...]
        this._chunkBuffer = '';          // accumulated text waiting to be flushed
        this._chunkTimerId = 0;
        this._sessionActive = false;
        this._pendingOp = null;

        // In-flight request cancellation
        this._cancellable = null;
    }

    /**
     * Set the extension directory path (used for bundled prompt files).
     * @param {string} dir - Absolute path to the extension directory
     */
    setExtensionDir(dir) {
        this._extensionDir = dir;
    }

    /**
     * Configure from GSettings.
     * @param {Gio.Settings} settings
     */
    setSettings(settings) {
        this._settings = settings;
        this._loadSettings();

        const keys = [
            'anthropic-api-key', 'anthropic-model', 'ai-enabled',
            'system-prompt-path', 'framing-prompt-path',
            'proxy-url', 'proxy-ca-cert',
            'ai-request-timeout-secs', 'ai-max-history-turns',
        ];
        for (const key of keys) {
            this._settingsChangedIds.push(
                this._settings.connect(`changed::${key}`, () => this._loadSettings())
            );
        }
    }

    _loadSettings() {
        if (!this._settings)
            return;
        this._apiKey = this._settings.get_string('anthropic-api-key').trim();
        this._model = this._settings.get_string('anthropic-model') || 'claude-haiku-4-5';
        this._enabled = this._settings.get_boolean('ai-enabled');
        this._systemPromptPath = this._settings.get_string('system-prompt-path');
        this._framingPromptPath = this._settings.get_string('framing-prompt-path');
        this._proxyUrl = this._settings.get_string('proxy-url');
        this._proxyCaCert = this._settings.get_string('proxy-ca-cert');
        this._requestTimeoutSecs = this._settings.get_uint('ai-request-timeout-secs');
        this._maxHistoryTurns = this._settings.get_uint('ai-max-history-turns');

        // Re-configure session proxy/TLS and timeout if already initialized.
        if (this._session) {
            this._configureSessionProxy();
            this._applySessionTimeout();
        }
    }

    /**
     * Apply the configured request timeout to the Soup.Session.
     * Soup.Session uses 0 to mean "no timeout" — we follow that
     * convention. The timeout is the maximum time the entire request
     * (including TLS handshake, request send, response receive) can
     * take. idle_timeout bounds time spent waiting for data on a
     * keep-alive socket.
     */
    _applySessionTimeout() {
        if (!this._session)
            return;
        const t = this._requestTimeoutSecs;
        this._session.timeout = t;
        this._session.idle_timeout = t;
        log(`Speakeasy AI: HTTP timeout set to ${t}s`);
    }

    /**
     * Initialize the HTTP session.
     * @returns {boolean} true if ready
     */
    init() {
        this._session = new Soup.Session();
        this._configureSessionProxy();
        this._applySessionTimeout();
        return true;
    }

    /**
     * Configure proxy and TLS settings on the Soup.Session based on
     * the current proxy-url and proxy-ca-cert settings.
     */
    _configureSessionProxy() {
        if (this._proxyUrl) {
            const resolver = Gio.SimpleProxyResolver.new(this._proxyUrl, null);
            this._session.set_property('proxy-resolver', resolver);
        } else {
            // Reset to system default proxy resolver.
            this._session.set_property('proxy-resolver',
                Gio.ProxyResolver.get_default());
        }

        // Load the proxy CA certificate for accept-certificate validation.
        // We can't rely on tls-database alone because GLib's TLS backend
        // doesn't consult it properly for CONNECT-tunneled connections.
        this._proxyCaCertObj = null;
        if (this._proxyCaCert) {
            try {
                this._proxyCaCertObj = Gio.TlsCertificate.new_from_file(
                    this._proxyCaCert);
            } catch (e) {
                console.error(`[Speakeasy] Failed to load proxy CA cert: ${e.message}`);
            }
        }
    }

    /**
     * Check if AI cleanup is enabled and configured.
     * @returns {boolean}
     */
    isAvailable() {
        return this._enabled && this._apiKey !== '' && this._session !== null;
    }

    /**
     * Return diagnostic info for debug logging without exposing private fields.
     * @returns {object} Key-value pairs of relevant state
     */
    getDebugInfo() {
        return {
            enabled: this._enabled,
            hasSession: this._session !== null,
            hasKey: this._apiKey !== '',
            model: this._model,
            sessionActive: this._sessionActive,
        };
    }

    // ─── Prompt loading ─────────────────────────────────────────────

    /**
     * Get the mtime (in seconds since epoch) of a file, or 0 if the
     * file doesn't exist or can't be stat'd.
     * @param {string} filePath
     * @returns {number}
     */
    _getFileMtime(filePath) {
        try {
            const file = Gio.File.new_for_path(filePath);
            const info = file.query_info(
                'time::modified', Gio.FileQueryInfoFlags.NONE, null);
            return info.get_attribute_uint64('time::modified');
        } catch (_e) {
            return 0;
        }
    }

    /**
     * Read a prompt file's contents. Returns the text, or null if the
     * file doesn't exist, can't be read, or is empty.
     * @param {string} filePath - Absolute path to the prompt file
     * @returns {string|null}
     */
    _readPromptFile(filePath) {
        if (!filePath || filePath === '')
            return null;

        try {
            const file = Gio.File.new_for_path(filePath);
            const [ok, contents] = file.load_contents(null);
            if (ok && contents) {
                const text = new TextDecoder().decode(contents);
                if (text.trim() === '') {
                    log(`Speakeasy AI: prompt file is empty: ${filePath}`);
                    return null;
                }
                return text;
            }
        } catch (e) {
            log(`Speakeasy AI: failed to read prompt file "${filePath}": ${e.message}`);
        }
        return null;
    }

    /**
     * Resolve which file to use for a prompt.
     * @param {string} settingsPath - User-configured path (may be empty)
     * @param {string} bundledName - Filename under prompts/ in extension dir
     * @returns {string|null} Resolved absolute path, or null if none found
     */
    _resolvePromptPath(settingsPath, bundledName) {
        // 1. User-configured path takes priority
        if (settingsPath && settingsPath !== '') {
            const file = Gio.File.new_for_path(settingsPath);
            if (file.query_exists(null))
                return settingsPath;
            log(`Speakeasy AI: configured prompt path not found: ${settingsPath}`);
        }

        // 2. Bundled file in extension directory
        if (this._extensionDir) {
            const bundledPath = GLib.build_filenamev([
                this._extensionDir, 'prompts', bundledName,
            ]);
            const file = Gio.File.new_for_path(bundledPath);
            if (file.query_exists(null))
                return bundledPath;
        }

        return null;
    }

    /**
     * Load system prompt and framing template, re-reading from disk
     * only if the file has actually changed (path or mtime differs).
     *
     * Priority: settings path → bundled file → (framing only: hardcoded default).
     * System prompt has no hardcoded fallback — the bundled file IS the default.
     */
    _loadPrompts() {
        let changed = false;

        // ── System prompt ──
        const sysPath = this._resolvePromptPath(
            this._systemPromptPath, 'system.txt');

        if (sysPath === null) {
            // No file available at all
            if (this._systemPrompt !== null)
                changed = true;
            this._systemPrompt = null;
            this._systemPromptFile = null;
            this._systemPromptMtime = 0;
            log('Speakeasy AI: WARNING — no system prompt available');
        } else {
            const mtime = this._getFileMtime(sysPath);
            if (sysPath !== this._systemPromptFile || mtime !== this._systemPromptMtime) {
                // Path changed or file modified — re-read
                this._systemPrompt = this._readPromptFile(sysPath);
                this._systemPromptFile = sysPath;
                this._systemPromptMtime = mtime;
                changed = true;
                log(`Speakeasy AI: system prompt reloaded from ${sysPath} (${this._systemPrompt?.length ?? 0} chars)`);
            }
        }

        // ── Framing template ──
        const framingPath = this._resolvePromptPath(
            this._framingPromptPath, 'framing.txt');

        if (framingPath === null) {
            // No file — use hardcoded default
            if (this._framingTemplateFile !== null || this._framingTemplate !== DEFAULT_FRAMING_TEMPLATE)
                changed = true;
            this._framingTemplate = DEFAULT_FRAMING_TEMPLATE;
            this._framingTemplateFile = null;
            this._framingTemplateMtime = 0;
        } else {
            const mtime = this._getFileMtime(framingPath);
            if (framingPath !== this._framingTemplateFile || mtime !== this._framingTemplateMtime) {
                const text = this._readPromptFile(framingPath);
                if (text !== null) {
                    this._framingTemplate = text;
                    this._framingTemplateFile = framingPath;
                    this._framingTemplateMtime = mtime;
                    changed = true;
                    log(`Speakeasy AI: framing prompt reloaded from ${framingPath} (${text.length} chars)`);
                } else {
                    // File exists but empty/unreadable — fall back to default
                    this._framingTemplate = DEFAULT_FRAMING_TEMPLATE;
                    this._framingTemplateFile = null;
                    this._framingTemplateMtime = 0;
                }
            }
        }

        if (!changed) {
            log('Speakeasy AI: prompts unchanged, reusing cached versions ' +
                `(system=${this._systemPrompt?.length ?? 0} chars, ` +
                `framing=${this._framingTemplate?.length ?? 0} chars)`);
        }
    }

    // ─── Session lifecycle ───────────────────────────────────────────

    /**
     * Begin a new AI session for a recording. Sends the initial framing
     * message and caches the system prompt.
     *
     * Called when the recording is committed (hold confirmed or double-tap
     * locked). This runs asynchronously; failures are non-fatal (the
     * final request will still work, just without the cache advantage).
     */
    async beginSession() {
        if (!this.isAvailable())
            return;

        // Clean up any prior session
        this._resetSession();

        this._sessionUuid = GLib.uuid_string_random();
        this._sessionActive = true;

        log(`Speakeasy AI: beginning session (uuid=${this._sessionUuid})`);

        // Re-read prompt files from disk each session so edits take
        // effect without restarting GNOME Shell.
        this._loadPrompts();

        // Replace {{UUID}} placeholder in the framing template
        const framingMessage = this._framingTemplate.replace(
            /\{\{UUID\}\}/g, this._sessionUuid
        );

        // Build the initial conversation
        this._conversationHistory = [
            {role: 'user', content: framingMessage},
        ];

        // Send the initial request (max_tokens=1, response discarded).
        // Track the warmup so finalize() can await it if the recording
        // ends before the warmup HTTP request completes.  Without this,
        // the conversation history has two consecutive user turns and the
        // Anthropic API rejects it with a 400.
        this._pendingOp = (async () => {
            try {
                await this._sendIntermediateRequest();
                log('Speakeasy AI: session started, cache warm');
            } catch (e) {
                // Non-fatal — the final request will still work
                log(`Speakeasy AI: session start failed (non-fatal): ${e.message}`);
            }
            // Start the chunk flush timer
            this._startChunkTimer();
        })();
    }

    /**
     * Feed raw STT text into the session buffer. Called by extension.js
     * when the recorder produces a final text segment.
     * @param {string} text - A finalized STT text segment
     */
    feedText(text) {
        if (!this._sessionActive || !text || text.trim() === '')
            return;

        if (this._chunkBuffer.length > 0)
            this._chunkBuffer += ' ';
        this._chunkBuffer += text;
    }

    /**
     * Finalize the session: flush remaining text, send the UUID signal,
     * and stream the cleaned output.
     *
     * @param {function(string)|null} onDelta - Called with each streamed
     *   text chunk. Use to pipe directly to wtype.
     * @returns {Promise<string|null>} The full cleaned text, or null on failure
     */
    async finalize(onDelta) {
        if (!this._sessionActive) {
            log('Speakeasy AI: finalize called but no active session');
            return null;
        }

        this._stopChunkTimer();

        // Wait for the beginSession() warmup and any pending chunk flushes
        // to complete before building the final request.  This ensures the
        // conversation history has proper alternating user/assistant turns;
        // without it, short recordings race against the warmup and produce
        // [user, user] which the Anthropic API rejects.
        if (this._pendingOp) {
            try {
                await this._pendingOp;
            } catch (_e) {
                // Errors already logged by the individual operations
            }
            this._pendingOp = null;
        }

        // Build the final user message: any remaining buffered text + UUID
        let finalContent = '';
        if (this._chunkBuffer.trim() !== '')
            finalContent = this._chunkBuffer.trim() + '\n';
        finalContent += this._sessionUuid;

        this._chunkBuffer = '';

        // Add the final user turn to the conversation
        this._conversationHistory.push({role: 'user', content: finalContent});

        log(`Speakeasy AI: finalizing session (${this._conversationHistory.length} turns)`);

        // Send the final request — this one streams the actual cleanup
        this._cancellable = new Gio.Cancellable();

        try {
            const cleanedText = await this._sendFinalRequest(onDelta);
            log(`Speakeasy AI: cleanup complete (${cleanedText?.length ?? 0} chars)`);
            this._resetSession();
            return cleanedText;
        } catch (e) {
            log(`Speakeasy AI: finalize failed: ${e.message}`);
            this._resetSession();
            return null;
        }
    }

    /**
     * Cancel the current session. Discards all state.
     */
    cancelSession() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._resetSession();
    }

    // ─── Internal: history cap ───────────────────────────────────────

    /**
     * Trim _conversationHistory to at most _maxHistoryTurns turn pairs.
     *
     * The framing pair (history[0]=user framing, history[1]=assistant
     * placeholder) is always preserved so the model still sees the
     * cleanup instructions. Older chunk pairs (user dictation chunk +
     * assistant placeholder) are dropped from the front, oldest first.
     *
     * Pairs are dropped in twos to keep the user/assistant alternation
     * required by the Anthropic API. We do not summarize dropped
     * content; the bytes simply go away. The most recent K-1 chunks
     * stay, and the FINAL turn (added by finalize()) is the one the
     * model is asked to clean up — that one always survives because
     * the cap runs before the final turn is appended.
     *
     * 0 disables the cap entirely (caller's risk).
     */
    _capHistory() {
        if (this._maxHistoryTurns <= 0)
            return;

        // Always preserve the framing pair (2 entries).
        const PRESERVE = 2;
        const allowedAfter = Math.max(0, 2 * (this._maxHistoryTurns - 1));
        const maxEntries = PRESERVE + allowedAfter;

        if (this._conversationHistory.length <= maxEntries)
            return;

        const excess = this._conversationHistory.length - maxEntries;
        // Drop in pairs to preserve user/assistant alternation.
        const toDrop = excess - (excess % 2);
        if (toDrop === 0)
            return;

        this._conversationHistory.splice(PRESERVE, toDrop);
        log(`Speakeasy AI: history cap — dropped ${toDrop} oldest entries ` +
            `(now ${this._conversationHistory.length}, max=${maxEntries})`);
    }

    // ─── Internal: intermediate requests ─────────────────────────────

    /**
     * Flush the chunk buffer as an intermediate conversation turn.
     * Sends the buffered text as a user message, with max_tokens=1.
     * The response is discarded; a placeholder is stored in history.
     *
     * The actual HTTP request is chained onto _pendingOp so that
     * finalize() can await any in-flight flush before building its
     * final request.
     */
    _flushChunk() {
        if (!this._sessionActive)
            return;

        const text = this._chunkBuffer.trim();
        if (text === '')
            return;

        this._chunkBuffer = '';
        this._conversationHistory.push({role: 'user', content: text});

        log(`Speakeasy AI: flushing chunk (${text.length} chars, ${this._conversationHistory.length} turns)`);

        const prevOp = this._pendingOp ?? Promise.resolve();
        this._pendingOp = prevOp.then(async () => {
            try {
                await this._sendIntermediateRequest();
            } catch (e) {
                // Non-fatal: the text is already in the conversation history.
                // The next flush or finalize will include it and advance the cache.
                log(`Speakeasy AI: chunk flush failed (non-fatal): ${e.message}`);
            }
        });
    }

    /**
     * Send an intermediate request (max_tokens=1, response discarded).
     * Stores a placeholder assistant turn in the conversation history.
     * Retries up to MAX_RETRIES times on failure.
     */
    async _sendIntermediateRequest() {
        const sessionUuid = this._sessionUuid;

        // Cap before snapshotting so the request body is bounded.
        this._capHistory();

        const body = {
            model: this._model,
            max_tokens: 1,
            system: [{
                type: 'text',
                text: this._systemPrompt,
                cache_control: {type: 'ephemeral'},
            }],
            messages: [...this._conversationHistory],
        };

        try {
            await this._sendWithRetry(body);
        } finally {
            // Always push the placeholder to keep the conversation history
            // valid (alternating user/assistant).  If the request failed,
            // the model hasn't seen this turn, but the text is still in
            // the preceding user message and will be included in the final
            // request.  Guard against a stale in-flight request from a
            // cancelled session corrupting a new one.
            if (this._sessionUuid === sessionUuid) {
                this._conversationHistory.push({
                    role: 'assistant',
                    content: ASSISTANT_PLACEHOLDER,
                });
            }
        }
    }

    /**
     * Send the final request with streaming enabled. Parses the SSE
     * stream and calls onDelta for each text chunk.
     * @param {function(string)|null} onDelta
     * @returns {Promise<string>} Full cleaned text
     */
    async _sendFinalRequest(onDelta) {
        // Cap before snapshotting so the request body is bounded.
        // Note: the final user turn (added by finalize()) is at the
        // end of history and is preserved by _capHistory(); only
        // older chunk pairs are dropped.
        this._capHistory();

        const body = {
            model: this._model,
            max_tokens: 4096,
            stream: true,
            system: [{
                type: 'text',
                text: this._systemPrompt,
                cache_control: {type: 'ephemeral'},
            }],
            messages: [...this._conversationHistory],
        };

        const cancellable = this._cancellable;

        // Retry logic for the final request
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RETRY_BASE_MS * Math.pow(4, attempt - 1);
                log(`Speakeasy AI: final retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
                await sleep(delay);
            }

            try {
                const msg = this._buildMessage(body);

                const inputStream = await new Promise((resolve, reject) => {
                    this._session.send_async(
                        msg, GLib.PRIORITY_DEFAULT, cancellable,
                        (session, result) => {
                            try {
                                resolve(session.send_finish(result));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                const status = msg.status_code;
                if (status !== 200) {
                    this._readErrorBody(inputStream, status);
                    lastError = new Error(`HTTP ${status}`);
                    // Don't retry client errors (4xx) — they won't succeed.
                    if (status >= 400 && status < 500)
                        break;
                    continue;
                }

                // Parse the SSE stream
                return await this._readSSEStream(inputStream, cancellable, onDelta);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;  // don't retry cancellation
                lastError = e;
                log(`Speakeasy AI: final request attempt ${attempt} failed: ${e.message}`);
            }
        }

        throw lastError ?? new Error('Final request failed after retries');
    }

    // ─── Internal: HTTP helpers ──────────────────────────────────────

    /**
     * Send a non-streaming request with retry logic.
     * @param {object} body - Request body
     */
    async _sendWithRetry(body) {
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RETRY_BASE_MS * Math.pow(4, attempt - 1);
                log(`Speakeasy AI: intermediate retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
                await sleep(delay);
            }

            try {
                const msg = this._buildMessage(body);
                const cancellable = this._sessionActive
                    ? new Gio.Cancellable() : null;

                const inputStream = await new Promise((resolve, reject) => {
                    this._session.send_async(
                        msg, GLib.PRIORITY_LOW, cancellable,
                        (session, result) => {
                            try {
                                resolve(session.send_finish(result));
                            } catch (e) {
                                reject(e);
                            }
                        }
                    );
                });

                const status = msg.status_code;

                // Close the stream (we don't need the response body)
                inputStream.close(null);

                if (status === 200) {
                    log('Speakeasy AI: intermediate request succeeded');
                    return;
                }

                lastError = new Error(`HTTP ${status}`);
                log(`Speakeasy AI: intermediate request got HTTP ${status}`);

                // Don't retry client errors (4xx) — they won't succeed.
                if (status >= 400 && status < 500)
                    break;
            } catch (e) {
                lastError = e;
                log(`Speakeasy AI: intermediate request attempt ${attempt} failed: ${e.message}`);
            }
        }

        throw lastError ?? new Error('Intermediate request failed after retries');
    }

    /**
     * Build a Soup.Message for the Anthropic API.
     * @param {object} body - Request body
     * @returns {Soup.Message}
     */
    _buildMessage(body) {
        const msg = Soup.Message.new_from_uri(
            'POST', GLib.Uri.parse(API_URL, GLib.UriFlags.NONE));

        const headers = msg.get_request_headers();
        headers.append('x-api-key', this._apiKey);
        headers.append('anthropic-version', API_VERSION);
        headers.append('content-type', 'application/json');

        const jsonBytes = new TextEncoder().encode(JSON.stringify(body));
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(jsonBytes)
        );

        // When a proxy CA cert is configured, validate the server
        // certificate against it.  GLib's TLS backend does not
        // consult tls-database for CONNECT-tunneled connections,
        // so we check the issuer name via accept-certificate.
        if (this._proxyCaCertObj) {
            const caSubject = this._proxyCaCertObj.get_subject_name();
            msg.connect('accept-certificate', (_msg, cert, errors) => {
                if (errors === 0)
                    return true;
                // Only override UNKNOWN_CA (1); reject other errors.
                if (errors !== 1)
                    return false;
                return cert.get_issuer_name() === caSubject;
            });
        }

        return msg;
    }

    /**
     * Read and log an error response body (non-200 status).
     * @param {Gio.InputStream} stream
     * @param {number} status
     */
    _readErrorBody(stream, status) {
        try {
            const dataStream = new Gio.DataInputStream({
                base_stream: stream,
                close_base_stream: true,
            });
            const bytes = dataStream.read_bytes(4096, null);
            if (bytes && bytes.get_size() > 0) {
                const text = new TextDecoder().decode(bytes.toArray());
                log(`Speakeasy AI: error body (HTTP ${status}): ${text}`);
            }
            dataStream.close(null);
        } catch (e) {
            log(`Speakeasy AI: could not read error body: ${e.message}`);
        }
    }

    // ─── Internal: SSE stream parsing ────────────────────────────────

    /**
     * Parse an SSE stream from the Anthropic API, extracting text deltas.
     * @param {Gio.InputStream} inputStream
     * @param {Gio.Cancellable} cancellable
     * @param {function(string)|null} onDelta
     * @returns {Promise<string>} Full accumulated text
     */
    _readSSEStream(inputStream, cancellable, onDelta) {
        const dataStream = new Gio.DataInputStream({
            base_stream: inputStream,
            close_base_stream: true,
        });

        let fullText = '';
        let currentEvent = '';
        let currentData = '';

        return new Promise((resolve, reject) => {
            const readNextLine = () => {
                dataStream.read_line_async(
                    GLib.PRIORITY_DEFAULT, cancellable,
                    (stream, result) => {
                        let line;
                        try {
                            [line] = stream.read_line_finish_utf8(result);
                        } catch (e) {
                            dataStream.close(null);
                            reject(e);
                            return;
                        }

                        if (line === null) {
                            // EOF
                            dataStream.close(null);
                            resolve(fullText);
                            return;
                        }

                        // Parse SSE lines
                        if (line.startsWith('event: ')) {
                            currentEvent = line.substring(7);
                        } else if (line.startsWith('data: ')) {
                            currentData = line.substring(6);
                        } else if (line === '') {
                            // Blank line = end of SSE event
                            if (currentEvent && currentData) {
                                const delta = this._handleSSEEvent(
                                    currentEvent, currentData, onDelta
                                );
                                if (delta !== null)
                                    fullText += delta;

                                if (currentEvent === 'message_stop') {
                                    currentEvent = '';
                                    currentData = '';
                                    dataStream.close(null);
                                    resolve(fullText);
                                    return;
                                }
                            }
                            currentEvent = '';
                            currentData = '';
                        }

                        readNextLine();
                    }
                );
            };

            readNextLine();
        });
    }

    /**
     * Handle a single parsed SSE event.
     * @param {string} eventType
     * @param {string} dataStr - Raw JSON string
     * @param {function(string)|null} onDelta
     * @returns {string|null} Text delta if this event produced text, else null
     */
    _handleSSEEvent(eventType, dataStr, onDelta) {
        let data;
        try {
            data = JSON.parse(dataStr);
        } catch (e) {
            log(`Speakeasy AI: failed to parse SSE data: ${e.message}`);
            return null;
        }

        switch (eventType) {
            case 'content_block_delta':
                if (data.delta?.type === 'text_delta' && data.delta.text) {
                    const text = data.delta.text;
                    if (onDelta)
                        onDelta(text);
                    return text;
                }
                break;

            case 'message_start':
                if (data.message?.usage) {
                    const u = data.message.usage;
                    log(`Speakeasy AI: usage — input=${u.input_tokens} ` +
                        `cache_create=${u.cache_creation_input_tokens ?? 0} ` +
                        `cache_read=${u.cache_read_input_tokens ?? 0}`);
                }
                break;

            case 'message_delta':
                if (data.usage)
                    log(`Speakeasy AI: output tokens: ${data.usage.output_tokens}`);
                if (data.delta?.stop_reason)
                    log(`Speakeasy AI: stop reason: ${data.delta.stop_reason}`);
                break;

            case 'error':
                log(`Speakeasy AI: stream error: ${data.error?.type}: ${data.error?.message}`);
                break;

            case 'ping':
            case 'content_block_start':
            case 'content_block_stop':
            case 'message_stop':
                break;

            default:
                break;
        }

        return null;
    }

    // ─── Internal: timer and session management ──────────────────────

    _startChunkTimer() {
        this._stopChunkTimer();
        this._chunkTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, CHUNK_FLUSH_INTERVAL_MS, () => {
                this._flushChunk();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopChunkTimer() {
        if (this._chunkTimerId) {
            GLib.source_remove(this._chunkTimerId);
            this._chunkTimerId = 0;
        }
    }

    _resetSession() {
        this._stopChunkTimer();
        this._sessionUuid = null;
        this._conversationHistory = [];
        this._chunkBuffer = '';
        this._sessionActive = false;
        this._pendingOp = null;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    /**
     * Destroy, releasing all resources.
     */
    destroy() {
        this.cancelSession();

        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        if (this._settings && this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = [];
        }
        this._settings = null;
    }
}
