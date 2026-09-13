/** `std/json` — JSON encoding and decoding, mapped onto Lumen values. */

import { NIL, bool, list, map, num, str, type Value, typeName } from '@lumen-lang/core';
import { Err, Ok, arg, expectNum, expectStr, fn, moduleOf } from './support.js';

/** Convert parsed JSON into Lumen values. */
function fromJson(input: unknown): Value {
  if (input === null || input === undefined) return NIL;
  if (typeof input === 'boolean') return bool(input);
  if (typeof input === 'number') return num(input);
  if (typeof input === 'string') return str(input);
  if (Array.isArray(input)) return list(input.map((item) => fromJson(item)));
  if (typeof input === 'object') {
    const entries = new Map<string, Value>();
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      entries.set(key, fromJson(value));
    }
    return map(entries);
  }
  return NIL;
}

/**
 * Convert Lumen values into JSON-ready data.
 *
 * Structs become objects. Enums become their variant name when they carry
 * nothing, and `{"variant": ..., "values": [...]}` when they do. Functions have
 * no JSON form.
 *
 * `Option` is the one exception, and it is worth the exception: `Some(v)`
 * becomes `v` and `None` becomes `null`. An optional field is the single most
 * common thing in a JSON document, JSON already has a way to spell it, and the
 * tagged form does not read as one —
 *
 *     {"nickname": {"variant": "Some", "values": ["addy"]}}
 *     {"nickname": "addy"}
 *
 * — so every consumer of an API built this way would have to unwrap it by hand.
 * `Option` maps onto a concept JSON has; `Result` does not, and keeps the tagged
 * form. There is no agreed JSON shape for "succeeded or failed" — some APIs use
 * a status code, some an `error` key, some a wrapper — and unlike `Option`, both
 * arms of a `Result` carry something the reader has to tell apart, so collapsing
 * it would lose what matters rather than what does not.
 *
 * The cost is that `Some(nil)` and `None` both become `null`. That is JSON's
 * limit rather than this function's: there is no second null to map the other
 * one to.
 */
export function toJson(value: Value): unknown {
  switch (value.k) {
    case 'nil':
      return null;
    case 'bool':
    case 'num':
    case 'str':
      return value.v;
    case 'list':
      return value.items.map((item) => toJson(item));
    case 'map':
    case 'struct': {
      const source = value.k === 'map' ? value.entries : value.fields;
      // `Object.create(null)`, not `{}`: assigning to `out.__proto__` on an
      // ordinary object sets the prototype instead of storing a key, so a map
      // with that key came back from `stringify` silently missing it.
      const out = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of source) out[key] = toJson(item);
      return out;
    }
    case 'enum':
      // The variant names are checked too, not just the enum's: somebody's own
      // `enum Option { A, B }` should keep the tagged form, and somebody's own
      // `enum Option { Some(Num), None }` wants this one anyway.
      if (value.enumName === 'Option' && (value.variant === 'Some' || value.variant === 'None')) {
        return value.variant === 'None' ? null : toJson(value.values[0] ?? NIL);
      }
      return value.values.length === 0
        ? value.variant
        : { variant: value.variant, values: value.values.map((v) => toJson(v)) };
    default:
      return undefined;
  }
}

export function stdJson(): Map<string, Value> {
  return moduleOf(
    /** Returns `Ok(value)` or `Err(message)` — parsing is never a silent failure. */
    fn('parse', ['text'], (a, c) => {
      const text = expectStr(arg(a, 0), c, 'parse(text)');
      try {
        return Ok(fromJson(JSON.parse(text)));
      } catch {
        // Deliberately our own wording rather than the host engine's: V8 changes
        // its JSON error text between Node releases, and a Lumen program's
        // output must not depend on which Node happens to be running it.
        return Err(str('invalid JSON'));
      }
    }),

    fn('stringify', ['value', { name: 'indent', defaultValue: num(0) }], (a, c) => {
      const indent = expectNum(arg(a, 1), c, 'stringify indent');
      const data = toJson(arg(a, 0));
      if (data === undefined) {
        return c.panic('cannot convert ' + typeName(arg(a, 0)) + ' to JSON');
      }
      return str(JSON.stringify(data, null, indent));
    }),
  );
}
