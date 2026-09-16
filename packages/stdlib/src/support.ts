/** Shared helpers for writing Lumen standard-library modules in TypeScript. */

import {
  NIL,
  type CallCtx,
  type ListValue,
  type MapValue,
  type NativeValue,
  type Value,
  display,
  enumValue,
  typeName,
} from '@lumen-lang/core';

/**
 * A value as a `Map` key, or a panic saying why it cannot be one.
 *
 * A Lumen `Map`'s keys are text, so a value used as one has to become text —
 * and a printed form is only an identity for some values. `Str`, `Num` and
 * `Bool` print differently whenever they differ, so they are safe. A `Map`, a
 * `List` or a struct is not:
 *
 *   - `{city: "Oslo", zone: 1}` and `{zone: 1, city: "Oslo"}` are `==` and
 *     print differently, so `groupBy` put them in **two** groups;
 *   - a value containing itself prints `[...]`, so every such value was the
 *     **same** group.
 *
 * Across types the printed forms overlap. `1` and `"1"` are not `==` and both
 * print `1`, so `groupBy` merged two different groups and `invert` silently
 * dropped an entry. That is not an exotic program: data read from a CSV is all
 * `Str` and data from JSON is mixed, so an `id` that is sometimes `7` and
 * sometimes `"7"` is an ordinary thing to be holding.
 *
 * `seen` carries the type each key was made from, so a second value of a
 * *different* type landing on the same text is refused rather than merged. Two
 * values of the **same** type landing on the same text really are the same key,
 * which is what `groupBy` is for and what `invert`'s documented "the last one
 * wins" means.
 *
 * The same reasoning `std/csv` applies to a duplicate column: one of the two
 * would silently win, and which one is not something a reader could predict.
 */
export function keyText(
  value: Value,
  seen: Map<string, string>,
  ctx: CallCtx,
  where: string,
): string {
  if (value.k !== 'str' && value.k !== 'num' && value.k !== 'bool') {
    ctx.panic(where + ' needs a Str, Num or Bool as a key, got ' + typeName(value), [
      "a Map's keys are text, and two " + typeName(value) + ' values that differ can print the same',
      'while two that are equal can print differently — so neither grouping nor separating',
      'them would be right. Make the key yourself: `.str()`, or the field you meant',
    ]);
  }
  const text = value.k === 'str' ? value.v : display(value);
  const already = seen.get(text);
  if (already !== undefined && already !== typeName(value)) {
    ctx.panic(where + ' has two different keys that both print as `' + text + '`', [
      'one is a ' + already + ' and one is a ' + typeName(value) + ', and they are not equal',
      'so merging them would lose one — convert both to the same type first',
    ]);
  }
  seen.set(text, typeName(value));
  return text;
}

/** Positional argument `i`, or nil when absent. */
export function arg(args: readonly Value[], i: number): Value {
  return args[i] ?? NIL;
}

export function expectStr(value: Value, ctx: CallCtx, what: string): string {
  if (value.k !== 'str') ctx.panic(what + ' must be a Str, got ' + typeName(value));
  return value.v;
}

export function expectNum(value: Value, ctx: CallCtx, what: string): number {
  if (value.k !== 'num') ctx.panic(what + ' must be a Num, got ' + typeName(value));
  return value.v;
}

export function expectInt(value: Value, ctx: CallCtx, what: string): number {
  const n = expectNum(value, ctx, what);
  if (!Number.isInteger(n)) ctx.panic(what + ' must be a whole number, got ' + n);
  return n;
}

export function expectList(value: Value, ctx: CallCtx, what: string): ListValue {
  if (value.k !== 'list') ctx.panic(what + ' must be a List, got ' + typeName(value));
  return value;
}

export function expectMap(value: Value, ctx: CallCtx, what: string): MapValue {
  if (value.k !== 'map') ctx.panic(what + ' must be a Map, got ' + typeName(value));
  return value;
}

export function expectFn(value: Value, ctx: CallCtx, what: string): Value {
  if (value.k !== 'fn' && value.k !== 'native') {
    ctx.panic(what + ' must be a function, got ' + typeName(value));
  }
  return value;
}

/**
 * Define a native with fixed, named parameters (so named arguments work).
 *
 * `signature` is the function's type, written in Lumen's own annotation syntax
 * — `'(s: Str, separator: Str) -> List<Str>'`. It goes here, beside the
 * implementation it describes, for the same reason the docstrings do: a fact
 * about a function kept anywhere else is a fact that goes stale. The checker
 * reads it (via `stdSignatures`) and so does the documentation generator.
 *
 * Omitting it leaves the function `Any` in and `Any` out, exactly as every
 * native was before any of them were typed. Nothing is silently half-checked:
 * a parameter with no annotation inside a signature is `Any` too.
 */
export function fn(
  name: string,
  params: readonly (string | { name: string; defaultValue: Value })[],
  call: (args: readonly Value[], ctx: CallCtx) => Value | Promise<Value>,
  doc?: string,
  signature?: string,
): NativeValue {
  return {
    k: 'native',
    name,
    params: params.map((p) => (typeof p === 'string' ? { name: p } : p)),
    ...(doc === undefined ? {} : { doc }),
    ...(signature === undefined ? {} : { signature }),
    call,
  };
}

/** Assemble a module's export table from a list of natives. */
export function moduleOf(...values: readonly NativeValue[]): Map<string, Value> {
  const exports = new Map<string, Value>();
  for (const value of values) exports.set(value.name, value);
  return exports;
}

/**
 * Attach one-line documentation to a module's functions, for `help()`.
 *
 * Kept separate from the definitions so the implementations stay readable and
 * the prose sits together where it can be reviewed as prose.
 */
export function withDocs(
  module: Map<string, Value>,
  docs: Readonly<Record<string, string>>,
): Map<string, Value> {
  for (const [name, doc] of Object.entries(docs)) {
    const value = module.get(name);
    if (value === undefined || value.k !== 'native') continue;
    module.set(name, { ...value, doc });
  }
  return module;
}

/**
 * Attach types to a module's functions, written in Lumen's own syntax.
 *
 * Beside `withDocs` and for the same reason: a table of prose reads as prose,
 * and a table of signatures reads as a reference. Both sit next to the
 * implementations they describe, so neither can be updated without the other
 * being right there.
 *
 * A name with no entry keeps no signature and stays `Any` in and `Any` out,
 * which is how every native behaved before any of them were typed.
 */
export function withSignatures(
  module: Map<string, Value>,
  signatures: Readonly<Record<string, string>>,
): Map<string, Value> {
  for (const [name, signature] of Object.entries(signatures)) {
    const value = module.get(name);
    if (value === undefined || value.k !== 'native') {
      // A name in the table that no function answers to. Almost always a typo
      // or a rename that missed one side — and its effect is to silently leave
      // that function unchecked, which is the kind of failure nothing notices.
      // Recorded rather than raised, because this runs on the way to running a
      // program; `tests/unit/signatures.test.ts` asserts the list is empty.
      unmatchedSignatures.push(name);
      continue;
    }
    // A variadic takes any number of arguments, which a fixed parameter list
    // cannot describe — and the checker's arity rule would then be wrong about
    // it in the one direction that rejects working programs.
    if (value.variadic === true) continue;
    module.set(name, { ...value, signature });
  }
  return module;
}

/** Names given a signature that no function in their module answers to. */
const unmatchedSignatures: string[] = [];

/**
 * For the tests only: signature-table keys that matched nothing.
 *
 * A mistyped key costs nothing visible — the function simply stays `Any` — so
 * without this the only symptom is a coverage number one lower than it should
 * be, which nobody would connect to the cause.
 */
export function unmatchedSignaturesForTesting(): readonly string[] {
  return unmatchedSignatures;
}

export const Ok = (v: Value): Value => enumValue('Result', 'Ok', [v]);
export const Err = (v: Value): Value => enumValue('Result', 'Err', [v]);
export const Some = (v: Value): Value => enumValue('Option', 'Some', [v]);
export const None: Value = enumValue('Option', 'None', []);
