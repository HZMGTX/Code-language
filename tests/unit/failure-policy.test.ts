/**
 * A function that says it answers with a `Result` answers with one.
 *
 * `docs/stdlib.md` states the rule: *"Fallible operations return a `Result`;
 * absence returns an `Option`. … Neither ever raises for an ordinary failure."*
 * That is the whole of Lumen's error story — there are no exceptions, so a
 * program's only way to handle a failure is to be handed one as a value. A
 * `Result`-returning function that raises instead takes the program's process
 * out on input it was written to cope with.
 *
 * Unlike the sweeps beside it, this one **found nothing**, and is here for the
 * same reason those are: the rule was kept by hand, and `std/process` had
 * already shown what that is worth. Every function the library declares as
 * answering with a `Result` is called with the awkward values of its own
 * declared parameter types, and the answer must be `Ok` or `Err` — never a
 * rendered `RT0…`.
 *
 * The one restraint is what makes it a fair question. A value is used only when
 * the declared type **fully describes** it:
 *
 *   - A bare `List` says nothing about its elements, so `[1]` satisfies the
 *     annotation and still breaks `csv.write`'s requirement of a list of lists
 *     of `Str`. That raise is a *wrong argument*, which the policy says should
 *     raise — the rule is about ordinary failures, not about programming
 *     errors. `List<Str>` does describe its elements, so its awkward values are
 *     fair game.
 *   - A `fn(Any) -> Any` cannot say what the callback must give back, and
 *     `result.andThen` requires a `Result`. So the callback used here honours
 *     that contract; passing one that does not is again a wrong argument.
 *
 * Both exclusions are properties of the type language rather than lists of
 * names, which is the difference between a check that keeps working and one
 * that quietly stops.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { showTy } from '@lumen-lang/core';
import { MODULE_EFFECTS, stdModuleExports } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/**
 * Whether a module can be swept blind — from the library's own classification,
 * not a second list beside it.
 *
 * Anything but `pure` stays out. Each of those has its own test with a seam:
 * `server.test.ts` over a real socket, `process.test.ts` and `fs-copy.test.ts`
 * in a temporary directory, `std/ai` against its mock provider. Calling
 * `fs.remove` with a swept path is not a test, it is a hazard — and this used
 * to be a copy of that classification, which is a copy that can disagree.
 */
function canSweep(module: string): boolean {
  return MODULE_EFFECTS.get(module) === 'pure';
}

/** Awkward but right-typed values, by the type the signature declares. */
const AWKWARD: Readonly<Record<string, readonly string[]>> = {
  // An unterminated brace, a lone bracket and a dangling character class are
  // what a program builds when it interpolates a value into a pattern; a NUL
  // and a lone backslash are what arrives from a file somebody else wrote.
  Str: ['""', '"not valid {"', '"/"', '"\\u{0}"', '"("', '"[a-"', '"\\\\"', '"  "', '"-"'],
  Num: ['0 - 1', '0', '1.5', '1e308', '0 - 1e308'],
  Bool: ['true', 'false'],
  'List<Str>': ['[]', '[""]', '["a"]', '["a", ""]'],
  Option: ['None', 'Some(1)'],
  Result: ['Err("e")', 'Ok(1)'],
};

/** A value of this type that is beyond reproach, for the parameters not varied. */
const BENIGN: Readonly<Record<string, string>> = {
  Str: '"a"',
  Num: '1',
  Bool: 'true',
  List: '[]',
  Map: '{}',
  Option: 'Some(1)',
  Result: 'Ok(1)',
  Any: '1',
};

/** A callback that honours `andThen`'s contract, which no annotation can state. */
const CALLBACK = 'fn(v) { Ok(v) }';

function valuesFor(shown: string): readonly string[] {
  if (shown.startsWith('fn(')) return [CALLBACK];
  const awkward = AWKWARD[shown];
  if (awkward !== undefined) return awkward;
  // A type that does not describe what is inside it gets only the empty value,
  // which it does describe.
  if (shown === 'List' || shown.startsWith('List')) return ['[]'];
  if (shown === 'Map' || shown.startsWith('Map')) return ['{}'];
  return ['1'];
}

function benignFor(shown: string): string {
  if (shown.startsWith('fn(')) return CALLBACK;
  if (shown.startsWith('List')) return '[]';
  if (shown.startsWith('Map')) return '{}';
  return BENIGN[shown] ?? '1';
}

describe('a Result-returning function answers with a Result', () => {
  it('has a classification for every module, so none is swept blind', () => {
    // The guard that makes `canSweep` safe. A module added to the library and
    // not to `MODULE_EFFECTS` would come back `undefined` — which is not
    // `pure`, so the sweep would skip it rather than call it, but it would also
    // be treated as pure by `TY010` and warn about working code. Either way
    // somebody has to classify it, and this is where they find out.
    const missing = [...stdModuleExports().keys()].filter((name) => !MODULE_EFFECTS.has(name));
    assert.deepEqual(missing, [], 'these modules have no entry in MODULE_EFFECTS');

    const extra = [...MODULE_EFFECTS.keys()].filter((name) => !stdModuleExports().has(name));
    assert.deepEqual(extra, [], 'MODULE_EFFECTS names modules that do not exist');
  });

  it('never raises for a value its declared type fully describes', async () => {
    const raised: string[] = [];
    let calls = 0;
    let functions = 0;

    for (const [moduleName, exports] of stdModuleExports()) {
      if (!canSweep(moduleName)) continue;
      for (const [name, ty] of exports) {
        if (ty.k !== 'fn' || showTy(ty.ret) !== 'Result') continue;
        functions += 1;
        const required = ty.params.filter((p) => !p.optional);

        // One parameter awkward at a time, the rest beyond reproach — so a
        // failure names which argument reached the raising branch rather than
        // leaving a combination to untangle.
        for (const [i, param] of required.entries()) {
          for (const value of valuesFor(showTy(param.ty))) {
            const args = required
              .map((p, j) => (j === i ? value : benignFor(showTy(p.ty))))
              .join(', ');
            const source = `import { ${name} } from "${moduleName}"\nprint(${name}(${args}))\n`;
            const result = await runSource(source);
            calls += 1;
            if (/error\[RT\d+\]/u.test(result.output)) {
              raised.push(
                `${moduleName}.${name}(${args}) raised:\n    ` +
                  result.output.trim().split('\n').slice(0, 2).join('\n    '),
              );
            } else if (!/^(Ok|Err)\(/u.test(result.output.trim())) {
              raised.push(
                `${moduleName}.${name}(${args}) answered with neither Ok nor Err:\n    ` +
                  result.output.trim().split('\n')[0],
              );
            }
          }
        }
      }
    }

    assert.deepEqual(raised, [], raised.join('\n'));
    // Guards on the sweep itself. A signature change that stopped anything from
    // declaring `Result` would otherwise leave this passing on nothing at all,
    // which is the way a check like this dies.
    assert.ok(functions >= 15, 'only ' + functions + ' functions declare a Result');
    assert.ok(calls >= 100, 'only ' + calls + ' calls made');
  });
});
