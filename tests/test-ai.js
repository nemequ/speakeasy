#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for AICleanup (ai.js) and OllamaCleanup (ollama.js)
//
// Run: gjs -m tests/test-ai.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {AICleanup} from '../ai.js';
import {OllamaCleanup} from '../ollama.js';

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

function assertDeepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${message}: expected ${b}, got ${a}`);
}

function test(name, fn) {
    try {
        fn();
        _passed++;
        print(`  PASS  ${name}`);
    } catch (e) {
        _failed++;
        _errors.push({name, error: e.message});
        print(`  FAIL  ${name}`);
        print(`        ${e.message}`);
    }
}

// ════════════════════════════════════════════════════════════════════
//  AICleanup tests
// ════════════════════════════════════════════════════════════════════

print('');
print('AICleanup');
print('─'.repeat(60));

test('constructor defaults', () => {
    const ai = new AICleanup();
    assertEqual(ai._session, null, '_session');
    assertEqual(ai._apiKey, '', '_apiKey');
    assertEqual(ai._model, 'claude-haiku-4-5', '_model');
    assertEqual(ai._enabled, true, '_enabled');
    assertEqual(ai._sessionActive, false, '_sessionActive');
    assertEqual(ai._sessionUuid, null, '_sessionUuid');
    assertEqual(ai._chunkBuffer, '', '_chunkBuffer');
    assertEqual(ai._chunkTimerId, 0, '_chunkTimerId');
    assertDeepEqual(ai._conversationHistory, [], '_conversationHistory');
    assertEqual(ai._pendingOp, null, '_pendingOp');
    assertEqual(ai._cancellable, null, '_cancellable');
    assertEqual(ai._extensionDir, null, '_extensionDir');
    assertEqual(ai._systemPromptPath, '', '_systemPromptPath');
    assertEqual(ai._framingPromptPath, '', '_framingPromptPath');
    assertEqual(ai._systemPrompt, null, '_systemPrompt');
    assertEqual(ai._systemPromptFile, null, '_systemPromptFile');
    assertEqual(ai._systemPromptMtime, 0, '_systemPromptMtime');
    assertEqual(ai._framingTemplate, null, '_framingTemplate');
    assertEqual(ai._framingTemplateFile, null, '_framingTemplateFile');
    assertEqual(ai._framingTemplateMtime, 0, '_framingTemplateMtime');
});

test('isAvailable() returns false when no API key', () => {
    const ai = new AICleanup();
    ai.init();
    assertEqual(ai.isAvailable(), false, 'no key');
    ai.destroy();
});

test('isAvailable() returns false when no session', () => {
    const ai = new AICleanup();
    ai._apiKey = 'sk-test';
    // _session is null, no init()
    assertEqual(ai.isAvailable(), false, 'no http session');
});

test('isAvailable() returns false when disabled', () => {
    const ai = new AICleanup();
    ai.init();
    ai._apiKey = 'sk-test';
    ai._enabled = false;
    assertEqual(ai.isAvailable(), false, 'disabled');
    ai.destroy();
});

test('isAvailable() returns true when key+enabled+session set', () => {
    const ai = new AICleanup();
    ai.init();
    ai._apiKey = 'sk-test';
    ai._enabled = true;
    assertEqual(ai.isAvailable(), true, 'should be available');
    ai.destroy();
});

test('getDebugInfo() returns expected keys', () => {
    const ai = new AICleanup();
    ai.init();
    ai._apiKey = 'secret-key';
    const info = ai.getDebugInfo();

    assertEqual(info.enabled, true, 'enabled');
    assertEqual(info.hasSession, true, 'hasSession');
    assertEqual(info.hasKey, true, 'hasKey');
    assertEqual(info.model, 'claude-haiku-4-5', 'model');
    assertEqual(info.sessionActive, false, 'sessionActive');
    // API key must not be exposed in debug info
    assertEqual(info.apiKey, undefined, 'apiKey should not leak');
    ai.destroy();
});

test('feedText() ignores when no active session', () => {
    const ai = new AICleanup();
    ai.feedText('hello world');
    assertEqual(ai._chunkBuffer, '', 'buffer should be empty');
});

test('feedText() ignores empty strings', () => {
    const ai = new AICleanup();
    ai._sessionActive = true;
    ai.feedText('');
    assertEqual(ai._chunkBuffer, '', 'empty string');
    ai.feedText('   ');
    assertEqual(ai._chunkBuffer, '', 'whitespace-only');
    ai.feedText(null);
    assertEqual(ai._chunkBuffer, '', 'null');
    ai.feedText(undefined);
    assertEqual(ai._chunkBuffer, '', 'undefined');
});

test('feedText() buffers text correctly', () => {
    const ai = new AICleanup();
    ai._sessionActive = true;

    ai.feedText('hello');
    assertEqual(ai._chunkBuffer, 'hello', 'first segment');

    ai.feedText('world');
    assertEqual(ai._chunkBuffer, 'hello world', 'second segment with space');

    ai.feedText('foo bar');
    assertEqual(ai._chunkBuffer, 'hello world foo bar', 'third segment');
});

test('cancelSession() resets session state', () => {
    const ai = new AICleanup();
    // Simulate an active session
    ai._sessionActive = true;
    ai._sessionUuid = 'test-uuid';
    ai._chunkBuffer = 'some buffered text';
    ai._conversationHistory = [{role: 'user', content: 'hi'}];
    ai._pendingOp = Promise.resolve();
    ai._cancellable = new Gio.Cancellable();

    ai.cancelSession();

    assertEqual(ai._sessionActive, false, 'sessionActive');
    assertEqual(ai._sessionUuid, null, 'sessionUuid');
    assertEqual(ai._chunkBuffer, '', 'chunkBuffer');
    assertDeepEqual(ai._conversationHistory, [], 'conversationHistory');
    assertEqual(ai._pendingOp, null, 'pendingOp');
    assertEqual(ai._cancellable, null, 'cancellable');
});

test('cancelSession() cancels cancellable', () => {
    const ai = new AICleanup();
    const cancellable = new Gio.Cancellable();
    ai._cancellable = cancellable;
    ai._sessionActive = true;

    assertEqual(cancellable.is_cancelled(), false, 'before cancel');
    ai.cancelSession();
    assertEqual(cancellable.is_cancelled(), true, 'after cancel');
});

test('session lifecycle without HTTP: beginSession sets UUID', () => {
    // We can't call beginSession() without making HTTP calls, but
    // we can manually simulate the state it sets before the HTTP call.
    const ai = new AICleanup();
    ai.init();
    ai._apiKey = 'sk-test';

    // Simulate what beginSession does before the HTTP call:
    ai._sessionUuid = GLib.uuid_string_random();
    ai._sessionActive = true;

    assert(ai._sessionUuid !== null, 'uuid should be set');
    assert(ai._sessionUuid.length > 0, 'uuid should not be empty');
    assertEqual(ai._sessionActive, true, 'sessionActive should be true');

    // feedText should work now
    ai.feedText('hello');
    assertEqual(ai._chunkBuffer, 'hello', 'buffer after feedText');

    ai.feedText('world');
    assertEqual(ai._chunkBuffer, 'hello world', 'buffer after second feedText');

    // cancelSession resets everything
    ai.cancelSession();
    assertEqual(ai._sessionActive, false, 'sessionActive after cancel');
    assertEqual(ai._chunkBuffer, '', 'buffer after cancel');
    assertEqual(ai._sessionUuid, null, 'uuid after cancel');
    ai.destroy();
});

test('_resolvePromptPath with missing settings path falls through to bundled', () => {
    const ai = new AICleanup();

    // With no extensionDir set, both fallbacks fail → null
    const result1 = ai._resolvePromptPath('/nonexistent/path.txt', 'system.txt');
    assertEqual(result1, null, 'nonexistent path with no extensionDir');

    // With extensionDir set but no bundled file → null
    ai._extensionDir = '/tmp/nonexistent-ext-dir-for-test';
    const result2 = ai._resolvePromptPath('', 'system.txt');
    assertEqual(result2, null, 'empty settings path, missing bundled');

    // With a nonexistent settings path, falls through
    const result3 = ai._resolvePromptPath('/nonexistent/custom.txt', 'system.txt');
    assertEqual(result3, null, 'nonexistent settings path, missing bundled');
});

test('_resolvePromptPath returns settings path when file exists', () => {
    const ai = new AICleanup();

    // Create a temp file
    const tmpDir = GLib.dir_make_tmp('speakeasy-test-XXXXXX');
    const tmpPath = GLib.build_filenamev([tmpDir, 'test-prompt.txt']);
    const file = Gio.File.new_for_path(tmpPath);
    file.replace_contents(
        new TextEncoder().encode('test prompt'),
        null, false, Gio.FileCreateFlags.NONE, null);

    const result = ai._resolvePromptPath(tmpPath, 'system.txt');
    assertEqual(result, tmpPath, 'should return settings path');

    // Cleanup
    file.delete(null);
    Gio.File.new_for_path(tmpDir).delete(null);
});

test('_resolvePromptPath returns bundled path when it exists', () => {
    const ai = new AICleanup();

    // Create a temp directory with prompts/ subdirectory
    const tmpDir = GLib.dir_make_tmp('speakeasy-test-XXXXXX');
    const promptsDir = GLib.build_filenamev([tmpDir, 'prompts']);
    GLib.mkdir_with_parents(promptsDir, 0o755);
    const bundledPath = GLib.build_filenamev([promptsDir, 'system.txt']);
    const file = Gio.File.new_for_path(bundledPath);
    file.replace_contents(
        new TextEncoder().encode('bundled prompt'),
        null, false, Gio.FileCreateFlags.NONE, null);

    ai._extensionDir = tmpDir;
    const result = ai._resolvePromptPath('', 'system.txt');
    assertEqual(result, bundledPath, 'should return bundled path');

    // Cleanup
    file.delete(null);
    Gio.File.new_for_path(promptsDir).delete(null);
    Gio.File.new_for_path(tmpDir).delete(null);
});

test('_readPromptFile with non-existent file returns null', () => {
    const ai = new AICleanup();
    const result = ai._readPromptFile('/nonexistent/path/to/prompt.txt');
    assertEqual(result, null, 'should return null for missing file');
});

test('_readPromptFile with empty path returns null', () => {
    const ai = new AICleanup();
    assertEqual(ai._readPromptFile(''), null, 'empty string');
    assertEqual(ai._readPromptFile(null), null, 'null');
    assertEqual(ai._readPromptFile(undefined), null, 'undefined');
});

test('_readPromptFile with empty file returns null', () => {
    const ai = new AICleanup();

    const tmpDir = GLib.dir_make_tmp('speakeasy-test-XXXXXX');
    const tmpPath = GLib.build_filenamev([tmpDir, 'empty.txt']);
    const file = Gio.File.new_for_path(tmpPath);
    // GLib requires non-null contents for replace_contents, so write
    // a single newline which .trim() will turn into '' (empty).
    file.replace_contents(
        new TextEncoder().encode('\n'),
        null, false, Gio.FileCreateFlags.NONE, null);

    const result = ai._readPromptFile(tmpPath);
    assertEqual(result, null, 'empty file should return null');

    file.delete(null);
    Gio.File.new_for_path(tmpDir).delete(null);
});

test('_readPromptFile with whitespace-only file returns null', () => {
    const ai = new AICleanup();

    const tmpDir = GLib.dir_make_tmp('speakeasy-test-XXXXXX');
    const tmpPath = GLib.build_filenamev([tmpDir, 'whitespace.txt']);
    const file = Gio.File.new_for_path(tmpPath);
    file.replace_contents(
        new TextEncoder().encode('   \n\t  \n'),
        null, false, Gio.FileCreateFlags.NONE, null);

    const result = ai._readPromptFile(tmpPath);
    assertEqual(result, null, 'whitespace-only file should return null');

    file.delete(null);
    Gio.File.new_for_path(tmpDir).delete(null);
});

test('_readPromptFile reads file contents', () => {
    const ai = new AICleanup();

    const tmpDir = GLib.dir_make_tmp('speakeasy-test-XXXXXX');
    const tmpPath = GLib.build_filenamev([tmpDir, 'real-prompt.txt']);
    const content = 'You are a helpful assistant.';
    const file = Gio.File.new_for_path(tmpPath);
    file.replace_contents(
        new TextEncoder().encode(content),
        null, false, Gio.FileCreateFlags.NONE, null);

    const result = ai._readPromptFile(tmpPath);
    assertEqual(result, content, 'should return file contents');

    file.delete(null);
    Gio.File.new_for_path(tmpDir).delete(null);
});

test('prompt mtime caching: _loadPrompts does not re-read unchanged file', () => {
    const ai = new AICleanup();

    // Create temp prompt files
    const tmpDir = GLib.dir_make_tmp('speakeasy-test-XXXXXX');
    const promptsDir = GLib.build_filenamev([tmpDir, 'prompts']);
    GLib.mkdir_with_parents(promptsDir, 0o755);

    const sysPath = GLib.build_filenamev([promptsDir, 'system.txt']);
    const sysFile = Gio.File.new_for_path(sysPath);
    sysFile.replace_contents(
        new TextEncoder().encode('system prompt content'),
        null, false, Gio.FileCreateFlags.NONE, null);

    const framingPath = GLib.build_filenamev([promptsDir, 'framing.txt']);
    const framingFile = Gio.File.new_for_path(framingPath);
    framingFile.replace_contents(
        new TextEncoder().encode('framing template {{UUID}}'),
        null, false, Gio.FileCreateFlags.NONE, null);

    ai._extensionDir = tmpDir;

    // First load — reads from disk
    ai._loadPrompts();
    assertEqual(ai._systemPrompt, 'system prompt content', 'system prompt loaded');
    assertEqual(ai._framingTemplate, 'framing template {{UUID}}', 'framing loaded');
    assertEqual(ai._systemPromptFile, sysPath, 'system prompt file path cached');
    assertEqual(ai._framingTemplateFile, framingPath, 'framing file path cached');
    const sysMtime1 = ai._systemPromptMtime;
    const framingMtime1 = ai._framingTemplateMtime;

    // Modify the in-memory value to detect if it gets overwritten
    ai._systemPrompt = 'MODIFIED IN MEMORY';
    ai._framingTemplate = 'MODIFIED IN MEMORY';

    // Second load — same path and mtime, should NOT re-read
    ai._loadPrompts();
    assertEqual(ai._systemPrompt, 'MODIFIED IN MEMORY', 'system prompt should not be re-read');
    assertEqual(ai._framingTemplate, 'MODIFIED IN MEMORY', 'framing should not be re-read');
    assertEqual(ai._systemPromptMtime, sysMtime1, 'mtime unchanged');
    assertEqual(ai._framingTemplateMtime, framingMtime1, 'framing mtime unchanged');

    // Cleanup
    sysFile.delete(null);
    framingFile.delete(null);
    Gio.File.new_for_path(promptsDir).delete(null);
    Gio.File.new_for_path(tmpDir).delete(null);
});

test('setExtensionDir sets _extensionDir', () => {
    const ai = new AICleanup();
    ai.setExtensionDir('/some/path');
    assertEqual(ai._extensionDir, '/some/path', 'extensionDir');
});

test('init() creates Soup session and returns true', () => {
    const ai = new AICleanup();
    const result = ai.init();
    assertEqual(result, true, 'init return value');
    assert(ai._session !== null, 'session should be created');
    ai.destroy();
});

test('destroy() cleans up', () => {
    const ai = new AICleanup();
    ai.init();
    ai._apiKey = 'test';
    ai._sessionActive = true;
    ai._sessionUuid = 'uuid';
    ai._chunkBuffer = 'text';

    ai.destroy();

    assertEqual(ai._session, null, 'session nulled');
    assertEqual(ai._sessionActive, false, 'sessionActive reset');
    assertEqual(ai._chunkBuffer, '', 'chunkBuffer cleared');
});

// ════════════════════════════════════════════════════════════════════
//  OllamaCleanup tests
// ════════════════════════════════════════════════════════════════════

print('');
print('OllamaCleanup');
print('─'.repeat(60));

test('constructor defaults', () => {
    const ol = new OllamaCleanup();
    assertEqual(ol._session, null, '_session');
    assertEqual(ol._url, 'http://localhost:11434', '_url');
    assertEqual(ol._model, 'qwen2.5:3b', '_model');
    assertEqual(ol._enabled, true, '_enabled');
    assertEqual(ol._sessionActive, false, '_sessionActive');
    assertEqual(ol._textBuffer, '', '_textBuffer');
    assertEqual(ol._cancellable, null, '_cancellable');
    assertEqual(ol._extensionDir, null, '_extensionDir');
    assertEqual(ol._systemPromptPath, '', '_systemPromptPath');
    assertEqual(ol._systemPrompt, null, '_systemPrompt');
    assertEqual(ol._systemPromptFile, null, '_systemPromptFile');
    assertEqual(ol._systemPromptMtime, 0, '_systemPromptMtime');
});

test('isAvailable() returns true when enabled+session (no API key needed)', () => {
    const ol = new OllamaCleanup();
    ol.init();
    assertEqual(ol.isAvailable(), true, 'should be available');
    ol.destroy();
});

test('isAvailable() returns false when disabled', () => {
    const ol = new OllamaCleanup();
    ol.init();
    ol._enabled = false;
    assertEqual(ol.isAvailable(), false, 'disabled');
    ol.destroy();
});

test('isAvailable() returns false when no http session', () => {
    const ol = new OllamaCleanup();
    assertEqual(ol.isAvailable(), false, 'no session');
});

test('getDebugInfo() returns expected keys', () => {
    const ol = new OllamaCleanup();
    ol.init();
    const info = ol.getDebugInfo();

    assertEqual(info.enabled, true, 'enabled');
    assertEqual(info.hasSession, true, 'hasSession');
    assertEqual(info.url, 'http://localhost:11434', 'url');
    assertEqual(info.model, 'qwen2.5:3b', 'model');
    assertEqual(info.sessionActive, false, 'sessionActive');
    ol.destroy();
});

test('feedText() ignores when no active session', () => {
    const ol = new OllamaCleanup();
    ol.feedText('hello');
    assertEqual(ol._textBuffer, '', 'buffer should be empty');
});

test('feedText() ignores empty strings', () => {
    const ol = new OllamaCleanup();
    ol._sessionActive = true;
    ol.feedText('');
    assertEqual(ol._textBuffer, '', 'empty string');
    ol.feedText('   ');
    assertEqual(ol._textBuffer, '', 'whitespace-only');
    ol.feedText(null);
    assertEqual(ol._textBuffer, '', 'null');
});

test('feedText() buffers correctly', () => {
    const ol = new OllamaCleanup();
    ol._sessionActive = true;

    ol.feedText('hello');
    assertEqual(ol._textBuffer, 'hello', 'first segment');

    ol.feedText('world');
    assertEqual(ol._textBuffer, 'hello world', 'second segment');

    ol.feedText('baz');
    assertEqual(ol._textBuffer, 'hello world baz', 'third segment');
});

test('beginSession() sets sessionActive (with init but no real server)', () => {
    const ol = new OllamaCleanup();
    ol.init();
    // beginSession checks isAvailable, so we need enabled + session
    // But it also calls _loadPrompt which may warn; that's fine
    ol.beginSession();
    assertEqual(ol._sessionActive, true, 'sessionActive');
    ol.cancelSession();
    ol.destroy();
});

test('cancelSession() resets state', () => {
    const ol = new OllamaCleanup();
    ol.init();
    ol._sessionActive = true;
    ol._textBuffer = 'buffered text';
    ol._cancellable = new Gio.Cancellable();

    ol.cancelSession();

    assertEqual(ol._sessionActive, false, 'sessionActive');
    assertEqual(ol._textBuffer, '', 'textBuffer');
    assertEqual(ol._cancellable, null, 'cancellable');
    ol.destroy();
});

test('cancelSession() cancels cancellable', () => {
    const ol = new OllamaCleanup();
    const cancellable = new Gio.Cancellable();
    ol._cancellable = cancellable;
    ol._sessionActive = true;

    assertEqual(cancellable.is_cancelled(), false, 'before');
    ol.cancelSession();
    assertEqual(cancellable.is_cancelled(), true, 'after');
});

test('beginSession/feedText/cancelSession lifecycle', () => {
    const ol = new OllamaCleanup();
    ol.init();

    ol.beginSession();
    assertEqual(ol._sessionActive, true, 'active after begin');

    ol.feedText('one');
    ol.feedText('two');
    ol.feedText('three');
    assertEqual(ol._textBuffer, 'one two three', 'buffer accumulates');

    ol.cancelSession();
    assertEqual(ol._sessionActive, false, 'inactive after cancel');
    assertEqual(ol._textBuffer, '', 'buffer cleared after cancel');

    ol.destroy();
});

test('finalize() with empty buffer returns null', () => {
    // We need to run the main loop briefly for the async finalize
    const ol = new OllamaCleanup();
    ol.init();
    ol._sessionActive = true;
    ol._textBuffer = '';

    // finalize is async, run it in main loop
    let result = 'not-set';
    const loop = GLib.MainLoop.new(null, false);

    ol.finalize(null).then(r => {
        result = r;
        loop.quit();
    }).catch(_e => {
        result = null;
        loop.quit();
    });

    // Add a timeout so the test doesn't hang
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });

    loop.run();

    assertEqual(result, null, 'empty buffer should return null');
    ol.destroy();
});

test('destroy() cleans up OllamaCleanup', () => {
    const ol = new OllamaCleanup();
    ol.init();
    ol._sessionActive = true;
    ol._textBuffer = 'stuff';

    ol.destroy();

    assertEqual(ol._session, null, 'session nulled');
    assertEqual(ol._sessionActive, false, 'sessionActive reset');
    assertEqual(ol._textBuffer, '', 'textBuffer cleared');
});

test('setExtensionDir sets _extensionDir', () => {
    const ol = new OllamaCleanup();
    ol.setExtensionDir('/my/ext/dir');
    assertEqual(ol._extensionDir, '/my/ext/dir', 'extensionDir');
});

// ─── Summary ────────────────────────────────────────────────────────

print('');
print('═'.repeat(60));
print(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);

if (_errors.length > 0) {
    print('');
    print('Failures:');
    for (const {name, error} of _errors)
        print(`  - ${name}: ${error}`);
}

print('');

imports.system.exit(_failed > 0 ? 1 : 0);
