/**
 * `std/map` — string-keyed map operations.
 *
 * Reading a missing key with `m["k"]` gives nil. `get` returns an Option
 * instead, which is the form to reach for when "absent" is a real case you
 * want the compiler-of-the-future to make you handle.
 */

import { NIL, bool, display, list, map, num, str, truthy, type Value } from '@lumen-lang/core';
import {
  None,
  Some,
  arg,
  expectFn,
  expectList,
  expectMap,
  expectStr,
  fn,
  moduleOf,
  withDocs,
  withSignatures,
} from './support.js';

/**
 * Every function's type, in Lumen's own annotation syntax.
 *
 * A Map's keys are always Str (§3), so every `key` parameter is one. The values
 * are anything, and `Ty` has no type variables, so `get` answers `Option` and
 * `values` answers `List` without saying of what.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  keys: '(m: Map) -> List<Str>',
  values: '(m: Map) -> List',
  entries: '(m: Map) -> List',
  get: '(m: Map, key: Str) -> Option',
  getOr: '(m: Map, key: Str, fallback: Any) -> Any',
  has: '(m: Map, key: Str) -> Bool',
  set: '(m: Map, key: Str, value: Any) -> Map',
  remove: '(m: Map, key: Str) -> Map',
  merge: '(m: Map, other: Map) -> Map',
  len: '(m: Map) -> Num',
  isEmpty: '(m: Map) -> Bool',
  update: '(m: Map, key: Str, f: fn(Any) -> Any, fallback: Any = nil) -> Map',
  mapValues: '(m: Map, f: fn(Any) -> Any) -> Map',
  filter: '(m: Map, predicate: fn(Any, Any) -> Any) -> Map',
  invert: '(m: Map) -> Map',
  pick: '(m: Map, keys: List<Str>) -> Map',
  omit: '(m: Map, keys: List<Str>) -> Map',
  fromEntries: '(pairs: List) -> Map',
};

export function stdMap(): Map<string, Value> {
  return withSignatures(
    withDocs(
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

    /**
     * The value at `key`, or `fallback` when there is none.
     *
     * `m[key]` gives `nil` for a missing key, which a counter then has to test
     * for on every single increment. This is the form that makes
     * `counts[word] = counts.getOr(word, 0) + 1` one line.
     */
    fn('getOr', ['m', 'key', 'fallback'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'getOr(m)');
      const key = expectStr(arg(a, 1), c, 'getOr key');
      return m.entries.get(key) ?? arg(a, 2);
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

    /**
     * A copy with one key's value replaced by `f(oldValue)`.
     *
     * A missing key gets `fallback`, which defaults to nil — so a counter is
     * `counts.update(word, fn(n) { n + 1 }, 0)` rather than a `get`, a `match`
     * and a `set`.
     */
    fn('update', ['m', 'key', 'f', { name: 'fallback', defaultValue: NIL }], async (a, c) => {
      const m = expectMap(arg(a, 0), c, 'update(m)');
      const key = expectStr(arg(a, 1), c, 'update(key)');
      const f = expectFn(arg(a, 2), c, 'update(f)');
      const current = m.entries.get(key) ?? arg(a, 3);
      const out = new Map(m.entries);
      out.set(key, await c.call(f, [current]));
      return map(out);
    }),

    /** A copy with every value passed through a function. Keys are untouched. */
    fn('mapValues', ['m', 'f'], async (a, c) => {
      const m = expectMap(arg(a, 0), c, 'mapValues(m)');
      const f = expectFn(arg(a, 1), c, 'mapValues(f)');
      const out = new Map<string, Value>();
      for (const [key, value] of m.entries) out.set(key, await c.call(f, [value]));
      return map(out);
    }),

    /** A copy holding only the entries a predicate says true to, given key and value. */
    fn('filter', ['m', 'predicate'], async (a, c) => {
      const m = expectMap(arg(a, 0), c, 'filter(m)');
      const p = expectFn(arg(a, 1), c, 'filter(predicate)');
      const out = new Map<string, Value>();
      for (const [key, value] of m.entries) {
        if (truthy(await c.call(p, [str(key), value]))) out.set(key, value);
      }
      return map(out);
    }),

    /**
     * Keys and values swapped.
     *
     * Values that are not Strs are displayed to make a key, and two entries
     * sharing a value collapse — the last one wins, which is the only answer
     * that keeps the result a map.
     */
    fn('invert', ['m'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'invert(m)');
      const out = new Map<string, Value>();
      for (const [key, value] of m.entries) {
        out.set(value.k === 'str' ? value.v : display(value), str(key));
      }
      return map(out);
    }),

    /** A copy holding only the named keys. Names that are absent are skipped. */
    fn('pick', ['m', 'keys'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'pick(m)');
      const keys = expectList(arg(a, 1), c, 'pick(keys)');
      const out = new Map<string, Value>();
      for (const key of keys.items) {
        const name = expectStr(key, c, 'pick key');
        const found = m.entries.get(name);
        if (found !== undefined) out.set(name, found);
      }
      return map(out);
    }),

    /** A copy without the named keys. */
    fn('omit', ['m', 'keys'], (a, c) => {
      const m = expectMap(arg(a, 0), c, 'omit(m)');
      const keys = expectList(arg(a, 1), c, 'omit(keys)');
      const drop = new Set(keys.items.map((key) => expectStr(key, c, 'omit key')));
      const out = new Map<string, Value>();
      for (const [key, value] of m.entries) if (!drop.has(key)) out.set(key, value);
      return map(out);
    }),

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
      update: 'A copy with one key passed through a function, with a fallback if absent.',
      mapValues: 'A copy with every value passed through a function.',
      filter: 'A copy holding only the entries a predicate accepts.',
      invert: 'Keys and values swapped; the last of a repeated value wins.',
      pick: 'A copy holding only the named keys.',
      omit: 'A copy without the named keys.',
      },
    ),
    SIGNATURES,
  );
}
