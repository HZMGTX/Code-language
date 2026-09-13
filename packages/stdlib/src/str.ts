/** `std/str` — string operations. The string is always the first argument. */

import { bool, list, num, str, type Value } from '@lumen-lang/core';
import {
  Err,
  Ok,
  arg,
  expectInt,
  expectStr,
  fn,
  moduleOf,
  withDocs,
} from './support.js';

export function stdStr(): Map<string, Value> {
  return withDocs(
    moduleOf(
    fn('upper', ['s'], (a, c) => str(expectStr(arg(a, 0), c, 'upper(s)').toUpperCase())),
    fn('lower', ['s'], (a, c) => str(expectStr(arg(a, 0), c, 'lower(s)').toLowerCase())),
    fn('trim', ['s'], (a, c) => str(expectStr(arg(a, 0), c, 'trim(s)').trim())),

    fn('split', ['s', 'separator'], (a, c) => {
      const source = expectStr(arg(a, 0), c, 'split(s)');
      const sep = expectStr(arg(a, 1), c, 'split separator');
      return list(source.split(sep).map((part) => str(part)));
    }),

    fn('lines', ['s'], (a, c) =>
      list(expectStr(arg(a, 0), c, 'lines(s)').split(/\r?\n/).map((l) => str(l))),
    ),

    fn('chars', ['s'], (a, c) =>
      list([...expectStr(arg(a, 0), c, 'chars(s)')].map((ch) => str(ch))),
    ),

    fn('contains', ['s', 'needle'], (a, c) =>
      bool(expectStr(arg(a, 0), c, 'contains(s)').includes(expectStr(arg(a, 1), c, 'contains needle'))),
    ),

    fn('startsWith', ['s', 'prefix'], (a, c) =>
      bool(expectStr(arg(a, 0), c, 'startsWith(s)').startsWith(expectStr(arg(a, 1), c, 'prefix'))),
    ),

    fn('endsWith', ['s', 'suffix'], (a, c) =>
      bool(expectStr(arg(a, 0), c, 'endsWith(s)').endsWith(expectStr(arg(a, 1), c, 'suffix'))),
    ),

    fn('replace', ['s', 'from', 'to'], (a, c) => {
      const source = expectStr(arg(a, 0), c, 'replace(s)');
      const from = expectStr(arg(a, 1), c, 'replace from');
      const to = expectStr(arg(a, 2), c, 'replace to');
      return str(source.split(from).join(to));
    }),

    fn('slice', ['s', 'start', { name: 'end', defaultValue: { k: 'nil' } }], (a, c) => {
      const chars = [...expectStr(arg(a, 0), c, 'slice(s)')];
      const start = expectInt(arg(a, 1), c, 'slice start');
      const endValue = arg(a, 2);
      const end = endValue.k === 'nil' ? chars.length : expectInt(endValue, c, 'slice end');
      return str(chars.slice(start, end).join(''));
    }),

    fn('indexOf', ['s', 'needle'], (a, c) =>
      num(expectStr(arg(a, 0), c, 'indexOf(s)').indexOf(expectStr(arg(a, 1), c, 'indexOf needle'))),
    ),

    fn('repeat', ['s', 'count'], (a, c) => {
      const count = expectInt(arg(a, 1), c, 'repeat count');
      if (count < 0) c.panic('repeat count must not be negative, got ' + count);
      return str(expectStr(arg(a, 0), c, 'repeat(s)').repeat(count));
    }),

    fn('padStart', ['s', 'width', { name: 'fill', defaultValue: str(' ') }], (a, c) =>
      str(
        expectStr(arg(a, 0), c, 'padStart(s)').padStart(
          expectInt(arg(a, 1), c, 'padStart width'),
          expectStr(arg(a, 2), c, 'padStart fill'),
        ),
      ),
    ),

    fn('padEnd', ['s', 'width', { name: 'fill', defaultValue: str(' ') }], (a, c) =>
      str(
        expectStr(arg(a, 0), c, 'padEnd(s)').padEnd(
          expectInt(arg(a, 1), c, 'padEnd width'),
          expectStr(arg(a, 2), c, 'padEnd fill'),
        ),
      ),
    ),

    fn('reverse', ['s'], (a, c) => str([...expectStr(arg(a, 0), c, 'reverse(s)')].reverse().join(''))),

    fn('len', ['s'], (a, c) => num([...expectStr(arg(a, 0), c, 'len(s)')].length)),

    fn('isEmpty', ['s'], (a, c) => bool(expectStr(arg(a, 0), c, 'isEmpty(s)').length === 0)),

    /** Parse a number, as a Result so failure is explicit rather than silent. */
    fn('toNum', ['s'], (a, c) => {
      const text = expectStr(arg(a, 0), c, 'toNum(s)').trim();
      const parsed = Number(text);
      if (text === '' || Number.isNaN(parsed)) return Err(str('`' + text + '` is not a number'));
      return Ok(num(parsed));
    }),
    ),
    {
      upper: 'Uppercase a string.',
      lower: 'Lowercase a string.',
      trim: 'Remove whitespace from both ends.',
      split: 'Split on a separator, giving a list of pieces.',
      lines: 'Split into a list of lines.',
      chars: 'Split into a list of single characters.',
      contains: 'True if the needle appears anywhere inside.',
      startsWith: 'True if the string begins with this prefix.',
      endsWith: 'True if the string ends with this suffix.',
      replace: 'Replace every occurrence of one piece of text with another.',
      slice: 'The characters from start up to (not including) end.',
      indexOf: 'Where the needle first appears, or -1 if it never does.',
      repeat: 'The string repeated a number of times.',
      padStart: 'Pad on the left until the string reaches a width.',
      padEnd: 'Pad on the right until the string reaches a width.',
      reverse: 'The characters in the opposite order.',
      len: 'How many characters the string has.',
      isEmpty: 'True if the string has no characters.',
      toNum: 'Parse as a number. Ok(n), or Err if it is not one.',
    },
  );
}
