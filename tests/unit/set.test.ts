/**
 * `std/set` tests.
 *
 * The module rests on one property that no Lumen program can observe directly:
 * two values share a key exactly when `==` says they are equal. Get it wrong in
 * one direction and a set quietly holds two of something; get it wrong in the
 * other and it loses an element. Neither raises, so neither would be found by
 * running set operations and looking at the answers.
 *
 * So the first test checks the property itself, over every ordered pair drawn
 * from a list of values chosen to include the ways it could break: values of
 * different types that print the same, maps whose entries were inserted in a
 * different order, nested structures, and strings containing the delimiters the
 * key format uses.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  NIL,
  bool,
  enumValue,
  inspect,
  list,
  map,
  num,
  str,
  valuesEqual,
  type Value,
} from '@lumen-lang/core';
import { setKeyForTesting as key } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/** A struct value, built the way the interpreter builds one. */
function struct(typeName: string, fields: Record<string, Value>): Value {
  return { k: 'struct', typeName, fields: new Map(Object.entries(fields)) };
}

/** A map built from entries in the given order, which is the order it keeps. */
function mapOf(...entries: [string, Value][]): Value {
  return map(new Map(entries));
}

const VALUES: Value[] = [
  NIL,
  bool(true),
  bool(false),
  num(0),
  num(-0),
  num(1),
  num(-1),
  num(1.5),
  num(Infinity),
  str(''),
  // Strings that look like other values, which is what the type tag is for.
  str('1'),
  str('true'),
  str('nil'),
  // Strings carrying the key format's own delimiters.
  str('a,b'),
  str('a'),
  str('b'),
  str('s1:a'),
  str('{x: 1}'),
  list([]),
  list([num(1)]),
  list([num(1), num(2)]),
  list([str('a,b')]),
  list([str('a'), str('b')]),
  list([list([num(1)]), num(2)]),
  list([num(1), list([num(2)])]),
  mapOf(),
  mapOf(['x', num(1)]),
  mapOf(['x', num(1)], ['y', num(2)]),
  // The same map, written the other way round: `==` says equal, `inspect` does not.
  mapOf(['y', num(2)], ['x', num(1)]),
  mapOf(['x', num(2)], ['y', num(1)]),
  struct('P', { x: num(1), y: num(2) }),
  struct('P', { y: num(2), x: num(1) }),
  struct('P', { x: num(1), y: num(3) }),
  struct('Q', { x: num(1), y: num(2) }),
  enumValue('C', 'Red', []),
  enumValue('C', 'Green', []),
  enumValue('C', 'Custom', [num(1)]),
  enumValue('C', 'Custom', [num(2)]),
  enumValue('D', 'Red', []),
];

describe('std/set — the key agrees with ==', () => {
  it('has values to compare', () => {
    assert.ok(VALUES.length >= 30, 'expected a decent spread, found ' + VALUES.length);
  });

  it('two values share a key exactly when they are equal', () => {
    const disagreements: string[] = [];
    for (const a of VALUES) {
      for (const b of VALUES) {
        const equal = valuesEqual(a, b);
        const sameKey = key(a) === key(b);
        if (equal !== sameKey) {
          disagreements.push(
            inspect(a) + ' and ' + inspect(b) + ': == says ' + String(equal) +
              ', the key says ' + String(sameKey) +
              '\n    key(a) = ' + key(a) + '\n    key(b) = ' + key(b),
          );
        }
      }
    }
    assert.deepEqual(disagreements, [], 'the key disagrees with `==`:\n  ' + disagreements.join('\n  '));
  });

  it('a value keys the same way twice', () => {
    for (const value of VALUES) assert.equal(key(value), key(value), inspect(value));
  });

  it('the two maps that differ only in insertion order are the trap this guards', () => {
    // Named separately because if the loop above ever stops covering it, this
    // says what was lost. `inspect` differs, `==` does not, and the key must
    // follow `==`.
    const a = mapOf(['x', num(1)], ['y', num(2)]);
    const b = mapOf(['y', num(2)], ['x', num(1)]);
    assert.notEqual(inspect(a), inspect(b), 'the premise changed: inspect now agrees');
    assert.ok(valuesEqual(a, b), 'the premise changed: == now disagrees');
    assert.equal(key(a), key(b));
  });
});

describe('std/set — behaviour', () => {
  // Only the names the body actually uses. Importing the whole module for every
  // one-line test would produce a wall of `RS011` warnings, and those warnings
  // land in the captured output — so a test asserting on that output would be
  // asserting on its own untidiness.
  const EXPORTS = [
    'of', 'has', 'add', 'remove', 'union', 'intersection', 'difference',
    'symmetricDifference', 'isSubset', 'isSuperset', 'isDisjoint', 'equals',
    'size', 'isSet', 'duplicates',
  ];

  const run = async (body: string): Promise<string> => {
    const used = EXPORTS.filter((name) =>
      new RegExp('\\b' + name + '\\s*\\(').test(body),
    );
    const source =
      (used.length === 0 ? '' : 'import { ' + used.join(', ') + ' } from "std/set"\n') +
      body +
      '\n';
    const result = await runSource(source, 'set.lm');
    assert.equal(result.failed, false, 'program failed:\n' + result.output);
    return result.output.trim();
  };

  it('of keeps the first of each, in order', async () => {
    assert.equal(await run('print(of([3, 1, 2, 3, 1]))'), '[3, 1, 2]');
  });

  it('union keeps the left order and appends the newcomers', async () => {
    assert.equal(await run('print(union([3, 1], [1, 4, 2]))'), '[3, 1, 4, 2]');
  });

  it('intersection and difference keep the left order', async () => {
    assert.equal(await run('print(intersection([3, 1, 2], [2, 3]))'), '[3, 2]');
    assert.equal(await run('print(difference([3, 1, 2], [2, 3]))'), '[1]');
  });

  it('symmetricDifference is the left leftovers then the right', async () => {
    assert.equal(await run('print(symmetricDifference([1, 2], [2, 3]))'), '[1, 3]');
  });

  it('the empty set is a subset of everything, including itself', async () => {
    assert.equal(await run('print([isSubset([], [1]), isSubset([], [])])'), '[true, true]');
  });

  it('isDisjoint is true for an empty side', async () => {
    assert.equal(await run('print([isDisjoint([], [1]), isDisjoint([1], [2])])'), '[true, true]');
  });

  it('equals ignores order and repeats, where == does not', async () => {
    assert.equal(await run('print([equals([1, 2], [2, 1]), [1, 2] == [2, 1]])'), '[true, false]');
    assert.equal(await run('print(equals([1, 1, 2], [2, 1]))'), 'true');
  });

  it('duplicates reports each repeated element once', async () => {
    assert.equal(await run('print(duplicates([1, 2, 1, 3, 2, 1]))'), '[1, 2]');
    assert.equal(await run('print(duplicates([1, 2, 3]))'), '[]');
  });

  it('size and isSet count distinct elements', async () => {
    assert.equal(await run('print([size([1, 1, 2]), isSet([1, 2]), isSet([1, 1])])'), '[2, true, false]');
  });

  it('add and remove leave the original alone', async () => {
    assert.equal(
      await run('let s = [1, 2]\nprint([add(s, 3), remove(s, 1), s])'),
      '[[1, 2, 3], [2], [1, 2]]',
    );
  });

  it('adding something already present changes nothing', async () => {
    assert.equal(await run('print(add([1, 2], 2))'), '[1, 2]');
  });

  it('removing something absent is not an error', async () => {
    assert.equal(await run('print(remove([1, 2], 9))'), '[1, 2]');
  });

  it('every operation deduplicates its input', async () => {
    // A set function given a list that is not a set answers as though it were.
    assert.equal(await run('print(union([1, 1], [2, 2]))'), '[1, 2]');
    assert.equal(await run('print(intersection([1, 1, 2], [1]))'), '[1]');
    assert.equal(await run('print(difference([1, 1, 2], [2]))'), '[1]');
    assert.equal(await run('print(add([1, 1], 2))'), '[1, 2]');
  });

  it('structs and enums are members by value', async () => {
    assert.equal(
      await run(
        'struct P { x: Num, y: Num }\n' +
          'print(size([P { x: 1, y: 2 }, P { x: 1, y: 2 }, P { x: 1, y: 3 }]))',
      ),
      '2',
    );
    assert.equal(
      await run(
        'enum C { Red, Custom(Num) }\nprint(size([C.Red, C.Red, C.Custom(1), C.Custom(1), C.Custom(2)]))',
      ),
      '3',
    );
  });

  it('values of different types that print alike stay distinct', async () => {
    assert.equal(await run('print(size([1, "1", true, "true", nil, "nil"]))'), '6');
  });

  it('a string holding a delimiter cannot forge another value’s key', async () => {
    assert.equal(await run('print(size([["a,b"], ["a", "b"]]))'), '2');
  });
});
