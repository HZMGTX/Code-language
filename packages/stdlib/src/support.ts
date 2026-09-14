/** Shared helpers for writing Lumen standard-library modules in TypeScript. */

import {
  NIL,
  type CallCtx,
  type ListValue,
  type MapValue,
  type NativeValue,
  type Value,
  enumValue,
  typeName,
} from '@lumen-lang/core';

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
    if (value === undefined || value.k !== 'native') continue;
    // A variadic takes any number of arguments, which a fixed parameter list
    // cannot describe — and the checker's arity rule would then be wrong about
    // it in the one direction that rejects working programs.
    if (value.variadic === true) continue;
    module.set(name, { ...value, signature });
  }
  return module;
}

export const Ok = (v: Value): Value => enumValue('Result', 'Ok', [v]);
export const Err = (v: Value): Value => enumValue('Result', 'Err', [v]);
export const Some = (v: Value): Value => enumValue('Option', 'Some', [v]);
export const None: Value = enumValue('Option', 'None', []);
