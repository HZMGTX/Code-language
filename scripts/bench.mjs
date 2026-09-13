#!/usr/bin/env node
/**
 * Measure how fast Lumen runs.
 *
 * The point is not a score; it is a number to argue with. philosophy.md calls
 * the interpreter's speed the trade most worth revisiting, and that claim
 * deserves evidence rather than a hunch. Run this before and after any change
 * that is supposed to make things faster.
 *
 *   node scripts/bench.mjs            three runs of each, report the best
 *   node scripts/bench.mjs --runs 5
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const BENCH = path.join(ROOT, 'bench');

const runsFlag = process.argv.indexOf('--runs');
const RUNS = runsFlag === -1 ? 3 : Number(process.argv[runsFlag + 1] ?? 3);

const files = readdirSync(BENCH).filter((f) => f.endsWith('.lm')).sort();
const results = [];

for (const file of files) {
  const times = [];
  let output = '';
  for (let i = 0; i < RUNS; i += 1) {
    const started = process.hrtime.bigint();
    const r = spawnSync(process.execPath, [CLI, 'run', path.join(BENCH, file)], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    if (r.status !== 0) {
      process.stdout.write('FAIL ' + file + '\n' + (r.stdout ?? '') + (r.stderr ?? ''));
      process.exit(1);
    }
    output = (r.stdout ?? '').trim();
    times.push(ms);
  }
  // Best of N: the least noisy estimate of the work itself.
  results.push({ file, best: Math.min(...times), all: times, output });
}

const width = Math.max(...results.map((r) => r.file.length));
process.stdout.write('\nbest of ' + RUNS + ' (includes ~60ms process start)\n\n');
for (const r of results) {
  process.stdout.write(
    '  ' + r.file.padEnd(width) + '  ' + String(r.best).padStart(6) + ' ms' +
      '   [' + r.all.join(', ') + ']   -> ' + r.output.slice(0, 24) + '\n',
  );
}
const total = results.reduce((sum, r) => sum + r.best, 0);
process.stdout.write('\n  ' + 'total'.padEnd(width) + '  ' + String(total).padStart(6) + ' ms\n');
