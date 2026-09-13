/**
 * The Lumen lexer.
 *
 * Turns source text into a flat token stream. Three things are worth knowing:
 *
 *  1. Newlines are significant. Runs of blank lines and comments collapse into a
 *     single `newline` token, which the parser uses as a statement terminator.
 *     This is what makes semicolons optional.
 *  2. Interpolated strings are lexed into parts. The expression inside `${...}`
 *     is captured as raw source plus its absolute position, and re-lexed later
 *     by the parser, so diagnostics inside an interpolation still point at the
 *     real file.
 *  3. Errors accumulate. The lexer reports every problem it finds rather than
 *     dying on the first one.
 */

import {
  type Diagnostic,
  type Pos,
  LumenError,
  pos,
  span,
} from './diagnostics.js';
import { KEYWORDS, OPERATORS, type TemplatePart, type Token, type TokenKind } from './token.js';

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isHex = (c: string): boolean =>
  isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c);

export class Lexer {
  private i = 0;
  private line: number;
  private col: number;
  private readonly baseOffset: number;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];

  /**
   * @param origin Where this source begins in the enclosing file. Supplied when
   *   lexing the inside of a `${...}` so positions stay absolute.
   */
  constructor(
    private readonly source: string,
    private readonly file: string,
    origin?: Pos,
  ) {
    this.baseOffset = origin?.offset ?? 0;
    this.line = origin?.line ?? 1;
    this.col = origin?.col ?? 1;
  }

  // ---------------------------------------------------------------- cursor

  private atEnd(): boolean {
    return this.i >= this.source.length;
  }

  private peek(ahead = 0): string {
    return this.source[this.i + ahead] ?? '';
  }

  private here(): Pos {
    return pos(this.baseOffset + this.i, this.line, this.col);
  }

  private advance(): string {
    const c = this.source[this.i] ?? '';
    this.i += 1;
    if (c === '\n') {
      this.line += 1;
      this.col = 1;
    } else {
      this.col += 1;
    }
    return c;
  }

  private eat(expected: string): boolean {
    if (this.source.startsWith(expected, this.i)) {
      for (let n = 0; n < expected.length; n += 1) this.advance();
      return true;
    }
    return false;
  }

  private error(code: string, message: string, from: Pos, label?: string): void {
    this.diagnostics.push({
      severity: 'error',
      code,
      message,
      span: span(from, this.here()),
      ...(label === undefined ? {} : { label }),
    });
  }

  // ---------------------------------------------------------------- driver

  /** Lex the whole input. Throws `LumenError` if anything went wrong. */
  lex(): Token[] {
    for (;;) {
      const crossedNewline = this.skipTrivia();
      if (crossedNewline && this.tokens.length > 0 && this.last()?.kind !== 'newline') {
        // A statement boundary. Zero-width: it stands between two real tokens.
        const p = this.here();
        this.tokens.push({ kind: 'newline', text: '\n', span: span(p, p) });
      }
      if (this.atEnd()) break;
      this.scanToken();
    }
    const end = this.here();
    this.tokens.push({ kind: 'eof', text: '', span: span(end, end) });

    if (this.diagnostics.length > 0) {
      throw new LumenError(this.diagnostics, this.file, this.source);
    }
    return this.tokens;
  }

  private last(): Token | undefined {
    return this.tokens[this.tokens.length - 1];
  }

  /**
   * Skip whitespace and comments.
   * @returns whether a line break was crossed.
   */
  private skipTrivia(): boolean {
    let sawNewline = false;
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') {
        this.advance();
      } else if (c === '\n') {
        sawNewline = true;
        this.advance();
      } else if (c === '/' && this.peek(1) === '/') {
        while (!this.atEnd() && this.peek() !== '\n') this.advance();
      } else if (c === '/' && this.peek(1) === '*') {
        if (this.skipBlockComment()) sawNewline = true;
      } else {
        return sawNewline;
      }
    }
  }

  /** Skip a `/* ... *\/` comment, which may nest. @returns whether it spanned lines. */
  private skipBlockComment(): boolean {
    const start = this.here();
    let sawNewline = false;
    let depth = 0;
    // Opening delimiter.
    this.advance();
    this.advance();
    depth += 1;
    while (!this.atEnd() && depth > 0) {
      if (this.peek() === '/' && this.peek(1) === '*') {
        this.advance();
        this.advance();
        depth += 1;
      } else if (this.peek() === '*' && this.peek(1) === '/') {
        this.advance();
        this.advance();
        depth -= 1;
      } else {
        if (this.peek() === '\n') sawNewline = true;
        this.advance();
      }
    }
    if (depth > 0) {
      this.diagnostics.push({
        severity: 'error',
        code: 'LX006',
        message: 'unterminated block comment',
        span: span(start, this.here()),
        label: 'this comment is never closed',
        notes: [{ message: 'block comments nest, so every `/*` needs its own `*/`' }],
      });
    }
    return sawNewline;
  }

  private scanToken(): void {
    const start = this.here();
    const c = this.peek();

    if (c === '"') {
      this.scanString(start);
      return;
    }
    if (isDigit(c)) {
      this.scanNumber(start);
      return;
    }
    if (isIdentStart(c)) {
      this.scanIdent(start);
      return;
    }

    for (const op of OPERATORS) {
      if (this.source.startsWith(op, this.i)) {
        // `.` must not swallow the leading dot of a float; `1.5` is handled by
        // scanNumber, but a bare `.5` is not a number literal in Lumen.
        for (let n = 0; n < op.length; n += 1) this.advance();
        this.push(op, op, start);
        return;
      }
    }

    // Nothing matched.
    this.advance();
    const hint =
      c === '|' ? 'did you mean `||` or `|>`?'
        : c === '&' ? 'did you mean `&&`?'
          : c === '#' ? 'comments in Lumen are `//` or `/* */`'
            : c === "'" ? 'Lumen strings use double quotes'
              : undefined;
    this.diagnostics.push({
      severity: 'error',
      code: 'LX001',
      message: 'unexpected character `' + c + '`',
      span: span(start, this.here()),
      label: 'not valid here',
      ...(hint === undefined ? {} : { notes: [{ message: hint }] }),
    });
  }

  private push(kind: TokenKind, text: string, start: Pos, extra: Partial<Token> = {}): void {
    this.tokens.push({ kind, text, span: span(start, this.here()), ...extra });
  }

  // ---------------------------------------------------------------- atoms

  private scanIdent(start: Pos): void {
    while (isIdentPart(this.peek())) this.advance();
    const text = this.source.slice(start.offset - this.baseOffset, this.i);
    const kw = KEYWORDS[text];
    this.push(kw ?? 'ident', text, start);
  }

  /**
   * Numbers: decimal with optional fraction and exponent, plus `0x` / `0b` / `0o`
   * radix forms. `_` is allowed as a visual separator between digits.
   *
   * A `.` is only consumed when a digit follows, so `0..10` lexes as
   * `0`, `..`, `10` rather than `0.` followed by a stray `.`.
   */
  private scanNumber(start: Pos): void {
    const radixPrefixes: Record<string, { radix: number; test: (c: string) => boolean }> = {
      x: { radix: 16, test: isHex },
      X: { radix: 16, test: isHex },
      b: { radix: 2, test: (c) => c === '0' || c === '1' },
      B: { radix: 2, test: (c) => c === '0' || c === '1' },
      o: { radix: 8, test: (c) => c >= '0' && c <= '7' },
      O: { radix: 8, test: (c) => c >= '0' && c <= '7' },
    };

    if (this.peek() === '0' && radixPrefixes[this.peek(1)] !== undefined) {
      const spec = radixPrefixes[this.peek(1)];
      if (spec !== undefined) {
        this.advance();
        this.advance();
        const digitsFrom = this.i;
        while (spec.test(this.peek()) || this.peek() === '_') this.advance();
        const digits = this.source.slice(digitsFrom, this.i).replace(/_/g, '');
        const text = this.source.slice(start.offset - this.baseOffset, this.i);
        if (digits.length === 0) {
          this.error('LX005', 'number literal `' + text + '` has no digits', start, 'expected digits here');
          this.push('number', text, start, { num: 0 });
          return;
        }
        this.push('number', text, start, { num: Number.parseInt(digits, spec.radix) });
        return;
      }
    }

    while (isDigit(this.peek()) || this.peek() === '_') this.advance();
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      this.advance();
      while (isDigit(this.peek()) || this.peek() === '_') this.advance();
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      const save = { i: this.i, line: this.line, col: this.col };
      this.advance();
      if (this.peek() === '+' || this.peek() === '-') this.advance();
      if (isDigit(this.peek())) {
        while (isDigit(this.peek()) || this.peek() === '_') this.advance();
      } else {
        // Not an exponent after all (e.g. `1e` in `1etc`); give the chars back.
        this.i = save.i;
        this.line = save.line;
        this.col = save.col;
      }
    }

    const text = this.source.slice(start.offset - this.baseOffset, this.i);
    const value = Number(text.replace(/_/g, ''));
    if (Number.isNaN(value)) {
      this.error('LX005', 'invalid number literal `' + text + '`', start, 'cannot parse this as a number');
      this.push('number', text, start, { num: 0 });
      return;
    }
    this.push('number', text, start, { num: value });
  }

  /**
   * Strings are double-quoted, may span lines, and support `${expr}`
   * interpolation. A string with no interpolation produces a `string` token with
   * its escapes already resolved; one with interpolation produces a `template`
   * token carrying alternating text and expression parts.
   */
  private scanString(start: Pos): void {
    this.advance(); // opening quote
    const parts: TemplatePart[] = [];
    let text = '';
    let interpolated = false;

    for (;;) {
      if (this.atEnd()) {
        this.diagnostics.push({
          severity: 'error',
          code: 'LX002',
          message: 'unterminated string',
          span: span(start, this.here()),
          label: 'this string is never closed',
          notes: [{ message: 'add a closing `"`; Lumen strings may span multiple lines' }],
        });
        break;
      }

      const c = this.peek();

      if (c === '"') {
        this.advance();
        break;
      }

      if (c === '\\') {
        text += this.scanEscape();
        continue;
      }

      if (c === '$' && this.peek(1) === '{') {
        interpolated = true;
        if (text.length > 0) {
          parts.push({ kind: 'text', value: text });
          text = '';
        }
        const interpolation = this.scanInterpolation();
        parts.push(interpolation.part);
        // An unterminated `${` has already eaten the rest of the input, so the
        // string is unterminated too. Reporting that as well would just be the
        // same mistake twice.
        if (!interpolation.terminated) break;
        continue;
      }

      text += this.advance();
    }

    const raw = this.source.slice(start.offset - this.baseOffset, this.i);
    if (!interpolated) {
      this.push('string', raw, start, { str: text });
      return;
    }
    if (text.length > 0) parts.push({ kind: 'text', value: text });
    this.push('template', raw, start, { parts });
  }

  /** Consume a backslash escape and return the character(s) it denotes. */
  private scanEscape(): string {
    const start = this.here();
    this.advance(); // backslash
    const c = this.advance();
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case '\\':
        return '\\';
      case '"':
        return '"';
      case '$':
        return '$';
      case '\n':
        // A line continuation: backslash at end of line swallows the newline.
        return '';
      case 'u': {
        if (this.peek() !== '{') {
          this.error('LX007', 'expected `{` after `\\u`', start, 'unicode escapes look like `\\u{1F600}`');
          return '';
        }
        this.advance();
        const from = this.i;
        while (isHex(this.peek())) this.advance();
        const digits = this.source.slice(from, this.i);
        if (!this.eat('}')) {
          this.error('LX007', 'unterminated unicode escape', start, 'expected `}`');
          return '';
        }
        const code = Number.parseInt(digits, 16);
        if (digits.length === 0 || Number.isNaN(code) || code > 0x10ffff) {
          this.error('LX007', 'invalid unicode escape `\\u{' + digits + '}`', start, 'not a valid code point');
          return '';
        }
        return String.fromCodePoint(code);
      }
      default:
        this.error(
          'LX004',
          'unknown escape sequence `\\' + c + '`',
          start,
          'not a recognised escape',
        );
        return c;
    }
  }

  /**
   * Consume `${ ... }` and capture the expression source verbatim, tracking
   * brace depth and skipping over nested string literals so that
   * `"${ pick("}") }"` is read correctly.
   */
  private scanInterpolation(): { part: TemplatePart; terminated: boolean } {
    const open = this.here();
    this.advance(); // $
    this.advance(); // {
    const exprOrigin = this.here();
    const from = this.i;
    let depth = 1;

    while (!this.atEnd()) {
      const c = this.peek();
      if (c === '"') {
        this.skipRawString();
        continue;
      }
      if (c === '{') {
        depth += 1;
        this.advance();
        continue;
      }
      if (c === '}') {
        depth -= 1;
        this.advance();
        if (depth === 0) break;
        continue;
      }
      this.advance();
    }

    if (depth > 0) {
      this.diagnostics.push({
        severity: 'error',
        code: 'LX003',
        message: 'unterminated interpolation',
        span: span(open, this.here()),
        label: 'this `${` is never closed',
        notes: [{ message: 'add a closing `}`' }],
      });
      return {
        part: { kind: 'expr', source: this.source.slice(from, this.i), span: span(exprOrigin, this.here()) },
        terminated: false,
      };
    }

    // `this.i - 1` excludes the closing brace we just consumed.
    const source = this.source.slice(from, this.i - 1);
    return {
      part: { kind: 'expr', source, span: span(exprOrigin, this.here()) },
      terminated: true,
    };
  }

  /** Skip over a string literal without interpreting it (used while brace-matching). */
  private skipRawString(): void {
    this.advance(); // opening quote
    while (!this.atEnd()) {
      if (this.peek() === '\\') {
        this.advance();
        this.advance();
        continue;
      }
      if (this.peek() === '"') {
        this.advance();
        return;
      }
      this.advance();
    }
  }
}

/** Convenience wrapper around {@link Lexer}. */
export function lex(source: string, file = '<input>', origin?: Pos): Token[] {
  return new Lexer(source, file, origin).lex();
}
