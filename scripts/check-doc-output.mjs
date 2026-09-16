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
 * `docs/tour.md` and `docs/from-python.md` use a second convention — the
 * result in a trailing comment, `print(x)  // 42` — and those are checked too,
 * where a block's prints line up one for one with the lines it produces. A
 * comment may carry a remark after the value, separated by an em dash:
 *
 *     print(greet(greeting: "Hi", name: "Bob"))   // Hi, Bob!   — by name
 *
 * What is still not covered: a block whose output does not line up with its
 * prints, because a loop or a multi-line string makes the mapping ambiguous.
 * The summary counts those, so the number it prints is what was really
 * checked rather than what was looked at.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');

/**
 * Every markdown file in the repository, found rather than listed.
 *
 * The list used to be written out, and it omitted `DEVELOPING.md` — the file
 * that explains how this checker works. Nothing was wrong with what it said,
 * because its one sample is a fragment and is skipped; but a document added
 * tomorrow would have been unverified and nothing would have mentioned it.
 * `docs.test.ts` reads the directories for the same reason, and a list of
 * things that exist goes stale exactly as fast as a count of them.
 */
const FILES = [
  ...readdirSync(ROOT).filter((name) => name.endsWith('.md')),
  ...readdirSync(path.join(ROOT, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => 'docs/' + name),
].sort();

// A guard on the guard: if the directories moved, this would otherwise verify
// nothing and say so cheerfully.
if (FILES.length < 8) {
  process.stderr.write('found only ' + FILES.length + ' documents, which cannot be right\n');
  process.exit(1);
}

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
let inlineChecked = 0;
let ambiguous = 0;
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

    checkInlineResults(file, text);
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

/**
 * The second convention: `print(x)   // 42`.
 *
 * Only checked where the block's `print` lines and its output lines match one
 * for one — a loop or a multi-line string makes which line came from which
 * call a guess, and a guess would produce failures nobody can act on.
 */
function checkInlineResults(file, text) {
  const blocks = /```lumen\n([\s\S]*?)```/g;
  let match;
  while ((match = blocks.exec(text)) !== null) {
    const code = match[1];
    const startLine = text.slice(0, match.index).split('\n').length;
    const lines = code.split('\n');

    const printLines = [];
    lines.forEach((l, i) => {
      if (/^\s*print\(/.test(l)) printLines.push(i);
    });
    const annotated = [];
    lines.forEach((l, i) => {
      const m = /^\s*print\(.*\)\s+\/\/ (.+)$/.exec(l);
      // Everything before an em dash is the claim; the rest is a remark.
      if (m !== null) annotated.push({ at: i, want: m[1].split('—')[0].trim() });
    });
    if (annotated.length === 0) continue;

    const script = path.join(workdir, 'inline.lm');
    writeFileSync(script, code, 'utf8');
    const run = spawnSync(process.execPath, [CLI, 'run', script], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', LUMEN_AI_PROVIDER: 'mock' },
      timeout: 30000,
    });
    if (run.status !== 0) {
      failures.push({
        file,
        line: startLine,
        code: code.trimEnd(),
        expected: '(it to run at all)',
        got: (run.stdout ?? '') + (run.stderr ?? ''),
      });
      continue;
    }

    const out = (run.stdout ?? '').replace(/\n$/, '').split('\n');
    if (out.length !== printLines.length) {
      ambiguous += 1;
      continue;
    }
    inlineChecked += annotated.length;

    for (const a of annotated) {
      const got = out[printLines.indexOf(a.at)];
      if (got !== a.want) {
        failures.push({
          file,
          line: startLine + a.at,
          code: lines[a.at].trim(),
          expected: a.want,
          got: got ?? '(nothing)',
        });
      }
    }
  }
}

for (const f of failures) {
  process.stdout.write('\n' + f.file + ':' + f.line + ' — what it says happens is not what happens\n');
  process.stdout.write('  program:\n' + f.code.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  process.stdout.write('  documented:\n' + f.expected.split('\n').map((l) => '    ' + l).join('\n') + '\n');
  process.stdout.write('  actual:\n' + f.got.split('\n').map((l) => '    ' + l).join('\n') + '\n');
}

const summary =
  checked + ' documented examples run and ' + inlineChecked + ' inline results checked, ' +
  (failures.length === 0 ? 'all correct' : failures.length + ' WRONG') +
  (skipped > 0 ? '; ' + skipped + ' skipped' : '') +
  (ambiguous > 0 ? '; ' + ambiguous + ' blocks whose output does not line up with their prints' : '');
process.stdout.write('\n' + summary + '\n');
process.exit(failures.length === 0 ? 0 : 1);
