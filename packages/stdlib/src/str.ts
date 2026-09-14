/**
 * `std/str` — string operations. The string is always the first argument.
 *
 * **A character is a code point.** `len`, `slice`, `chars`, `reverse`,
 * `indexOf` and the three padding functions all count the same thing, which is
 * the only property that makes them usable together: `slice(s, indexOf(s, ":"))`
 * has to cut where `indexOf` pointed, and `padEnd(s, 28)` has to produce
 * something `len` calls 28 so a column lines up.
 *
 * JavaScript counts UTF-16 units instead, where an emoji is two and `"héllo"`
 * may be five or six depending on how it was typed. Every function here that
 * takes or gives a position or a width converts, because a module half of whose
 * functions count one thing and half the other is worse than either.
 *
 * What this does *not* claim to be is a grapheme cluster — `reverse` of an `e`
 * followed by a combining acute still moves the accent, and there is no
 * dependency-free way to do better. Code points are where the line is drawn,
 * and it is drawn in the same place by everything here.
 */

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
  withSignatures,
} from './support.js';

/**
 * Every function's type, in Lumen's own annotation syntax.
 *
 * `Str` throughout, because that is what this module is: there is no reading of
 * `upper(1)` that works, and until these existed the checker had no way to know
 * it. What is deliberately *not* here is as important — nothing is narrowed
 * past what the implementation actually accepts, since a signature that is
 * tighter than the code rejects a program that would have run.
 */
/**
 * Where `needle` starts in `haystack`, in code points, or `-1`.
 *
 * The host answers in UTF-16 units, and every position in this module is a code
 * point. Converting costs one pass over the prefix, which is nothing beside
 * handing back an index that means something different from the one `slice`
 * wants.
 */
function codePointIndexOf(haystack: string, needle: string): number {
  const at = haystack.indexOf(needle);
  // `-1` is not found and `0` is the same number in both counts.
  if (at <= 0) return at;
  return [...haystack.slice(0, at)].length;
}

/**
 * `s` padded to `width` code points, on one side or the other.
 *
 * Not `String.prototype.padStart`, which counts UTF-16 units: it pads `"🎉"` to
 * a width of 5 with three characters, because an emoji is two units — and
 * `len("🎉")` is 1, so the result was four characters long by this module's own
 * count. A table column built with `padEnd` came out short by one for every row
 * whose text had an emoji in it, which is a thing that is invisible until a
 * name does.
 *
 * A `fill` of more than one character is repeated and cut, which is what
 * JavaScript does and what a reader expects: `padStart("ab", 6, "xy")` is
 * `"xyxyab"` rather than `"xyxyxyab"`.
 */
function padded(s: string, width: number, fill: string, side: 'start' | 'end'): string {
  const length = [...s].length;
  const units = [...fill];
  if (units.length === 0 || length >= width) return s;
  let made = '';
  for (let i = 0; i < width - length; i += 1) made += units[i % units.length];
  return side === 'start' ? made + s : s + made;
}

const SIGNATURES: Readonly<Record<string, string>> = {
  upper: '(s: Str) -> Str',
  lower: '(s: Str) -> Str',
  trim: '(s: Str) -> Str',
  trimStart: '(s: Str) -> Str',
  trimEnd: '(s: Str) -> Str',
  capitalize: '(s: Str) -> Str',
  title: '(s: Str) -> Str',
  reverse: '(s: Str) -> Str',
  split: '(s: Str, separator: Str) -> List<Str>',
  splitOnce: '(s: Str, separator: Str) -> List<Str>',
  lines: '(s: Str) -> List<Str>',
  chars: '(s: Str) -> List<Str>',
  words: '(s: Str) -> List<Str>',
  contains: '(s: Str, needle: Str) -> Bool',
  startsWith: '(s: Str, prefix: Str) -> Bool',
  endsWith: '(s: Str, suffix: Str) -> Bool',
  isEmpty: '(s: Str) -> Bool',
  replace: '(s: Str, old: Str, new: Str) -> Str',
  // `end` defaults to nil and means "to the end", so it genuinely accepts
  // either a Num or nil — narrowing it to Num would reject a program that runs.
  slice: '(s: Str, start: Num, end: Any = nil) -> Str',
  indexOf: '(s: Str, needle: Str) -> Num',
  count: '(s: Str, needle: Str) -> Num',
  len: '(s: Str) -> Num',
  repeat: '(s: Str, count: Num) -> Str',
  padStart: '(s: Str, width: Num, fill: Str = " ") -> Str',
  padEnd: '(s: Str, width: Num, fill: Str = " ") -> Str',
  center: '(s: Str, width: Num, pad: Str = " ") -> Str',
  removePrefix: '(s: Str, prefix: Str) -> Str',
  removeSuffix: '(s: Str, suffix: Str) -> Str',
  toNum: '(s: Str) -> Result',
};

export function stdStr(): Map<string, Value> {
  return withSignatures(
    withDocs(
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

    // `old` and `new` rather than `from` and `to`, because `from` is a keyword:
    // no Lumen program could declare a parameter by that name, so the library
    // had one that could not have been written in the language it is for. They
    // are also what Python calls them, which is where most readers are arriving
    // from.
    fn('replace', ['s', 'old', 'new'], (a, c) => {
      const source = expectStr(arg(a, 0), c, 'replace(s)');
      const old = expectStr(arg(a, 1), c, 'replace old');
      const replacement = expectStr(arg(a, 2), c, 'replace new');
      return str(source.split(old).join(replacement));
    }),

    fn('slice', ['s', 'start', { name: 'end', defaultValue: { k: 'nil' } }], (a, c) => {
      const chars = [...expectStr(arg(a, 0), c, 'slice(s)')];
      const start = expectInt(arg(a, 1), c, 'slice start');
      const endValue = arg(a, 2);
      const end = endValue.k === 'nil' ? chars.length : expectInt(endValue, c, 'slice end');
      return str(chars.slice(start, end).join(''));
    }),

    /**
     * Where `needle` starts, counted in code points, or `-1`.
     *
     * The same units `slice` takes, which is the entire point: `slice(s, 0,
     * indexOf(s, ":"))` is the commonest thing anybody does with this, and
     * JavaScript's `indexOf` counts UTF-16 units. On `"🎉name: value"` it says
     * 6 where the colon is the sixth code point — so the left half came back
     * *including* the colon and the right half started a character late, both
     * silently, for any text with an emoji in it.
     */
    fn('indexOf', ['s', 'needle'], (a, c) =>
      num(
        codePointIndexOf(
          expectStr(arg(a, 0), c, 'indexOf(s)'),
          expectStr(arg(a, 1), c, 'indexOf needle'),
        ),
      ),
    ),

    fn('repeat', ['s', 'count'], (a, c) => {
      const count = expectInt(arg(a, 1), c, 'repeat count');
      if (count < 0) c.panic('repeat count must not be negative, got ' + count);
      return str(expectStr(arg(a, 0), c, 'repeat(s)').repeat(count));
    }),

    fn('padStart', ['s', 'width', { name: 'fill', defaultValue: str(' ') }], (a, c) =>
      str(
        padded(
          expectStr(arg(a, 0), c, 'padStart(s)'),
          expectInt(arg(a, 1), c, 'padStart width'),
          expectStr(arg(a, 2), c, 'padStart fill'),
          'start',
        ),
      ),
    ),

    fn('padEnd', ['s', 'width', { name: 'fill', defaultValue: str(' ') }], (a, c) =>
      str(
        padded(
          expectStr(arg(a, 0), c, 'padEnd(s)'),
          expectInt(arg(a, 1), c, 'padEnd width'),
          expectStr(arg(a, 2), c, 'padEnd fill'),
          'end',
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
      const length = [...s].length;
      if (length >= width) return str(s);
      // Left first, so an odd remainder goes on the right — which is where a
      // reader expects the extra one, and matches `"x".center(4)`.
      const left = Math.floor((width - length) / 2);
      return str(padded(padded(s, length + left, pad, 'start'), width, pad, 'end'));
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
    ),
    SIGNATURES,
  );
}
