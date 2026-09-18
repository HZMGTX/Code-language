/**
 * `std/core` — the parts of the world that are not the language itself:
 * time, environment, process arguments, and a few general utilities.
 *
 * Note that `print`, `len`, `type`, `assert`, `Ok`, `Err`, `Some` and `None`
 * need no import at all; they are in the prelude. This module holds the things
 * that genuinely touch the host.
 */

import { NIL, bool, inspect, list, map, num, str, type Value } from '@lumen-lang/core';
import { None, Some, arg, expectNum, expectStr, fn, moduleOf, withDocs, withSignatures } from './support.js';

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

/**
 * The handful of things that are about the program itself rather than about a
 * value: the clock, the environment, the arguments, stopping.
 *
 * `clone` and `inspect` take anything and are honest about giving back
 * anything, which is what `Any` is for. `env` answers an `Option` because a
 * variable that is not set is not an empty string.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  now: '() -> Num',
  env: '(name: Str) -> Option',
  args: '() -> List<Str>',
  exit: '(code: Num = 0) -> Nil',
  sleep: '(milliseconds: Num) -> Nil',
  inspect: '(value: Any) -> Str',
  clone: '(value: Any) -> Any',
  isNil: '(value: Any) -> Bool',
};

/** One line each, for `help()` and the generated reference. */
const DOCS: Readonly<Record<string, string>> = {
  now: 'Milliseconds since the Unix epoch, the instant `std/time` works with.',
  env: 'An environment variable as an Option: `Some(value)`, or `None` when it is unset.',
  args: "The command-line arguments after the script's own name.",
  exit: 'Stop the program with a status code, 0 unless given.',
  sleep: 'Pause for a number of milliseconds.',
  inspect: 'A value written the way source would write it, so a string keeps its quotes.',
  clone: 'A deep copy, so changing the copy leaves the original alone.',
  isNil: 'Whether a value is `nil`.',
};

export function stdCore(): Map<string, Value> {
  return withSignatures(
    withDocs(
    moduleOf(
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

    /**
     * Stop the program.
     *
     * Through the host, like everything else here. This was the one function in
     * the standard library that reached for a Node API directly — a bare
     * `process.exit()` — which made it the one thing that could not work in a
     * browser or a worker, and the one way an embedding could have the program
     * it was running take the whole process down with it.
     */
    fn('exit', [{ name: 'code', defaultValue: num(0) }], (a, c) => {
      const code = expectNum(arg(a, 0), c, 'exit code');
      if (c.host.exit === undefined) {
        return c.panic('exit() is not available here', [
          'this host cannot stop the program; return from `main` instead',
        ]);
      }
      c.host.exit(code);
      // Only reached by a host that chose to keep going.
      return NIL;
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
    ),
    DOCS,
    ),
    SIGNATURES,
  );
}
