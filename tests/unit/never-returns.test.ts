/**
 * Exactly two library functions stop the program instead of answering.
 *
 * `panic` and `exit` are declared `-> Nil`, because `Nil` is as close as the
 * type language gets to "no answer" — and reading that literally made an
 * ordinary guard clause a type error:
 *
 *     fn mustBePositive(n: Num) -> Num {
 *       if n > 0 { return n }
 *       panic("expected a positive number, got ${n}")   ← TY002, wrongly
 *     }
 *
 * The checker is now told which signatures belong to functions that never give
 * a value back. Nothing in a signature distinguishes them, so that is a list —
 * and a list is the thing this repository keeps finding has gone stale.
 *
 * This is what keeps it honest, by asking the question of the running program
 * rather than of the list: every library function that answers `Nil` is called
 * with a line after it, and exactly the listed two must fail to reach that
 * line. A new never-returning function fails here on the day it is written, and
 * so does a listed one that quietly starts returning.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { showTy, type Ty } from '@lumen-lang/core';
import { NEVER_RETURNS, stdModuleExports, stdSignatures } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/** An argument of each declared type, so the call itself is well-formed. */
const ARG: Readonly<Record<string, string>> = {
  Str: '"x"',
  Num: '0',
  Bool: 'true',
  List: '[]',
  Map: '{}',
  Any: '1',
  Option: 'Some(1)',
  Result: 'Ok(1)',
};

function callOf(shown: string): string {
  const inside = shown.slice(shown.indexOf('(') + 1, shown.lastIndexOf(')'));
  if (inside.trim() === '') return '';
  return inside
    .split(',')
    .map((p) => {
      const ty = (p.includes(':') ? p.slice(p.indexOf(':') + 1) : p).trim().split(' ')[0] ?? 'Any';
      return ARG[ty] ?? '1';
    })
    .join(', ');
}

describe('exactly the listed functions never return', () => {
  /** Every library function whose declared answer is `Nil`, with how to reach it. */
  function nilAnswering(): readonly { readonly key: string; readonly source: string }[] {
    const out: { key: string; source: string }[] = [];
    const add = (module: string, name: string, ty: Ty): void => {
      if (ty.k !== 'fn' || showTy(ty.ret) !== 'Nil') return;
      const args = callOf(showTy(ty));
      const preamble = module === '' ? '' : `import { ${name} } from "${module}"\n`;
      out.push({ key: module + '.' + name, source: `${preamble}${name}(${args})\nprint("REACHED")\n` });
    };
    for (const [name, ty] of stdSignatures()) add('', name, ty);
    for (const [module, exports] of stdModuleExports()) {
      // Only the pure and the harmless: calling `fs.remove` or `serve` to see
      // whether it returns is not a test, it is a hazard.
      if (module !== 'std/core' && module !== 'std/math' && module !== 'std/list') continue;
      for (const [name, ty] of exports) add(module, name, ty);
    }
    return out;
  }

  it('finds something to ask about', () => {
    assert.ok(nilAnswering().length >= 3, 'only ' + nilAnswering().length + ' Nil-answering functions');
    assert.ok(NEVER_RETURNS.length >= 2, 'the list is empty');
  });

  it('every listed function really does stop the program', async () => {
    for (const [module, name] of NEVER_RETURNS) {
      const ty = module === '' ? stdSignatures().get(name) : stdModuleExports().get(module)?.get(name);
      assert.ok(ty !== undefined, module + '.' + name + ' is listed but does not exist');
      const preamble = module === '' ? '' : `import { ${name} } from "${module}"\n`;
      const result = await runSource(`${preamble}${name}(${callOf(showTy(ty))})\nprint("REACHED")\n`);
      assert.doesNotMatch(result.output, /REACHED/u, module + '.' + name + ' returned: ' + result.output);
    }
  });

  it('no other Nil-answering function stops the program', async () => {
    const listed = new Set(NEVER_RETURNS.map(([module, name]) => module + '.' + name));
    const stopped: string[] = [];
    let checked = 0;
    for (const { key, source } of nilAnswering()) {
      if (listed.has(key)) continue;
      checked += 1;
      const result = await runSource(source);
      if (!/REACHED/u.test(result.output)) stopped.push(key + ': ' + result.output.trim().split('\n')[0]);
    }
    assert.deepEqual(stopped, [], 'these stop the program and are not listed in NEVER_RETURNS');
    assert.ok(checked >= 1, 'nothing was checked');
  });

  it('a guard clause ending in one of them is not a type error', async () => {
    // The defect itself, from both ends: the annotated function is accepted,
    // and the program still stops when the guard fails.
    const good = await runSource(
      'fn mustBePositive(n: Num) -> Num {\n  if n > 0 { return n }\n  panic("not positive: ${n}")\n}\nprint(mustBePositive(3))\n',
    );
    assert.equal(good.failed, false, good.output);
    assert.equal(good.output.trim(), '3');

    const bad = await runSource(
      'fn mustBePositive(n: Num) -> Num {\n  if n > 0 { return n }\n  panic("not positive: ${n}")\n}\nprint(mustBePositive(0 - 1))\n',
    );
    assert.match(bad.output, /not positive: -1/u, bad.output);
  });

  it('says nothing about a program that declares its own panic', async () => {
    // By the identity of the library's signature, not by the name — the same
    // restraint RS012 uses when it recognises `panic` by binding.
    const result = await runSource('fn panic(m) { 0 }\nfn f() -> Num {\n  panic("x")\n}\nprint(f())\n');
    assert.equal(result.failed, false, result.output);
    assert.equal(result.output.trim(), '0');
  });
});
