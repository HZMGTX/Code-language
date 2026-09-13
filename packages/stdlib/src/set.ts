/**
 * `std/set` — set operations over lists.
 *
 * ## A set is a List
 *
 * There is no separate `Set` value. A set here is an ordinary `List` that
 * happens to have no duplicates, and every function in this module takes and
 * returns one. That choice buys a great deal:
 *
 *   - everything in `std/list` already works on it — `map`, `filter`, `sorted`,
 *     `len`, `join`, and the `for … in` loop
 *   - `print` shows it the way you would write it
 *   - `type()` answers `List`, which is the truth rather than a polite fiction
 *   - no new value kind, so equality, JSON, and the type checker need no cases
 *
 * Order is part of the deal: every function keeps the order of its first
 * argument, and `union` appends the newcomers from the second in their own
 * order. Set theory says a set is unordered, but a program that prints one has
 * to print it in *some* order, and "the order you built it in" is the only
 * answer that is stable across runs. Sort it if you want a different one.
 *
 * ## What it costs
 *
 * The bulk operations — `union`, `intersection`, `difference`,
 * `symmetricDifference`, `isSubset`, `equals` — index one argument first and
 * then walk the other, so they are linear in the total size rather than the
 * product. That is the reason this module exists: the same thing written with
 * `filter` and `contains` is quadratic, and quietly so.
 *
 * `has`, `add` and `remove` are single-element operations and have to build
 * that index to answer one question, so they stay linear — no worse than
 * `contains`, but no better. Building a set once and asking many questions of
 * it is a hashed collection, which is a v0.2 data-structure problem and not
 * this module.
 *
 * ## Which values count as the same
 *
 * The same ones `==` does, including across nesting: two structs with equal
 * fields are one element, and so are two maps with the same entries written in
 * a different order. `inspect` looks like it would serve as the key and does
 * not — it prints a map's entries in insertion order, so `{x: 1, y: 2}` and
 * `{y: 2, x: 1}` would be two elements of a set despite being `==`. `key`
 * below sorts them, which is what keeps the module honest.
 */

import { bool, list, num, type MapValue, type Value } from '@lumen-lang/core';
import { arg, expectList, fn, moduleOf, withDocs } from './support.js';

/**
 * Identity for values that have no structure to compare — functions, modules,
 * and type objects. `==` compares these by reference, so the key must too.
 */
const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identity(value: object): number {
  const seen = identities.get(value);
  if (seen !== undefined) return seen;
  nextIdentity += 1;
  identities.set(value, nextIdentity);
  return nextIdentity;
}

/**
 * A string that two values share exactly when `==` says they are equal.
 *
 * Every string is written with its length first (`s3:abc`), so no value can
 * forge another's key by containing a delimiter: without it, the one-element
 * list `["a,b"]` and the two-element `["a", "b"]` would both key as `l[a,b]`.
 *
 * `path` carries the containers currently being keyed. A value that contains
 * itself gets a back-reference to how far up the cycle closes (`^0` for "this
 * one"), so `a.push(a)` followed by `size([a])` answers rather than overflowing
 * the stack. Two cyclic values built the same way therefore key the same way.
 *
 * There is one narrow limit, and it is stated rather than hidden: `==` calls two
 * cyclic values equal when nothing distinguishes them however far you unroll, so
 * `a = [a]` equals `b = [[b]]`. Their back-references sit at different depths, so
 * they key differently and a set can hold both. Agreeing there needs a canonical
 * form for infinite trees, which is a real algorithm and not one this module is
 * going to carry for a value nobody builds on purpose.
 */
function key(value: Value, path: readonly Value[] = []): string {
  const at = path.indexOf(value);
  if (at !== -1) return '^' + String(path.length - 1 - at);
  const inner = [...path, value];

  switch (value.k) {
    case 'nil':
      return 'nil';
    case 'bool':
      return value.v ? 'true' : 'false';
    case 'num':
      // `-0` and `0` are `==`, and `String(-0)` is `"0"` anyway, but saying so
      // here means the key does not depend on that staying true.
      return 'n' + String(value.v === 0 ? 0 : value.v);
    case 'str':
      return 's' + String(value.v.length) + ':' + value.v;
    case 'list':
      return (
        'l' + String(value.items.length) +
        '[' + value.items.map((item) => key(item, inner)).join(',') + ']'
      );
    case 'map':
      return 'm' + entriesKey(value, inner);
    case 'struct': {
      const fields = [...value.fields.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, v]) => 's' + String(name.length) + ':' + name + '=' + key(v, inner));
      return 'S' + String(value.typeName.length) + ':' + value.typeName + '{' + fields.join(',') + '}';
    }
    case 'enum': {
      const name = value.enumName + '.' + value.variant;
      return (
        'E' + String(name.length) + ':' + name +
        '(' + value.values.map((v) => key(v, inner)).join(',') + ')'
      );
    }
    default:
      // Functions, natives, modules and type objects: reference identity.
      return 'r' + String(identity(value));
  }
}

/** A map's entries, sorted by name, so insertion order cannot change the key. */
function entriesKey(value: MapValue, path: readonly Value[]): string {
  const parts = [...value.entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, v]) => 's' + String(name.length) + ':' + name + '=' + key(v, path));
  return '{' + parts.join(',') + '}';
}

/** The keys of every element, for membership tests against a whole list. */
function indexOf(values: readonly Value[]): Set<string> {
  const index = new Set<string>();
  for (const value of values) index.add(key(value));
  return index;
}

/** The elements of `xs` in order, with later duplicates dropped. */
function dedupe(xs: readonly Value[]): Value[] {
  const seen = new Set<string>();
  const out: Value[] = [];
  for (const value of xs) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

export function stdSet(): Map<string, Value> {
  return withDocs(
    moduleOf(
      /** The set of a list: the same elements in the same order, minus repeats. */
      fn('of', ['xs'], (a, c) => list(dedupe(expectList(arg(a, 0), c, 'of(xs)').items))),

      fn('has', ['s', 'value'], (a, c) => {
        const s = expectList(arg(a, 0), c, 'has(s)');
        const needle = key(arg(a, 1));
        return bool(s.items.some((item) => key(item) === needle));
      }),

      /** A copy with `value` added, or the same members if it was already there. */
      fn('add', ['s', 'value'], (a, c) => {
        const s = expectList(arg(a, 0), c, 'add(s)');
        const value = arg(a, 1);
        const out = dedupe(s.items);
        const k = key(value);
        if (!out.some((item) => key(item) === k)) out.push(value);
        return list(out);
      }),

      /** A copy without `value`. Removing something absent is not an error. */
      fn('remove', ['s', 'value'], (a, c) => {
        const s = expectList(arg(a, 0), c, 'remove(s)');
        const k = key(arg(a, 1));
        return list(dedupe(s.items).filter((item) => key(item) !== k));
      }),

      /** Everything in either, `a`'s order first. */
      fn('union', ['a', 'b'], (a, c) => {
        const left = expectList(arg(a, 0), c, 'union(a)');
        const right = expectList(arg(a, 1), c, 'union(b)');
        return list(dedupe([...left.items, ...right.items]));
      }),

      /** Everything in both, in `a`'s order. */
      fn('intersection', ['a', 'b'], (a, c) => {
        const left = expectList(arg(a, 0), c, 'intersection(a)');
        const right = indexOf(expectList(arg(a, 1), c, 'intersection(b)').items);
        return list(dedupe(left.items).filter((item) => right.has(key(item))));
      }),

      /** Everything in `a` that is not in `b`, in `a`'s order. */
      fn('difference', ['a', 'b'], (a, c) => {
        const left = expectList(arg(a, 0), c, 'difference(a)');
        const right = indexOf(expectList(arg(a, 1), c, 'difference(b)').items);
        return list(dedupe(left.items).filter((item) => !right.has(key(item))));
      }),

      /** Everything in exactly one of them: `a`'s leftovers, then `b`'s. */
      fn('symmetricDifference', ['a', 'b'], (a, c) => {
        const left = expectList(arg(a, 0), c, 'symmetricDifference(a)');
        const right = expectList(arg(a, 1), c, 'symmetricDifference(b)');
        const inLeft = indexOf(left.items);
        const inRight = indexOf(right.items);
        return list([
          ...dedupe(left.items).filter((item) => !inRight.has(key(item))),
          ...dedupe(right.items).filter((item) => !inLeft.has(key(item))),
        ]);
      }),

      /** True when every element of `a` is in `b`. An empty set is a subset of anything. */
      fn('isSubset', ['a', 'b'], (a, c) => {
        const left = expectList(arg(a, 0), c, 'isSubset(a)');
        const right = indexOf(expectList(arg(a, 1), c, 'isSubset(b)').items);
        return bool(left.items.every((item) => right.has(key(item))));
      }),

      /** True when every element of `b` is in `a`. */
      fn('isSuperset', ['a', 'b'], (a, c) => {
        const left = indexOf(expectList(arg(a, 0), c, 'isSuperset(a)').items);
        const right = expectList(arg(a, 1), c, 'isSuperset(b)');
        return bool(right.items.every((item) => left.has(key(item))));
      }),

      /** True when they share no element at all. */
      fn('isDisjoint', ['a', 'b'], (a, c) => {
        const left = expectList(arg(a, 0), c, 'isDisjoint(a)');
        const right = indexOf(expectList(arg(a, 1), c, 'isDisjoint(b)').items);
        return bool(!left.items.some((item) => right.has(key(item))));
      }),

      /**
       * True when they have the same members, whatever the order or repeats.
       *
       * This is what `==` cannot answer: `[1, 2] == [2, 1]` is false, because
       * two lists are equal when their elements match in order, and that is the
       * right answer for lists.
       */
      fn('equals', ['a', 'b'], (a, c) => {
        const left = indexOf(expectList(arg(a, 0), c, 'equals(a)').items);
        const right = indexOf(expectList(arg(a, 1), c, 'equals(b)').items);
        if (left.size !== right.size) return bool(false);
        for (const k of left) if (!right.has(k)) return bool(false);
        return bool(true);
      }),

      /** How many distinct elements there are. */
      fn('size', ['s'], (a, c) => num(indexOf(expectList(arg(a, 0), c, 'size(s)').items).size)),

      /** True when the list has no duplicates, so it is already a set. */
      fn('isSet', ['xs'], (a, c) => {
        const xs = expectList(arg(a, 0), c, 'isSet(xs)');
        return bool(indexOf(xs.items).size === xs.items.length);
      }),

      /**
       * The elements that appear more than once, in the order they first do.
       *
       * The question `of()` throws away, and the one worth asking of data you
       * did not write: a duplicate in a list of identifiers is usually a bug
       * somewhere upstream, and finding it is easier than guessing.
       */
      fn('duplicates', ['xs'], (a, c) => {
        const xs = expectList(arg(a, 0), c, 'duplicates(xs)');
        const seen = new Set<string>();
        const repeated = new Set<string>();
        const out: Value[] = [];
        for (const value of xs.items) {
          const k = key(value);
          if (!seen.has(k)) {
            seen.add(k);
            continue;
          }
          if (repeated.has(k)) continue;
          repeated.add(k);
          out.push(value);
        }
        return list(out);
      }),
    ),
    {
      of: 'The same elements in the same order, minus repeats.',
      has: 'True if the value is a member.',
      add: 'A copy with a value added, if it was not already there.',
      remove: 'A copy without a value. Removing an absent one is not an error.',
      union: 'Everything in either set, the first one’s order first.',
      intersection: 'Everything in both sets, in the first one’s order.',
      difference: 'Everything in the first set that is not in the second.',
      symmetricDifference: 'Everything in exactly one of the two sets.',
      isSubset: 'True if every element of the first is in the second.',
      isSuperset: 'True if every element of the second is in the first.',
      isDisjoint: 'True if the two share no element.',
      equals: 'True if both have the same members, whatever the order.',
      size: 'How many distinct elements there are.',
      isSet: 'True if the list has no duplicates already.',
      duplicates: 'The elements that appear more than once, first occurrence order.',
    },
  );
}

/**
 * Exported for the tests only.
 *
 * The property that makes this module correct is that two values share a key
 * exactly when `==` says they are equal, and it is not observable from Lumen
 * — a set that got it wrong would just quietly hold two of something. The test
 * checks it directly over every pair of a list of values.
 */
export const setKeyForTesting = key;
