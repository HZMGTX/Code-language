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

/** Define a native with fixed, named parameters (so named arguments work). */
export function fn(
  name: string,
  params: readonly (string | { name: string; defaultValue: Value })[],
  call: (args: readonly Value[], ctx: CallCtx) => Value | Promise<Value>,
): NativeValue {
  return {
    k: 'native',
    name,
    params: params.map((p) => (typeof p === 'string' ? { name: p } : p)),
    call,
  };
}

/** Assemble a module's export table from a list of natives. */
export function moduleOf(...values: readonly NativeValue[]): Map<string, Value> {
  const exports = new Map<string, Value>();
  for (const value of values) exports.set(value.name, value);
  return exports;
}

export const Ok = (v: Value): Value => enumValue('Result', 'Ok', [v]);
export const Err = (v: Value): Value => enumValue('Result', 'Err', [v]);
export const Some = (v: Value): Value => enumValue('Option', 'Some', [v]);
export const None: Value = enumValue('Option', 'None', []);
