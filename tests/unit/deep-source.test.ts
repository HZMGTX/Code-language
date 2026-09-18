/**
 * Deeply nested source is a diagnostic, never a crash.
 *
 * `docs/spec.md` promises `PA016` for source nested past 250 levels, and
 * `nested`'s own comment in the parser explains why it matters: *"The limit
 * bounds every later walk of the tree as well — the resolver, the type checker,
 * `display`, equality — since none of them can meet a tree deeper than the
 * parser was willing to build."*
 *
 * That was not true. The limit counted the **parser's** recursion, and several
 * shapes deepen the *tree* without deepening the parser:
 *
 *   - `1 + 1 + 1 + …` is parsed by a loop, so three thousand terms sat at depth
 *     1 and then took the type checker's stack out;
 *   - `-` repeated, `**` chained, `x = x = …`, `a[0][0]…`, a nested list
 *     pattern and a nested `List<…>` annotation each recurse somewhere the
 *     counter never saw.
 *
 * Every one printed `RangeError: Maximum call stack size exceeded` — the host's
 * own words, with no file, no line and no diagnostic — and `lumen run` printed
 * "stack overflow — a function is probably recursing without a base case" about
 * programs that declare no function at all.
 *
 * So this is written as a **generator of shapes** rather than a list of known
 * ones, at a depth that reliably overflows an unguarded walk. A shape added
 * here is a shape guarded; a shape nobody thought of is at least a shape this
 * file makes it easy to add. Asserting a list of the seven already found would
 * be the same mistake the NaN route list made.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runSource } from '../support/harness.js';

/**
 * Deep enough to overflow a recursive walk, well past the 250-level limit.
 *
 * The stack gives out somewhere between 500 and 1000 levels, per the parser's
 * own note, so 4000 is unambiguous on any machine.
 */
const DEEP = 4000;

/** Every shape that nests, and the source that nests it. */
const SHAPES: Readonly<Record<string, string>> = {
  'chained +': 'print(' + Array.from({ length: DEEP }, () => '1').join(' + ') + ')',
  'chained ||': 'print(' + Array.from({ length: DEEP }, () => 'true').join(' or ') + ')',
  'chained **': 'print(' + Array.from({ length: DEEP }, () => '2').join(' ** ') + ')',
  'chained comparison': 'print(' + Array.from({ length: DEEP }, () => '1').join(' == ') + ')',
  'chained |>': 'fn f(x) { x }\nprint(1' + ' |> f()'.repeat(DEEP) + ')',
  'unary -': 'print(' + '-'.repeat(DEEP) + '1)',
  'unary not': 'print(' + 'not '.repeat(DEEP) + 'true)',
  'unary !': 'print(' + '!'.repeat(DEEP) + 'true)',
  'parens': 'print(' + '('.repeat(DEEP) + '1' + ')'.repeat(DEEP) + ')',
  'list literal': 'print(' + '['.repeat(DEEP) + ']'.repeat(DEEP) + ')',
  'call': 'fn f(x) { x }\nprint(' + 'f('.repeat(DEEP) + '1' + ')'.repeat(DEEP) + ')',
  'index chain': 'let a = [1]\nprint(a' + '[0]'.repeat(DEEP) + ')',
  'member chain': 'let m = { a: 1 }\nprint(m' + '.a'.repeat(DEEP) + ')',
  'assignment chain': 'var x = 1\n' + 'x = '.repeat(DEEP) + '1\nprint(x)',
  'list pattern':
    'match [1] {\n  ' + '['.repeat(DEEP) + 'x' + ']'.repeat(DEEP) + ' => print(x),\n  _ => print(0),\n}',
  'type annotation':
    'fn f(a: ' + 'List<'.repeat(DEEP) + 'Num' + '>'.repeat(DEEP) + ') { a }\nprint(f([]))',
  'nested blocks': 'fn f() {\n' + '  if true {\n'.repeat(DEEP) + '    print(1)\n' + '  }\n'.repeat(DEEP) + '}\nf()',
  'nested fn': 'print(' + 'fn() { '.repeat(DEEP) + '1' + ' }'.repeat(DEEP) + ')',
  'string interpolation': 'print("' + '${"'.repeat(DEEP) + 'x' + '"}'.repeat(DEEP) + '")',
  'nested map': 'print(' + '{ a: '.repeat(DEEP) + '1' + ' }'.repeat(DEEP) + ')',
  // Three shapes that escaped the budget after this file was written, each
  // found by a sweep rather than by this list — which is the argument for
  // deriving a list rather than writing one, and the reason these are here.
  // `?.` was absent from the token set that counts a suffix while the branch
  // below handled both spellings; `else if` and `await` recursed without going
  // through `nested` at all.
  'optional-chain': 'let a = nil\nprint(a' + '?.b'.repeat(DEEP) + ')',
  'else-if ladder':
    'let n = 0\nlet r = if n == 0 { 0 }\n' +
    Array.from({ length: DEEP }, (_, i) => '  else if n == ' + (i + 1) + ' { ' + (i + 1) + ' }').join('\n') +
    '\n  else { 0 - 1 }\nprint(r)',
  'await chain': 'let x = ' + 'await '.repeat(DEEP) + '1\nprint(x)',
};

/** Text that means a host exception escaped instead of a Lumen diagnostic. */
const HOST_CRASH = /RangeError|Maximum call stack|stack overflow|internal error/;

describe('deeply nested source is a diagnostic, not a crash', () => {
  for (const [name, source] of Object.entries(SHAPES)) {
    it('answers with a diagnostic for a ' + DEEP + '-deep ' + name, async () => {
      const result = await runSource(source + '\n');
      // What the answer *is* does not matter — `PA016`, or any other located
      // diagnostic, or even success if the shape turns out to be cheap. What
      // matters is that the host's stack never becomes the user's problem.
      assert.doesNotMatch(
        result.output,
        HOST_CRASH,
        name + ' produced a host crash:\n' + result.output.trim().split('\n').slice(0, 4).join('\n'),
      );
      if (result.failed) {
        // And when it does fail, it says where — a diagnostic with no location
        // is the other half of what was wrong here.
        assert.match(
          result.output,
          /-->|error\[[A-Z]{2}\d+\]/,
          name + ' failed without a located diagnostic:\n' + result.output.trim().slice(0, 300),
        );
      }
    });
  }

  it('still accepts source just inside the limit', async () => {
    // The guard is worthless if it refuses ordinary programs, and a chain of a
    // couple of hundred terms is generated source somebody really does have.
    const ok = await runSource('print(' + Array.from({ length: 240 }, () => '1').join(' + ') + ')\n');
    assert.equal(ok.failed, false, ok.output);
    assert.equal(ok.output.trim(), '240');

    const unary = await runSource('print(' + '-'.repeat(240) + '1)\n');
    assert.equal(unary.failed, false, unary.output);
    assert.equal(unary.output.trim(), '1');
  });
});
