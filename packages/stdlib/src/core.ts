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
function clone(value: Value): Value {
  switch (value.k) {
    case 'list':
      return list(value.items.map((item) => clone(item)));
    case 'map': {
      const entries = new Map<string, Value>();
      for (const [key, item] of value.entries) entries.set(key, clone(item));
      return map(entries);
    }
    case 'struct': {
      const fields = new Map<string, Value>();
      for (const [key, item] of value.fields) fields.set(key, clone(item));
      return { k: 'struct', typeName: value.typeName, fields };
    }
    case 'enum':
      return { ...value, values: value.values.map((item) => clone(item)) };
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
    fn('args', [], () => list(process.argv.slice(3).map((a) => str(a)))),

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
