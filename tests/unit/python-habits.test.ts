/**
 * Every hint names something that exists, and every habit gets its hint.
 *
 * `hints.ts` is a table of what Lumen says when a program is written with
 * another language's spelling: `True`, `elif`, `xs.append(2)`, `f"…"`. A note
 * that names a module, a function or a method that is not there is worse than
 * no note — it sends somebody to look for a thing that does not exist — so the
 * first half of this file holds every note to the repository it describes:
 *
 *   - every `std/…` it mentions is a module that ships;
 *   - every name inside an `import { … } from "std/…"` is exported by it;
 *   - every prelude function it writes as `name(` is in the prelude;
 *   - every method a `use` points at is on that type's table.
 *
 * All four are derived from the library rather than listed, so a renamed
 * export fails here on the day it is renamed. The second half is the probe
 * that produced the table: the habits themselves, each run through the whole
 * pipeline and required to produce the code it always did *and* the note.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { FOREIGN_KEYWORDS, FOREIGN_METHODS, FOREIGN_NAMES, KEYWORDS, UNIVERSAL } from '@lumen-lang/core';
import { createInterpreter, stdMethodNames, stdModuleExports } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/** Every note in every table, with where it came from. */
function allNotes(): readonly { readonly from: string; readonly note: string }[] {
  const out: { from: string; note: string }[] = [];
  for (const [name, note] of FOREIGN_NAMES) out.push({ from: 'FOREIGN_NAMES.' + name, note });
  for (const [name, note] of FOREIGN_KEYWORDS) out.push({ from: 'FOREIGN_KEYWORDS.' + name, note });
  for (const [key, hint] of FOREIGN_METHODS) {
    if ('note' in hint) out.push({ from: 'FOREIGN_METHODS.' + key, note: hint.note });
  }
  return out;
}

describe('every hint names something that exists', () => {
  const modules = stdModuleExports();
  const prelude = new Set(createInterpreter().globals.ownNames());
  const tables = stdMethodNames();

  it('names only modules that ship', () => {
    const missing: string[] = [];
    for (const { from, note } of allNotes()) {
      for (const [, module] of note.matchAll(/"(std\/[a-z]+)"/gu)) {
        if (!modules.has(module ?? '')) missing.push(from + ' names ' + module);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('imports only names the module exports', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const { from, note } of allNotes()) {
      for (const [, names, module] of note.matchAll(/import \{ ([^}]+) \} from "(std\/[a-z]+)"/gu)) {
        const exports = modules.get(module ?? '');
        for (const name of (names ?? '').split(',').map((n) => n.trim())) {
          checked += 1;
          if (exports === undefined || !exports.has(name)) missing.push(from + ': ' + module + ' has no `' + name + '`');
        }
      }
    }
    assert.deepEqual(missing, []);
    assert.ok(checked >= 5, 'only ' + checked + ' imported names checked');
  });

  it('calls only functions that exist by a bare name', () => {
    // `num(text)`, `str(x)`, `removeAt(i)`: a name straight after a backtick
    // and straight before a `(` is a call, and the thing called has to be in
    // the prelude, exported by some module, or a keyword (`fn(x) { … }`).
    const known = new Set([...prelude, ...KEYWORDS.keys()]);
    for (const exports of modules.values()) for (const name of exports.keys()) known.add(name);
    const missing: string[] = [];
    let checked = 0;
    for (const { from, note } of allNotes()) {
      for (const [, name] of note.matchAll(/`([a-z][A-Za-z]*)\(/gu)) {
        checked += 1;
        if (!known.has(name ?? '')) missing.push(from + ' calls `' + name + '`, which nothing defines');
      }
    }
    assert.deepEqual(missing, []);
    assert.ok(checked >= 5, 'only ' + checked + ' calls checked');
  });

  it('points every `use` at a method the type really has', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const [key, hint] of FOREIGN_METHODS) {
      const [type, name] = key.split('.');
      assert.ok(type !== undefined && name !== undefined && !key.includes('.', key.indexOf('.') + 1), 'malformed key ' + key);
      const available = new Set([...(tables.get(type) ?? []), ...(tables.get(UNIVERSAL) ?? [])]);
      // The foreign name itself must *not* be a method, or the hint is unreachable.
      if (available.has(name)) missing.push(key + ' is a real method, so the hint can never be shown');
      if ('use' in hint) {
        checked += 1;
        if (!available.has(hint.use)) missing.push(key + ' points at `' + hint.use + '`, which ' + type + ' does not have');
      }
    }
    assert.deepEqual(missing, []);
    assert.ok(checked >= 10, 'only ' + checked + ' targets checked');
  });

  it('never hints about a name that is a keyword, or in the prelude', () => {
    // A keyword can never reach `RS001`, and a prelude name is defined. Either
    // would be a row that can never be shown — a note nobody reads.
    const dead = [...FOREIGN_NAMES.keys()].filter((name) => prelude.has(name));
    assert.deepEqual(dead, [], 'these are defined, so RS001 never fires for them');
  });
});

interface Habit {
  readonly habit: string;
  readonly source: string;
  readonly code: string;
  readonly says: RegExp;
}

/** The probe, kept: each habit, the code it always produced, and the note it gains. */
const HABITS: readonly Habit[] = [
  { habit: 'print without parentheses', source: 'print "hello"', code: 'PA003', says: /to call `print`, put its arguments in parentheses/u },
  { habit: '`def`', source: 'def add(a, b):', code: 'PA003', says: /declared with `fn`/u },
  { habit: '`class`', source: 'class Point:', code: 'PA003', says: /structs instead of classes/u },
  { habit: '`lambda`', source: 'let f = lambda x: x + 1', code: 'PA003', says: /anonymous function is `fn\(x\)/u },
  { habit: '`elif`', source: 'if 1 == 1 { print(1) } elif 1 == 2 { print(2) }', code: 'PA003', says: /`elif` is spelled `else if`/u },
  { habit: 'a ternary', source: 'let y = 1 if true else 2', code: 'PA003', says: /`if` is an expression/u },
  { habit: '`try`', source: 'try {\n  print(1)\n}', code: 'PA003', says: /no exceptions/u },
  { habit: '`raise`', source: 'raise "boom"', code: 'PA003', says: /`Err\(\.\.\.\)`|`panic\(/u },
  { habit: '`from … import`', source: 'from "std/str" import upper', code: 'PA003', says: /import \{ upper \} from "std\/str"/u },
  { habit: '`switch`', source: 'let y = 1\nswitch y { case 1: print(1) }', code: 'PA003', says: /`match` chooses/u },
  { habit: 'a colon block', source: 'if 1 == 1:\n  print(1)', code: 'PA001', says: /does not use `:`/u },
  { habit: 'an f-string', source: 'let name = "x"\nprint(f"hi {name}")', code: 'PA001', says: /no `f` prefix/u },
  { habit: '`in`', source: 'print(2 in [1, 2])', code: 'PA001', says: /contains/u },
  { habit: 'a slice', source: 'print([1, 2, 3][0:2])', code: 'PA001', says: /slice\(from, to\)/u },
  { habit: 'a bare import', source: 'import math', code: 'PA001', says: /import \{ sqrt \} from "std\/math"/u },
  { habit: '`True`', source: 'let t = True\nprint(t)', code: 'RS001', says: /spells it `true`/u },
  { habit: '`null`', source: 'let n = null\nprint(n)', code: 'RS001', says: /`nil` is the missing value/u },
  { habit: '`int(…)`', source: 'print(int("5"))', code: 'RS001', says: /`num\(text\)`/u },
  { habit: '`dict()`', source: 'let d = dict()\nprint(d)', code: 'RS001', says: /empty map/u },
  { habit: '`pass`', source: 'fn g() { pass }\ng()', code: 'RS001', says: /empty block is written/u },
  { habit: 'assigning before declaring', source: 'count = 1\nprint(count)', code: 'RS001', says: /declare it first: `let count = …`/u },
  { habit: '`.append`', source: 'let xs = [1]\nxs.append(2)', code: 'TY012', says: /did you mean `push`\?/u },
  { habit: '`.length`', source: 'let xs = [1]\nprint(xs.length)', code: 'TY012', says: /did you mean `len`\?/u },
  { habit: '`.strip()`', source: 'print(" a ".strip())', code: 'TY012', says: /did you mean `trim`\?/u },
  { habit: '`.forEach`', source: 'let xs = [1]\nxs.forEach(fn(x) { print(x) })', code: 'TY012', says: /for x in xs/u },
  { habit: '`.unwrap()`', source: 'print(Some(1).unwrap())', code: 'TY012', says: /taken apart with `match`/u },
  { habit: 'Str + Num', source: 'print("a" + 1)', code: 'TY005', says: /`str\(n\)`/u },
  { habit: 'Str * Num', source: 'print("ab" * 3)', code: 'TY005', says: /repeat\(3\)/u },
];

describe('each habit gets its hint', () => {
  for (const habit of HABITS) {
    it(habit.habit, async () => {
      const result = await runSource(habit.source + '\n');
      assert.match(result.output, new RegExp('\\[' + habit.code + '\\]', 'u'), result.output);
      assert.match(result.output, habit.says, result.output);
    });
  }

  it('the interpreter says the same for a host that skipped the static passes', async () => {
    const { runUnchecked } = await import('../support/harness.js');
    const result = await runUnchecked('let xs = [1]\nxs.append(2)\n');
    assert.match(result.output, /RT027/u, result.output);
    assert.match(result.output, /did you mean `push`\?/u, result.output);
  });
});
