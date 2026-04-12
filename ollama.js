// SPDX-License-Identifier: MIT
// Speakeasy — Local AI text cleanup via Ollama (OpenAI-compatible API)
//
// Much simpler than the Anthropic backend: no multi-turn conversation,
// no prompt caching warmup, no chunk flushing.  Just accumulate raw STT
// text during recording, then send a single request to Ollama when the
// recording stops.
//
// Uses Ollama's OpenAI-compatible endpoint (/v1/chat/completions) with
// streaming so we can handle longer responses without timeout issues.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {sleep} from './utils.js';

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen2.5:3b';
const MAX_RETRIES = 1;
const RETRY_BASE_MS = 500;

// Default request timeout in seconds. Overridden by GSettings via
// the shared 'ai-request-timeout-secs' key (same as the Anthropic
// backend). 0 = no timeout (not recommended).
const DEFAULT_REQUEST_TIMEOUT_SECS = 60;

// Framing text for single-shot cleanup requests. Instructs the model
// that the input is raw STT output and uses END-OF-DICTATION as the
// end-of-input marker (no per-session UUID needed for single-shot).
const OLLAMA_FRAMING =
    'What follows is raw output from a speech recognition engine. '
    + 'It will be lowercase, without punctuation, and may contain filler words, '
    + 'self-corrections, and false starts. All text up to the marker '
    + '"END-OF-DICTATION" is raw dictation that needs cleanup. When you see '
    + 'that marker, output a properly capitalized, punctuated, and coherent '
    + 'version of everything that was dictated.';

/**
 * OllamaCleanup manages speech-to-text cleanup via a local Ollama server.
 *
 * Implements the AIBackend interface (see ai.js) so extension.js can
 * swap backends transparently:
 *
 *   const ai = new OllamaCleanup();
 *   ai.setSettings(settings);
 *   ai.init();
 *
 *   // On recording commit:
 *   ai.beginSession();
 *
 *   // During recording:
 *   ai.feedText(segment);
 *
 *   // On recording stop:
 *   const cleaned = await ai.finalize(null);
 *
 *   // On discard:
 *   ai.cancelSession();
 */
export class OllamaCleanup {
    constructor() {
        this._session = null;   // Soup.Session
        this._url = DEFAULT_URL;
        this._model = DEFAULT_MODEL;
        this._enabled = true;
        this._settings = null;
        this._settingsChangedIds = [];

        this._requestTimeoutSecs = DEFAULT_REQUEST_TIMEOUT_SECS;

        // Extension directory — used to resolve bundled prompt files
        this._extensionDir = null;
        this._systemPromptPath = '';

        // Prompt cache
        this._systemPrompt = null;
        this._systemPromptFile = null;
        this._systemPromptMtime = 0;

        // Per-recording session state
        this._textBuffer = '';
        this._sessionActive = false;
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
            'ollama-url', 'ollama-model', 'ai-enabled',
            'system-prompt-path', 'ai-request-timeout-secs',
            'proxy-url', 'proxy-ca-cert',
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
        this._url = this._settings.get_string('ollama-url') || DEFAULT_URL;
        this._model = this._settings.get_string('ollama-model') || DEFAULT_MODEL;
        this._enabled = this._settings.get_boolean('ai-enabled');
        this._systemPromptPath = this._settings.get_string('system-prompt-path');
        this._requestTimeoutSecs = this._settings.get_uint('ai-request-timeout-secs');
        this._proxyUrl = this._settings.get_string('proxy-url');
        this._proxyCaCert = this._settings.get_string('proxy-ca-cert');

        if (this._session) {
            this._configureSessionProxy();
            this._applySessionTimeout();
        }
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
     * Configure proxy and TLS settings on the Soup.Session.
     */
    _configureSessionProxy() {
        if (this._proxyUrl) {
            const resolver = Gio.SimpleProxyResolver.new(this._proxyUrl, null);
            this._session.set_property('proxy-resolver', resolver);
        } else {
            this._session.set_property('proxy-resolver',
                Gio.ProxyResolver.get_default());
        }

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
     * Apply the configured request timeout to the Soup.Session.
     * 0 disables the timeout (Soup convention).
     */
    _applySessionTimeout() {
        if (!this._session)
            return;
        const t = this._requestTimeoutSecs;
        this._session.timeout = t;
        this._session.idle_timeout = t;
        log(`Speakeasy Ollama: HTTP timeout set to ${t}s`);
    }

    /**
     * Check if cleanup is enabled and configured.
     * No API key needed — just needs Ollama running.
     * @returns {boolean}
     */
    isAvailable() {
        return this._enabled && this._session !== null;
    }

    /**
     * Return diagnostic info for debug logging without exposing private fields.
     * @returns {object} Key-value pairs of relevant state
     */
    getDebugInfo() {
        return {
            enabled: this._enabled,
            hasSession: this._session !== null,
            url: this._url,
            model: this._model,
            sessionActive: this._sessionActive,
        };
    }

    // ─── Prompt loading ─────────────────────────────────────────────

    /**
     * Load the system prompt, re-reading from disk only if the file
     * has changed (path or mtime differs).
     */
    _loadPrompt() {
        // Resolve path: settings override → bundled default
        let path = this._systemPromptPath;
        if (!path || path === '') {
            if (this._extensionDir) {
                path = GLib.build_filenamev([
                    this._extensionDir, 'prompts', 'system.txt',
                ]);
            }
        }

        if (!path) {
            log('Speakeasy Ollama: WARNING — no system prompt available');
            this._systemPrompt = null;
            return;
        }

        // Check mtime to avoid re-reading unchanged files
        let mtime = 0;
        try {
            const file = Gio.File.new_for_path(path);
            const info = file.query_info(
                'time::modified', Gio.FileQueryInfoFlags.NONE, null);
            mtime = info.get_attribute_uint64('time::modified');
        } catch (_e) {
            mtime = 0;
        }

        if (path === this._systemPromptFile && mtime === this._systemPromptMtime) {
            log(`Speakeasy Ollama: prompt unchanged, reusing cached (${this._systemPrompt?.length ?? 0} chars)`);
            return;
        }

        // Read the file
        try {
            const file = Gio.File.new_for_path(path);
            const [ok, contents] = file.load_contents(null);
            if (ok && contents) {
                this._systemPrompt = new TextDecoder().decode(contents);
                this._systemPromptFile = path;
                this._systemPromptMtime = mtime;
                log(`Speakeasy Ollama: prompt loaded from ${path} (${this._systemPrompt.length} chars)`);
                return;
            }
        } catch (e) {
            log(`Speakeasy Ollama: failed to read prompt "${path}": ${e.message}`);
        }

        this._systemPrompt = null;
    }

    // (Framing text is now the module-level OLLAMA_FRAMING const.)

    // ─── Session lifecycle ───────────────────────────────────────────

    /**
     * Begin a new session.  For Ollama, this just resets state and
     * loads the prompt — no HTTP warmup needed.
     */
    beginSession() {
        if (!this.isAvailable())
            return;

        this._resetSession();
        this._sessionActive = true;
        this._loadPrompt();
        log('Speakeasy Ollama: session started');
    }

    /**
     * Feed raw STT text into the session buffer.
     * @param {string} text - A finalized STT text segment
     */
    feedText(text) {
        if (!this._sessionActive || !text || text.trim() === '')
            return;

        if (this._textBuffer.length > 0)
            this._textBuffer += ' ';
        this._textBuffer += text;
    }

    /**
     * Finalize the session: send accumulated text to Ollama for cleanup.
     *
     * @param {function(string)|null} onDelta - Called with each streamed
     *   text chunk (not used for Ollama but kept for interface compat).
     * @returns {Promise<string|null>} The full cleaned text, or null on failure
     */
    async finalize(onDelta) {
        if (!this._sessionActive) {
            log('Speakeasy Ollama: finalize called but no active session');
            return null;
        }

        const text = this._textBuffer.trim();
        if (text === '') {
            log('Speakeasy Ollama: no text to clean');
            this._resetSession();
            return null;
        }

        log(`Speakeasy Ollama: cleaning ${text.length} chars via ${this._model}`);
        this._cancellable = new Gio.Cancellable();

        try {
            const cleaned = await this._sendWithRetry(text, onDelta);
            log(`Speakeasy Ollama: cleanup complete (${cleaned?.length ?? 0} chars)`);
            this._resetSession();
            return cleaned;
        } catch (e) {
            log(`Speakeasy Ollama: finalize failed: ${e.message}`);
            this._resetSession();
            return null;
        }
    }

    /**
     * Cancel the current session.
     */
    cancelSession() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._resetSession();
    }

    // ─── Internal: HTTP ──────────────────────────────────────────────

    /**
     * Send the cleanup request with retry logic.
     * @param {string} text - Raw STT text to clean
     * @param {function(string)|null} onDelta
     * @returns {Promise<string>} Cleaned text
     */
    async _sendWithRetry(text, onDelta) {
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RETRY_BASE_MS * attempt;
                log(`Speakeasy Ollama: retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
                await sleep(delay);
            }

            try {
                return await this._sendRequest(text, onDelta);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                lastError = e;
                log(`Speakeasy Ollama: attempt ${attempt} failed: ${e.message}`);
            }
        }

        throw lastError ?? new Error('Ollama request failed after retries');
    }

    /**
     * Send a single streaming request to Ollama's OpenAI-compatible API.
     * @param {string} text - Raw STT text
     * @param {function(string)|null} onDelta
     * @returns {Promise<string>} Cleaned text
     */
    async _sendRequest(text, onDelta) {
        const url = `${this._url}/v1/chat/completions`;

        // Build the user message with framing context
        const userContent = `${OLLAMA_FRAMING}\n\n${text}\n\nEND-OF-DICTATION`;

        const body = {
            model: this._model,
            stream: true,
            temperature: 0.3,
            messages: [
                {role: 'system', content: this._systemPrompt ?? ''},
                {role: 'user', content: userContent},
            ],
        };

        const msg = Soup.Message.new_from_uri(
            'POST', GLib.Uri.parse(url, GLib.UriFlags.NONE));

        const headers = msg.get_request_headers();
        headers.append('content-type', 'application/json');

        const jsonBytes = new TextEncoder().encode(JSON.stringify(body));
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(jsonBytes)
        );

        // Validate server certificate against proxy CA if configured
        if (this._proxyCaCertObj) {
            const caSubject = this._proxyCaCertObj.get_subject_name();
            msg.connect('accept-certificate', (_msg, cert, errors) => {
                if (errors === 0)
                    return true;
                if (errors !== 1) // 1 = UNKNOWN_CA
                    return false;
                return cert.get_issuer_name() === caSubject;
            });
        }

        const inputStream = await new Promise((resolve, reject) => {
            this._session.send_async(
                msg, GLib.PRIORITY_DEFAULT, this._cancellable,
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
            // Read error body for logging
            try {
                const ds = new Gio.DataInputStream({
                    base_stream: inputStream, close_base_stream: true,
                });
                const bytes = ds.read_bytes(4096, null);
                if (bytes && bytes.get_size() > 0) {
                    const errText = new TextDecoder().decode(bytes.toArray());
                    log(`Speakeasy Ollama: error body (HTTP ${status}): ${errText}`);
                }
                ds.close(null);
            } catch (_e) { /* ignore */ }
            throw new Error(`HTTP ${status}`);
        }

        return await this._readSSEStream(inputStream, this._cancellable, onDelta);
    }

    // ─── Internal: SSE parsing (OpenAI format) ───────────────────────

    /**
     * Parse an OpenAI-compatible SSE stream, extracting text deltas.
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

                        if (line.startsWith('data: ')) {
                            const data = line.substring(6);

                            if (data === '[DONE]') {
                                dataStream.close(null);
                                resolve(fullText);
                                return;
                            }

                            try {
                                const json = JSON.parse(data);
                                const content = json.choices?.[0]?.delta?.content;
                                if (content) {
                                    fullText += content;
                                    if (onDelta)
                                        onDelta(content);
                                }
                            } catch (_e) {
                                // Skip unparseable lines
                            }
                        }

                        readNextLine();
                    }
                );
            };

            readNextLine();
        });
    }

    // ─── Internal: helpers ───────────────────────────────────────────

    _resetSession() {
        this._textBuffer = '';
        this._sessionActive = false;

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

        if (this._settings && this._settingsChangedIds) {
            for (const id of this._settingsChangedIds)
                this._settings.disconnect(id);
            this._settingsChangedIds = [];
        }
        this._settings = null;
        this._session = null;
    }
}
