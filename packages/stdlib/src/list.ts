/**
 * `std/list` — list operations.
 *
 * Every function takes the list first, which is what makes the pipeline read
 * left to right: `xs |> filter(pred) |> map(f) |> sum()`.
 *
 * Functions never mutate their input unless the name says so (`push`, `pop`).
 */

import {
  NIL,
  bool,
  inspect,
  list,
  num,
  str,
  truthy,
  type ListValue,
  type Value,
  typeName,
  valuesEqual,
} from '@lumen-lang/core';
import {
  None,
  Some,
  arg,
  expectFn,
  expectInt,
  expectList,
  expectNum,
  expectStr,
  fn,
  moduleOf,
  withDocs,
} from './support.js';

/** Compare two values for sorting; only Nums and Strs have a natural order. */
function orderOf(a: Value, b: Value, panic: (m: string) => never): number {
  if (a.k === 'num' && b.k === 'num') return a.v - b.v;
  if (a.k === 'str' && b.k === 'str') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  return panic('cannot order ' + typeName(a) + ' against ' + typeName(b));
}

export function stdList(): Map<string, Value> {
  return withDocs(
    moduleOf(
    fn('map', ['xs', 'f'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'map(xs)');
      const f = expectFn(arg(a, 1), c, 'map(f)');
      const out: Value[] = [];
      for (const item of xs.items) out.push(await c.call(f, [item]));
      return list(out);
    }),

    fn('filter', ['xs', 'predicate'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'filter(xs)');
      const p = expectFn(arg(a, 1), c, 'filter(predicate)');
      const out: Value[] = [];
      for (const item of xs.items) if (truthy(await c.call(p, [item]))) out.push(item);
      return list(out);
    }),

    fn('reduce', ['xs', 'f', 'initial'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'reduce(xs)');
      const f = expectFn(arg(a, 1), c, 'reduce(f)');
      let acc = arg(a, 2);
      for (const item of xs.items) acc = await c.call(f, [acc, item]);
      return acc;
    }),

    fn('find', ['xs', 'predicate'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'find(xs)');
      const p = expectFn(arg(a, 1), c, 'find(predicate)');
      for (const item of xs.items) if (truthy(await c.call(p, [item]))) return Some(item);
      return None;
    }),

    // The predicate is optional: with none, the elements are tested directly,
    // so `any([true, false])` reads the way a Python programmer expects.
    fn('any', ['xs', { name: 'predicate', defaultValue: NIL }], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'any(xs)');
      const p = arg(a, 1);
      for (const item of xs.items) {
        const held = p.k === 'nil' ? item : await c.call(expectFn(p, c, 'any(predicate)'), [item]);
        if (truthy(held)) return bool(true);
      }
      return bool(false);
    }),

    fn('all', ['xs', { name: 'predicate', defaultValue: NIL }], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'all(xs)');
      const p = arg(a, 1);
      for (const item of xs.items) {
        const held = p.k === 'nil' ? item : await c.call(expectFn(p, c, 'all(predicate)'), [item]);
        if (!truthy(held)) return bool(false);
      }
      return bool(true);
    }),

    fn('count', ['xs', 'predicate'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'count(xs)');
      const p = expectFn(arg(a, 1), c, 'count(predicate)');
      let total = 0;
      for (const item of xs.items) if (truthy(await c.call(p, [item]))) total += 1;
      return num(total);
    }),

    fn('len', ['xs'], (a, c) => num(expectList(arg(a, 0), c, 'len(xs)').items.length)),

    fn('isEmpty', ['xs'], (a, c) => bool(expectList(arg(a, 0), c, 'isEmpty(xs)').items.length === 0)),

    fn('first', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'first(xs)');
      const head = xs.items[0];
      return head === undefined ? None : Some(head);
    }),

    fn('last', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'last(xs)');
      const tail = xs.items[xs.items.length - 1];
      return tail === undefined ? None : Some(tail);
    }),

    fn('at', ['xs', 'index'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'at(xs)');
      const raw = expectInt(arg(a, 1), c, 'at index');
      const i = raw < 0 ? xs.items.length + raw : raw;
      const item = xs.items[i];
      return item === undefined ? None : Some(item);
    }),

    /** Appends in place and returns the list, so it can be chained. */
    fn('push', ['xs', 'value'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'push(xs)');
      xs.items.push(arg(a, 1));
      return xs;
    }),

    /** Removes and returns the last element as an Option, leaving the list shorter. */
    fn('pop', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'pop(xs)');
      const item = xs.items.pop();
      return item === undefined ? None : Some(item);
    }),

    fn('slice', ['xs', 'start', { name: 'end', defaultValue: NIL }], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'slice(xs)');
      const start = expectInt(arg(a, 1), c, 'slice start');
      const endValue = arg(a, 2);
      const end = endValue.k === 'nil' ? xs.items.length : expectInt(endValue, c, 'slice end');
      return list(xs.items.slice(start, end));
    }),

    fn('take', ['xs', 'n'], (a, c) =>
      list(expectList(arg(a, 0), c, 'take(xs)').items.slice(0, expectInt(arg(a, 1), c, 'take n'))),
    ),

    fn('drop', ['xs', 'n'], (a, c) =>
      list(expectList(arg(a, 0), c, 'drop(xs)').items.slice(expectInt(arg(a, 1), c, 'drop n'))),
    ),

    fn('reverse', ['xs'], (a, c) => list([...expectList(arg(a, 0), c, 'reverse(xs)').items].reverse())),

    fn('contains', ['xs', 'value'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'contains(xs)');
      const needle = arg(a, 1);
      return bool(xs.items.some((item) => valuesEqual(item, needle)));
    }),

    fn('indexOf', ['xs', 'value'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'indexOf(xs)');
      const needle = arg(a, 1);
      return num(xs.items.findIndex((item) => valuesEqual(item, needle)));
    }),

    fn('unique', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'unique(xs)');
      const out: Value[] = [];
      for (const item of xs.items) {
        if (!out.some((seen) => valuesEqual(seen, item))) out.push(item);
      }
      return list(out);
    }),

    fn('flatten', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'flatten(xs)');
      const out: Value[] = [];
      for (const item of xs.items) {
        if (item.k === 'list') out.push(...item.items);
        else out.push(item);
      }
      return list(out);
    }),

    fn('join', ['xs', { name: 'separator', defaultValue: str('') }], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'join(xs)');
      const sep = expectStr(arg(a, 1), c, 'join separator');
      return str(xs.items.map((item) => (item.k === 'str' ? item.v : inspect(item))).join(sep));
    }),

    fn('sort', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'sort(xs)');
      const copy = [...xs.items];
      copy.sort((x, y) => orderOf(x, y, (m) => c.panic(m)));
      return list(copy);
    }),

    fn('sortBy', ['xs', 'key'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'sortBy(xs)');
      const key = expectFn(arg(a, 1), c, 'sortBy(key)');
      // Compute keys first so the comparator stays synchronous.
      const keyed: { key: Value; item: Value }[] = [];
      for (const item of xs.items) keyed.push({ key: await c.call(key, [item]), item });
      keyed.sort((x, y) => orderOf(x.key, y.key, (m) => c.panic(m)));
      return list(keyed.map((entry) => entry.item));
    }),

    fn('sum', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'sum(xs)');
      let total = 0;
      for (const item of xs.items) {
        if (item.k !== 'num') return c.panic('sum() needs a List of Num, found ' + typeName(item));
        total += item.v;
      }
      return num(total);
    }),

    fn('zip', ['xs', 'ys'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'zip(xs)');
      const ys = expectList(arg(a, 1), c, 'zip(ys)');
      const out: Value[] = [];
      const size = Math.min(xs.items.length, ys.items.length);
      for (let i = 0; i < size; i += 1) {
        out.push(list([xs.items[i] ?? NIL, ys.items[i] ?? NIL]));
      }
      return list(out);
    }),

    /** `[a, b]` becomes `[[0, a], [1, b]]`. */
    fn('enumerate', ['xs', { name: 'start', defaultValue: num(0) }], (a, c) => {
      const xs: ListValue = expectList(arg(a, 0), c, 'enumerate(xs)');
      // `start` because numbering a printed list from 1 is at least as common
      // as indexing one from 0, and rewriting `i + 1` at every use is worse.
      const start = expectNum(arg(a, 1), c, 'enumerate start');
      return list(xs.items.map((item, i) => list([num(start + i), item])));
    }),
    ),
    {
      map: 'Apply a function to every element, giving a new list.',
      filter: 'Keep only the elements a predicate says true to.',
      reduce: 'Fold the list down to a single value.',
      find: 'The first element matching a predicate. Some(x), or None.',
      any: 'True if any element is truthy, or matches the predicate if one is given.',
      all: 'True if every element is truthy, or matches the predicate if one is given.',
      count: 'How many elements match a predicate.',
      len: 'How many elements the list has.',
      isEmpty: 'True if the list has no elements.',
      first: 'The first element. Some(x), or None if empty.',
      last: 'The last element. Some(x), or None if empty.',
      at: 'The element at an index, counting from the end if negative. Some(x), or None.',
      push: 'Append a value, changing the list in place, and return it.',
      pop: 'Remove and return the last element. Some(x), or None if empty.',
      slice: 'The elements from start up to (not including) end.',
      take: 'The first n elements.',
      drop: 'Everything after the first n elements.',
      reverse: 'A reversed copy. The original is untouched.',
      contains: 'True if the value appears in the list.',
      indexOf: 'Where a value first appears, or -1 if it never does.',
      unique: 'A copy with duplicates removed, keeping the first of each.',
      flatten: 'Merge one level of nested lists.',
      join: 'Join the elements into a string with a separator.',
      sort: 'A sorted copy. Works on numbers or on strings.',
      sortBy: 'A copy sorted by the key each element maps to.',
      sum: 'Add up a list of numbers.',
      zip: 'Pair up two lists, stopping at the shorter one.',
      enumerate: 'Pair each element with its index: [[0, a], [1, b]].',
    },
  );
}
