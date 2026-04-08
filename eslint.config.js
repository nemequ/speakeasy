// ESLint flat config for the Speakeasy GNOME Shell extension.
//
// This codebase is GJS (GNOME Shell extension) code, not browser or Node.js.
// It uses ESM modules and a handful of GJS/Shell-specific globals.
//
// The ruleset is intentionally minimal. The goal is a smoke-test baseline:
// next time someone introduces a syntax error, an unused import, or an
// obvious typo, eslint catches it. This is not a style enforcer.
//
// To run:  make lint   (requires eslint on PATH; `npm i -g eslint`)

// We avoid importing @eslint/js so this config works with a bare global
// eslint install (no local node_modules / package.json). The rules below
// are a hand-picked subset of what eslint:recommended would give us,
// minus the ones that generate noise on this codebase.

export default [
    {
        ignores: [
            'schemas/**',
            'prompts/**',
            'node_modules/**',
            '.git/**',
            '*.compiled',
        ],
    },
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                // GJS / GNOME Shell globals
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                imports: 'readonly',
                global: 'readonly',
                globalThis: 'readonly',
                window: 'readonly',
                ARGV: 'readonly',
                // Standard timer / web-ish globals GJS exposes
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                queueMicrotask: 'readonly',
                TextEncoder: 'readonly',
                TextDecoder: 'readonly',
                console: 'readonly',
            },
        },
        rules: {
            // --- Likely-bug rules (errors) ---
            'constructor-super': 'error',
            'for-direction': 'error',
            'getter-return': 'error',
            'no-async-promise-executor': 'error',
            'no-case-declarations': 'error',
            'no-class-assign': 'error',
            'no-compare-neg-zero': 'error',
            'no-cond-assign': 'error',
            'no-const-assign': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-debugger': 'error',
            'no-dupe-args': 'error',
            'no-dupe-class-members': 'error',
            'no-dupe-else-if': 'error',
            'no-dupe-keys': 'error',
            'no-duplicate-case': 'error',
            'no-ex-assign': 'error',
            'no-fallthrough': 'error',
            'no-func-assign': 'error',
            'no-import-assign': 'error',
            'no-invalid-regexp': 'error',
            'no-irregular-whitespace': 'error',
            'no-loss-of-precision': 'error',
            'no-misleading-character-class': 'error',
            'no-new-native-nonconstructor': 'error',
            'no-obj-calls': 'error',
            'no-self-assign': 'error',
            'no-setter-return': 'error',
            'no-sparse-arrays': 'error',
            'no-this-before-super': 'error',
            'no-undef': 'error',
            'no-unexpected-multiline': 'error',
            'no-unreachable': 'error',
            'no-unsafe-finally': 'error',
            'no-unsafe-negation': 'error',
            'no-unsafe-optional-chaining': 'error',
            'no-unused-labels': 'error',
            'no-useless-backreference': 'error',
            'no-useless-catch': 'error',
            'require-yield': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',

            // --- Downgraded / relaxed rules ---
            // The codebase uses `(_e) => ...` and `let _unused = ...` for
            // explicitly-discarded values. Warn only, and respect the
            // underscore-prefix convention.
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
                ignoreRestSiblings: true,
            }],

            // Empty catch blocks are used deliberately for best-effort cleanup.
            'no-empty': ['warn', { allowEmptyCatch: true }],

            // The following rules from eslint:recommended are intentionally
            // left OFF because they generate noise without flagging real bugs
            // in this codebase:
            //   - no-prototype-builtins: GJS dicts frequently use hasOwnProperty
            //   - no-control-regex: used for parsing subprocess output
            //   - no-inner-declarations: not a bug pattern we care about
            //   - no-redeclare: GJS globals collide with lexical vars in a few
            //     places; this is caught by other means
        },
    },
];
