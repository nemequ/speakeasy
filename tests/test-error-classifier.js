#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for errorClassifier.js.
//
// Run: gjs -m tests/test-error-classifier.js
//
// When ai.finalize() throws, the controller needs to distinguish
// timeouts from other network failures so the user gets a useful
// message ("re-run cleanup later" vs "check your proxy") instead
// of a generic "cleanup error". The classifier under test here is
// the mapping from Gio/GLib errors (and HTTP-status errors wrapped
// by ai.js) into those user-facing categories.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    classifyAiError, aiErrorUserMessage, AiErrorCategory,
} from '../errorClassifier.js';

let _passed = 0;
let _failed = 0;
const _errors = [];

function assertEqual(actual, expected, message) {
    if (actual !== expected)
        throw new Error(
            `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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

function makeGioError(code, msg = 'mock') {
    return new GLib.Error(Gio.io_error_quark(), code, msg);
}

print('');
print('errorClassifier');
print('─'.repeat(60));

test('Gio TIMED_OUT -> timeout', () => {
    const e = makeGioError(Gio.IOErrorEnum.TIMED_OUT, 'request timed out');
    assertEqual(classifyAiError(e), AiErrorCategory.TIMEOUT, 'timeout');
});

test('Gio NETWORK_UNREACHABLE -> network', () => {
    const e = makeGioError(Gio.IOErrorEnum.NETWORK_UNREACHABLE, 'no route');
    assertEqual(classifyAiError(e), AiErrorCategory.NETWORK, 'network');
});

test('Gio HOST_UNREACHABLE -> network', () => {
    const e = makeGioError(Gio.IOErrorEnum.HOST_UNREACHABLE, 'host');
    assertEqual(classifyAiError(e), AiErrorCategory.NETWORK, 'network');
});

test('Gio HOST_NOT_FOUND -> network', () => {
    const e = makeGioError(Gio.IOErrorEnum.HOST_NOT_FOUND, 'dns');
    assertEqual(classifyAiError(e), AiErrorCategory.NETWORK, 'network');
});

test('Gio CONNECTION_REFUSED -> network', () => {
    const e = makeGioError(Gio.IOErrorEnum.CONNECTION_REFUSED, 'refused');
    assertEqual(classifyAiError(e), AiErrorCategory.NETWORK, 'network');
});

test('Gio PROXY_FAILED -> network', () => {
    const e = makeGioError(Gio.IOErrorEnum.PROXY_FAILED, 'proxy down');
    assertEqual(classifyAiError(e), AiErrorCategory.NETWORK, 'network');
});

test('HTTP 500 wrapped Error -> http', () => {
    const e = new Error('HTTP 500');
    assertEqual(classifyAiError(e), AiErrorCategory.HTTP, 'http');
});

test('HTTP 429 wrapped Error -> http', () => {
    const e = new Error('HTTP 429');
    assertEqual(classifyAiError(e), AiErrorCategory.HTTP, 'http');
});

test('message mentioning "timed out" -> timeout (fallback)', () => {
    const e = new Error('operation timed out after 30s');
    assertEqual(classifyAiError(e), AiErrorCategory.TIMEOUT, 'timeout fallback');
});

test('generic Error -> unknown', () => {
    const e = new Error('something exploded');
    assertEqual(classifyAiError(e), AiErrorCategory.UNKNOWN, 'unknown');
});

test('null -> unknown', () => {
    assertEqual(classifyAiError(null), AiErrorCategory.UNKNOWN, 'unknown');
});

test('undefined -> unknown', () => {
    assertEqual(classifyAiError(undefined), AiErrorCategory.UNKNOWN, 'unknown');
});

test('fake object with matches() mimicking timeout -> timeout', () => {
    // Tests the duck-typed path: callers may pass non-GLib.Error
    // objects that still expose .matches(domain, code).
    const fake = {
        message: 'fake',
        matches(domain, code) {
            return domain === Gio.io_error_quark() &&
                   code === Gio.IOErrorEnum.TIMED_OUT;
        },
    };
    assertEqual(classifyAiError(fake), AiErrorCategory.TIMEOUT, 'timeout');
});

test('aiErrorUserMessage has distinct wording for each category', () => {
    const t = aiErrorUserMessage(AiErrorCategory.TIMEOUT);
    const n = aiErrorUserMessage(AiErrorCategory.NETWORK);
    const h = aiErrorUserMessage(AiErrorCategory.HTTP);
    const u = aiErrorUserMessage(AiErrorCategory.UNKNOWN, new Error('boom'));
    if (t === n || t === h || t === u || n === h || n === u || h === u)
        throw new Error('messages should all differ');
    if (!/timed out/i.test(t)) throw new Error('timeout message should mention "timed out"');
    if (!/network|proxy|unreachable/i.test(n)) throw new Error('network message should mention network/proxy');
    if (!/HTTP/.test(h)) throw new Error('http message should mention HTTP');
    if (!/boom/.test(u)) throw new Error('unknown message should include original error detail');
});

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
