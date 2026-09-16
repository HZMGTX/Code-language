/**
 * Every library export can be called by the name it is exported under.
 *
 * `x.f(a)`, `f(x, a)` and `x |> f(a)` are meant to be one expression, and one
 * export cannot manage two of the three: `std/option.or` is a *keyword* in
 * expression position, so `or(maybe, fallback)` is a syntax error and only
 * `maybe.or(fallback)` works. The import even succeeds, which is the trap —
 * it binds a name the program can never use.
 *
 * Found by calling `help()` on all 253 exports and reading the one module whose
 * program would not parse. It is the same mistake the language already fixed
 * twice from the other side: `from` and `as` stopped being keywords in v0.2
 * because `let from = ...` and `replace(s, from, to)` are what anybody writes,
 * and the library had twice ended up with a parameter no Lumen program could
 * declare. This is that shape once more, as an export nobody can call.
 *
 * So the question is asked of every export at once rather than of the one that
 * turned up: a future `and`, `not`, `in` or `match` is caught here, on the day
 * it is written, instead of by somebody's import three releases later.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { KEYWORDS, parse } from '@lumen-lang/core';
import { stdModuleExports } from '@lumen-lang/stdlib';

/**
 * Names that are method-only, and why each is allowed to be.
 *
 * `or` reads best as a method — `maybe.or(fallback)` is how every language with
 * an `Option` spells it — and there is no fixing the other spelling: `or` in
 * expression position is genuinely the operator, and `a or (b)` cannot be told
 * from `or(a, b)`. Renaming it would cost the reading that matters to gain the
 * one that does not, so it stays and `docs/stdlib.md` says so.
 */
const METHOD_ONLY: Readonly<Record<string, string>> = {
  or: 'std/option.or — `or` is the logical operator in expression position, so only `maybe.or(x)` parses',
};

describe('every export can be called by its own name', () => {
  const exports = stdModuleExports();

  it('finds the library', () => {
    assert.ok(exports.size >= 15, 'only ' + exports.size + ' modules');
  });

  it('parses a call to every export, or says why it cannot', async () => {
    const uncallable: string[] = [];
    let checked = 0;

    for (const [module, names] of exports) {
      for (const name of names.keys()) {
        checked += 1;
        // The plain call, which is the spelling a program reaches for first.
        const source = `import { ${name} } from "${module}"\nprint(${name})\n`;
        try {
          parse(source, 'probe.lm');
        } catch {
          uncallable.push(module + '.' + name);
        }
      }
    }

    assert.ok(checked >= 200, 'only ' + checked + ' exports checked');
    assert.deepEqual(
      uncallable.map((full) => full.slice(full.indexOf('.') + 1)).sort(),
      Object.keys(METHOD_ONLY).sort(),
      'these exports cannot be called by name — rename them, or add a reason to METHOD_ONLY:\n  ' +
        uncallable.join('\n  '),
    );
  });

  it('does not excuse a name that is callable after all', () => {
    // The other direction, so a reason cannot outlive the problem it explains.
    const stillAKeyword = Object.keys(METHOD_ONLY).filter((name) => KEYWORDS.has(name));
    assert.deepEqual(
      Object.keys(METHOD_ONLY).sort(),
      stillAKeyword.sort(),
      'these are no longer keywords, so the excuse should go',
    );
  });

  it('the method form of a method-only export really does work', async () => {
    // The whole justification for keeping it. If this stopped being true the
    // export would be unreachable by any spelling at all.
    const { runSource } = await import('../support/harness.js');
    const result = await runSource('print(None.or(Some(1)))\nprint(Some(2).or(Some(1)))\n');
    assert.equal(result.failed, false, result.output);
    assert.deepEqual(result.output.trim().split('\n'), ['Some(1)', 'Some(2)']);
  });
});
