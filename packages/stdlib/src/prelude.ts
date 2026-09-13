/**
 * The prelude: what is available with no import at all.
 *
 * The guiding question was "what does a beginner reach for in the first hour?".
 * In v0.1 even `map`, `filter` and `sum` needed an import, which is a lot of
 * ceremony before you have done anything. These are the functions that earn
 * their place in every file.
 *
 * Most are the standard-library functions re-exported under the name a Python
 * programmer would reach for, so there is one implementation, not two.
 */

import {
  NIL,
  bool,
  list,
  num,
  str,
  truthy,
  type CallCtx,
  type NativeValue,
  type Value,
  inspect,
  typeName,
} from '@lumen-lang/core';

import { stdList } from './list.js';
import { stdMath } from './math.js';
import { stdOption } from './option.js';
import { stdResult } from './result.js';
import { stdStr } from './str.js';
import { stdMap } from './map.js';
import { None, Some, arg, expectInt, fn } from './support.js';
import { STD_MODULES, STD_MODULE_NAMES } from './modules.js';

/** Pull one native out of a module table. */
function take(module: Map<string, Value>, name: string): NativeValue {
  const found = module.get(name);
  if (found === undefined || found.k !== 'native') {
    throw new Error('prelude: std module has no native named ' + name);
  }
  return found;
}

/** Re-export a standard-library function under a different prelude name. */
function alias(source: NativeValue, name: string, doc: string): NativeValue {
  return { ...source, name, doc };
}

/**
 * Reduce over either a single list or the arguments themselves, so that both
 * `min([3, 1, 2])` and `min(3, 1, 2)` work — Python accepts both, and guessing
 * wrong about which one a beginner meant is a bad first experience.
 */
function extremum(which: 'min' | 'max') {
  return (args: readonly Value[], ctx: CallCtx): Value => {
    const first = args[0] ?? NIL;
    const items = args.length === 1 && first.k === 'list' ? first.items : args;
    if (items.length === 0) {
      return ctx.panic(which + '() needs at least one value', [
        'it takes either a list, as ' + which + '([1, 2, 3]), or several numbers',
      ]);
    }
    let best: number | undefined;
    for (const item of items) {
      if (item.k !== 'num') {
        return ctx.panic(which + '() needs Nums, found ' + typeName(item));
      }
      if (best === undefined) best = item.v;
      else best = which === 'min' ? Math.min(best, item.v) : Math.max(best, item.v);
    }
    return num(best ?? 0);
  };
}

/** Render a function's signature the way it would be written in Lumen. */
function signatureOf(value: NativeValue): string {
  if (value.variadic === true) return value.name + '(...)';
  const params = value.params
    .map((p) => (p.defaultValue === undefined ? p.name : p.name + ' = ...'))
    .join(', ');
  return value.name + '(' + params + ')';
}

/**
 * Everything the prelude adds beyond the language's own built-ins.
 * `installPrelude` declares these as globals.
 */
export function preludeExtras(): Map<string, Value> {
  const L = stdList();
  const M = stdMath();
  const S = stdStr();

  const extras = new Map<string, Value>();
  const define = (value: NativeValue): void => {
    extras.set(value.name, value);
  };

  // --- sequences -------------------------------------------------------------
  define(alias(take(L, 'map'), 'map', 'Apply a function to every element, giving a new list.'));
  define(alias(take(L, 'filter'), 'filter', 'Keep the elements a predicate says true to.'));
  define(alias(take(L, 'reduce'), 'reduce', 'Fold a list down to a single value.'));
  define(alias(take(L, 'sum'), 'sum', 'Add up a list of numbers.'));
  define(alias(take(L, 'sort'), 'sorted', 'A sorted copy of a list. The original is untouched.'));
  define(alias(take(L, 'reverse'), 'reversed', 'A reversed copy of a list.'));
  define(alias(take(L, 'enumerate'), 'enumerate', 'Pair each element with its index: [[0, a], [1, b]]. Pass start: 1 to count from one.'));
  define(alias(take(L, 'zip'), 'zip', 'Pair up two lists, stopping at the shorter one.'));
  define(alias(take(L, 'any'), 'any', 'True if any element is truthy, or matches the predicate if one is given.'));
  define(alias(take(L, 'all'), 'all', 'True if every element is truthy, or matches the predicate if one is given.'));

  // --- numbers ---------------------------------------------------------------
  define(alias(take(M, 'abs'), 'abs', 'Distance from zero.'));
  define(alias(take(M, 'round'), 'round', 'Round to the nearest whole number.'));
  define(alias(take(M, 'floor'), 'floor', 'Round down to a whole number.'));
  define(alias(take(M, 'ceil'), 'ceil', 'Round up to a whole number.'));
  define(alias(take(M, 'fixed'), 'fixed', 'A number as text with a fixed number of decimals: fixed(4.5, 2) is "4.50".'));

  define({
    k: 'native',
    name: 'min',
    params: [],
    variadic: true,
    doc: 'The smallest of a list, or of the numbers given.',
    call: extremum('min'),
  });
  define({
    k: 'native',
    name: 'max',
    params: [],
    variadic: true,
    doc: 'The largest of a list, or of the numbers given.',
    call: extremum('max'),
  });

  // --- strings ---------------------------------------------------------------
  define(alias(take(S, 'split'), 'split', 'Split a string on a separator, giving a list.'));
  define(alias(take(L, 'join'), 'join', 'Join a list into a string with a separator.'));

  // --- ranges ----------------------------------------------------------------
  define(
    fn(
      'range',
      ['start', { name: 'end', defaultValue: NIL }, { name: 'step', defaultValue: num(1) }],
      (a, c) => {
        // range(n) counts from 0; range(a, b) counts from a. Same as Python.
        const first = expectInt(arg(a, 0), c, 'range start');
        const endValue = arg(a, 1);
        const [from, to] =
          endValue.k === 'nil' ? [0, first] : [first, expectInt(endValue, c, 'range end')];
        const step = expectInt(arg(a, 2), c, 'range step');
        if (step === 0) return c.panic('range() step cannot be 0');

        const size = step > 0 ? Math.ceil((to - from) / step) : Math.ceil((from - to) / -step);
        if (size > 10_000_000) {
          return c.panic('range() of ' + size + ' elements is too large', [
            'ranges are built as lists; use a `while` loop for very large spans',
          ]);
        }
        const items: Value[] = [];
        if (step > 0) for (let i = from; i < to; i += step) items.push(num(i));
        else for (let i = from; i > to; i += step) items.push(num(i));
        return list(items);
      },
      'A list of numbers: range(5), range(2, 6), or range(10, 0, -2).',
    ),
  );

  // --- console ---------------------------------------------------------------
  define(
    fn(
      'input',
      [{ name: 'prompt', defaultValue: str('') }],
      async (a, c) => {
        const prompt = arg(a, 0);
        const text = prompt.k === 'str' ? prompt.v : '';
        if (c.host.readLine === undefined) {
          return c.panic('input() is not available here', [
            'this host has no console; input() needs an interactive terminal',
          ]);
        }
        const line = await c.host.readLine(text);
        return line === undefined ? None : Some(str(line));
      },
      'Read one line from the console. Some(text), or None at end of input.',
    ),
  );

  return extras;
}

/**
 * `help()` — the thing you reach for when you have forgotten a name.
 *
 * With no argument it lists what is available. Given a function it shows the
 * signature and description. Given any other value it shows the type and the
 * methods you can call on it, which is the question you usually actually have.
 */
function makeHelp(methodsOf: (type: string) => string[], preludeNames: () => string[]): NativeValue {
  return fn(
    'help',
    [{ name: 'subject', defaultValue: NIL }],
    (a, c) => {
      const subject = arg(a, 0);
      const out: string[] = [];

      if (subject.k === 'nil') {
        out.push('Lumen help');
        out.push('');
        out.push('  help(x)          describe a value, a function, or a type');
        out.push('  help("std/list") list what a module provides');
        out.push('');
        out.push('Available everywhere, with no import:');
        out.push('  ' + preludeNames().sort().join(', '));
        out.push('');
        out.push('Modules you can import:');
        out.push('  ' + STD_MODULE_NAMES.join(', '));
        c.host.writeOut(out.join('\n') + '\n');
        return NIL;
      }

      if (subject.k === 'native') {
        out.push(signatureOf(subject));
        if (subject.doc !== undefined) out.push('  ' + subject.doc);
        c.host.writeOut(out.join('\n') + '\n');
        return NIL;
      }

      if (subject.k === 'fn') {
        const params = subject.params
          .map((p) => (p.rest ? '..' : '') + p.name + (p.defaultValue === undefined ? '' : ' = ...'))
          .join(', ');
        out.push(subject.name === '' ? 'fn(' + params + ')' : subject.name + '(' + params + ')');
        out.push('  defined in Lumen');
        c.host.writeOut(out.join('\n') + '\n');
        return NIL;
      }

      if (subject.k === 'module') {
        out.push('module with ' + subject.exports.size + ' functions:');
        out.push('  ' + [...subject.exports.keys()].sort().join(', '));
        c.host.writeOut(out.join('\n') + '\n');
        return NIL;
      }

      // A module path given as a string, e.g. help("std/list").
      if (subject.k === 'str' && STD_MODULE_NAMES.includes(subject.v)) {
        const factory = STD_MODULES.get(subject.v);
        out.push(subject.v);
        out.push('  import { ... } from "' + subject.v + '"');
        if (factory !== undefined) {
          out.push('  ' + [...factory().keys()].sort().join(', '));
        }
        c.host.writeOut(out.join('\n') + '\n');
        return NIL;
      }

      const type = typeName(subject);
      out.push(type + ': ' + inspect(subject));
      const methods = methodsOf(type);
      if (methods.length > 0) {
        out.push('');
        out.push('methods you can call on it:');
        out.push('  ' + methods.sort().join(', '));
      }
      c.host.writeOut(out.join('\n') + '\n');
      return NIL;
    },
    'Describe a value, a function, or a module. Call help() alone for an overview.',
  );
}

/**
 * Which standard module supplies the methods for each built-in type.
 *
 * A few functions are also registered under the name a Python programmer would
 * reach for. Two names for one function is a small cost; making someone guess
 * which of `sort` and `sorted` this language chose is a larger one.
 */
/**
 * The `std/math` functions whose first parameter is the number itself, which
 * is what makes `n.round()` and `2.pow(10)` mean anything.
 *
 * Listed rather than taken wholesale: `random()` takes no number at all, and
 * `PI` and `E` are values, so neither belongs on a receiver.
 */
const NUM_METHODS = [
  'abs', 'acos', 'asin', 'atan', 'atan2', 'cbrt', 'ceil', 'clamp', 'cos', 'exp',
  'fixed', 'floor', 'gcd', 'hypot', 'lcm', 'log', 'max', 'min', 'pow', 'round',
  'sign', 'sin', 'sqrt', 'tan', 'trunc',
];

/**
 * The functions that are methods on every value.
 *
 * Their subject is any value at all, so there is no type to attach them to and
 * no reason to leave them off one. `"${n}"` covers most of what `str` is for,
 * but a chain like `n.str().padStart(3)` has nowhere to put the interpolation,
 * and `p.str()` on a struct had no spelling at all.
 *
 * Deliberately short. This is not a general fallback to whatever is in scope —
 * see `registerUniversalMethods` for why that would be a worse error message
 * rather than a better language.
 */
export const UNIVERSAL_METHODS: readonly string[] = ['str', 'inspect', 'type', 'clone', 'isNil'];

/**
 * The universal methods, resolved through `lookup`.
 *
 * `lookup` rather than a fixed import because these do not all live in one
 * place: `str` and `type` are core builtins installed straight into the globals,
 * while `inspect`, `clone` and `isNil` are exports of `std/core` that the prelude
 * deliberately does not put in scope. Taking a lookup lets the caller search
 * both, and means a name that moves between the two homes keeps working.
 *
 * A name that resolves to nothing is skipped rather than faked, so this cannot
 * be the thing that breaks if one is ever removed.
 */
export function universalMethods(lookup: (name: string) => Value | undefined): Map<string, Value> {
  const out = new Map<string, Value>();
  for (const name of UNIVERSAL_METHODS) {
    const found = lookup(name);
    if (found !== undefined && (found.k === 'native' || found.k === 'fn')) out.set(name, found);
  }
  return out;
}

export function methodTables(): Record<string, Map<string, Value>> {
  const listMethods = stdList();
  const sort = listMethods.get('sort');
  const reverse = listMethods.get('reverse');
  if (sort !== undefined) listMethods.set('sorted', sort);
  if (reverse !== undefined) listMethods.set('reversed', reverse);

  const math = stdMath();
  const numMethods = new Map<string, Value>();
  for (const name of NUM_METHODS) {
    const found = math.get(name);
    if (found !== undefined) numMethods.set(name, found);
  }

  return {
    Str: stdStr(),
    List: listMethods,
    Map: stdMap(),
    Num: numMethods,
    // `Option` and `Result` are the type names `type()` reports for the two
    // prelude enums, which is what method lookup dispatches on.
    Option: stdOption(),
    Result: stdResult(),
  };
}

export { makeHelp, signatureOf };
