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
  display,
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
  keyText,
  moduleOf,
  withDocs,
  withSignatures,
} from './support.js';

/** Compare two values for sorting; only Nums and Strs have a natural order. */
function orderOf(a: Value, b: Value, panic: (m: string) => never): number {
  if (a.k === 'num' && b.k === 'num') return a.v - b.v;
  if (a.k === 'str' && b.k === 'str') return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  return panic('cannot order ' + typeName(a) + ' against ' + typeName(b));
}

/**
 * Every function's type, in Lumen's own annotation syntax.
 *
 * Conservative on purpose, because `Ty` has no type variables. `map(xs, f)`
 * genuinely returns a list of whatever `f` gives back, and there is no way to
 * write that here — so the element type is left off, and a `List` is all the
 * checker learns. That is enough for `xs.map(f) + 1` to be caught and not
 * enough to be wrong about, which is the right side to err on.
 *
 * `value` parameters stay `Any` for the same reason: `contains(xs, value)`
 * works on a list of anything, and narrowing it to the element type is a
 * promise this pass cannot keep.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  map: '(xs: List, f: fn(Any) -> Any) -> List',
  filter: '(xs: List, predicate: fn(Any) -> Any) -> List',
  reduce: '(xs: List, f: fn(Any, Any) -> Any, initial: Any) -> Any',
  find: '(xs: List, predicate: fn(Any) -> Any) -> Option',
  any: '(xs: List, predicate: Any = nil) -> Bool',
  all: '(xs: List, predicate: Any = nil) -> Bool',
  count: '(xs: List, predicate: fn(Any) -> Any) -> Num',
  len: '(xs: List) -> Num',
  isEmpty: '(xs: List) -> Bool',
  first: '(xs: List) -> Option',
  last: '(xs: List) -> Option',
  at: '(xs: List, index: Num) -> Option',
  push: '(xs: List, value: Any) -> List',
  pop: '(xs: List) -> Option',
  // `end` defaults to nil and means "to the end", so it takes a Num or nil.
  slice: '(xs: List, start: Num, end: Any = nil) -> List',
  take: '(xs: List, n: Num) -> List',
  drop: '(xs: List, n: Num) -> List',
  reverse: '(xs: List) -> List',
  contains: '(xs: List, value: Any) -> Bool',
  indexOf: '(xs: List, value: Any) -> Num',
  unique: '(xs: List) -> List',
  flatten: '(xs: List) -> List',
  join: '(xs: List, separator: Str = "") -> Str',
  sort: '(xs: List) -> List',
  sortBy: '(xs: List, key: fn(Any) -> Any) -> List',
  sum: '(xs: List) -> Num',
  zip: '(xs: List, ys: List) -> List',
  groupBy: '(xs: List, key: fn(Any) -> Any) -> Map',
  partition: '(xs: List, predicate: fn(Any) -> Any) -> List',
  chunk: '(xs: List, size: Num) -> List',
  windows: '(xs: List, size: Num) -> List',
  flatMap: '(xs: List, f: fn(Any) -> Any) -> List',
  scan: '(xs: List, f: fn(Any, Any) -> Any, initial: Any) -> List',
  intersperse: '(xs: List, value: Any) -> List',
  insert: '(xs: List, index: Num, value: Any) -> List',
  removeAt: '(xs: List, index: Num) -> List',
  concat: '(xs: List, ys: List) -> List',
  minimum: '(xs: List) -> Option',
  maximum: '(xs: List) -> Option',
  minBy: '(xs: List, key: fn(Any) -> Any) -> Option',
  maxBy: '(xs: List, key: fn(Any) -> Any) -> Option',
  enumerate: '(xs: List, start: Num = 0) -> List',
};

export function stdList(): Map<string, Value> {
  return withSignatures(
    withDocs(
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

    /**
     * Split into a Map from key to the elements that produced it.
     *
     * The one people reach for most often and cannot easily write, because
     * `reduce` over a Map means rebuilding the accumulator on every element.
     *
     * A Map's keys are text, so the key is displayed rather than inspected:
     * grouping by `u.name` should key on `ada`, not on `"ada"`. That is only
     * an identity for a `Str`, a `Num` or a `Bool`, so `keyText` refuses
     * anything else and refuses a collision between types — see there for what
     * went wrong without it, which was both splitting equal keys and merging
     * different ones.
     */
    fn('groupBy', ['xs', 'key'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'groupBy(xs)');
      const key = expectFn(arg(a, 1), c, 'groupBy(key)');
      const groups = new Map<string, Value>();
      const seen = new Map<string, string>();
      for (const item of xs.items) {
        const name = keyText(await c.call(key, [item]), seen, c, 'groupBy');
        const bucket = groups.get(name);
        if (bucket !== undefined && bucket.k === 'list') bucket.items.push(item);
        else groups.set(name, list([item]));
      }
      return { k: 'map', entries: groups };
    }),

    /** `[matching, notMatching]` — one pass, both halves, original order kept. */
    fn('partition', ['xs', 'predicate'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'partition(xs)');
      const p = expectFn(arg(a, 1), c, 'partition(predicate)');
      const yes: Value[] = [];
      const no: Value[] = [];
      for (const item of xs.items) (truthy(await c.call(p, [item])) ? yes : no).push(item);
      return list([list(yes), list(no)]);
    }),

    /**
     * Consecutive runs of `size`, the last one short if it does not divide.
     *
     * The short final chunk is deliberate: dropping it loses data, and padding
     * it invents some.
     */
    fn('chunk', ['xs', 'size'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'chunk(xs)');
      const size = expectInt(arg(a, 1), c, 'chunk size');
      if (size < 1) return c.panic('chunk size must be at least 1, got ' + size);
      const out: Value[] = [];
      for (let i = 0; i < xs.items.length; i += size) out.push(list(xs.items.slice(i, i + size)));
      return list(out);
    }),

    /**
     * Every overlapping run of `size`, so `windows([1,2,3], 2)` is
     * `[[1,2],[2,3]]`. Empty when the list is shorter than the window, because
     * there is no such run — not one short one.
     */
    fn('windows', ['xs', 'size'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'windows(xs)');
      const size = expectInt(arg(a, 1), c, 'windows size');
      if (size < 1) return c.panic('windows size must be at least 1, got ' + size);
      const out: Value[] = [];
      for (let i = 0; i + size <= xs.items.length; i += 1) out.push(list(xs.items.slice(i, i + size)));
      return list(out);
    }),

    /** Map, then flatten one level — for a function that returns a list each time. */
    fn('flatMap', ['xs', 'f'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'flatMap(xs)');
      const f = expectFn(arg(a, 1), c, 'flatMap(f)');
      const out: Value[] = [];
      for (const item of xs.items) {
        const produced = await c.call(f, [item]);
        if (produced.k === 'list') out.push(...produced.items);
        else out.push(produced);
      }
      return list(out);
    }),

    /**
     * Like `reduce`, but keeping every step rather than only the last.
     *
     * A running total, in other words: `scan([1,2,3], fn(a, b) { a + b }, 0)`
     * gives `[0, 1, 3, 6]`. The initial value is the first element of the
     * result, so the output is always one longer than the input.
     */
    fn('scan', ['xs', 'f', 'initial'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'scan(xs)');
      const f = expectFn(arg(a, 1), c, 'scan(f)');
      let acc = arg(a, 2);
      const out: Value[] = [acc];
      for (const item of xs.items) {
        acc = await c.call(f, [acc, item]);
        out.push(acc);
      }
      return list(out);
    }),

    /** A value between every pair of elements: `intersperse([1,2,3], 0)` is `[1,0,2,0,3]`. */
    fn('intersperse', ['xs', 'value'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'intersperse(xs)');
      const sep = arg(a, 1);
      const out: Value[] = [];
      for (const [i, item] of xs.items.entries()) {
        if (i > 0) out.push(sep);
        out.push(item);
      }
      return list(out);
    }),

    /** A copy with `value` inserted at `index`, counting from the end if negative. */
    fn('insert', ['xs', 'index', 'value'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'insert(xs)');
      const raw = expectInt(arg(a, 1), c, 'insert index');
      const at = raw < 0 ? xs.items.length + raw : raw;
      const copy = [...xs.items];
      copy.splice(Math.max(0, Math.min(copy.length, at)), 0, arg(a, 2));
      return list(copy);
    }),

    /** A copy without the element at `index`. An index past the end changes nothing. */
    fn('removeAt', ['xs', 'index'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'removeAt(xs)');
      const raw = expectInt(arg(a, 1), c, 'removeAt index');
      const at = raw < 0 ? xs.items.length + raw : raw;
      if (at < 0 || at >= xs.items.length) return list([...xs.items]);
      const copy = [...xs.items];
      copy.splice(at, 1);
      return list(copy);
    }),

    /** Two lists joined into a new one. Neither original is changed. */
    fn('concat', ['xs', 'ys'], (a, c) =>
      list([
        ...expectList(arg(a, 0), c, 'concat(xs)').items,
        ...expectList(arg(a, 1), c, 'concat(ys)').items,
      ]),
    ),

    /** The smallest element. `None` when the list is empty, rather than an error. */
    fn('minimum', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'minimum(xs)');
      let best: Value | undefined;
      for (const item of xs.items) {
        if (best === undefined || orderOf(item, best, (m) => c.panic(m)) < 0) best = item;
      }
      return best === undefined ? None : Some(best);
    }),

    /** The largest element. `None` when the list is empty. */
    fn('maximum', ['xs'], (a, c) => {
      const xs = expectList(arg(a, 0), c, 'maximum(xs)');
      let best: Value | undefined;
      for (const item of xs.items) {
        if (best === undefined || orderOf(item, best, (m) => c.panic(m)) > 0) best = item;
      }
      return best === undefined ? None : Some(best);
    }),

    /** The element whose key is smallest. `None` when the list is empty. */
    fn('minBy', ['xs', 'key'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'minBy(xs)');
      const key = expectFn(arg(a, 1), c, 'minBy(key)');
      let best: { key: Value; item: Value } | undefined;
      for (const item of xs.items) {
        const k = await c.call(key, [item]);
        if (best === undefined || orderOf(k, best.key, (m) => c.panic(m)) < 0) best = { key: k, item };
      }
      return best === undefined ? None : Some(best.item);
    }),

    /** The element whose key is largest. `None` when the list is empty. */
    fn('maxBy', ['xs', 'key'], async (a, c) => {
      const xs = expectList(arg(a, 0), c, 'maxBy(xs)');
      const key = expectFn(arg(a, 1), c, 'maxBy(key)');
      let best: { key: Value; item: Value } | undefined;
      for (const item of xs.items) {
        const k = await c.call(key, [item]);
        if (best === undefined || orderOf(k, best.key, (m) => c.panic(m)) > 0) best = { key: k, item };
      }
      return best === undefined ? None : Some(best.item);
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
      groupBy: 'Group the elements into a Map by the key each one maps to.',
      partition: 'Split into [matching, notMatching] in one pass.',
      chunk: 'Consecutive runs of n, the last short if it does not divide.',
      windows: 'Every overlapping run of n elements.',
      flatMap: 'Map a function that returns lists, then flatten one level.',
      scan: 'Like reduce, but keeping every intermediate value.',
      intersperse: 'Put a value between every pair of elements.',
      insert: 'A copy with a value inserted at an index.',
      removeAt: 'A copy without the element at an index.',
      concat: 'Two lists joined into a new one.',
      minimum: 'The smallest element. Some(x), or None if empty.',
      maximum: 'The largest element. Some(x), or None if empty.',
      minBy: 'The element with the smallest key. Some(x), or None if empty.',
      maxBy: 'The element with the largest key. Some(x), or None if empty.',
      },
    ),
    SIGNATURES,
  );
}
