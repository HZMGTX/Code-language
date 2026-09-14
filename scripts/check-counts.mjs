#!/usr/bin/env node
/**
 * Check the numbers in README.md against the repository.
 *
 * A count written by hand goes stale the moment anybody adds a file, and a stale
 * count on the front page is the cheapest kind of lie to tell and the most
 * embarrassing to be caught in: this README claimed "207 tests, 74 conformance
 * fixtures" when there were 799 and 116, and claimed the suite was "green on
 * Node 20/22/24" on a repository where CI has never managed to start.
 *
 * `check-doc-output.mjs` already proves the documented examples produce what they
 * claim. This does the same job for the numbers, and for two more things worth
 * pinning:
 *
 *   - every `examples/*.lm` appears in the README's table, and the table names
 *     nothing that does not exist
 *   - every `std/*` module has a row in the generated stdlib reference
 *   - most of the standard library declares a type
 *   - every `RS` and `TY` diagnostic the implementation can emit is named in the
 *     specification, **and** in the header comment of the file that emits it
 *
 * Run it with `--fix` to rewrite the counts rather than only reporting them.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = path.join(ROOT, 'README.md');
const FIX = process.argv.includes('--fix');

/** Every file under `dir` matching `suffix`, recursively. */
function collect(dir, suffix) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full, suffix));
    else if (entry.name.endsWith(suffix)) found.push(full);
  }
  return found;
}

/**
 * How many tests the suite actually runs.
 *
 * Taken from the runner rather than counted from the source, because `it(...)`
 * inside a loop is one line and many tests — which is exactly how the
 * per-file formatter and set-key tests are written.
 */
function testCount() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tests.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LUMEN_AI_PROVIDER: 'mock' },
  });
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  const match = /^# pass (\d+)$/m.exec(out);
  if (match === undefined || match === null) {
    throw new Error('could not read a test count from the runner:\n' + out.slice(-2000));
  }
  if (result.status !== 0) {
    throw new Error('the test suite is failing, so its count is not worth publishing');
  }
  return Number(match[1]);
}

function moduleCount() {
  const dist = path.join(ROOT, 'packages', 'stdlib', 'dist', 'modules.js');
  if (!existsSync(dist)) throw new Error('run `npm run build` first: ' + dist + ' is missing');
  return null; // filled in by the caller, which can await the import
}

const problems = [];
const readme = readFileSync(README, 'utf8');

// ---------------------------------------------------------------- the counts

const { STD_MODULES } = await import(
  new URL('../packages/stdlib/dist/modules.js', import.meta.url).href
);
void moduleCount;

const actual = {
  tests: testCount(),
  fixtures: collect(path.join(ROOT, 'tests', 'conformance'), '.lm').length,
  // Runnable programs: every single-file example, plus the entry point of the
  // multi-file one. Its helper modules are imported rather than run.
  examples:
    readdirSync(path.join(ROOT, 'examples')).filter((name) => name.endsWith('.lm')).length + 1,
  modules: STD_MODULES.size,
};

const CLAIMS = [
  { key: 'tests', pattern: /\*\*(\d+) tests\*\*/, what: 'tests' },
  { key: 'fixtures', pattern: /(\d+) conformance fixtures/, what: 'conformance fixtures' },
  { key: 'examples', pattern: /(\d+) example programs/, what: 'example programs' },
  { key: 'modules', pattern: /(\d+) standard\n?\s*modules/, what: 'standard modules' },
];

let fixed = readme;
for (const claim of CLAIMS) {
  const match = claim.pattern.exec(readme);
  if (match === null) {
    problems.push('README does not state a count of ' + claim.what);
    continue;
  }
  const said = Number(match[1]);
  const real = actual[claim.key];
  if (said === real) continue;
  problems.push('README says ' + said + ' ' + claim.what + ', but there are ' + real);
  if (FIX) {
    fixed = fixed.replace(match[0], match[0].replace(String(said), String(real)));
  }
}

// ------------------------------------------------------- the examples table

const listed = [...readme.matchAll(/^\| `([a-z_]+\.lm)` \|/gm)].map((m) => m[1]).sort();
const onDisk = readdirSync(path.join(ROOT, 'examples'))
  .filter((name) => name.endsWith('.lm'))
  .sort();

for (const name of onDisk) {
  if (!listed.includes(name)) problems.push('examples/' + name + ' has no row in the README table');
}
for (const name of listed) {
  if (!onDisk.includes(name)) problems.push('the README table names ' + name + ', which does not exist');
}

// --------------------------------------- every static check is in the spec

/**
 * The `RS` and `TY` families, compared against the specification.
 *
 * Only those two. The spec's own §8 says "selected codes" of the `LX`, `PA` and
 * `RT` families and means it — there are eighty of them and tabulating every one
 * would be a worse document. But §7.5 and §6 list the static checks exhaustively,
 * because those are the diagnostics a reader needs to know the complete set of:
 * they are what `lumen check` can say about a program that has not run.
 *
 * This exists because `TY005` and `TY006` shipped without reaching the spec. The
 * patch that was supposed to add them silently matched nothing, and there was no
 * check to notice — so two static checks existed that the document defining the
 * language did not mention.
 */
const spec = readFileSync(path.join(ROOT, 'docs', 'spec.md'), 'utf8');
const emitted = new Set();
for (const file of collect(path.join(ROOT, 'packages'), '.ts')) {
  if (file.includes('/dist/')) continue;
  for (const match of readFileSync(file, 'utf8').matchAll(/'((?:RS|TY)\d{3})'/g)) {
    emitted.add(match[1]);
  }
}
for (const code of [...emitted].sort()) {
  if (!spec.includes('`' + code + '`')) {
    problems.push(code + ' can be emitted but is not named in docs/spec.md');
  }
}

// ------------------------------- every static check is in its file's own header

/**
 * The lists at the top of `resolver.ts` and `types.ts`, against what they emit.
 *
 * Those headers are what somebody reads to learn what a pass does, and both had
 * gone stale: `resolver.ts` listed RS001–RS007 while emitting RS008, and
 * `types.ts` listed TY001–TY004 while emitting TY005 and TY006. The spec check
 * above would not have caught either — a code can be in the specification and
 * missing from the file that raises it.
 */
const HEADERED = [
  ['packages/core/src/resolver.ts', /^RS/],
  ['packages/core/src/types.ts', /^TY/],
];
for (const [relative, family] of HEADERED) {
  const text = readFileSync(path.join(ROOT, relative), 'utf8');
  const header = text.slice(0, text.indexOf('*/'));
  for (const code of [...emitted].filter((c) => family.test(c)).sort()) {
    if (!header.includes(code)) {
      problems.push(code + ' is emitted but not listed in the header of ' + relative);
    }
  }
}

// ------------------------------------------- the library declares its types

/**
 * How much of the standard library carries a declared type.
 *
 * Not a demand that all of it does — `map(xs, f)` returns a list of whatever
 * `f` gives back, and `Ty` has no type variables, so forcing a signature onto
 * it would be worse than leaving it alone; a variadic cannot have one at all.
 * This is here so the work cannot silently stall, and so that removing one is a
 * decision somebody makes rather than a thing that happens.
 *
 * `tests/unit/signatures.test.ts` is what checks each signature against the
 * function it describes. This only counts them.
 */
let natives = 0;
let typed = 0;
for (const factory of STD_MODULES.values()) {
  for (const value of factory().values()) {
    if (value.k !== 'native') continue;
    natives += 1;
    if (value.signature !== undefined) typed += 1;
  }
}
const MINIMUM_TYPED = 0.8;
if (typed / natives < MINIMUM_TYPED) {
  problems.push(
    'only ' + typed + ' of ' + natives + ' standard-library functions declare a type (want ' +
      Math.round(MINIMUM_TYPED * 100) + '%)',
  );
}

// ------------------------------------------------ every module is documented

const stdlib = readFileSync(path.join(ROOT, 'docs', 'stdlib.md'), 'utf8');
for (const name of STD_MODULES.keys()) {
  if (!stdlib.includes('`' + name + '`')) {
    problems.push(name + ' is not mentioned in docs/stdlib.md');
  }
}

// ---------------------------------------------------------------- the answer

if (FIX && fixed !== readme) {
  writeFileSync(README, fixed, 'utf8');
  process.stdout.write('rewrote the counts in README.md\n');
}

const summary =
  String(actual.tests) + ' tests, ' + String(actual.fixtures) + ' fixtures, ' +
  String(actual.examples) + ' examples, ' + String(actual.modules) + ' modules, ' +
  String(emitted.size) + ' static checks, ' +
  String(typed) + '/' + String(natives) + ' typed';

if (problems.length === 0) {
  process.stdout.write('README matches the repository (' + summary + ')\n');
  process.exit(0);
}

process.stdout.write('\n' + summary + '\n\n');
for (const problem of problems) process.stdout.write('  ' + problem + '\n');
process.stdout.write(
  '\n' + String(problems.length) + ' problem' + (problems.length === 1 ? '' : 's') +
    (FIX ? ' (counts rewritten; the rest need a person)' : ' — `node scripts/check-counts.mjs --fix` rewrites the counts') +
    '\n',
);
process.exit(1);
