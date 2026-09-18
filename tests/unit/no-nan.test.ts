/**
 * A `NaN` cannot be produced by any Lumen program.
 *
 * `docs/spec.md` states it: *"any arithmetic that would produce one is
 * `RT046`"*. The reason is in the guard's own comment — a `NaN` is equal to
 * nothing, including itself, and is neither less than nor greater than
 * anything, so one that gets into a value silently breaks every comparison it
 * later reaches. Sorting, set membership, `minimum`, `maximum` and `groupBy`
 * all rest on comparison behaving, and none of them is written to cope with a
 * value that compares false against itself.
 *
 * So the invariant is worth more than a habit, and it was being kept as one.
 * Four holes were found in an afternoon:
 *
 *   - compound assignment had its own arithmetic inside `storeInto` and went
 *     round `checked`, so `a -= inf` was a `NaN` while `inf - inf` was
 *     `RT046`;
 *   - `asin` and `acos` are defined only on `[-1, 1]` and answered `NaN`
 *     outside it, while every sibling that can produce one already refused —
 *     `sqrt(-1)`, `log(0)`, `pow(-8, 0.5)`, `gcd(Infinity, 2)`;
 *   - `sin`, `cos` and `tan` answered `NaN` at `Infinity`, found by the
 *     hand-written half of this test;
 *   - `list.sum([inf, -inf])` did its addition in TypeScript rather than
 *     through a Lumen operator, and was **missed by the hand-written half** —
 *     which is the lesson this file now carries in its shape.
 *
 * There are two halves, and the second exists because of that miss. The first
 * is a written list of language-level routes: arithmetic, compound assignment,
 * a unary operator. Those cannot be enumerated from the library, so they are
 * enumerated by hand.
 *
 * The second **derives** its route list from the library rather than guessing
 * it: every exported function is called with `Infinity`, with a negative
 * `Infinity`, and with a list of the two — the arguments that make an answer
 * undefined — and the answer is rejected if it is a `NaN`. Asserting a guessed
 * list is how `sum` was missed; a function added tomorrow is covered without
 * anybody remembering to add a line.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { showTy, type Ty } from '@lumen-lang/core';
import { stdModuleExports } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/** The largest finite double times ten, which is how a program reaches Infinity. */
const INF = '(1e308 * 10)';

/** `serve` never returns; `exit`, `sleep` and `input` stop or block the sweep. */
const UNCALLABLE: ReadonlySet<string> = new Set(['serve', 'exit', 'sleep', 'input']);

/** The name `type()` answers for a declared type. */
function tyName(ty: Ty | undefined): string {
  if (ty === undefined || ty.k === 'any') return 'Any';
  return showTy(ty).replace(/<.*>$/, '');
}

/**
 * Argument lists that push a function towards an answer with no value.
 *
 * `Infinity` wherever a `Num` goes, and a list of cancelling infinities
 * wherever a `List` goes — which is exactly how `sum` got there, and how
 * `reduce` would if its `+` were not a real Lumen operator.
 */
function argumentShapes(params: readonly { optional?: boolean; ty?: Ty }[]): readonly string[] {
  const required = params.filter((p) => !p.optional);
  /** A value of the right shape, for a parameter this call is not varying. */
  const filler = (p: { ty?: Ty }, listArg: string, num: string): string => {
    switch (tyName(p.ty)) {
      case 'Str':
        return '"x"';
      case 'Bool':
        return 'true';
      case 'Map':
        return '{ a: 1 }';
      case 'List':
        return listArg;
      case 'Fn':
        return 'fn(a, b) { a + b }';
      default:
        return num;
    }
  };

  const shapes: string[] = [];
  const lists = [`[${INF}, (0 - 1e308 * 10)]`, `[${INF}, 0]`];

  // Everything extreme at once, which is where this sweep started.
  for (const listArg of lists) {
    shapes.push(required.map((p) => filler(p, listArg, INF)).join(', '));
  }

  // And one extreme argument at a time, with ordinary numbers beside it —
  // the shape `failure-policy.test.ts` already sweeps in, and the shape that
  // was missing here. Every indeterminate form needs exactly this: `pow(1,
  // INFINITY)` and `pow(-1, INFINITY)` are NaN in IEEE 754 and `pow(INFINITY,
  // INFINITY)` is not, so a sweep that only ever made every argument infinite
  // could not reach them. It did not, and `pow` answered a NaN for a year.
  for (const [i, varied] of required.entries()) {
    if (tyName(varied.ty) !== 'Num' && tyName(varied.ty) !== 'Any') continue;
    for (const extreme of [INF, `(0 - ${INF})`]) {
      for (const beside of ['1', '0', '(0 - 1)']) {
        shapes.push(
          required
            .map((p, j) => (j === i ? extreme : filler(p, lists[0] as string, beside)))
            .join(', '),
        );
      }
    }
  }
  return [...new Set(shapes)];
}

/**
 * Every way a number might arrive without a value.
 *
 * Each is an expression that is `NaN` in IEEE 754, or a library call whose
 * IEEE answer is. What the language does instead is its own business — a
 * panic, a `Result`, or a defined answer like `Infinity` — and this test only
 * insists that it is not a `NaN`.
 */
const ROUTES: readonly (readonly [string, string, string])[] = [
  // Arithmetic.
  ['inf - inf', `${INF} - ${INF}`, ''],
  ['inf * 0', `${INF} * 0`, ''],
  ['inf / inf', `${INF} / ${INF}`, ''],
  ['inf % 2', `${INF} % 2`, ''],
  ['2 % 0', '2 % 0', ''],
  ['-inf + inf', `(0 - ${INF}) + ${INF}`, ''],
  ['inf ** 0', `${INF} ** 0`, ''],
  ['(-8) ** (1/3)', '(0 - 8) ** (1 / 3)', ''],
  ['0 ** -1', '0 ** (0 - 1)', ''],
  // Compound assignment, which had its own arithmetic and went round the guard.
  ['x -= inf', `${INF}`, 'var x = ' + INF + '\nx -= ' + INF],
  ['x *= 0', `${INF}`, 'var x = ' + INF + '\nx *= 0'],
  ['x /= inf', `${INF}`, 'var x = ' + INF + '\nx /= ' + INF],
  ['x += -inf', `${INF}`, 'var x = ' + INF + '\nx += (0 - ' + INF + ')'],
  // Library functions whose IEEE answer is NaN outside their domain.
  ['asin(2)', 'asin(2)', 'import { asin } from "std/math"'],
  ['asin(-2)', 'asin(0 - 2)', 'import { asin } from "std/math"'],
  ['acos(2)', 'acos(2)', 'import { acos } from "std/math"'],
  ['acos(-2)', 'acos(0 - 2)', 'import { acos } from "std/math"'],
  ['asin(inf)', `asin(${INF})`, 'import { asin } from "std/math"'],
  ['sqrt(-1)', 'sqrt(0 - 1)', 'import { sqrt } from "std/math"'],
  ['log(0)', 'log(0)', 'import { log } from "std/math"'],
  ['log(-1)', 'log(0 - 1)', 'import { log } from "std/math"'],
  ['pow(-8, 0.5)', 'pow(0 - 8, 0.5)', 'import { pow } from "std/math"'],
  ['gcd(inf, 2)', `gcd(${INF}, 2)`, 'import { gcd } from "std/math"'],
  ['lcm(inf, 2)', `lcm(${INF}, 2)`, 'import { lcm } from "std/math"'],
  ['hypot(inf, inf)', `hypot(${INF}, ${INF})`, 'import { hypot } from "std/math"'],
  ['round(inf)', `round(${INF})`, 'import { round } from "std/math"'],
  ['fixed(inf, 2)', `fixed(${INF}, 2)`, 'import { fixed } from "std/math"'],
  ['trunc(inf)', `trunc(${INF})`, 'import { trunc } from "std/math"'],
  ['sign(inf)', `sign(${INF})`, 'import { sign } from "std/math"'],
  ['clamp(inf, 0, 1)', `clamp(${INF}, 0, 1)`, 'import { clamp } from "std/math"'],
  ['tan(inf)', `tan(${INF})`, 'import { tan } from "std/math"'],
  ['exp(inf) - exp(inf)', `exp(${INF}) - exp(${INF})`, 'import { exp } from "std/math"'],
  // Text and JSON, where a number arrives from outside the program.
  ['json 1e400', 'parse("1e400").unwrapOr(0)', 'import { parse } from "std/json"'],
  [
    'json 1e400 - 1e400',
    'parse("1e400").unwrapOr(0) - parse("1e400").unwrapOr(0)',
    'import { parse } from "std/json"',
  ],
  ['toNum("nan")', 'toNum("nan")', 'import { toNum } from "std/str"'],
  ['toNum("1e400")', 'toNum("1e400").unwrapOr(0)', 'import { toNum } from "std/str"'],
  // The one the hand-written list missed, kept here as well as in the derived
  // sweep so the miss stays visible.
  ['list.sum([inf, -inf])', `sum([${INF}, (0 - 1e308 * 10)])`, 'import { sum } from "std/list"'],
];

describe('a NaN cannot be produced', () => {
  it('has no route to one', async () => {
    const leaks: string[] = [];
    for (const [label, expr, prelude] of ROUTES) {
      const source = prelude + '\nprint(' + expr + ')\n';
      const result = await runSource(source);
      // `type()` rather than the printed value: a `NaN` prints as `NaN`, but so
      // does the text of a message about one — `toNum("NaN")` correctly answers
      // `Err("\`NaN\` is not a number")`, and reading the output for the word
      // called that a defect when the sweep was first written by hand.
      const typed = await runSource(prelude + '\nprint(type(' + expr + '))\n');
      const isNumber = typed.output.trim().split('\n').pop()?.trim() === 'Num';
      if (!result.failed && isNumber && /\bNaN\b/.test(result.output)) {
        leaks.push(label + ' produced ' + result.output.trim().split('\n').pop());
      }
    }
    assert.deepEqual(leaks, []);
  });

  it('has no route to one anywhere in the library, derived rather than listed', async () => {
    // The list above is written by hand and missed `list.sum`. This one is not
    // written: every function the library exports is called with the arguments
    // that make an answer undefined, so a function added later is covered
    // without anybody remembering to add a line for it.
    const leaks: string[] = [];
    let calls = 0;

    for (const [moduleName, exports] of stdModuleExports()) {
      for (const [name, ty] of exports) {
        if (ty?.k !== 'fn' || UNCALLABLE.has(name)) continue;
        for (const args of argumentShapes(ty.params ?? [])) {
          const source =
            `import { ${name} } from "${moduleName}"\n` +
            `let answer = ${name}(${args})\n` +
            'print("${type(answer)} ${answer}")\n';
          const result = await runSource(source);
          calls += 1;
          const answer = result.output.trim().split('\n').pop()?.trim() ?? '';
          // The type is read as well as the value, because a *message* about a
          // NaN legitimately contains the word — `toNum("NaN")` rightly
          // answers an `Err` mentioning it.
          if (/^(Num|List|Map) .*\bNaN\b/.test(answer)) {
            leaks.push(`${moduleName}.${name}(${args}) -> ${answer}`);
          }
        }
      }
    }

    assert.deepEqual(leaks, []);
    assert.ok(calls > 250, 'only made ' + String(calls) + ' calls; the sweep is not reaching the library');
  });

  it('answers in range, so the guards are not simply refusing everything', async () => {
    // The other direction. A guard that rejected its whole domain would pass
    // the test above and break the functions.
    const result = await runSource(
      'import { asin, acos, atan, sqrt, log } from "std/math"\n' +
        'print("${asin(0)} ${asin(1)} ${asin(0 - 1)}")\n' +
        'print("${acos(0)} ${acos(1)} ${acos(0 - 1)}")\n' +
        'print("${atan(1)} ${sqrt(4)} ${log(1)}")\n',
    );
    assert.equal(result.failed, false, result.output);
    const lines = result.output.trim().split('\n');
    assert.equal(lines[0], '0 1.5707963267948966 -1.5707963267948966');
    assert.equal(lines[1], '1.5707963267948966 0 3.141592653589793');
    assert.equal(lines[2], '0.7853981633974483 2 0');
  });
});
