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
  String(actual.examples) + ' examples, ' + String(actual.modules) + ' modules';

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
