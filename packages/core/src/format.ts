/**
 * `lumen fmt` — put every line at least as far in as its brackets require.
 *
 * ## What it does, and what it deliberately does not
 *
 * It rewrites **leading whitespace** and nothing else: indentation, trailing
 * whitespace removed, runs of blank lines collapsed to one, exactly one newline
 * at the end of the file.
 *
 * It does **not** touch spacing inside a line, and it does **not** move line
 * breaks. Newlines end statements in Lumen, so moving one changes what the
 * program means; and code in the wild aligns things on purpose —
 *
 *     x if x % 15 == 0 => "FizzBuzz",
 *     x if x % 3 == 0  => "Fizz",
 *
 * — which a formatter that collapsed every run of spaces would destroy.
 *
 * ## Column alignment is recognised, not overruled
 *
 * A line further in than its brackets require is usually a mistake, and gets
 * pulled back. But sometimes it is a decision:
 *
 *     let a = [[1, 2, 3],
 *              [4, 5, 6]]
 *
 * The difference is that the second row starts at exactly the column where the
 * first row starts — it is lined up with it, and lining things up is the whole
 * point. So an over-indented line is left alone when, and only when, its
 * indentation lands on the column of the enclosing bracket's first element.
 *
 * The column is read from the input but emitted against the output, because the
 * opening line may itself have moved. A row aligned under a `[[` on a line that
 * is about to be pulled back two spaces has to move with it, or the second pass
 * would see a line aligned to nothing and pull it back further — a formatter
 * whose output depends on how many times it has run.
 *
 * A bracket only offers a column when something follows it on the same line,
 * because that is what there is to line up with. `import { upper, lower,` and
 * `let a = [[1, 2,` do; `fn f() {` does not, so a block body indented eight
 * spaces has nothing to be aligned to and is brought back to two — which is
 * the case a formatter exists to fix. That one test replaces any guessing about
 * what a brace is for: a block brace ends its line, a list brace does not.
 *
 * ## Depth counts lines, not brackets
 *
 * `print(match c {` opens two brackets, and its body belongs one level in, not
 * two — which is what anyone writing it by hand does. So every bracket a line
 * leaves open shares one level: the line's own indent plus one.
 *
 * That is why this is a stack rather than a counter. Each open bracket
 * remembers the indent of the line that opened it, so closing it returns to
 * exactly that line's level however the brackets were distributed:
 *
 *     let rooms = {
 *       hall: Room {
 *         name: "Hall",
 *         blurb: "Dusty." },     ← closes the `Room {` opened two lines up
 *       library: Room {          ← so this is back at the map's level
 *
 * A counter cannot do that, because the `}` here is not at the start of its
 * line: there is no way to know how far to come back out without remembering
 * where the bracket was opened.
 *
 * ## Lines it leaves alone entirely
 *
 * A line whose start is inside a multi-line string, an interpolation or a block
 * comment is emitted byte for byte. Re-indenting one of those would change a
 * value or a comment's text rather than its presentation — the one way a
 * whitespace-only formatter could still be wrong.
 *
 * Three invariants, all tested against every Lumen file in the repository:
 * formatting changes only whitespace; the token stream is unchanged; and
 * formatting twice is formatting once.
 */

import { lexWithComments } from './lexer.js';
import type { Comment, Token } from './token.js';

/** Two spaces per level, matching the examples and the specification. */
const INDENT = '  ';

/** Runs of blank lines longer than this collapse. One blank line is a paragraph. */
const MAX_BLANK_RUN = 1;

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
/** A line beginning with one of these continues the one before it. */
const CONTINUERS = new Set(['.', '?.', '|>']);

/** One bracket, and the column a line aligning under it would start at. */
interface Bracket {
  readonly opens: boolean;
  /**
   * For an opener with something after it on the same line, the column that
   * first element starts at — where a continuation line lining up with it
   * would begin. `-1` when there is nothing to line up with.
   */
  readonly column: number;
}

interface LineShape {
  /** Every bracket on the line, in order. */
  brackets: Bracket[];
  /** How many of those are closers at the very start of the line. */
  leadingClosers: number;
  /** True when the first token continues the previous line. */
  continuation: boolean;
  /** True when the line has no tokens or comments on it. */
  blank: boolean;
  /** True when the line begins inside a multi-line token and must not be touched. */
  verbatim: boolean;
}

/** What each line does to the bracket structure, read from tokens rather than text. */
function shapes(source: string, tokens: readonly Token[], comments: readonly Comment[]): LineShape[] {
  const count = source.split('\n').length;
  const out: LineShape[] = Array.from({ length: count }, () => ({
    brackets: [],
    leadingClosers: 0,
    continuation: false,
    blank: true,
    verbatim: false,
  }));

  const at = (line: number): LineShape | undefined => out[line];
  // Offsets rather than `col`, so the column is unambiguous about its base.
  const lineStart: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStart.push(i + 1);
  }
  // Newlines and EOF say nothing about brackets, and dropping them here makes
  // "the token after this one" mean the next thing on the line.
  const code = tokens.filter((t) => t.kind !== 'eof' && t.kind !== 'newline');
  const seenToken = new Array<boolean>(count).fill(false);
  /** Whether every code token so far on a line has been a closing bracket. */
  const onlyClosers = new Array<boolean>(count).fill(true);

  /** Every line after a multi-line span's first belongs to that span. */
  const markSpanned = (from: number, to: number): void => {
    for (let l = from + 1; l <= to && l < count; l += 1) {
      const shape = at(l);
      if (shape !== undefined) shape.verbatim = true;
    }
  };

  for (const c of comments) {
    const from = c.span.start.line - 1;
    const shape = at(from);
    if (shape !== undefined) shape.blank = false;
    if (c.block) markSpanned(from, c.span.end.line - 1);
  }

  for (let index = 0; index < code.length; index += 1) {
    const token = code[index];
    if (token === undefined) continue;
    const line = token.span.start.line - 1;
    const shape = at(line);
    if (shape === undefined) continue;

    shape.blank = false;
    const first = !(seenToken[line] ?? false);
    seenToken[line] = true;

    if (CONTINUERS.has(token.kind) && first) shape.continuation = true;
    if (OPENERS.has(token.kind)) {
      // A line lines up with the opener's first element, not with the bracket:
      // `import { upper,` has a space after the brace, so the column to match
      // is where `upper` starts. An opener that ends its line has no element,
      // and so offers no column at all.
      const next = code[index + 1];
      const sameLine = next !== undefined && next.span.start.line - 1 === line;
      shape.brackets.push({
        opens: true,
        column: sameLine ? next.span.start.offset - (lineStart[line] ?? 0) : -1,
      });
      onlyClosers[line] = false;
    } else if (CLOSERS.has(token.kind)) {
      shape.brackets.push({ opens: false, column: -1 });
      // `})` at the start of a line pulls out twice; the `)` in `f(x)` pulls out
      // nothing, because code came first. So a closer counts as leading only
      // while nothing but closers has been seen on this line.
      if (onlyClosers[line] !== false) shape.leadingClosers += 1;
    } else {
      onlyClosers[line] = false;
    }
    if (token.span.end.line - 1 > line) markSpanned(line, token.span.end.line - 1);
  }

  return out;
}

/**
 * Format a source file.
 *
 * A file that does not lex comes back unchanged: it is precisely the file whose
 * structure cannot be trusted, and rewriting it would be worse than leaving it.
 */
export function format(source: string, file = '<input>'): string {
  let tokens: readonly Token[];
  let comments: readonly Comment[];
  try {
    const lexed = lexWithComments(source, file);
    tokens = lexed.tokens;
    comments = lexed.comments;
  } catch {
    return source;
  }

  const lines = source.split('\n');
  const shape = shapes(source, tokens, comments);
  const out: string[] = [];
  /**
   * One frame per open bracket: the indent its contents belong at, the input
   * column a line aligning under it would start at, and where that column ends
   * up once the opening line has been re-indented.
   */
  const open: { indent: number; column: number; outColumn: number }[] = [];
  let blankRun = 0;
  /** The level the previous code line came out at, for the continuation rule. */
  let previous = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const s = shape[i];
    if (s === undefined) continue;

    // A line inside a multi-line string has no tokens starting on it, so it
    // looks blank — and collapsing it would delete part of a string's value.
    // Verbatim wins over every other rule here.
    if (s.blank && !s.verbatim) {
      blankRun += 1;
      if (blankRun <= MAX_BLANK_RUN) out.push('');
      continue;
    }
    blankRun = 0;

    // Closers at the start of the line belong to brackets opened earlier, so
    // they come off the stack before the line's own indent is read from it.
    for (let c = 0; c < s.leadingClosers; c += 1) open.pop();
    const enclosing = open[open.length - 1];
    const structural = enclosing?.indent ?? 0;

    // A line starting with `.` or `|>` continues the one above, and needs a
    // level of its own to say so — but only when a bracket has not already
    // given it one. `print(s` / `|> len())` is inside the `(` and is indented
    // once, where `let x = foo` / `.bar()` has no bracket and would otherwise
    // sit flush against the line it continues.
    const bump = s.continuation && structural <= previous ? 1 : 0;
    const level = structural + bump;

    // How far this line moved, so a line aligning under one of its brackets
    // moves with it rather than staying at a column that is no longer there.
    let shift = 0;

    if (s.verbatim) {
      // Inside a multi-line string or block comment: the bytes are the value,
      // so they are emitted untouched. The brackets still have to be counted,
      // though — `two"))` closes two real brackets, and a stack that missed
      // them would indent the rest of the file one level too far.
      out.push(raw);
    } else {
      const floor = INDENT.repeat(level);
      const current = raw.slice(0, raw.length - raw.trimStart().length);
      // Starting exactly where the enclosing bracket's first element does: that
      // is alignment, and it is kept. Anything else past the floor is a mistake,
      // and is pulled back to it.
      const aligned =
        current.length > floor.length &&
        current.length === enclosing?.column &&
        !current.includes('\t');
      const indent = aligned ? ' '.repeat(enclosing?.outColumn ?? current.length) : floor;
      out.push(indent + raw.trim());
      shift = indent.length - current.length;
      previous = level;
    }

    // Whatever this line leaves open shares one level: its own, plus one.
    const before = open.length;
    for (let b = s.leadingClosers; b < s.brackets.length; b += 1) {
      const bracket = s.brackets[b];
      if (bracket === undefined) continue;
      if (bracket.opens) {
        open.push({
          indent: level + 1,
          column: bracket.column,
          outColumn: bracket.column + shift,
        });
      } else open.pop();
    }
    for (let f = before; f < open.length; f += 1) {
      const frame = open[f];
      if (frame !== undefined) frame.indent = level + 1;
    }
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
