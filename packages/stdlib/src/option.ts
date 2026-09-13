/**
 * `std/option` — working with `Some(x)` and `None` without a `match` each time.
 *
 * `match` is the honest way to handle absence and will always be there. But a
 * great many uses of an Option are one of three shapes — turn the value into
 * another value, supply a default, ask whether there is one — and spelling
 * each of those as a two-armed `match` buries the interesting line among the
 * ceremony.
 *
 *     match find(notes, id) { Some(n) => n.title, None => "(none)" }
 *     find(notes, id).map(title).unwrapOr("(none)")
 *
 * Every function takes the Option first, so each is also a method.
 */

import { bool, enumValue, truthy, type CallCtx, type EnumValue, type Value } from '@lumen-lang/core';
import { None, Some, arg, expectFn, fn, moduleOf } from './support.js';

/** The Option a function was handed, or a panic naming what it got instead. */
function expectOption(value: Value, ctx: CallCtx, where: string): EnumValue {
  if (value.k === 'enum' && value.enumName === 'Option') return value;
  return ctx.panic(where + ' needs an Option (Some(x) or None)', [
    'this is ' + (value.k === 'enum' ? value.enumName : value.k),
  ]) as never;
}

const isSome = (o: EnumValue): boolean => o.variant === 'Some';
/** `Some(x)` always carries exactly one value, so index 0 is always there. */
const inner = (o: EnumValue): Value => o.values[0] as Value;

export function stdOption(): Map<string, Value> {
  return moduleOf(
    fn(
      'isSome',
      ['option'],
      (a, c) => bool(isSome(expectOption(arg(a, 0), c, 'isSome(option)'))),
      'True when there is a value.',
    ),

    fn(
      'isNone',
      ['option'],
      (a, c) => bool(!isSome(expectOption(arg(a, 0), c, 'isNone(option)'))),
      'True when there is nothing.',
    ),

    fn(
      'unwrapOr',
      ['option', 'fallback'],
      (a, c) => {
        const o = expectOption(arg(a, 0), c, 'unwrapOr(option)');
        return isSome(o) ? inner(o) : arg(a, 1);
      },
      'The value, or the fallback when there is none.',
    ),

    fn(
      'map',
      ['option', 'f'],
      async (a, c) => {
        const o = expectOption(arg(a, 0), c, 'map(option)');
        if (!isSome(o)) return o;
        const f = expectFn(arg(a, 1), c, 'map(f)');
        return Some(await c.call(f, [inner(o)]));
      },
      'Apply a function to the value, if there is one. None passes through.',
    ),

    fn(
      'andThen',
      ['option', 'f'],
      async (a, c) => {
        const o = expectOption(arg(a, 0), c, 'andThen(option)');
        if (!isSome(o)) return o;
        const f = expectFn(arg(a, 1), c, 'andThen(f)');
        const next = await c.call(f, [inner(o)]);
        // The function is expected to answer with an Option of its own; saying
        // so is better than wrapping whatever came back and hiding the mistake.
        return expectOption(next, c, 'the function given to andThen');
      },
      'Like map, for a function that itself returns an Option. No double wrapping.',
    ),

    fn(
      'filter',
      ['option', 'predicate'],
      async (a, c) => {
        const o = expectOption(arg(a, 0), c, 'filter(option)');
        if (!isSome(o)) return o;
        const p = expectFn(arg(a, 1), c, 'filter(predicate)');
        return truthy(await c.call(p, [inner(o)])) ? o : None;
      },
      'Keep the value only if a predicate says true to it.',
    ),

    fn(
      'or',
      ['option', 'other'],
      (a, c) => {
        const o = expectOption(arg(a, 0), c, 'or(option)');
        return isSome(o) ? o : expectOption(arg(a, 1), c, 'or(other)');
      },
      'This Option if it has a value, otherwise the other one.',
    ),

    fn(
      'okOr',
      ['option', 'error'],
      (a, c) => {
        const o = expectOption(arg(a, 0), c, 'okOr(option)');
        return isSome(o)
          ? enumValue('Result', 'Ok', [inner(o)])
          : enumValue('Result', 'Err', [arg(a, 1)]);
      },
      'Turn an Option into a Result, using this error for None.',
    ),

    fn(
      'toList',
      ['option'],
      (a, c) => {
        const o = expectOption(arg(a, 0), c, 'toList(option)');
        return { k: 'list', items: isSome(o) ? [inner(o)] : [] };
      },
      'A list of one element, or an empty one — so an Option can be mapped over.',
    ),
  );
}
