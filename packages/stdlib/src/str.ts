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
    /** Leading whitespace removed, trailing left alone. */
    fn('trimStart', ['s'], (a, c) => str(expectStr(arg(a, 0), c, 'trimStart(s)').trimStart())),

    /** Trailing whitespace removed, leading left alone. */
    fn('trimEnd', ['s'], (a, c) => str(expectStr(arg(a, 0), c, 'trimEnd(s)').trimEnd())),

    /** First letter upper, the rest lower: `"aDA" -> "Ada"`. */
    fn('capitalize', ['s'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'capitalize(s)');
      return str(s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase());
    }),

    /** Every word capitalized: `"ada lovelace" -> "Ada Lovelace"`. */
    fn('title', ['s'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'title(s)');
      // Split on the spaces rather than around them, so the original spacing
      // survives: two spaces between words stay two spaces.
      return str(
        s
          .split(' ')
          .map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase())
          .join(' '),
      );
    }),

    /** How many times a piece of text appears, without overlaps. */
    fn('count', ['s', 'needle'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'count(s)');
      const needle = expectStr(arg(a, 1), c, 'count(needle)');
      // An empty needle matches between every character, which is a number
      // nobody wants and an infinite loop if written the obvious way.
      if (needle === '') return c.panic('count needs a non-empty needle');
      let total = 0;
      let at = s.indexOf(needle);
      while (at !== -1) {
        total += 1;
        at = s.indexOf(needle, at + needle.length);
      }
      return num(total);
    }),

    /**
     * Split at the first separator only, giving `[before, after]`.
     *
     * `"key=a=b".split("=")` gives three pieces and loses where the key ended.
     * This gives `["key", "a=b"]`. With no separator present, the whole string
     * is the first piece and the second is empty.
     */
    fn('splitOnce', ['s', 'separator'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'splitOnce(s)');
      const sep = expectStr(arg(a, 1), c, 'splitOnce(separator)');
      if (sep === '') return c.panic('splitOnce needs a non-empty separator');
      const at = s.indexOf(sep);
      if (at === -1) return list([str(s), str('')]);
      return list([str(s.slice(0, at)), str(s.slice(at + sep.length))]);
    }),

    /** The words in a string: split on runs of whitespace, with no empties. */
    fn('words', ['s'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'words(s)');
      const found = s.split(/\s+/).filter((word) => word !== '');
      return list(found.map((word) => str(word)));
    }),

    /** Padded on both sides to `width`, the extra space going on the right. */
    fn('center', ['s', 'width', { name: 'pad', defaultValue: str(' ') }], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'center(s)');
      const width = expectInt(arg(a, 1), c, 'center width');
      const pad = expectStr(arg(a, 2), c, 'center pad');
      if (pad === '') return c.panic('center needs a non-empty pad');
      if (s.length >= width) return str(s);
      const total = width - s.length;
      const left = Math.floor(total / 2);
      return str(s.padStart(s.length + left, pad).padEnd(width, pad));
    }),

    /** The text with a prefix removed, if it is there. */
    fn('removePrefix', ['s', 'prefix'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'removePrefix(s)');
      const prefix = expectStr(arg(a, 1), c, 'removePrefix(prefix)');
      return str(prefix !== '' && s.startsWith(prefix) ? s.slice(prefix.length) : s);
    }),

    /** The text with a suffix removed, if it is there. */
    fn('removeSuffix', ['s', 'suffix'], (a, c) => {
      const s = expectStr(arg(a, 0), c, 'removeSuffix(s)');
      const suffix = expectStr(arg(a, 1), c, 'removeSuffix(suffix)');
      return str(suffix !== '' && s.endsWith(suffix) ? s.slice(0, s.length - suffix.length) : s);
    }),

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
      trimStart: 'Remove whitespace from the start only.',
      trimEnd: 'Remove whitespace from the end only.',
      capitalize: 'First letter upper, the rest lower.',
      title: 'Every word capitalized.',
      count: 'How many times a piece of text appears, without overlaps.',
      splitOnce: 'Split at the first separator only, giving [before, after].',
      words: 'The words, splitting on runs of whitespace.',
      center: 'Pad both sides until the string reaches a width.',
      removePrefix: 'The text with a prefix removed, if it is there.',
      removeSuffix: 'The text with a suffix removed, if it is there.',
    },
  );
}
