/**
 * `std/result` — working with `Ok(x)` and `Err(e)` without a `match` each time.
 *
 * Lumen has no exceptions, so a Result is how failure travels. `?` handles the
 * commonest case — hand it straight back to the caller — and `match` handles
 * the rest. These are for what sits between: changing the value, changing the
 * error, supplying a default, or asking which one you have.
 *
 * Every function takes the Result first, so each is also a method.
 */

import { bool, enumValue, type CallCtx, type EnumValue, type Value } from '@lumen-lang/core';
import { None, Some, arg, expectFn, fn, moduleOf } from './support.js';

function expectResult(value: Value, ctx: CallCtx, where: string): EnumValue {
  if (value.k === 'enum' && value.enumName === 'Result') return value;
  return ctx.panic(where + ' needs a Result (Ok(x) or Err(e))', [
    'this is ' + (value.k === 'enum' ? value.enumName : value.k),
  ]) as never;
}

const isOk = (r: EnumValue): boolean => r.variant === 'Ok';
/** Both variants carry exactly one value, so index 0 is always there. */
const inner = (r: EnumValue): Value => r.values[0] as Value;

export function stdResult(): Map<string, Value> {
  return moduleOf(
    fn('isOk', ['result'], (a, c) => bool(isOk(expectResult(arg(a, 0), c, 'isOk(result)'))),
      'True when it succeeded.'),

    fn('isErr', ['result'], (a, c) => bool(!isOk(expectResult(arg(a, 0), c, 'isErr(result)'))),
      'True when it failed.'),

    fn(
      'unwrapOr',
      ['result', 'fallback'],
      (a, c) => {
        const r = expectResult(arg(a, 0), c, 'unwrapOr(result)');
        return isOk(r) ? inner(r) : arg(a, 1);
      },
      'The value, or the fallback when it failed.',
    ),

    fn(
      'map',
      ['result', 'f'],
      async (a, c) => {
        const r = expectResult(arg(a, 0), c, 'map(result)');
        if (!isOk(r)) return r;
        const f = expectFn(arg(a, 1), c, 'map(f)');
        return enumValue('Result', 'Ok', [await c.call(f, [inner(r)])]);
      },
      'Apply a function to the value, if it succeeded. An Err passes through.',
    ),

    fn(
      'mapErr',
      ['result', 'f'],
      async (a, c) => {
        const r = expectResult(arg(a, 0), c, 'mapErr(result)');
        if (isOk(r)) return r;
        const f = expectFn(arg(a, 1), c, 'mapErr(f)');
        return enumValue('Result', 'Err', [await c.call(f, [inner(r)])]);
      },
      'Change the error, leaving a success alone — for adding context as it travels up.',
    ),

    fn(
      'andThen',
      ['result', 'f'],
      async (a, c) => {
        const r = expectResult(arg(a, 0), c, 'andThen(result)');
        if (!isOk(r)) return r;
        const f = expectFn(arg(a, 1), c, 'andThen(f)');
        const next = await c.call(f, [inner(r)]);
        return expectResult(next, c, 'the function given to andThen');
      },
      'Like map, for a function that itself returns a Result. No double wrapping.',
    ),

    fn(
      'ok',
      ['result'],
      (a, c) => {
        const r = expectResult(arg(a, 0), c, 'ok(result)');
        return isOk(r) ? Some(inner(r)) : None;
      },
      'The success as an Option, discarding the error.',
    ),

    fn(
      'err',
      ['result'],
      (a, c) => {
        const r = expectResult(arg(a, 0), c, 'err(result)');
        return isOk(r) ? None : Some(inner(r));
      },
      'The error as an Option, discarding the success.',
    ),
  );
}
