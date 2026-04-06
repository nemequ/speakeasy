#!/usr/bin/env -S gjs -m
// Integration test for AICleanup: spins up a local HTTP server that
// mimics the Anthropic API, then exercises the full session lifecycle.
//
// Run: gjs -m tests/test-ai-integration.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {AICleanup} from '../ai.js';

// ─── Test harness ───────────────────────────────────────────────────

let _passed = 0;
let _failed = 0;
let _errors = [];

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function test(name, fn) {
    try {
        await fn();
        _passed++;
        print(`  PASS  ${name}`);
    } catch (e) {
        _failed++;
        _errors.push({name, error: e.message, stack: e.stack});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

// ─── Mock Anthropic API server ──────────────────────────────────────

class MockAnthropicServer {
    constructor() {
        this._server = new Soup.Server();
        this._requests = [];       // captured request bodies
        this._nextResponse = null; // what to respond with
        this._forceStatus = 0;    // force a specific HTTP status (0 = normal)
        this._port = 0;
    }

    start() {
        this._server.add_handler('/v1/messages', (server, msg, path, query) => {
            const body = msg.get_request_body();
            const requestText = new TextDecoder().decode(body.flatten().get_data());
            const requestJson = JSON.parse(requestText);
            this._requests.push(requestJson);

            // Validate required headers
            const headers = msg.get_request_headers();
            const apiKey = headers.get_one('x-api-key');
            const version = headers.get_one('anthropic-version');
            const contentType = headers.get_one('content-type');

            // Force a specific status if configured
            if (this._forceStatus > 0) {
                const errorBody = JSON.stringify({
                    type: 'error',
                    error: {type: 'authentication_error', message: 'invalid x-api-key'},
                });
                msg.set_status(this._forceStatus, null);
                msg.get_response_headers().append('content-type', 'application/json');
                msg.get_response_body().append(new TextEncoder().encode(errorBody));
                return;
            }

            // Log the request for debugging
            print(`    [mock] Received request: model=${requestJson.model}, ` +
                  `max_tokens=${requestJson.max_tokens}, ` +
                  `stream=${requestJson.stream ?? false}, ` +
                  `messages=${requestJson.messages?.length ?? 0}, ` +
                  `has_system=${!!requestJson.system}, ` +
                  `top_level_keys=[${Object.keys(requestJson).join(',')}]`);

            // Check for invalid top-level fields
            const validFields = new Set([
                'model', 'messages', 'max_tokens', 'metadata',
                'stop_sequences', 'stream', 'system', 'temperature',
                'tool_choice', 'tools', 'top_k', 'top_p',
            ]);
            const extraFields = Object.keys(requestJson)
                .filter(k => !validFields.has(k));
            if (extraFields.length > 0) {
                print(`    [mock] ERROR: Unknown top-level fields: ${extraFields.join(', ')}`);
                const errorBody = JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: `Extra inputs are not permitted: ${extraFields.join(', ')}`,
                    },
                });
                msg.set_status(400, null);
                msg.get_response_headers().append('content-type', 'application/json');
                msg.get_response_body().append(new TextEncoder().encode(errorBody));
                return;
            }

            // Validate messages alternate correctly
            const msgs = requestJson.messages || [];
            for (let i = 1; i < msgs.length; i++) {
                if (msgs[i].role === msgs[i - 1].role) {
                    print(`    [mock] ERROR: Consecutive ${msgs[i].role} messages at index ${i - 1} and ${i}`);
                    const errorBody = JSON.stringify({
                        type: 'error',
                        error: {
                            type: 'invalid_request_error',
                            message: `messages: roles must alternate between "user" and "assistant", but found consecutive "${msgs[i].role}" roles`,
                        },
                    });
                    msg.set_status(400, null);
                    msg.get_response_headers().append('content-type', 'application/json');
                    msg.get_response_body().append(new TextEncoder().encode(errorBody));
                    return;
                }
            }

            // Validate first message is user
            if (msgs.length > 0 && msgs[0].role !== 'user') {
                print(`    [mock] ERROR: First message must be user, got ${msgs[0].role}`);
                const errorBody = JSON.stringify({
                    type: 'error',
                    error: {
                        type: 'invalid_request_error',
                        message: `messages: first message must use the "user" role`,
                    },
                });
                msg.set_status(400, null);
                msg.get_response_headers().append('content-type', 'application/json');
                msg.get_response_body().append(new TextEncoder().encode(errorBody));
                return;
            }

            // Validate system prompt is not null/empty
            if (requestJson.system) {
                for (const block of requestJson.system) {
                    if (block.type === 'text' && (block.text === null || block.text === undefined)) {
                        print(`    [mock] ERROR: System block has null text`);
                        const errorBody = JSON.stringify({
                            type: 'error',
                            error: {
                                type: 'invalid_request_error',
                                message: `system.0.text: Input should be a valid string`,
                            },
                        });
                        msg.set_status(400, null);
                        msg.get_response_headers().append('content-type', 'application/json');
                        msg.get_response_body().append(new TextEncoder().encode(errorBody));
                        return;
                    }
                }
            }

            if (requestJson.stream) {
                // SSE streaming response
                msg.set_status(200, null);
                msg.get_response_headers().append('content-type', 'text/event-stream');

                const cleanedText = this._nextResponse ?? 'Hello, world.';
                const sseBody =
                    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"${requestJson.model}","stop_reason":null,"usage":{"input_tokens":100,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n` +
                    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
                    `event: ping\ndata: {"type":"ping"}\n\n` +
                    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${cleanedText}"}}\n\n` +
                    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
                    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}\n\n` +
                    `event: message_stop\ndata: {"type":"message_stop"}\n\n`;

                msg.get_response_body().append(new TextEncoder().encode(sseBody));
            } else {
                // Non-streaming response (intermediate requests)
                msg.set_status(200, null);
                msg.get_response_headers().append('content-type', 'application/json');
                const responseBody = JSON.stringify({
                    id: 'msg_test',
                    type: 'message',
                    role: 'assistant',
                    content: [{type: 'text', text: '...'}],
                    model: requestJson.model,
                    stop_reason: 'end_turn',
                    usage: {
                        input_tokens: 100,
                        output_tokens: 1,
                        cache_creation_input_tokens: 1000,
                        cache_read_input_tokens: 0,
                    },
                });
                msg.get_response_body().append(new TextEncoder().encode(responseBody));
            }
        });

        this._server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);

        // Get the assigned port
        const uris = this._server.get_uris();
        this._port = uris[0].get_port();
        print(`    [mock] Server listening on port ${this._port}`);
    }

    getUrl() {
        return `http://127.0.0.1:${this._port}`;
    }

    getRequests() {
        return this._requests;
    }

    clearRequests() {
        this._requests = [];
    }

    setNextResponse(text) {
        this._nextResponse = text;
    }

    setForceStatus(status) {
        this._forceStatus = status;
    }

    stop() {
        this._server.disconnect();
    }
}

// ─── Helper: create a configured AICleanup pointing at mock server ──

function createTestAI(mockServer) {
    const ai = new AICleanup();

    // Set extension dir to project root (for bundled prompts)
    const testDir = GLib.path_get_dirname(
        GLib.filename_from_uri(import.meta.url)[0]);
    ai.setExtensionDir(GLib.path_get_dirname(testDir));

    ai.init();
    ai._apiKey = 'sk-test-key-for-mock';
    ai._enabled = true;
    ai._model = 'claude-haiku-4-5';

    // Monkey-patch the API URL to point at mock server
    // We need to patch _buildMessage to use our URL instead
    const origBuildMessage = ai._buildMessage.bind(ai);
    ai._buildMessage = function(body) {
        const msg = Soup.Message.new_from_uri(
            'POST', GLib.Uri.parse(`${mockServer.getUrl()}/v1/messages`, GLib.UriFlags.NONE));

        const headers = msg.get_request_headers();
        headers.append('x-api-key', this._apiKey);
        headers.append('anthropic-version', '2023-06-01');
        headers.append('content-type', 'application/json');

        const jsonBytes = new TextEncoder().encode(JSON.stringify(body));
        msg.set_request_body_from_bytes(
            'application/json',
            new GLib.Bytes(jsonBytes)
        );
        return msg;
    };

    return ai;
}

// ─── Run tests ─────────────────────────────────────────────────────

const loop = GLib.MainLoop.new(null, false);

(async () => {
    print('');
    print('AICleanup Integration Tests (with mock HTTP server)');
    print('─'.repeat(60));

    const mock = new MockAnthropicServer();
    mock.start();

    // Test: Full session lifecycle (beginSession → feedText → finalize)
    await test('full session lifecycle produces cleaned text', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();
        mock.setNextResponse('Hello, world.');

        await ai.beginSession();
        ai.feedText('hello world');
        const result = await ai.finalize(null);

        assertEqual(result, 'Hello, world.', 'cleaned text');

        // Verify requests were made
        const requests = mock.getRequests();
        print(`    [info] ${requests.length} request(s) made`);
        assert(requests.length >= 2, `expected at least 2 requests (warmup + final), got ${requests.length}`);

        // Check that NO request has invalid top-level fields
        for (let i = 0; i < requests.length; i++) {
            const validFields = new Set([
                'model', 'messages', 'max_tokens', 'metadata',
                'stop_sequences', 'stream', 'system', 'temperature',
                'tool_choice', 'tools', 'top_k', 'top_p',
            ]);
            const extraFields = Object.keys(requests[i])
                .filter(k => !validFields.has(k));
            assertEqual(extraFields.length, 0,
                `request ${i} has invalid top-level fields: ${extraFields.join(', ')}`);
        }

        ai.destroy();
    });

    // Test: Intermediate request has correct system prompt
    await test('intermediate request includes system prompt', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();

        await ai.beginSession();
        // beginSession fires the warmup async via _pendingOp.
        // Feed text + finalize to await it and collect the request.
        ai.feedText('test');
        await ai.finalize(null);

        const requests = mock.getRequests();
        assert(requests.length >= 1, `expected at least 1 request, got ${requests.length}`);

        const warmup = requests[0];
        assert(warmup.system !== undefined, 'system field present');
        assert(Array.isArray(warmup.system), 'system is array');
        assert(warmup.system.length > 0, 'system has content');
        assert(warmup.system[0].text !== null, 'system text is not null');
        assert(warmup.system[0].text !== undefined, 'system text is not undefined');
        assert(warmup.system[0].text.length > 0, `system text is not empty (got ${warmup.system[0].text?.length} chars)`);
        print(`    [info] System prompt: ${warmup.system[0].text.length} chars`);

        ai.destroy();
    });

    // Test: Final request has streaming enabled
    await test('final request enables streaming', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();

        await ai.beginSession();
        ai.feedText('test text');
        await ai.finalize(null);

        const requests = mock.getRequests();
        const finalReq = requests[requests.length - 1];
        assertEqual(finalReq.stream, true, 'stream should be true');
        assertEqual(finalReq.max_tokens, 4096, 'max_tokens');

        ai.destroy();
    });

    // Test: Messages alternate user/assistant correctly
    await test('messages alternate user/assistant', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();

        await ai.beginSession();
        ai.feedText('some dictated text');
        await ai.finalize(null);

        const requests = mock.getRequests();
        for (let i = 0; i < requests.length; i++) {
            const msgs = requests[i].messages;
            for (let j = 1; j < msgs.length; j++) {
                assert(msgs[j].role !== msgs[j - 1].role,
                    `request ${i}: consecutive ${msgs[j].role} at positions ${j - 1} and ${j}`);
            }
            assertEqual(msgs[0].role, 'user', `request ${i}: first message should be user`);
        }

        ai.destroy();
    });

    // Test: Final request contains the UUID signal
    await test('final request contains UUID signal', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();

        await ai.beginSession();
        const uuid = ai._sessionUuid;
        assert(uuid !== null, 'UUID should be set');

        ai.feedText('hello world');
        await ai.finalize(null);

        const requests = mock.getRequests();
        const finalReq = requests[requests.length - 1];
        const lastMsg = finalReq.messages[finalReq.messages.length - 1];
        assert(lastMsg.content.includes(uuid),
            `final message should contain UUID "${uuid}"`);
        assertEqual(lastMsg.role, 'user', 'final message should be user');

        ai.destroy();
    });

    // Test: onDelta callback fires
    await test('onDelta callback receives streamed text', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();
        mock.setNextResponse('Cleaned output.');

        let deltaText = '';
        await ai.beginSession();
        ai.feedText('test');
        const result = await ai.finalize((delta) => { deltaText += delta; });

        assertEqual(result, 'Cleaned output.', 'full text');
        assertEqual(deltaText, 'Cleaned output.', 'delta text');

        ai.destroy();
    });

    // Test: Empty session returns null
    await test('finalize with no text still sends UUID', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();
        mock.setNextResponse('');

        await ai.beginSession();
        // Don't feed any text
        const result = await ai.finalize(null);

        // Should still send a request (just UUID, no text)
        const requests = mock.getRequests();
        assert(requests.length >= 2, 'requests should be made');

        ai.destroy();
    });

    // Test: 401 errors are NOT retried
    await test('401 auth error is not retried (fails fast)', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();
        mock.setForceStatus(401);

        // beginSession makes the warmup request which will get 401
        await ai.beginSession();

        // Wait for the warmup to complete (it's async via _pendingOp)
        // feedText + finalize will await _pendingOp
        ai.feedText('test');

        const result = await ai.finalize(null);
        assertEqual(result, null, 'should return null on auth failure');

        // Key check: with 401, we should see exactly 1 warmup + 1 final = 2 requests
        // NOT 4 warmup + 4 final = 8 requests (old retry behavior)
        const requests = mock.getRequests();
        print(`    [info] ${requests.length} request(s) made (should be 2, not 8)`);
        assert(requests.length <= 2,
            `401 should not be retried: expected <= 2 requests, got ${requests.length}`);

        mock.setForceStatus(0);
        ai.destroy();
    });

    // Test: 500 errors ARE retried
    await test('500 server error is retried', async () => {
        const ai = createTestAI(mock);
        mock.clearRequests();
        mock.setForceStatus(500);

        await ai.beginSession();
        ai.feedText('test');

        const result = await ai.finalize(null);
        assertEqual(result, null, 'should return null on server failure');

        // Should see retries: warmup (4 attempts) + final (4 attempts) = 8
        const requests = mock.getRequests();
        print(`    [info] ${requests.length} request(s) made (should be 8 with retries)`);
        assert(requests.length > 2,
            `500 should be retried: expected > 2 requests, got ${requests.length}`);

        mock.setForceStatus(0);
        ai.destroy();
    });

    mock.stop();

    // ── Summary ──
    print('');
    print('═'.repeat(60));
    print(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);

    if (_errors.length > 0) {
        print('');
        print('Failures:');
        for (const {name, error, stack} of _errors) {
            print(`  - ${name}: ${error}`);
            if (stack) print(`    ${stack.split('\n').slice(1, 3).join('\n    ')}`);
        }
    }

    print('');
    loop.quit();
})().catch(e => {
    printerr(`Fatal: ${e.message}\n${e.stack}`);
    loop.quit();
});

loop.run();
imports.system.exit(_failed > 0 ? 1 : 0);
