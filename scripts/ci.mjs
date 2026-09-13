#!/usr/bin/env node
/**
 * Run everything CI runs, locally.
 *
 * GitHub Actions is the usual gate, but it is not always available — a private
 * repository whose Actions are disabled or out of minutes will never run a job,
 * and a contributor should not have to discover that to find out whether their
 * change is sound. This script is the same set of checks, in the same order, on
 * one machine.
 *
 *   node scripts/ci.mjs            everything that does not need bun
 *   node scripts/ci.mjs --full     also build and prove the native binary
 *
 * Exits non-zero on the first failure, and prints a summary either way.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FULL = process.argv.includes('--full');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');

const results = [];
let failed = 0;

function run(label, command, args, options = {}) {
  process.stdout.write('\n── ' + label + '\n');
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: options.quiet === true ? 'pipe' : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', LUMEN_AI_PROVIDER: 'mock', ...(options.env ?? {}) },
  });
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  const ok = result.status === 0;
  if (!ok) failed += 1;
  if (!ok && options.quiet === true) {
    process.stdout.write((result.stdout ?? '') + (result.stderr ?? ''));
  }
  results.push({ label, ok, ms });
  process.stdout.write((ok ? '   ok  ' : '   FAIL ') + label + '  (' + ms + 'ms)\n');
  return { ok, out: (result.stdout ?? '') + (result.stderr ?? '') };
}

/** A check implemented here rather than by another process. */
function check(label, fn) {
  process.stdout.write('\n── ' + label + '\n');
  const started = process.hrtime.bigint();
  let ok = false;
  let detail = '';
  try {
    detail = fn() ?? '';
    ok = true;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  if (!ok) failed += 1;
  if (detail !== '') process.stdout.write('   ' + detail + '\n');
  results.push({ label, ok, ms });
  process.stdout.write((ok ? '   ok  ' : '   FAIL ') + label + '  (' + ms + 'ms)\n');
}

const node = process.execPath;

// The same order as .github/workflows/ci.yml, so a green run here means the
// same thing a green run there would.
run('build', 'npm', ['run', 'build']);
run('typecheck (clean rebuild)', 'npm', ['run', 'typecheck']);
run('unit and conformance tests', node, [path.join(ROOT, 'scripts', 'run-tests.mjs')]);
run('Lumen test suite', node, [CLI, 'test', path.join(ROOT, 'tests', 'lumen')]);
// The static checks over every Lumen program in the repository. Conformance
// fixtures are excluded on purpose: many of them are deliberately wrong, which
// is what they are for, and a checker that passed on those would be checking
// nothing.
run('examples pass the static checks', node, [CLI, 'check', path.join(ROOT, 'examples')]);
run('Lumen test files pass the static checks', node, [CLI, 'check', path.join(ROOT, 'tests', 'lumen')]);
run('benchmarks pass the static checks', node, [CLI, 'check', path.join(ROOT, 'bench')]);
run('examples', node, [path.join(ROOT, 'scripts', 'run-examples.mjs')]);
run('generated stdlib docs are current', node, [path.join(ROOT, 'scripts', 'gen-stdlib-docs.mjs'), '--check']);
// Not "do the documented examples parse" — "does what they say happens happen".
run('documented examples produce what they claim', node, [path.join(ROOT, 'scripts', 'check-doc-output.mjs')]);
run('every package stays private', node, [path.join(ROOT, 'scripts', 'check-private.mjs')]);

// Tier 2 of the distribution: one file, no node_modules in sight.
run('portable bundle builds', node, [path.join(ROOT, 'scripts', 'bundle.mjs')], { quiet: true });
check('portable bundle is self-contained', () => {
  const bundle = path.join(ROOT, 'build', 'lumen.cjs');
  if (!existsSync(bundle)) throw new Error('build/lumen.cjs was not produced');
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'lumen-ci-'));
  try {
    copyFileSync(bundle, path.join(sandbox, 'lumen.cjs'));
    copyFileSync(path.join(ROOT, 'examples', 'hello.lm'), path.join(sandbox, 'hello.lm'));
    if (readdirSync(sandbox).includes('node_modules')) throw new Error('sandbox is not clean');
    const r = spawnSync(node, ['lumen.cjs', 'run', 'hello.lm'], { cwd: sandbox, encoding: 'utf8' });
    const out = (r.stdout ?? '').trim();
    if (out !== 'Hello from Lumen!') {
      throw new Error('unexpected output: ' + JSON.stringify(out) + (r.stderr ?? ''));
    }
    return 'ran from ' + sandbox + ' with nothing else present';
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// Tier 1 needs bun, which not every machine has, so it is opt-in.
if (FULL) {
  run('native binary builds', node, [path.join(ROOT, 'scripts', 'build-binary.mjs')], { quiet: true });
  check('native binary runs with no runtime installed', () => {
    const binary = path.join(ROOT, 'build', 'lumen');
    if (!existsSync(binary)) throw new Error('build/lumen was not produced');
    // Prove the stripped environment really has no node, or the check is empty.
    const control = spawnSync('node', ['--version'], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
    if (control.status === 0) throw new Error('node still reachable; this check would prove nothing');
    const r = spawnSync(binary, ['run', path.join(ROOT, 'examples', 'hello.lm')], {
      env: { PATH: '/nonexistent', HOME: '/tmp' },
      encoding: 'utf8',
    });
    const out = (r.stdout ?? '').trim();
    if (out !== 'Hello from Lumen!') {
      throw new Error('unexpected output: ' + JSON.stringify(out) + (r.stderr ?? ''));
    }
    return 'ran with PATH=/nonexistent and no node available';
  });
} else {
  process.stdout.write('\n   skipped the native binary (needs bun) — pass --full to include it\n');
}

process.stdout.write('\n' + '='.repeat(60) + '\n');
for (const r of results) {
  process.stdout.write((r.ok ? '  ok    ' : '  FAIL  ') + r.label.padEnd(42) + String(r.ms).padStart(6) + 'ms\n');
}
process.stdout.write('='.repeat(60) + '\n');
process.stdout.write(
  (failed === 0 ? 'all ' + results.length + ' checks passed' : failed + ' of ' + results.length + ' checks FAILED') + '\n',
);
process.exit(failed === 0 ? 0 : 1);
