/**
 * A warning never stops a program.
 *
 * `checkModule`'s own comment states it — *"a warning must never stop a program
 * that works. A caller that ignores them behaves exactly as it did before they
 * existed"* — and the line below it did the opposite the moment there was a
 * warning to stop:
 *
 *     const typeProblems = checkTypes(module, options);
 *     if (typeProblems.length > 0) {
 *       throw new LumenError(typeProblems, module.file, source);
 *     }
 *
 * No severity filter, which was harmless while the type checker produced
 * nothing but errors. `TY010` gave it a warning, and `lumen run` began refusing
 * to run any program that had one.
 *
 * **The fixture written for `TY010` recorded that as correct.** A golden file
 * full of diagnostics with none of its program's output looks exactly like a
 * fixture that only produces diagnostics, and its `-quiet` companion passed,
 * because a program with no warnings ran fine. Nothing looked wrong.
 *
 * So the property is checked here directly, on every warning the language has,
 * derived from `docs/spec.md`'s own table rather than listed: a new warning code
 * fails this file until somebody shows that a program carrying it still runs.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { runSource } from '../support/harness.js';

const SPEC = fileURLToPath(new URL('../../../docs/spec.md', import.meta.url));

/** Every code `docs/spec.md` marks as a warning rather than an error. */
async function warningCodes(): Promise<readonly string[]> {
  const spec = await fsp.readFile(SPEC, 'utf8');
  return [...spec.matchAll(/^\|\s*`([A-Z]{2}\d{3})`\s*\|[^|]*\ba \*\*warning\*\*/gmu)]
    .map((m) => m[1] ?? '')
    .sort();
}

/**
 * A program that earns each warning and then prints, so "it ran" is visible.
 *
 * Each one is ordinary working code with one thing about it worth mentioning —
 * which is what a warning is for, and what makes "it still runs" the whole
 * point rather than a detail.
 */
const EARNS: Readonly<Record<string, string>> = {
  RS011: `
    import { upper } from "std/str"
    let spare = 1
    print("RS011 ran")
  `,
  RS012: `
    fn check(n) {
      return n
      print("never runs")
    }
    print("RS012 ran \${check(1)}")
  `,
  TY010: `
    var xs: List<Num> = [3, 1, 2]
    xs.sort()
    print("TY010 ran \${xs}")
  `,
};

describe('a warning never stops a program', () => {
  it('finds the warning codes the spec declares', async () => {
    const codes = await warningCodes();
    assert.ok(codes.length >= 3, 'found only ' + JSON.stringify(codes) + ' in the spec');
  });

  it('has a program for every warning code the spec declares', async () => {
    // The half that keeps this from stalling: a new warning has to be shown
    // not to stop a program before the suite goes green again.
    const missing = (await warningCodes()).filter((code) => !(code in EARNS));
    assert.deepEqual(missing, [], 'no program earns: ' + missing.join(', '));
  });

  for (const [code, source] of Object.entries(EARNS)) {
    it(code + ' is reported, and the program still runs', async () => {
      const result = await runSource(source.trim() + '\n');

      // Reported...
      assert.match(result.output, new RegExp('warning\\[' + code + '\\]', 'u'), result.output);
      // ...and not as an error, which is the distinction the whole thing rests on.
      assert.doesNotMatch(result.output, new RegExp('error\\[' + code + '\\]', 'u'));
      // ...and the program ran to its end and answered.
      assert.equal(result.failed, false, result.output);
      assert.match(result.output, new RegExp(code + ' ran', 'u'), result.output);
    });
  }
});
