/**
 * Every library function says what it does, in one line, to `help()`.
 *
 * `help(walk)` printed a signature and nothing else. So did `help(chat)`,
 * `help(stringify)` and seventy-two others — 75 of 249 — because their
 * authors had written the explanation as a TypeScript comment above the
 * definition, which is exactly where a person reading `help()` cannot see it,
 * and `docs/stdlib.md` is generated from the same docstrings, so a row there
 * was a signature with an empty cell beside it.
 *
 * The rule is derived from the modules rather than listed: every native every
 * standard module exports carries a `doc`, and it is one line. A function
 * added tomorrow without one fails here on the day it is added.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { STD_MODULES } from '@lumen-lang/stdlib';

/** Every native the library exports, by full name, with its doc. */
function natives(): readonly { readonly name: string; readonly doc: string | undefined }[] {
  const out: { name: string; doc: string | undefined }[] = [];
  for (const [module, load] of STD_MODULES) {
    for (const [name, value] of load()) {
      if (value.k !== 'native') continue;
      out.push({ name: module + '.' + name, doc: value.doc });
    }
  }
  return out;
}

describe('every library function is documented', () => {
  const all = natives();

  it('finds the library', () => {
    assert.ok(all.length >= 200, 'only ' + all.length + ' natives found');
  });

  it('gives each one a doc line', () => {
    const missing = all.filter((n) => n.doc === undefined || n.doc.trim() === '').map((n) => n.name);
    assert.deepEqual(missing, [], 'these have no docstring, so help() has nothing to say');
  });

  it('keeps each doc to one line that reads as a sentence', () => {
    const wrong: string[] = [];
    for (const { name, doc } of all) {
      if (doc === undefined) continue;
      if (doc.includes('\n')) wrong.push(name + ': more than one line');
      else if (doc.length > 160) wrong.push(name + ': ' + doc.length + ' characters');
      else if (!/^[A-Z`]/u.test(doc)) wrong.push(name + ': does not start with a capital: ' + doc);
      else if (!/[.!?)`]$/u.test(doc)) wrong.push(name + ': does not end a sentence: ' + doc);
    }
    assert.deepEqual(wrong, []);
  });
});
