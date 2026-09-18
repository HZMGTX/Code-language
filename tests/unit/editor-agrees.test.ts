/**
 * The editor reports exactly what `lumen check` reports.
 *
 * Stated in the language server's own header — *"an editor that disagrees with
 * the compiler is worse than an editor with no hover"* — and it was not true
 * twice:
 *
 *   - `analyse()` called `checkModule` and **discarded its return value**, so
 *     every warning the compiler produced was invisible in the editor. The
 *     existing test could not have caught it, because it asserted about one
 *     hand-written program that happened to produce an error rather than a
 *     warning.
 *   - Adding `TY010` meant a new warning, and nothing would have failed if the
 *     editor had missed that one too.
 *
 * So this is driven by the **conformance corpus** rather than by hand-written
 * programs: every fixture whose golden output holds a diagnostic is analysed
 * both ways, and the two sets of codes must match. A fixture added for a new
 * diagnostic therefore tests the editor as well, without anybody remembering to
 * write a second test — which is the only reason this file is worth having over
 * the two examples it replaces.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LumenError, checkModule, parse } from '@lumen-lang/core';
import { checkOptions, createInterpreter, createNodeHost } from '@lumen-lang/stdlib';
import { analyse } from '@lumen-lang/lsp';

const CONFORMANCE = fileURLToPath(new URL('../../conformance', import.meta.url));

/** Every code a rendered diagnostic block names, in the order it appears. */
function codesIn(text: string): readonly string[] {
  return [...text.matchAll(/^(?:error|warning)\[([A-Z]{2}\d{3})\]/gmu)].map((m) => m[1] ?? '');
}

/**
 * A diagnostic as this file compares them: its code *and* how loud it is.
 *
 * Severity matters as much as the code: it is the difference between a red
 * squiggle under working code and a grey note beside it.
 *
 * What this catches is the **editor** deciding a severity for itself and
 * getting it wrong. It cannot catch a severity that is wrong in the compiler,
 * because both sides here read the same `checkModule` and would be wrong
 * together — the conformance fixtures are what hold that, since a code
 * changing from `warning` to `error` changes the bytes they pin.
 */
function asPair(d: { readonly code: string; readonly severity: string }): string {
  return d.code + '/' + d.severity;
}

/**
 * What `lumen check` reports for this source, as a code and severity each.
 *
 * `parse` is inside the `try` as well, because a fixture in `lexer/` or
 * `parser-errors/` never reaches the checker — and those are most of the
 * corpus. Leaving it outside made this file throw rather than compare, which
 * is how it found out.
 */
function codesFromChecker(source: string, file: string, globals: readonly string[]): readonly string[] {
  try {
    const module = parse(source, file);
    return checkModule(module, source, checkOptions(globals)).map(asPair);
  } catch (error) {
    if (error instanceof LumenError) return error.diagnostics.map(asPair);
    throw error;
  }
}

interface Case {
  readonly name: string;
  readonly source: string;
  readonly expected: readonly string[];
}

/**
 * The fixtures whose golden output is a diagnostic, and only those.
 *
 * A fixture that prints its results is exercising the interpreter, and the
 * editor has nothing to say about it. One whose `.expected` begins with a
 * rendered diagnostic is exactly the corpus this wants.
 */
async function diagnosticFixtures(): Promise<readonly Case[]> {
  const cases: Case[] = [];
  const groups = await fsp.readdir(CONFORMANCE, { withFileTypes: true });
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const dir = path.join(CONFORMANCE, group.name);
    for (const entry of await fsp.readdir(dir)) {
      if (!entry.endsWith('.lm')) continue;
      const golden = path.join(dir, entry.replace(/\.lm$/u, '.expected'));
      const expected = await fsp.readFile(golden, 'utf8').catch(() => '');
      const codes = codesIn(expected);
      if (codes.length === 0) continue;
      cases.push({
        name: group.name + '/' + entry,
        source: await fsp.readFile(path.join(dir, entry), 'utf8'),
        expected: codes,
      });
    }
  }
  return cases.sort((a, b) => a.name.localeCompare(b.name));
}

describe('the editor reports what the compiler reports', () => {
  const interpreter = createInterpreter({ host: createNodeHost() });
  const globals = interpreter.globals.ownNames();

  it('finds the fixtures that produce a diagnostic', async () => {
    // The corpus is the point of this file, so a change that emptied it —
    // a moved directory, a renamed suffix — has to fail rather than pass
    // vacuously. Twenty is well under what is there and well over nothing.
    const cases = await diagnosticFixtures();
    assert.ok(cases.length >= 20, 'found only ' + cases.length + ' diagnostic fixtures');
  });

  it('agrees on every one of them', async () => {
    const cases = await diagnosticFixtures();
    const disagreements: string[] = [];

    for (const fixture of cases) {
      const file = path.basename(fixture.name);
      const fromChecker = codesFromChecker(fixture.source, file, globals);
      // Severity as well as code. It is the difference between a red squiggle
      // under working code and a grey one, and it is exactly what went wrong
      // when `TY010` made the type checker produce its first warning.
      const fromEditor = analyse('file:///' + file, 1, fixture.source, globals).diagnostics.map(asPair);
      if (fromChecker.join(',') !== fromEditor.join(',')) {
        disagreements.push(
          fixture.name + ': checker ' + JSON.stringify(fromChecker) + ' editor ' + JSON.stringify(fromEditor),
        );
      }
    }

    assert.deepEqual(disagreements, [], disagreements.join('\n'));
  });

  it('reports every severity the compiler does, not only errors', async () => {
    // The specific shape of the bug: warnings are *returned* while errors are
    // raised, so a server that only catches shows none of them. Asserting that
    // the corpus contains both kinds is what keeps the test above honest — it
    // would pass on an errors-only corpus with the warnings dropped again.
    const cases = await diagnosticFixtures();
    const codes = new Set(cases.flatMap((c) => c.expected));
    const warnings = [...codes].filter((code) => code === 'RS011' || code === 'TY010');
    assert.ok(warnings.length > 0, 'no warning appears anywhere in the corpus: ' + [...codes].join(', '));

    // And at least one fixture must mix the two, because that is the case where
    // a server that raises on the first error loses the warnings beside it.
    const mixed = cases.filter(
      (c) => c.expected.some((x) => x === 'RS011' || x === 'TY010') && c.expected.length > 1,
    );
    assert.ok(mixed.length > 0, 'no fixture holds a warning alongside anything else');
  });
});
