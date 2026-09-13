#!/usr/bin/env node
/**
 * Build `build/lumen.cjs` — the portable single-file distribution of Lumen.
 *
 * The result is ONE CommonJS file that runs the whole `lumen` CLI on a bare
 * Node >= 20: no npm install, no node_modules, no source tree.
 *
 *     node lumen.cjs run app.lm
 *
 * How it works
 * ------------
 * 1. `tsconfig.cjs.json` recompiles the same TypeScript sources to CommonJS
 *    into `build/cjs/`. That project stands alone — its own outDir, its own
 *    tsBuildInfoFile, no project references — so it never disturbs the main
 *    `tsc --build` output in `packages/*\/dist`.
 * 2. Every emitted module is wrapped in a factory and registered in a small
 *    map. A `require` shim resolves relative specifiers the way Node does
 *    (exact, then `.js`, then `/index.js`), maps the two `@lumen-lang/*`
 *    package specifiers to their entry modules, and falls through to the real
 *    `require` for `node:fs`, `node:path`, `node:http` and `node:readline`.
 *
 * Nothing rewrites ESM syntax. CommonJS `require()` is a function call rather
 * than syntax, which is the whole reason we compile a second time instead of
 * trying to stitch `packages/*\/dist` together.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PROJECT = path.join(ROOT, 'tsconfig.cjs.json');
const CJS_DIR = path.join(ROOT, 'build', 'cjs');
const BUILD_INFO = path.join(ROOT, 'build', 'cjs.tsbuildinfo');
const OUT_FILE = path.join(ROOT, 'build', 'lumen.cjs');

/** The module every bundle starts from. */
const ENTRY = 'packages/cli/src/index.js';

/**
 * `paths` in tsconfig teaches the type checker where the workspace packages
 * live, but tsc never rewrites the specifier it emits. These two bare names
 * therefore survive into the output and the require shim resolves them.
 */
const ALIASES = {
  '@lumen-lang/core': 'packages/core/src/index.js',
  '@lumen-lang/stdlib': 'packages/stdlib/src/index.js',
};

/**
 * `packages/cli/src/index.ts` ends in a top-level `await`. CommonJS has no
 * syntax for that, so tsc reports TS1378 — and then emits exactly the code we
 * want anyway. The bundler wraps that module's factory in an async function,
 * where `await` is legal, so the diagnostic is expected and handled. Any other
 * diagnostic is a real problem and fails the build.
 */
const EXPECTED_DIAGNOSTICS = new Set(['TS1378']);

function fail(message) {
  process.stderr.write('bundle: ' + message + '\n');
  process.exit(1);
}

/** Recompile every package source to CommonJS under build/cjs. */
function compile() {
  // Stale modules would be silently baked into the bundle, so start clean.
  // Only this project's own artefacts are removed — `build/` is shared with
  // the native-binary build.
  rmSync(CJS_DIR, { recursive: true, force: true });
  rmSync(BUILD_INFO, { force: true });

  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(process.execPath, [tsc, '-p', PROJECT], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.error) fail('could not run tsc: ' + result.error.message);

  const output = (result.stdout ?? '') + (result.stderr ?? '');
  const diagnostics = output.split('\n').filter((line) => /error TS\d+:/.test(line));
  const surprises = diagnostics.filter((line) => {
    const code = /error (TS\d+):/.exec(line);
    return code === null || !EXPECTED_DIAGNOSTICS.has(code[1]);
  });

  if (surprises.length > 0) {
    fail('the CommonJS compile failed:\n' + surprises.join('\n'));
  }
  // The expected TS1378 already makes tsc exit non-zero, so a bad status only
  // means trouble when it reported no diagnostic at all — a missing or crashed
  // compiler, say. Report what it actually said instead of letting the next
  // step complain about an empty build/cjs.
  if (result.status !== 0 && diagnostics.length === 0) {
    fail(
      'tsc exited with status ' +
        result.status +
        (output.trim() === '' ? ' and said nothing' : ':\n' + output.trim()),
    );
  }
}

/** Every emitted .js file, as bundle module ids (posix, relative to build/cjs). */
function collect(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const id = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) found.push(...collect(path.join(dir, entry.name), id));
    else if (entry.name.endsWith('.js')) found.push(id);
  }
  return found;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const FACTORY_PARAMS = ['exports', 'module', 'require', '__filename', '__dirname'];

/**
 * A `#!` line is legal only at the very start of a file, so the CLI entry's
 * shebang cannot travel into a function body. Blank the line rather than
 * deleting it, so line numbers in stack traces still line up with the module.
 */
function stripShebang(body) {
  return body.startsWith('#!') ? body.replace(/^#![^\n]*/, '') : body;
}

/**
 * Decide whether a module body needs an async factory, by asking the engine
 * to compile it rather than by pattern-matching the text. A body that compiles
 * as neither is not valid CommonJS and stops the build.
 */
function factoryKind(body, id) {
  try {
    new Function(...FACTORY_PARAMS, body);
    return 'function';
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    try {
      new AsyncFunction(...FACTORY_PARAMS, body);
      return 'async function';
    } catch (asyncError) {
      fail('`' + id + '` is not valid CommonJS: ' + asyncError.message);
    }
  }
}

const PRELUDE = `'use strict';
(function () {
var __modules = Object.create(null);
var __cache = Object.create(null);
var __aliases = ${JSON.stringify(ALIASES, null, 2)};
var __nodeRequire = typeof require === 'function' ? require : null;
var __root = typeof __dirname === 'string' ? __dirname : '.';

function __dirOf(id) {
  var cut = id.lastIndexOf('/');
  return cut < 0 ? '' : id.slice(0, cut);
}

/** Join a bundle-relative directory with a relative specifier, resolving . and .. */
function __join(dir, spec) {
  var stack = dir === '' ? [] : dir.split('/');
  var parts = spec.split('/');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** Node's own lookup order for a file specifier: exact, then .js, then /index.js. */
function __pick(base) {
  var candidates = [base, base + '.js', base + '/index.js'];
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i] in __modules) return candidates[i];
  }
  return null;
}

/** Map a specifier to a bundled module id, or null when it belongs to Node. */
function __locate(dir, spec) {
  if (spec.charAt(0) === '.') return __pick(__join(dir, spec));
  if (spec in __aliases) return __pick(__aliases[spec]);
  for (var name in __aliases) {
    if (spec.indexOf(name + '/') === 0) {
      return __pick(__join(__dirOf(__aliases[name]), './' + spec.slice(name.length + 1)));
    }
  }
  return null;
}

function __requireFrom(fromId) {
  var dir = __dirOf(fromId);
  function require(spec) {
    var id = __locate(dir, spec);
    if (id !== null) return __req(id);
    if (__nodeRequire !== null) return __nodeRequire(spec);
    throw new Error("Cannot find module '" + spec + "' from '" + fromId + "'");
  }
  require.resolve = function (spec) {
    var id = __locate(dir, spec);
    if (id !== null) return __root + '/' + id;
    if (__nodeRequire !== null) return __nodeRequire.resolve(spec);
    throw new Error("Cannot resolve '" + spec + "' from '" + fromId + "'");
  };
  require.cache = __cache;
  return require;
}

function __req(id) {
  var cached = __cache[id];
  if (cached !== undefined) return cached.exports;

  var factory = __modules[id];
  if (factory === undefined) throw new Error('Module ' + id + ' is missing from this bundle');

  var module = { id: id, filename: __root + '/' + id, exports: {}, loaded: false, children: [], paths: [] };
  __cache[id] = module;
  try {
    factory.call(module.exports, module.exports, module, __requireFrom(id), module.filename, __root + '/' + __dirOf(id));
  } catch (error) {
    delete __cache[id];
    throw error;
  }
  module.loaded = true;
  return module.exports;
}
`;

function bundle() {
  let stat;
  try {
    stat = statSync(CJS_DIR);
  } catch {
    stat = null;
  }
  if (stat === null || !stat.isDirectory()) fail('no CommonJS output at ' + CJS_DIR);

  const ids = collect(CJS_DIR);
  if (ids.length === 0) fail('the CommonJS compile produced no modules');
  if (!ids.includes(ENTRY)) fail('the entry module ' + ENTRY + ' is not in the compiled output');

  const version = JSON.parse(readFileSync(path.join(ROOT, 'packages', 'cli', 'package.json'), 'utf8')).version;

  const parts = [
    '#!/usr/bin/env node\n',
    '/**\n',
    ' * Lumen ' + version + ' — portable single-file build.\n',
    ' *\n',
    ' * Generated by scripts/bundle.mjs. Do not edit; edit the TypeScript sources.\n',
    ' * Needs only Node >= 20 — no npm install, no node_modules, no source tree.\n',
    ' *\n',
    ' *     node lumen.cjs run app.lm\n',
    ' */\n',
    PRELUDE,
  ];

  let asyncModules = 0;
  for (const id of ids) {
    const body = stripShebang(readFileSync(path.join(CJS_DIR, id), 'utf8'));
    const kind = factoryKind(body, id);
    if (kind === 'async function') {
      // Only the entry may await at the top level. Any other module would hand
      // its importers a half-filled `exports` the moment it awaits, and nothing
      // would say so — the bundle would just be quietly wrong.
      if (id !== ENTRY) fail('`' + id + '` uses top-level await; only ' + ENTRY + ' may');
      asyncModules += 1;
    }
    parts.push(
      '\n__modules[' + JSON.stringify(id) + '] = ' + kind + ' (' + FACTORY_PARAMS.join(', ') + ') {\n',
      body.endsWith('\n') ? body : body + '\n',
      '};\n',
    );
  }

  parts.push('\n__req(' + JSON.stringify(ENTRY) + ');\n', '})();\n');

  const text = parts.join('');

  // Compiling the finished file catches a mistake in the prelude or in the
  // stitching before anyone tries to run it.
  try {
    new Function(text.replace(/^#![^\n]*\n/, ''));
  } catch (error) {
    fail('the generated bundle is not valid JavaScript: ' + error.message);
  }

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, text);
  chmodSync(OUT_FILE, 0o755);

  return { bytes: Buffer.byteLength(text), modules: ids.length, asyncModules };
}

compile();
const { bytes, modules, asyncModules } = bundle();

process.stdout.write(
  'bundle: ' +
    path.relative(ROOT, OUT_FILE) +
    '\n' +
    '  ' +
    modules +
    ' modules (' +
    asyncModules +
    ' with top-level await), ' +
    bytes.toLocaleString('en-US') +
    ' bytes (' +
    (bytes / 1024).toFixed(1) +
    ' KiB)\n' +
    '  run it with: node ' +
    path.basename(OUT_FILE) +
    ' run app.lm\n',
);
