// SPDX-License-Identifier: MIT
// Speakeasy — AI text cleanup via OpenRouter (OpenAI-compatible API)
//
// OpenRouter provides an OpenAI-compatible API at openrouter.ai.
// Uses the same /v1/chat/completions endpoint as Ollama but with
// cloud API key authentication and required referer/title headers.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {sleep} from './utils.js';

const DEFAULT_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-haiku-4-5-20251001';
const MAX_RETRIES = 1;
const RETRY_BASE_MS = 500;

const DEFAULT_REQUEST_TIMEOUT_SECS = 60;

const OPENROUTER_FRAMING =
    'What follows is raw output from a speech recognition engine. '
    + 'It will be lowercase, without punctuation, and may contain filler words, '
    + 'self-corrections, and false starts. All text up to the marker '
    + '"END-OF-DICTATION" is raw dictation that needs cleanup. When you see '
    + 'that marker, output a properly capitalized, punctuated, and coherent '
    + 'version of everything that was dictated.';

export class OpenRouterCleanup {
    constructor() {
        this._session = null;
        this._url = DEFAULT_URL;
        this._model = DEFAULT_MODEL;
        this._apiKey = '';
        this._enabled = true;
        this._settings = null;
        this._settingsChangedIds = [];

        this._requestTimeoutSecs = DEFAULT_REQUEST_TIMEOUT_SECS;

        this._extensionDir = null;
        this._systemPromptPath = '';

        this._systemPrompt = null;
        this._systemPromptFile = null;
        this._systemPromptMtime = 0;

        this._textBuffer = '';
        this._sessionActive = false;
        this._cancellable = null;
    }

    setExtensionDir(dir) {
        this._extensionDir = dir;
    }

    setSettings(settings) {
        this._settings = settings;
        this._loadSettings();

        const keys = [
            'openrouter-url', 'openrouter-model', 'openrouter-api-key',
            'ai-enabled', 'system-prompt-path', 'ai-request-timeout-secs',
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
        this._url = this._settings.get_string('openrouter-url') || DEFAULT_URL;
        this._model = this._settings.get_string('openrouter-model') || DEFAULT_MODEL;
        this._apiKey = this._settings.get_string('openrouter-api-key') || '';
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

    init() {
        this._session = new Soup.Session();
        this._configureSessionProxy();
        this._applySessionTimeout();
        return true;
    }

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

    _applySessionTimeout() {
        if (!this._session)
            return;
        const t = this._requestTimeoutSecs;
        this._session.timeout = t;
        this._session.idle_timeout = t;
        log(`Speakeasy OpenRouter: HTTP timeout set to ${t}s`);
    }

    isAvailable() {
        return this._enabled && this._session !== null && this._apiKey.length > 0;
    }

    getDebugInfo() {
        return {
            enabled: this._enabled,
            hasSession: this._session !== null,
            hasApiKey: this._apiKey.length > 0,
            url: this._url,
            model: this._model,
            sessionActive: this._sessionActive,
        };
    }

    _loadPrompt() {
        let path = this._systemPromptPath;
        if (!path || path === '') {
            if (this._extensionDir) {
                path = GLib.build_filenamev([
                    this._extensionDir, 'prompts', 'system.txt',
                ]);
            }
        }

        if (!path) {
            log('Speakeasy OpenRouter: WARNING — no system prompt available');
            this._systemPrompt = null;
            return;
        }

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
            log(`Speakeasy OpenRouter: prompt unchanged, reusing cached (${this._systemPrompt?.length ?? 0} chars)`);
            return;
        }

        try {
            const file = Gio.File.new_for_path(path);
            const [ok, contents] = file.load_contents(null);
            if (ok && contents) {
                this._systemPrompt = new TextDecoder().decode(contents);
                this._systemPromptFile = path;
                this._systemPromptMtime = mtime;
                log(`Speakeasy OpenRouter: prompt loaded from ${path} (${this._systemPrompt.length} chars)`);
                return;
            }
        } catch (e) {
            log(`Speakeasy OpenRouter: failed to read prompt "${path}": ${e.message}`);
        }

        this._systemPrompt = null;
    }

    beginSession() {
        if (!this.isAvailable())
            return;

        this._resetSession();
        this._sessionActive = true;
        this._loadPrompt();
        log('Speakeasy OpenRouter: session started');
    }

    feedText(text) {
        if (!this._sessionActive || !text || text.trim() === '')
            return;

        if (this._textBuffer.length > 0)
            this._textBuffer += ' ';
        this._textBuffer += text;
    }

    async finalize(onDelta) {
        if (!this._sessionActive) {
            log('Speakeasy OpenRouter: finalize called but no active session');
            return null;
        }

        const text = this._textBuffer.trim();
        if (text === '') {
            log('Speakeasy OpenRouter: no text to clean');
            this._resetSession();
            return null;
        }

        log(`Speakeasy OpenRouter: cleaning ${text.length} chars via ${this._model}`);
        this._cancellable = new Gio.Cancellable();

        try {
            const cleaned = await this._sendWithRetry(text, onDelta);
            log(`Speakeasy OpenRouter: cleanup complete (${cleaned?.length ?? 0} chars)`);
            this._resetSession();
            return cleaned;
        } catch (e) {
            log(`Speakeasy OpenRouter: finalize failed: ${e.message}`);
            this._resetSession();
            return null;
        }
    }

    cancelSession() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._resetSession();
    }

    async _sendWithRetry(text, onDelta) {
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                const delay = RETRY_BASE_MS * attempt;
                log(`Speakeasy OpenRouter: retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
                await sleep(delay);
            }

            try {
                return await this._sendRequest(text, onDelta);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                lastError = e;
                log(`Speakeasy OpenRouter: attempt ${attempt} failed: ${e.message}`);
            }
        }

        throw lastError ?? new Error('OpenRouter request failed after retries');
    }

    async _sendRequest(text, onDelta) {
        const url = `${this._url}/chat/completions`;

        const userContent = `${OPENROUTER_FRAMING}\n\n${text}\n\nEND-OF-DICTATION`;

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
        headers.append('Authorization', `Bearer ${this._apiKey}`);
        headers.append('HTTP-Referer', 'https://github.com/anomalyco/speakeasy');
        headers.append('X-Title', 'Speakeasy');

        const jsonBytes = new TextEncoder().encode(JSON.stringify(body));
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(jsonBytes)
        );

        if (this._proxyCaCertObj) {
            const caSubject = this._proxyCaCertObj.get_subject_name();
            msg.connect('accept-certificate', (_msg, cert, errors) => {
                if (errors === 0)
                    return true;
                if (errors !== 1)
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
            try {
                const ds = new Gio.DataInputStream({
                    base_stream: inputStream, close_base_stream: true,
                });
                const bytes = ds.read_bytes(4096, null);
                if (bytes && bytes.get_size() > 0) {
                    const errText = new TextDecoder().decode(bytes.toArray());
                    log(`Speakeasy OpenRouter: error body (HTTP ${status}): ${errText}`);
                }
                ds.close(null);
            } catch (_e) { /* ignore */ }
            throw new Error(`HTTP ${status}`);
        }

        return await this._readSSEStream(inputStream, this._cancellable, onDelta);
    }

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
                            }
                        }

                        readNextLine();
                    }
                );
            };

            readNextLine();
        });
    }

    _resetSession() {
        this._textBuffer = '';
        this._sessionActive = false;

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

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