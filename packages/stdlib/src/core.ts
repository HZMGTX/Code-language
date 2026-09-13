/**
 * `std/core` — the parts of the world that are not the language itself:
 * time, environment, process arguments, and a few general utilities.
 *
 * Note that `print`, `len`, `type`, `assert`, `Ok`, `Err`, `Some` and `None`
 * need no import at all; they are in the prelude. This module holds the things
 * that genuinely touch the host.
 */

import { NIL, bool, inspect, list, map, num, str, type Value } from '@lumen-lang/core';
import { None, Some, arg, expectNum, expectStr, fn, moduleOf } from './support.js';

/** Deep copy, so mutating the result cannot affect the original. */
/**
 * A deep copy, preserving shape.
 *
 * `copies` maps each container already cloned to its copy, which does two things
 * at once. A value that contains itself can be cloned at all — without the map,
 * `a.push(a)` followed by `clone(a)` was a stack overflow, reported as "a
 * function is probably recursing without a base case" when no function of the
 * reader's was involved. And a value shared in two places stays shared once,
 * rather than becoming two copies: `[inner, inner]` clones to a list whose two
 * elements are still one list, which is what copying a *value* should mean.
 *
 * `inspect` already prints `[1, [...]]` for a self-containing list, so the
 * language had decided such a value is a real one; crashing on it was the
 * inconsistency.
 */
function clone(value: Value, copies = new Map<Value, Value>()): Value {
  const already = copies.get(value);
  if (already !== undefined) return already;

  switch (value.k) {
    case 'list': {
      // The copy is registered before its contents are filled in, because the
      // contents may refer back to it. This is the whole trick.
      const items: Value[] = [];
      const copy = list(items);
      copies.set(value, copy);
      for (const item of value.items) items.push(clone(item, copies));
      return copy;
    }
    case 'map': {
      const entries = new Map<string, Value>();
      const copy = map(entries);
      copies.set(value, copy);
      for (const [key, item] of value.entries) entries.set(key, clone(item, copies));
      return copy;
    }
    case 'struct': {
      const fields = new Map<string, Value>();
      const copy: Value = { k: 'struct', typeName: value.typeName, fields };
      copies.set(value, copy);
      for (const [key, item] of value.fields) fields.set(key, clone(item, copies));
      return copy;
    }
    case 'enum': {
      // An enum's payload is readonly, so it cannot be filled in after the fact
      // — but it also cannot be reassigned, so a cycle can only reach it through
      // a list, map or struct, each of which is registered above.
      const values = value.values.map((item) => clone(item, copies));
      const copy: Value = { ...value, values };
      copies.set(value, copy);
      return copy;
    }
    default:
      // Scalars and functions are already immutable or shared by design.
      return value;
  }
}

export function stdCore(): Map<string, Value> {
  return moduleOf(
    /** Milliseconds since the Unix epoch. */
    fn('now', [], (_a, c) => num(c.host.now())),

    /** An environment variable as an Option, so "unset" is explicit. */
    fn('env', ['name'], (a, c) => {
      const value = c.host.getEnv(expectStr(arg(a, 0), c, 'env(name)'));
      return value === undefined ? None : Some(str(value));
    }),

    /** Command-line arguments passed after the script name. */
    /**
     * The arguments after the script's own name.
     *
     * Asked of the host rather than read out of `process.argv`, because the
     * offset is not a constant: `lumen run x.lm a b` and `lumen x.lm a b` are
     * the same program with the same arguments and put them one place apart.
     * This used to be `process.argv.slice(3)`, which gave `["x.lm", "a", "b"]`
     * for the first and `["a", "b"]` for the second.
     */
    fn('args', [], (_a, c) => list((c.host.args?.() ?? []).map((value) => str(value)))),

    fn('exit', [{ name: 'code', defaultValue: num(0) }], (a, c) => {
      process.exit(expectNum(arg(a, 0), c, 'exit code'));
    }),

    fn('sleep', ['milliseconds'], async (a, c) => {
      const ms = expectNum(arg(a, 0), c, 'sleep(milliseconds)');
      if (ms < 0) return c.panic('sleep needs a non-negative duration, got ' + ms);
      await new Promise((resolve) => setTimeout(resolve, ms));
      return NIL;
    }),

    /** The debug rendering of a value — strings come back quoted. */
    fn('inspect', ['value'], (a) => str(inspect(arg(a, 0)))),

    fn('clone', ['value'], (a) => clone(arg(a, 0))),

    fn('isNil', ['value'], (a) => bool(arg(a, 0).k === 'nil')),
  );
}
