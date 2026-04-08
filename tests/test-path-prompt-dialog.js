#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: MIT
// Unit tests for the pure helpers exported from ui/pathPromptDialog.js.
// The widget itself can't be instantiated outside gnome-shell (uses St),
// but the validation helper is plain JS and testable here.
//
// Run: gjs -m tests/test-path-prompt-dialog.js

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {validateAudioPath} from '../ui/pathValidation.js';

let _passed = 0;
let _failed = 0;
const _errors = [];

function assert(condition, message) {
    if (!condition)
        throw new Error(`Assertion failed: ${message}`);
}

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

// ── Helpers ──

function mktmp() {
    return GLib.dir_make_tmp('speakeasy-pathprompt-test-XXXXXX');
}

function writeFile(path, content) {
    const file = Gio.File.new_for_path(path);
    file.replace_contents(
        new TextEncoder().encode(content),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return path;
}

function rmrf(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const enumerator = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const child = GLib.build_filenamev([path, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                rmrf(child);
            else
                Gio.File.new_for_path(child).delete(null);
        }
        enumerator.close(null);
        file.delete(null);
    } catch (_e) { /* ignore */ }
}

// ── Tests ──

print('');
print('pathPromptDialog.validateAudioPath');
print('─'.repeat(60));

test('empty string is rejected', () => {
    const r = validateAudioPath('');
    assertEqual(r.ok, false, 'ok');
    assert(r.error && r.error.length > 0, 'error message present');
});

test('whitespace-only string is rejected', () => {
    const r = validateAudioPath('   \t  ');
    assertEqual(r.ok, false, 'ok');
    assert(/empty|enter/i.test(r.error), 'mentions empty/enter');
});

test('null is rejected', () => {
    const r = validateAudioPath(null);
    assertEqual(r.ok, false, 'ok');
});

test('undefined is rejected', () => {
    const r = validateAudioPath(undefined);
    assertEqual(r.ok, false, 'ok');
});

test('non-existent path is rejected with "not found"', () => {
    const r = validateAudioPath('/tmp/speakeasy-definitely-does-not-exist-xyz.opus');
    assertEqual(r.ok, false, 'ok');
    assert(/not found/i.test(r.error), `message contains "not found": ${r.error}`);
});

test('existing readable file is accepted', () => {
    const dir = mktmp();
    try {
        const p = writeFile(GLib.build_filenamev([dir, 'sample.opus']), 'fake audio');
        const r = validateAudioPath(p);
        assertEqual(r.ok, true, 'ok');
        assertEqual(r.error, null, 'error is null');
    } finally {
        rmrf(dir);
    }
});

test('path with surrounding whitespace is trimmed and accepted', () => {
    const dir = mktmp();
    try {
        const p = writeFile(GLib.build_filenamev([dir, 'sample.wav']), 'fake');
        const r = validateAudioPath(`  ${p}  `);
        assertEqual(r.ok, true, 'ok');
    } finally {
        rmrf(dir);
    }
});

test('directory path is rejected', () => {
    const dir = mktmp();
    try {
        const r = validateAudioPath(dir);
        assertEqual(r.ok, false, 'directory should not count as a file');
        assert(r.error && r.error.length > 0, 'error message present');
    } finally {
        rmrf(dir);
    }
});

// ── Results ──
print('');
print('═'.repeat(60));
print(`Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);
if (_failed > 0) {
    for (const e of _errors)
        print(`  ${e.name}: ${e.error}`);
    imports.system.exit(1);
}
