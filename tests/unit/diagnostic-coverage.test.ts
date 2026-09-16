/**
 * Every diagnostic the language can emit is exercised by something.
 *
 * A code that is emitted, documented and never triggered is a message nobody
 * has read. `check-counts.mjs` already fails on a code that is emitted and not
 * *documented*; this asks the other half of the question, and when it was first
 * run the answer was that **43 of 96 had no test at all** — nearly half of what
 * a person sees when a program goes wrong.
 *
 * Most of the gap was the interpreter's own guard layer, which §6 promises to a
 * host that skips the static passes. Every ordinary test goes through
 * `checkModule` first and sees the static diagnostic instead, so the run-time
 * twin of each check had quietly never run. `runtime-guards.test.ts` covers it
 * now; `TY011` is the reminder of why that matters, since moving the indexing
 * question a pass earlier took `RT021` and `RT023` out of every test that had
 * been reaching them by accident.
 *
 * What remains is listed below with a reason each, because "5 uncovered" is a
 * number and this has to be an argument.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Codes no source could be found to reach, and why each is still there.
 *
 * Not proof of dead code — only that nothing anybody tried reaches them, which
 * is a weaker claim and the honest one. They are defensive depth behind a
 * grammar that could change, and each costs a few lines; deleting a guard that
 * turns out to be reachable is the expensive mistake, not keeping one that is
 * not.
 */
const UNREACHED: Readonly<Record<string, string>> = {
  PA012:
    'malformed `else` branch — anything but `{` or `if` after `else` is caught by PA001 first',
  RT009:
    'map keys must be Str — a map literal accepts only a name or a string, so no other key can be written',
  RT025:
    'module has no export — an import of a missing name is RT002, and a module value has no member syntax',
  RT032: 'invalid assignment target — PA008 refuses it while parsing, before anything runs',
  RT034:
    'native takes no named arguments — the only positional-only native is an enum constructor, ' +
    'which answers with RT039 and a better sentence: "takes its values by position, not by name"',
};

/**
 * Every source file that is not build output — and not this one.
 *
 * `UNREACHED` names its five codes as string literals, in a file that lives
 * under `tests/`. Scanning it made each of them look exercised by its own
 * excuse, and the check passed with nothing uncovered: a test that proves
 * whatever it was given. It is skipped on both sides for that reason.
 */
const SELF = 'diagnostic-coverage.test.ts';

async function sourcesUnder(dir: string, ext: string, found: string[] = []): Promise<string[]> {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'dist' && entry.name !== 'node_modules') await sourcesUnder(full, ext, found);
    } else if (entry.name.endsWith(ext) && entry.name !== SELF) {
      found.push(full);
    }
  }
  return found;
}

async function codesIn(files: readonly string[], pattern: RegExp): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of files) {
    for (const [, code] of (await fsp.readFile(file, 'utf8')).matchAll(pattern)) {
      found.add(code ?? '');
    }
  }
  return found;
}

describe('every diagnostic is exercised by a test', () => {
  it('leaves nothing untested but what is listed, with a reason', async () => {
    // Emitted: a code written as a string literal in the passes that report it.
    const emitted = await codesIn(
      await sourcesUnder(path.join(ROOT, 'packages'), '.ts'),
      /'((?:LX|PA|RS|TY|RT)\d{3})'/gu,
    );
    // Exercised: a code a golden file pins, or a test names.
    const exercised = new Set([
      ...(await codesIn(
        await sourcesUnder(path.join(ROOT, 'tests'), '.expected'),
        /\[((?:LX|PA|RS|TY|RT)\d{3})\]/gu,
      )),
      ...(await codesIn(
        await sourcesUnder(path.join(ROOT, 'tests'), '.ts'),
        /\b((?:LX|PA|RS|TY|RT)\d{3})\b/gu,
      )),
    ]);

    // A guard on the guard: if either scan found nothing, this would pass
    // having compared two empty sets.
    assert.ok(emitted.size >= 90, 'found only ' + emitted.size + ' emitted codes');
    assert.ok(exercised.size >= 80, 'found only ' + exercised.size + ' exercised codes');

    const untested = [...emitted].filter((code) => !exercised.has(code)).sort();
    assert.deepEqual(
      untested,
      Object.keys(UNREACHED).sort(),
      'these codes are emitted and never exercised — add a test, or a reason to UNREACHED:\n  ' +
        untested.filter((c) => !(c in UNREACHED)).join('\n  '),
    );
  });

  it('does not list a code that is exercised after all', async () => {
    // The other direction. A reason left behind after somebody wrote the test
    // is a note that has stopped being true, which is the thing this whole
    // repository keeps finding.
    const exercised = new Set([
      ...(await codesIn(
        await sourcesUnder(path.join(ROOT, 'tests'), '.expected'),
        /\[((?:LX|PA|RS|TY|RT)\d{3})\]/gu,
      )),
      ...(await codesIn(
        await sourcesUnder(path.join(ROOT, 'tests'), '.ts'),
        // Not the reasons themselves, which name their own codes.
        /\b((?:LX|PA|RS|TY|RT)\d{3})\b/gu,
      )),
    ]);
    const covered = Object.keys(UNREACHED).filter((code) => exercised.has(code));
    assert.deepEqual(covered, [], 'these have a test now, so the reason should go');
  });
});
