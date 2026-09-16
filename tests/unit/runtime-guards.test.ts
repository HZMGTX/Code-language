/**
 * The interpreter guards itself, for a host that skipped the static passes.
 *
 * §6 of `docs/spec.md` makes the promise: *"Arity, field names and operand
 * types are also checked at run time, so a host embedding the interpreter
 * without running these passes is not left unguarded."* That is a real
 * commitment to a real consumer — `packages/core` is published to nobody, but
 * it is the package the whole design is arranged around, and the CLI is only
 * one of the things that can drive it.
 *
 * Almost none of it was exercised. Every ordinary test goes through
 * `checkModule` first and sees the *static* diagnostic, so fourteen of the
 * codes below appeared in no golden file and no test: the interpreter's own
 * field checks, its struct checks, its indexing checks and its argument
 * checks. They were the only thing standing behind that promise and nobody had
 * read a word of what they say.
 *
 * `TY011` made two of them worse the day it was added. Asking the indexing
 * question a pass earlier is right — it catches the mistake before the program
 * runs — and it also means `RT021` and `RT023` can no longer be reached through
 * the CLI at all. A check that moves earlier takes its run-time twin out of
 * every test that covered it, which is an argument for testing the layer
 * directly rather than through whatever happens to reach it.
 *
 * Nothing here found a defect. Each message is Lumen's own words, names the
 * thing that is wrong, and points at it. That is worth knowing and worth
 * keeping.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runUnchecked } from '../support/harness.js';

interface Guard {
  /** What a host would be doing wrong. */
  readonly what: string;
  readonly source: string;
  readonly code: string;
  /** Part of the message, so a rewrite that loses the point fails. */
  readonly says: RegExp;
}

const GUARDS: readonly Guard[] = [
  // --- struct literals: the "field names" half of the promise
  {
    what: 'a field the struct does not have',
    source: 'struct P { x: Num }\nprint(P { x: 1, y: 2 })',
    code: 'RT013',
    says: /`P` has no field `y`/u,
  },
  {
    what: 'a field the struct requires and the literal omits',
    source: 'struct P { x: Num }\nprint(P { })',
    code: 'RT015',
    says: /`P` is missing field `x`/u,
  },
  {
    what: 'the same field twice',
    source: 'struct P { x: Num }\nprint(P { x: 1, x: 2 })',
    code: 'RT014',
    says: /field `x` is set twice/u,
  },
  {
    what: 'reading a field that is not there',
    source: 'struct P { x: Num }\nlet p = P { x: 1 }\nprint(p.nope)',
    code: 'RT024',
    says: /`P` has no field `nope`/u,
  },
  {
    what: 'a struct literal for something that is not a struct',
    source: 'let P = 1\nprint(P { x: 1 })',
    code: 'RT012',
    says: /`P` is not a struct/u,
  },
  {
    what: 'a struct literal for a name that is nothing at all',
    source: 'print(Nope { x: 1 })',
    code: 'RT011',
    says: /no struct named `Nope`/u,
  },

  // --- indexing, which `TY011` now catches a pass earlier
  {
    what: 'a list indexed by something that is not a number',
    source: 'print([1, 2]["a"])',
    code: 'RT021',
    says: /list index must be a Num, got Str/u,
  },
  {
    what: 'indexing something that cannot be indexed',
    source: 'print((1)[0])',
    code: 'RT023',
    says: /cannot index Num/u,
  },
  {
    what: 'an index past the end',
    source: 'print([1][5])',
    code: 'RT022',
    says: /index 5 is out of bounds for a list of length 1/u,
  },

  // --- arguments: the "arity" half of the promise
  {
    what: 'more arguments than the function takes',
    source: 'fn f(a) { a }\nprint(f(1, 2))',
    code: 'RT040',
    says: /`f` takes 1 argument/u,
  },
  {
    what: 'one argument given positionally and again by name',
    source: 'fn f(a) { a }\nprint(f(1, a: 2))',
    code: 'RT044',
    says: /both positionally and by name/u,
  },
  {
    what: 'the same name twice',
    source: 'fn f(a) { a }\nprint(f(a: 1, a: 2))',
    code: 'RT038',
    says: /`a` is given twice/u,
  },
  {
    what: 'a name the function does not have',
    source: 'fn f(a) { a }\nprint(f(b: 1))',
    code: 'RT039',
    says: /`f` has no parameter named `b`/u,
  },

  // --- operands and the rest of what the interpreter refuses on its own
  {
    what: 'a compound assignment whose operands do not go together',
    source: 'var s = "a"\ns += 1\nprint(s)',
    code: 'RT028',
    says: /cannot apply `\+=` to Str and Num/u,
  },
  {
    what: 'negating something that is not a number',
    source: 'print(-"x")',
    code: 'RT006',
    says: /cannot negate Str/u,
  },
  {
    what: 'calling something that is not a function',
    source: 'let n = 1\nprint(n())',
    code: 'RT033',
    says: /cannot call Num/u,
  },
  {
    what: 'looping over something that is not a sequence',
    source: 'for x in 1 { print(x) }',
    code: 'RT004',
    says: /cannot iterate over Num/u,
  },
  {
    what: 'a loop pattern the element does not fit',
    source: 'for [a, b] in [1, 2] { print(a) }',
    code: 'RT003',
    says: /loop pattern did not match 1/u,
  },
  {
    what: 'a range whose bounds are not numbers',
    source: 'print("a" .. 3)',
    code: 'RT007',
    says: /a range needs two Nums, got Str and Num/u,
  },
  {
    what: 'a match no arm covers',
    source: 'let n = 1\nprint(match n { 2 => "two" })',
    code: 'RT020',
    says: /no match arm matched 1/u,
  },
  {
    what: 'a variant the enum does not have',
    source: 'enum E { A }\nprint(E.B)',
    code: 'RT026',
    says: /enum `E` has no variant `B`/u,
  },
  {
    what: 'assigning to a field of something with no fields',
    source: 'var n = 1\nn.field = 2\nprint(n)',
    code: 'RT030',
    says: /cannot assign to a field of Num/u,
  },
  {
    what: 'assigning into something that cannot be indexed',
    source: 'var n = 1\nn[0] = 2\nprint(n)',
    code: 'RT031',
    says: /cannot assign into Num/u,
  },
  {
    what: 'a name that is not defined',
    source: 'print(nope)',
    code: 'RT005',
    says: /`nope` is not defined/u,
  },
];

describe('the interpreter guards itself without the static passes', () => {
  for (const guard of GUARDS) {
    it(guard.code + ': ' + guard.what, async () => {
      const result = await runUnchecked(guard.source + '\n');
      assert.match(result.output, new RegExp('error\\[' + guard.code + '\\]', 'u'), result.output);
      assert.match(result.output, guard.says, result.output);
      // Lumen's own words, and a place to look. A run-time guard that reported
      // a bare host error would be the `std/process` defect one layer down.
      assert.match(result.output, /-->/u, 'no location:\n' + result.output);
      assert.doesNotMatch(result.output, /TypeError|ReferenceError|undefined is not/u, result.output);
    });
  }

  it('RT041: a host that supplied no module resolver', async () => {
    // The furthest edge of the same promise: an interpreter with no way to
    // reach a file at all. Embedding one in a browser is the stated v0.4 goal,
    // and this is the sentence that program gets — not a crash on `undefined`.
    const { Interpreter, parse, LumenError } = await import('@lumen-lang/core');
    const { createNodeHost } = await import('@lumen-lang/stdlib');
    const host = createNodeHost();
    const quiet = { ...host, writeOut: () => {}, writeErr: () => {} };
    const interpreter = new Interpreter({ host: quiet });

    const source = 'import { upper } from "std/str"\nprint(upper("a"))\n';
    await assert.rejects(
      async () => await interpreter.runModule(parse(source, 'probe.lm'), source),
      (error: unknown) => {
        assert.ok(error instanceof LumenError, 'not a diagnostic: ' + String(error));
        assert.equal(error.diagnostics[0]?.code, 'RT041');
        assert.match(error.diagnostics[0]?.message ?? '', /imports are not available here/u);
        return true;
      },
    );
  });

  it('RT043: two modules importing each other', async () => {
    // Not reachable from one file, so it is the one guard here that needs a
    // directory. A cycle has to be refused rather than followed: the second
    // module would otherwise see the first half-built, and which half depends
    // on which file the program named first.
    const { promises: fsp } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { runSource } = await import('../support/harness.js');

    const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-cycle-'));
    try {
      await fsp.writeFile(
        path.join(box, 'b.lm'),
        'import { fromA } from "./a.lm"\nexport fn fromB() { "B via ' + '${fromA()}" }\n',
        'utf8',
      );
      const entry = path.join(box, 'a.lm');
      await fsp.writeFile(
        entry,
        'import { fromB } from "./b.lm"\nexport fn fromA() { "A" }\nprint(fromB())\n',
        'utf8',
      );

      const result = await runSource(await fsp.readFile(entry, 'utf8'), 'a.lm', [], box);
      assert.match(result.output, /RT043/u, result.output);
      assert.match(result.output, /import cycle involving/u, result.output);
      assert.match(result.output, /modules cannot import each other in a loop/u, result.output);
    } finally {
      await fsp.rm(box, { recursive: true, force: true });
    }
  });

  it('says something different when the static passes do run', async () => {
    // The point of the seam. Half of these are caught earlier now, and a test
    // that went through `checkModule` would be testing the other layer while
    // believing it was testing this one — which is exactly how these guards
    // came to have no coverage at all.
    const { runSource } = await import('../support/harness.js');
    const checked = await runSource('print([1, 2]["a"])\n');
    assert.match(checked.output, /TY011/u, checked.output);

    const unchecked = await runUnchecked('print([1, 2]["a"])\n');
    assert.match(unchecked.output, /RT021/u, unchecked.output);
  });
});
