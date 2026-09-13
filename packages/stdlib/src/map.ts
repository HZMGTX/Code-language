/**
 * `std/map` — string-keyed map operations.
 *
 * Reading a missing key with `m["k"]` gives nil. `get` returns an Option
 * instead, which is the form to reach for when "absent" is a real case you
 * want the compiler-of-the-future to make you handle.
 */

import { NIL, bool, list, map, num, str, type Value } from '@lumen-lang/core';
import {
  None,
  Some,
  arg,
  expectList,
  expectMap,
  expectStr,
  fn,
  moduleOf,
  withDocs,
} from './support.js';

export function stdMap(): Map<string, Value> {
  return withDocs(
    moduleOf(
    fn('keys', ['m'], (a, c) =>
      list([...expectMap(arg(a, 0), c, 'keys(m)').entries.keys()].map((k) => str(k))),
    ),

    fn('values', ['m'], (a, c) => list([...expectMap(arg(a, 0), c, 'values(m)').entries.values()])),

    /** `{a: 1}` becomes `[["a", 1]]`. */
    fn('entries', ['m'], (a, c) =>
      list(
        [...expectMap(arg(a, 0), c, 'entries(m)').entries].map(([k, v]) => list([str(k), v])),
      ),
    ),

    fn('get', ['m', 'key'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'get(m)');
      const key = expectStr(arg(a, 1), c, 'get key');
      const found = m.entries.get(key);
      return found === undefined ? None : Some(found);
    }),

    fn('has', ['m', 'key'], (a, c) =>
      bool(expectMap(arg(a, 0), c, 'has(m)').entries.has(expectStr(arg(a, 1), c, 'has key'))),
    ),

    /** Returns a new map; the original is untouched. */
    fn('set', ['m', 'key', 'value'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'set(m)');
      const next = new Map(m.entries);
      next.set(expectStr(arg(a, 1), c, 'set key'), arg(a, 2));
      return map(next);
    }),

    fn('remove', ['m', 'key'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'remove(m)');
      const next = new Map(m.entries);
      next.delete(expectStr(arg(a, 1), c, 'remove key'));
      return map(next);
    }),

    /** Later maps win on conflicting keys. */
    fn('merge', ['m', 'other'], (a, c) => {
      const left = expectMap(arg(a, 0), c, 'merge(m)');
      const right = expectMap(arg(a, 1), c, 'merge(other)');
      return map(new Map([...left.entries, ...right.entries]));
    }),

    fn('len', ['m'], (a, c) => num(expectMap(arg(a, 0), c, 'len(m)').entries.size)),

    fn('isEmpty', ['m'], (a, c) => bool(expectMap(arg(a, 0), c, 'isEmpty(m)').entries.size === 0)),

    /** Build a map from `[[key, value], ...]`. */
    fn('fromEntries', ['pairs'], (a, c) => {
      const pairs = expectList(arg(a, 0), c, 'fromEntries(pairs)');
      const out = new Map<string, Value>();
      for (const pair of pairs.items) {
        if (pair.k !== 'list' || pair.items.length !== 2) {
          return c.panic('fromEntries expects a List of [key, value] pairs');
        }
        const key = pair.items[0] ?? NIL;
        if (key.k !== 'str') return c.panic('fromEntries keys must be Str');
        out.set(key.v, pair.items[1] ?? NIL);
      }
      return map(out);
    }),
    ),
    {
      keys: 'The keys, in insertion order.',
      values: 'The values, in insertion order.',
      entries: 'The pairs, as [[key, value], ...].',
      get: 'The value at a key. Some(v), or None if absent.',
      has: 'True if the key is present.',
      set: 'A copy with one key set. The original is untouched.',
      remove: 'A copy with one key removed.',
      merge: 'A copy of the two maps combined; the later map wins.',
      len: 'How many entries the map has.',
      isEmpty: 'True if the map has no entries.',
      fromEntries: 'Build a map from [[key, value], ...].',
    },
  );
}
