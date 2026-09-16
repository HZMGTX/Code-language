/**
 * `inspect` against the lexer that has to read it back.
 *
 * `inspect`'s own comment states its contract — "print a value the way you
 * would write it" — and that is a property, not a matter of taste: the text it
 * produces should lex back to the value it was given. It is what the REPL
 * shows, what `print` shows for anything inside a collection, and what a person
 * copies out of a log and pastes into a program.
 *
 * Checking it by reading the output is how it stayed broken. `inspect` used
 * `JSON.stringify` for strings, which escapes for a *different* language:
 *
 *   - `"${name}"` came out as `"${name}"`, which Lumen reads as an
 *     interpolation of `name` — a different value, silently.
 *   - a control character came out as JSON's `\u0000` spelling, and Lumen
 *     spells unicode escapes `\u{0}`, so the text did not lex at all.
 *   - `\b` and `\f` are JSON escapes that Lumen does not have.
 *
 * And `Map` keys were concatenated raw, so `{"a-b": 1}` rendered as
 * `{a-b: 1}` — a subtraction — while a key containing a newline broke the
 * rendering across lines. A `Map` key is an arbitrary string, and
 * `std/csv.records`, `std/json.parse` and `std/web.form` all build maps whose
 * keys somebody else chose.
 *
 * So the test lexes the output rather than looking at it.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { inspect, lex, list, map, num, str, type Value } from '@lumen-lang/core';

/**
 * The string a single string literal lexes to.
 *
 * The real lexer, so this cannot drift from what the language accepts. A token
 * stream of anything other than one string and an end marker means `inspect`
 * produced something that is not a single string literal, which is a failure in
 * itself.
 */
function lexBack(source: string): string {
  const tokens = [...lex(source, '<inspect>')];
  assert.equal(
    tokens.length,
    2,
    'not one literal: ' + source + ' -> ' + tokens.map((t) => t.kind).join(' '),
  );
  const [first] = tokens;
  // `string`, not `template`. That distinction is the whole `${` half of this:
  // an unescaped interpolation marker makes the lexer produce a `template`
  // token, which is a different kind of thing entirely — source that computes
  // a value rather than source that is one.
  assert.equal(first?.kind, 'string', 'not a plain string literal: ' + source);
  assert.equal(tokens[1]?.kind, 'eof', 'trailing tokens after the literal: ' + source);
  return first?.str as string;
}

/**
 * One character from its code point.
 *
 * Every awkward character in the list below is built rather than written as a
 * source escape, because a formatter that "helpfully" resolves `\u0000` leaves
 * a raw NUL byte in this file — which happened once already.
 */
const ch = (code: number): string => String.fromCodePoint(code);

/** The strings worth trying: every escape, and every near-miss. */
const STRINGS = [
  '',
  'plain',
  'with "quotes"',
  'with \\ backslash',
  'ends with backslash \\',
  'with\nnewline',
  'with\ttab',
  'with\rcarriage return',
  'with\r\nboth',
  // Lumen's own escape, and the one JSON.stringify does not know about.
  '${name}',
  'a ${b} c ${d}',
  '$ bare',
  '$x not a brace',
  '$',
  '${',
  '\\${escaped already}',
  '}{',
  // Control characters. JSON spells these \u0000 and \b; Lumen spells the
  // first \u{0} and has no \b at all. Built with `String.fromCharCode` rather
  // than written as source escapes, so that no formatter can normalise them
  // into raw control bytes sitting in this file.
  ch(0),
  'nul:' + ch(0) + 'end',
  ch(8) + 'backspace',
  ch(12) + 'form feed',
  ch(27) + '[31mANSI' + ch(27) + '[0m',
  ch(0x7f),
  // Beyond the BMP, and a combining mark that is a second code point.
  ch(0x1f389),
  'a' + ch(0x1f389) + 'b',
  'e' + ch(0x301),
  ch(0xe9),
  // Line and paragraph separators, which some engines escape and some do not.
  ch(0x2028),
  ch(0x2029),
  // A lone surrogate, which a regex without the `u` flag can hand back.
  ch(0xd83c),
  'before' + ch(0xd83c) + 'after',
];

describe('inspect reads back as what it was given', () => {
  it('round-trips every string through the real lexer', () => {
    for (const text of STRINGS) {
      const source = inspect(str(text));
      assert.equal(
        lexBack(source),
        text,
        'inspect(' + JSON.stringify(text) + ') was ' + source + ', which lexes to something else',
      );
    }
  });

  it('never leaves a raw control character in its output', () => {
    // Separate from the round trip because a raw control character can survive
    // one — the lexer accepts it — while still making a log line unreadable and
    // an editor show a replacement glyph.
    for (const text of STRINGS) {
      const source = inspect(str(text));
      for (const ch of source) {
        const code = ch.codePointAt(0) as number;
        assert.ok(
          code >= 0x20 || code === 0x09,
          'inspect(' + JSON.stringify(text) + ') left a raw U+' +
            code.toString(16).padStart(4, '0') + ' in its output',
        );
      }
    }
  });

  it('escapes the interpolation marker, and only where it matters', () => {
    // A bare `$` needs nothing, and escaping every one of them would make every
    // price and every shell snippet harder to read for no gain.
    assert.equal(inspect(str('${name}')), '"\\${name}"');
    assert.equal(inspect(str('$5.00')), '"$5.00"');
    assert.equal(inspect(str('$x')), '"$x"');
  });

  it('writes a Map key bare only when it is a name', () => {
    const entries = new Map<string, Value>([
      ['plain', num(1)],
      ['_leading', num(2)],
      ['with2digits', num(3)],
      ['a-b', num(4)],
      ['has space', num(5)],
      ['', num(6)],
      ['with"quote', num(7)],
      ['with\nnewline', num(8)],
      ['9leading', num(9)],
      ['${interp}', num(10)],
    ]);
    assert.equal(
      inspect(map(entries)),
      '{plain: 1, _leading: 2, with2digits: 3, "a-b": 4, "has space": 5, "": 6, ' +
        '"with\\"quote": 7, "with\\nnewline": 8, "9leading": 9, "\\${interp}": 10}',
    );
  });

  it('keeps quoting nested values, which is why keys had to be quoted too', () => {
    // A list element was always quoted — `[1, "a"]`, not `[1, a]` — so a key
    // that was not made one function answer the same question two ways.
    assert.equal(inspect(list([num(1), str('a')])), '[1, "a"]');
  });
});
