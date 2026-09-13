#!/usr/bin/env node
/**
 * Run every example in the documentation and compare it with the output the
 * documentation claims.
 *
 * `tests/unit/docs.test.ts` already checks that each ```lumen block parses.
 * That catches a block which is not Lumen; it does not catch a block whose
 * claimed output stopped being true — which is the failure that actually
 * happens, because the language changes underneath prose that nobody re-runs.
 *
 * Found on its first run: a tutorial showing `RT029` for a mistake the static
 * checker now catches as `RS005`, a method list missing a method added months
 * later, and a column of output padded by hand and padded wrong.
 *
 * The convention it relies on is the one the documents already follow: a
 * ```lumen block, then a plain ``` block holding exactly what running it
 * prints. A block with no output block after it is only parsed, not run.
 *
 * A block that cannot be run standalone — one that needs input typed at it, or
 * that deliberately shows a session — is skipped with an HTML comment on the
 * line before it:
 *
 *     <!-- no-run: reads from the console -->
 *
 * The reason is required, so skipping is a decision somebody made rather than
 * a thing that quietly happened.
 *
 * What this does not cover: `docs/tour.md` and `docs/from-python.md` state
 * their results in trailing comments — `print(x)  // 42` — rather than in an
 * output block, and those claims are not checked by anything. Verifying them
 * needs a different convention and is worth doing; saying so here is better
 * than letting the count above imply the documentation is all verified.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');

const FILES = [
  'docs/learn.md',
  'docs/tour.md',
  'docs/from-python.md',
  'docs/spec.md',
  'docs/stdlib.md',
  'README.md',
];

/**
 * The file a diagnostic names is not part of what is being claimed — the
 * documents use realistic names like `marks.lm` — so both sides are levelled
 * before comparing.
 */
function normalize(text) {
  return text.replace(/--> \S*?([^/\\\s]+\.lm)/g, '--> FILE.lm').trimEnd();
}

const workdir = mkdtempSync(path.join(os.tmpdir(), 'lumen-docs-'));
let checked = 0;
let skipped = 0;
const failures = [];

try {
  for (const file of FILES) {
    const full = path.join(ROOT, file);
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }

    // A lumen block, then optionally a plain block holding its output.
    const blocks = /(?:<!-- no-run:([^>]*)-->\n)?```lumen\n([\s\S]*?)```\n+(?:```\n([\s\S]*?)```)?/g;
    let match;
    while ((match = blocks.exec(text)) !== null) {
      const [, skipReason, code, expected] = match;
      if (expected === undefined) continue; // nothing claimed; the parse test covers it
      if (skipReason !== undefined) {
        skipped += 1;
        continue;
      }

      const line = text.slice(0, match.index).split('\n').length;
      const script = path.join(workdir, 'block.lm');
      writeFileSync(script, code, 'utf8');
      const run = spawnSync(process.execPath, [CLI, 'run', script], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', LUMEN_AI_PROVIDER: 'mock' },
        timeout: 30000,
      });
      checked += 1;

      const got = normalize((run.stdout ?? '') + (run.stderr ?? ''));
      if (got !== normalize(expected)) {
        failures.push({ file, line, code: code.trimEnd(), expected: normalize(expected), got });
      }
    }
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

for (const f of failures) {
  process.stdout.write('\n' + f.file + ':' + f.line + ' — what it says happens is not what happens\n');
  process.stdout.write('  program:\n' + f.code.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  process.stdout.write('  documented:\n' + f.expected.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  process.stdout.write('  actual:\n' + f.got.split('\n').map((l) => '    ' + l).join('\n') + '\n');
}

const summary =
  checked + ' documented examples run, ' + (checked - failures.length) + ' correct' +
  (skipped > 0 ? ', ' + skipped + ' skipped' : '') +
  (failures.length > 0 ? ', ' + failures.length + ' WRONG' : '');
process.stdout.write('\n' + summary + '\n');
process.exit(failures.length === 0 ? 0 : 1);
