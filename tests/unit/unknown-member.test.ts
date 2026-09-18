/**
 * `TY012` never calls a real member a typo.
 *
 * The check says `List has no method `append`` before a program runs, which is
 * only worth having if it can never say it about a method that exists. That is
 * the "no false positives" rule the static passes all live under, and this
 * check has a specific way to break it: it asks its tables, and a table that is
 * a *copy* of the interpreter's would agree with it until the day one of them
 * changed. `Num.max` is the proof that the obvious source is the wrong one —
 * the checker's signature map holds only the methods somebody wrote a
 * signature for, and `max` has none and works.
 *
 * So the tables are the interpreter's own, handed over as names, and this
 * walks every method on every one of them through the checker and requires
 * silence. A method added to `std/list` tomorrow is covered the day it is
 * added; a table the checker cannot see fails here rather than in a program.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LumenError, UNIVERSAL, checkModule, checkTypes, parse } from '@lumen-lang/core';
import { checkOptions, createInterpreter, stdMethodNames } from '@lumen-lang/stdlib';

/**
 * A value of each type the checker can name, so a member can be read off it.
 *
 * Every type name the tables use has to be here, and the first test says so:
 * a table for a type with no receiver would otherwise be a table nobody swept.
 */
const RECEIVERS: Readonly<Record<string, string>> = {
  Str: '"abc"',
  List: '[1, 2]',
  Map: '{ a: 1 }',
  Num: '1',
  Bool: 'true',
  Nil: 'nil',
  Option: 'Some(1)',
  Result: 'Ok(1)',
  Fn: '(fn(x) { x })',
};

function check(source: string): readonly string[] {
  const globals = createInterpreter().globals.ownNames();
  try {
    return checkModule(parse(source, 'probe.lm'), source, checkOptions(globals)).map((d) => d.code);
  } catch (error) {
    if (error instanceof LumenError) return error.diagnostics.map((d) => d.code);
    throw error;
  }
}

describe('TY012 asks the interpreter, not a copy of it', () => {
  const tables = stdMethodNames();

  it('has a receiver for every type that has a table', () => {
    const missing = [...tables.keys()].filter((type) => type !== UNIVERSAL && !(type in RECEIVERS));
    assert.deepEqual(missing, [], 'add a receiver for these types to RECEIVERS');
    assert.ok(tables.has(UNIVERSAL), 'the tables say nothing about what every value has');
  });

  it('is silent for every method on every table', () => {
    const noisy: string[] = [];
    let swept = 0;
    for (const [type, names] of tables) {
      if (type === UNIVERSAL) continue;
      for (const name of names) {
        swept += 1;
        const source = 'let r = ' + RECEIVERS[type] + '\nprint(r.' + name + ')\n';
        const codes = check(source).filter((code) => code === 'TY012');
        if (codes.length > 0) noisy.push(type + '.' + name);
      }
    }
    assert.deepEqual(noisy, [], 'real methods reported as missing');
    assert.ok(swept >= 100, 'only ' + swept + ' methods swept');
  });

  it('is silent for the methods every value has, on every kind of value', () => {
    const noisy: string[] = [];
    for (const name of tables.get(UNIVERSAL) ?? []) {
      for (const [type, receiver] of Object.entries(RECEIVERS)) {
        const codes = check('let r = ' + receiver + '\nprint(r.' + name + ')\n');
        if (codes.includes('TY012')) noisy.push(type + '.' + name);
      }
    }
    assert.deepEqual(noisy, []);
    assert.ok((tables.get(UNIVERSAL)?.size ?? 0) >= 5, 'fewer universal methods than the spec names');
  });

  it('reports a member no type has, on every kind of value but a Map', () => {
    for (const [type, receiver] of Object.entries(RECEIVERS)) {
      const codes = check('let r = ' + receiver + '\nprint(r.definitelyNotAMember)\n');
      if (type === 'Map') {
        // A missing key reads as nil by design, so there is nothing to report.
        assert.deepEqual(codes, [], 'a Map member is a key');
      } else {
        assert.deepEqual(codes, ['TY012'], type + ' was not reported');
      }
    }
  });

  it('says what the interpreter says, name for name', () => {
    // Not a tautology: `stdMethodNames` could be rewritten to read something
    // else, and this is what would notice. `methodNames` is the interpreter's
    // own public answer — the one `RT027` and `help()` print.
    const interpreter = createInterpreter();
    for (const [type, names] of tables) {
      if (type === UNIVERSAL) continue;
      const runtime = new Set(interpreter.methodNames(type));
      for (const name of names) assert.ok(runtime.has(name), type + '.' + name + ' is not a run-time method');
      for (const name of tables.get(UNIVERSAL) ?? []) {
        assert.ok(runtime.has(name), name + ' belongs to every value, but not at run time');
      }
    }
  });

  it('says nothing when a host hands over no tables, or incomplete ones', () => {
    // The gradual rule's other half: unknown stays silent. A host that embeds
    // the checker without the interpreter's tables must not get a checker
    // that calls everything a typo.
    const source = 'let xs = [1]\nxs.append(2)\n';
    const module = parse(source, 'probe.lm');
    assert.deepEqual(checkTypes(module, {}), []);
    assert.deepEqual(
      checkTypes(module, { methodNames: new Map([['List', new Set(['push'])]]) }),
      [],
      'a table with no entry for what every value has is not usable',
    );
    const full = new Map([
      ['List', new Set(['push'])],
      [UNIVERSAL, new Set(['str'])],
    ]);
    assert.deepEqual(checkTypes(module, { methodNames: full }).map((d) => d.code), ['TY012']);
  });
});
