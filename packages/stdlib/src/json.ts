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
 * Convert Lumen values into JSON-ready data. Structs become objects, enums
 * become `{"variant": ..., "values": [...]}`, and functions have no JSON form.
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
      const out: Record<string, unknown> = {};
      for (const [key, item] of source) out[key] = toJson(item);
      return out;
    }
    case 'enum':
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
