/**
 * `std/regex` — regular expressions.
 *
 * A pattern is a `Str`, not a type of its own. There is no literal syntax for
 * one, deliberately: `/.../` would be ambiguous with division in a language
 * whose newlines are significant, and every escape a pattern needs would then
 * have to be understood by the lexer as well as by the matcher. A string keeps
 * the whole question in one place, and `"\\d+"` is what other languages write
 * inside a string anyway.
 *
 * **The dialect is ECMAScript**, because the host's engine is, and pretending
 * otherwise would mean either a slow matcher of our own or a translation layer
 * that is wrong in the corners. It is written down rather than left to be
 * discovered: `\d`, `\w`, `\s`, `\b`, groups, named groups `(?<name>…)`,
 * alternation, greedy and lazy quantifiers, lookahead and lookbehind, and
 * character classes all mean what they mean in JavaScript, Java, Python and
 * every other tool that borrowed from Perl.
 *
 * **Every function that takes a pattern can fail**, because a pattern comes
 * from somewhere — a config file, an argument, a user — and `(` is a perfectly
 * ordinary thing for a person to type. So the answer is a `Result` rather than
 * a panic, and a program that builds a pattern from input can say so instead
 * of stopping.
 *
 * **No backtracking guard.** `(a+)+b` against a long line of `a`s takes time
 * exponential in its length, in this engine as in most. A pattern from a
 * trusted source is fine; one from a stranger is a denial of service, and this
 * module says so rather than implying a safety it does not have.
 */

import { NIL, bool, list, map, num, str, type Value } from '@lumen-lang/core';
import {
  Err,
  None,
  Ok,
  Some,
  arg,
  expectStr,
  fn,
  moduleOf,
  withDocs,
  withSignatures,
} from './support.js';

/**
 * Build a `RegExp`, or the reason it could not be built.
 *
 * `u` is not set. It would reject patterns that work everywhere else — a bare
 * `\d` inside a class, a lone `{` — and the surprise of a pattern that is legal
 * in every other tool being refused here is worse than the surprise of `.`
 * matching half an astral character, which is what `u` buys.
 */
function compile(pattern: string, flags: string): RegExp | string {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // V8's message is `Invalid regular expression: /x(/: Unterminated group`,
    // which names the pattern twice and in a syntax nobody wrote. Keep the
    // reason and drop the framing.
    const reason = /:\s*([^:]+)$/.exec(detail);
    return '`' + pattern + '` is not a valid pattern: ' + (reason?.[1] ?? detail);
  }
}

/**
 * The three options, as the letters the engine wants.
 *
 * Named booleans rather than a flags string, because `multiline: true` says
 * what it does and `"gm"` is a thing to look up — and because `help()` then
 * lists them. They are what a regular expression is *for*, over plain string
 * work: without `multiline`, `^` matches only the very start of the text, so a
 * pattern written to find something at the beginning of each line finds it at
 * most once. That was the state this module shipped in, and it was found by
 * writing a program that needed it.
 *
 * There is no `unicode`. It would reject patterns that work in every other
 * tool — a bare `\d` inside a class, a lone `{` — and the surprise of a valid
 * pattern being refused here is worse than the surprise of `.` matching half
 * an astral character.
 */
function flagsFor(options: readonly Value[], global: boolean): string {
  const on = (value: Value | undefined): boolean => value?.k === 'bool' && value.v;
  return (
    (global ? 'g' : '') +
    (on(options[0]) ? 'i' : '') +
    (on(options[1]) ? 'm' : '') +
    (on(options[2]) ? 's' : '')
  );
}

/** The three optional parameters every pattern-taking function carries. */
const OPTIONS = [
  { name: 'ignoreCase', defaultValue: bool(false) },
  { name: 'multiline', defaultValue: bool(false) },
  { name: 'dotAll', defaultValue: bool(false) },
] as const;

/** Where those three start, for a function with `n` parameters before them. */
const optionsFrom = (args: readonly Value[], at: number): readonly Value[] =>
  [args[at], args[at + 1], args[at + 2]].map((v) => v ?? bool(false));

/**
 * One match, as a Lumen value.
 *
 * `text` is what matched, `at` is where it started, `groups` are the numbered
 * captures and `named` the named ones. A group that did not take part is `nil`
 * rather than missing, because a list whose length changes with which branch of
 * an alternation fired is a list nobody can index.
 */
function matchValue(found: RegExpExecArray): Value {
  const groups = found.slice(1).map((captured) => (captured === undefined ? NIL : str(captured)));
  const named = new Map<string, Value>();
  for (const [name, captured] of Object.entries(found.groups ?? {})) {
    named.set(name, captured === undefined ? NIL : str(captured));
  }
  return map(
    new Map<string, Value>([
      ['text', str(found[0])],
      ['at', num(found.index)],
      ['groups', list(groups)],
      ['named', map(named)],
    ]),
  );
}

/** Every match, with the zero-width guard every `g` loop needs. */
function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  re.lastIndex = 0;
  for (;;) {
    const found = re.exec(text);
    if (found === null) break;
    out.push(found);
    // A pattern that can match nothing — `a*` — returns an empty match at every
    // position and never advances `lastIndex` on its own. Without this the loop
    // never ends, which is the classic way to hang a program with a `g` flag.
    if (found[0] === '') re.lastIndex += 1;
  }
  return out;
}

const SIGNATURES: Readonly<Record<string, string>> = {
  isValid: '(pattern: Str) -> Bool',
  test: '(text: Str, pattern: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  find: '(text: Str, pattern: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  findAll: '(text: Str, pattern: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  replace: '(text: Str, pattern: Str, replacement: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  replaceFirst: '(text: Str, pattern: Str, replacement: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  split: '(text: Str, pattern: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  captures: '(text: Str, pattern: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
  escape: '(text: Str) -> Str',
  count: '(text: Str, pattern: Str, ignoreCase: Bool = false, multiline: Bool = false, dotAll: Bool = false) -> Result',
};

export function stdRegex(): Map<string, Value> {
  /** Run `body` against a compiled pattern, or answer why it would not compile. */
  const withPattern = (
    pattern: string,
    flags: string,
    body: (re: RegExp) => Value,
  ): Value => {
    const re = compile(pattern, flags);
    return typeof re === 'string' ? Err(str(re)) : Ok(body(re));
  };

  return withSignatures(
    withDocs(
      moduleOf(
        /**
         * Whether a pattern compiles, without matching anything with it.
         *
         * A Bool rather than a Result, because "is this a pattern" cannot
         * itself fail. It is what a program validating a config file wants
         * before it stores one.
         */
        fn('isValid', ['pattern'], (a, c) =>
          bool(typeof compile(expectStr(arg(a, 0), c, 'isValid(pattern)'), '') !== 'string'),
        ),

        fn('test', ['text', 'pattern', ...OPTIONS], (a, c) =>
          withPattern(
            expectStr(arg(a, 1), c, 'test(pattern)'),
            flagsFor(optionsFrom(a, 2), false),
            (re) => bool(re.test(expectStr(arg(a, 0), c, 'test(text)'))),
          ),
        ),

        /** The first match, as `Some(match)`, or `None`. */
        fn('find', ['text', 'pattern', ...OPTIONS], (a, c) =>
          withPattern(
            expectStr(arg(a, 1), c, 'find(pattern)'),
            flagsFor(optionsFrom(a, 2), false),
            (re) => {
              const found = re.exec(expectStr(arg(a, 0), c, 'find(text)'));
              return found === null ? None : Some(matchValue(found));
            },
          ),
        ),

        /** Every match, as a list — empty when there are none. */
        fn('findAll', ['text', 'pattern', ...OPTIONS], (a, c) =>
          withPattern(
            expectStr(arg(a, 1), c, 'findAll(pattern)'),
            flagsFor(optionsFrom(a, 2), true),
            (re) => list(allMatches(re, expectStr(arg(a, 0), c, 'findAll(text)')).map(matchValue)),
          ),
        ),

        /** How many times a pattern matches. */
        fn('count', ['text', 'pattern', ...OPTIONS], (a, c) =>
          withPattern(
            expectStr(arg(a, 1), c, 'count(pattern)'),
            flagsFor(optionsFrom(a, 2), true),
            (re) => num(allMatches(re, expectStr(arg(a, 0), c, 'count(text)')).length),
          ),
        ),

        /**
         * Just the captured groups of the first match.
         *
         * `Some([a, b])` or `None`, which is the shape a program destructuring
         * a match actually wants: `match captures(line, "(\\d+)-(\\d+)") { … }`
         * reads as the question being asked, where reaching into a match map
         * for `groups` does not.
         */
        fn('captures', ['text', 'pattern', ...OPTIONS], (a, c) =>
          withPattern(
            expectStr(arg(a, 1), c, 'captures(pattern)'),
            flagsFor(optionsFrom(a, 2), false),
            (re) => {
              const found = re.exec(expectStr(arg(a, 0), c, 'captures(text)'));
              if (found === null) return None;
              return Some(
                list(found.slice(1).map((captured) => (captured === undefined ? NIL : str(captured)))),
              );
            },
          ),
        ),

        /**
         * Replace every match.
         *
         * `$1` and `$<name>` in the replacement are the captured groups, and
         * `$$` is a literal dollar — the same spelling as everywhere else.
         */
        fn(
          'replace',
          ['text', 'pattern', 'replacement', ...OPTIONS],
          (a, c) =>
            withPattern(
              expectStr(arg(a, 1), c, 'replace(pattern)'),
              flagsFor(optionsFrom(a, 3), true),
              (re) =>
                str(
                  expectStr(arg(a, 0), c, 'replace(text)').replace(
                    re,
                    expectStr(arg(a, 2), c, 'replace(replacement)'),
                  ),
                ),
            ),
        ),

        /** Replace only the first match. */
        fn(
          'replaceFirst',
          ['text', 'pattern', 'replacement', ...OPTIONS],
          (a, c) =>
            withPattern(
              expectStr(arg(a, 1), c, 'replaceFirst(pattern)'),
              flagsFor(optionsFrom(a, 3), false),
              (re) =>
                str(
                  expectStr(arg(a, 0), c, 'replaceFirst(text)').replace(
                    re,
                    expectStr(arg(a, 2), c, 'replaceFirst(replacement)'),
                  ),
                ),
            ),
        ),

        /** Split on a pattern, the way `std/str.split` splits on fixed text. */
        fn('split', ['text', 'pattern', ...OPTIONS], (a, c) =>
          withPattern(
            expectStr(arg(a, 1), c, 'split(pattern)'),
            flagsFor(optionsFrom(a, 2), false),
            (re) =>
              list(
                expectStr(arg(a, 0), c, 'split(text)')
                  .split(re)
                  .map((piece) => (piece === undefined ? str('') : str(piece))),
              ),
          ),
        ),

        /**
         * Text with every pattern character escaped, so it matches literally.
         *
         * What you need when a pattern is built from something a person typed:
         * searching for `a.b` should find `a.b` and not `axb`, and remembering
         * which of `.^$*+?()[]{}|\\/` needs a backslash is not a thing to do by
         * hand at every call site.
         */
        fn('escape', ['text'], (a, c) =>
          str(expectStr(arg(a, 0), c, 'escape(text)').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
        ),
      ),
      {
        isValid: 'True if the pattern compiles. Asking cannot itself fail.',
        test: 'True if the pattern matches anywhere in the text.',
        find: 'The first match. Some(match) with text, at, groups and named — or None.',
        findAll: 'Every match, as a list. Empty if there are none.',
        count: 'How many times the pattern matches.',
        captures: 'The captured groups of the first match. Some([…]) or None.',
        replace: 'Replace every match. $1 and $<name> are the captured groups.',
        replaceFirst: 'Replace only the first match.',
        split: 'Split the text wherever the pattern matches.',
        escape: 'Escape every pattern character, so the text matches literally.',
      },
    ),
    SIGNATURES,
  );
}
