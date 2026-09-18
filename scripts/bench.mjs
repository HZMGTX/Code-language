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
 *
 * To compare two builds, pass a second interpreter to measure against:
 *
 *   npm run bundle && cp build/lumen.cjs /tmp/before.cjs
 *   ...make the change...
 *   npm run bundle
 *   node scripts/bench.mjs --this build/lumen.cjs --against /tmp/before.cjs
 *
 * Two bundles, because they are the same kind of artifact. Measuring the built
 * CLI against a bundle measures module loading as much as the interpreter.
 *
 * That mode **interleaves** them: A then B, then B then A, alternating, so that
 * whatever the machine is doing lands on both. This is not a refinement. A
 * change measured here as a "16% regression" was 4% when measured this way, and
 * the optimisation built to fix the other 12% saved nothing at all, because the
 * 12% was the laptop. Measuring all of A and then all of B attributes drift to
 * the code, and drift over a few seconds is larger than most changes worth
 * making.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const BENCH = path.join(ROOT, 'bench');

const runsFlag = process.argv.indexOf('--runs');
const againstFlag = process.argv.indexOf('--against');
const thisFlag = process.argv.indexOf('--this');
const AGAINST = againstFlag === -1 ? undefined : process.argv[againstFlag + 1];
// Compare like with like. A bundle is one CommonJS file and the built CLI is
// thirty-odd ES modules, so measuring one against the other measures module
// loading as much as the interpreter — the first attempt at this said
// `collections.lm` had regressed 31%, which was entirely that.
const CLI = thisFlag === -1 ? DEFAULT_CLI : process.argv[thisFlag + 1];
const RUNS = runsFlag === -1 ? (AGAINST === undefined ? 3 : 5) : Number(process.argv[runsFlag + 1] ?? 3);

const files = readdirSync(BENCH).filter((f) => f.endsWith('.lm')).sort();

/** One run of one file through one interpreter. Exits if the program fails. */
function once(interpreter, file) {
  const started = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [interpreter, 'run', path.join(BENCH, file)], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  if (r.status !== 0) {
    process.stdout.write('FAIL ' + file + ' under ' + interpreter + '\n' + (r.stdout ?? '') + (r.stderr ?? ''));
    process.exit(1);
  }
  return { ms, output: (r.stdout ?? '').trim() };
}

const results = [];
for (const file of files) {
  const mine = [];
  const theirs = [];
  let output = '';
  let otherOutput = '';
  for (let i = 0; i < RUNS; i += 1) {
    // Alternate which goes first, so a warming cache or a busy moment does not
    // systematically favour whichever is measured first.
    const order = AGAINST === undefined || i % 2 === 0 ? ['mine', 'theirs'] : ['theirs', 'mine'];
    for (const which of order) {
      if (which === 'theirs') {
        if (AGAINST === undefined) continue;
        const run = once(AGAINST, file);
        theirs.push(run.ms);
        otherOutput = run.output;
      } else {
        const run = once(CLI, file);
        mine.push(run.ms);
        output = run.output;
      }
    }
  }
  if (AGAINST !== undefined && output !== otherOutput) {
    process.stdout.write(
      'FAIL ' + file + ': the two builds print different things\n  this: ' + output +
        '\n  that: ' + otherOutput + '\n',
    );
    process.exit(1);
  }
  results.push({
    file,
    best: Math.min(...mine),
    all: mine,
    output,
    ...(AGAINST === undefined ? {} : { wasBest: Math.min(...theirs), was: theirs }),
  });
}

const width = Math.max(...results.map((r) => r.file.length));
process.stdout.write(
  '\nbest of ' + RUNS + ' (includes ~60ms process start)' +
    (AGAINST === undefined ? '' : ', interleaved against ' + AGAINST) + '\n\n',
);
for (const r of results) {
  const line =
    '  ' + r.file.padEnd(width) + '  ' + String(r.best).padStart(6) + ' ms';
  if (r.wasBest === undefined) {
    process.stdout.write(line + '   [' + r.all.join(', ') + ']   -> ' + r.output.slice(0, 24) + '\n');
  } else {
    const change = ((r.best - r.wasBest) / r.wasBest) * 100;
    process.stdout.write(
      line + '  was ' + String(r.wasBest).padStart(6) + ' ms   ' +
        (change > 0 ? '+' : '') + change.toFixed(1) + '%\n',
    );
  }
}
const total = results.reduce((sum, r) => sum + r.best, 0);
if (AGAINST === undefined) {
  process.stdout.write('\n  ' + 'total'.padEnd(width) + '  ' + String(total).padStart(6) + ' ms\n');
} else {
  const wasTotal = results.reduce((sum, r) => sum + r.wasBest, 0);
  const change = ((total - wasTotal) / wasTotal) * 100;
  process.stdout.write(
    '\n  ' + 'total'.padEnd(width) + '  ' + String(total).padStart(6) + ' ms  was ' +
      String(wasTotal).padStart(6) + ' ms   ' + (change > 0 ? '+' : '') + change.toFixed(1) + '%\n' +
      '\n  Process start is roughly 60 ms of each figure and cannot change, so the\n' +
      '  effect on the interpreter itself is larger than the percentage above.\n',
  );
}
