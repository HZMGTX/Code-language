/**
 * Does each declared return type match what the function actually returns?
 *
 * Four tests already compare a signature with its implementation — the same
 * parameter names, in the same order, the same ones optional, and the same
 * defaults. None of them looked at the **return**, which is how this got in:
 *
 *     pop: '(xs: List) -> List'      // and it returns an Option
 *
 * `pop`'s own docstring says "Some(x), or None if empty", and the
 * implementation returns exactly that. Only the signature disagreed — and a
 * signature is not documentation that can be quietly wrong, it is what the
 * checker believes. So `unwrapOr(pop(xs), 0)`, which is the idiomatic way to
 * use `pop`, was rejected:
 *
 *     error[TY001]: `unwrapOr` expects Option for `option` but was given List
 *
 * A false positive on correct code, which `docs/philosophy.md` names as the one
 * thing gradual typing must never do. The converse is just as bad: code that
 * really was wrong got approved, because the checker thought `pop` gave a List.
 *
 * There is nothing in TypeScript to compare a signature's return against — a
 * native's callback is typed `Value` and nothing finer. So the function is
 * *called*, and the answer's own `type()` is the thing compared. Arguments come
 * from the declared parameter types, which is mechanical.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { showTy, type Ty } from '@lumen-lang/core';
import { stdModuleExports } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/**
 * A type's name as `type()` answers it.
 *
 * `showTy` is the language's own rendering, so this cannot drift from what a
 * signature means. Writing the mapping by hand instead produced the
 * interpreter's internal tags — `num`, `str`, `list` — and reported all 72
 * functions as mismatched, which is a good demonstration of why the rendering
 * belongs to the language and not to the test.
 */
function tyName(ty: Ty | undefined): string {
  if (ty === undefined || ty.k === 'any') return 'Any';
  // `List<Str>` and `List` are both `List` to `type()`.
  return showTy(ty).replace(/<.*>$/, '');
}

/** A Lumen literal of a declared type, for calling the function with. */
function literalFor(ty: Ty | undefined): string {
  switch (tyName(ty)) {
    case 'Str':
      return '"x"';
    case 'Num':
      return '1';
    case 'Bool':
      return 'true';
    case 'List':
      return '[1]';
    case 'Map':
      return '{ a: 1 }';
    case 'Option':
      return 'Some(1)';
    case 'Result':
      return 'Ok(1)';
    case 'Fn':
      return 'fn(x) { x }';
    default:
      return '1';
  }
}

describe('a declared return type is what the function returns', () => {
  it('agrees with a real call, for every function that declares one', async () => {
    const mismatches: string[] = [];
    let checked = 0;
    let skipped = 0;

    for (const [moduleName, exports] of stdModuleExports()) {
      for (const [name, ty] of exports) {
        if (ty?.k !== 'fn') continue;
        const declared = tyName(ty.ret);
        // `Any` has nothing to contradict, and the one function declaring `Nil`
        // is `std/web.serve`, which never returns.
        if (declared === 'Any' || declared === 'Nil') continue;

        const args = ty.params
          .filter((p) => !p.optional)
          .map((p) => literalFor(p.ty))
          .join(', ');
        const source =
          `import { ${name} } from "${moduleName}"\nprint(type(${name}(${args})))\n`;
        const result = await runSource(source);
        const answer = result.output.trim().split('\n').pop()?.trim() ?? '';

        // A call that could not be made is not a finding. Plenty of these need
        // a real file or a real URL, and this is looking for a declared type
        // contradicted by a real answer — not for functions with prerequisites.
        if (result.failed || !/^[A-Z][A-Za-z]*$/.test(answer)) {
          skipped += 1;
          continue;
        }
        checked += 1;
        if (answer !== declared) {
          mismatches.push(
            `${moduleName}.${name}(${args}) declares \`-> ${declared}\` ` +
              `(${showTy(ty)}) and returned ${answer}`,
          );
        }
      }
    }

    assert.deepEqual(mismatches, []);
    // Guards on the sweep itself. Without them a change that made every call
    // fail would leave the assertion above passing while checking nothing, and
    // a sweep that skips most of the library is not the check it claims to be.
    assert.ok(checked > 150, 'only checked ' + String(checked) + ' return types');
    assert.ok(
      skipped < checked,
      'skipped ' + String(skipped) + ' of ' + String(checked + skipped) + '; too many to trust',
    );
  });
});
