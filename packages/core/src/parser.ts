/**
 * The Lumen parser: a recursive-descent statement parser wrapped around a
 * Pratt expression parser.
 *
 * Three rules deserve explanation, because they are where brace-and-newline
 * languages usually go wrong.
 *
 * 1. STATEMENT TERMINATION. A statement ends at a line break, a `;`, or a `}`.
 *    Semicolons are therefore optional. Inside `(`, `[`, and argument lists,
 *    line breaks are insignificant, so multi-line calls need no continuation
 *    marker.
 *
 * 2. LEADING-OPERATOR CONTINUATION. A line break is also insignificant when the
 *    next meaningful token is `|>`, `.`, or `?.`. That is what lets a pipeline
 *    be written down the page:
 *
 *        let names = users
 *          |> filter(fn(u) { u.active })
 *          |> map(fn(u) { u.name })
 *
 * 3. BRACE AMBIGUITY. `{` starts a map literal in expression position but a
 *    block after `if`/`while`/`for`/`match`. Inside those headers, brace
 *    literals (map literals and `Name { ... }` struct literals) are suppressed,
 *    so `if task.done { ... }` reads the brace as the block it obviously is.
 *    A map literal in a header must be parenthesised. This mirrors Rust.
 */

import { FOREIGN_KEYWORDS, STRING_PREFIXES } from './hints.js';
import {
  type Diagnostic,
  type Note,
  type Span,
  LumenError,
  joinSpans,
  span,
} from './diagnostics.js';
import { lex } from './lexer.js';
import { KEYWORDS, describe, describeToken, type Token, type TokenKind } from './token.js';
import type {
  Arg,
  BinaryOp,
  Block,
  EnumVariant,
  Expr,
  ExportDecl,
  FieldInit,
  FnDecl,
  MapEntry,
  MatchArm,
  Module,
  Param,
  Pattern,
  Stmt,
  StructField,
  TypeExpr,
} from './ast.js';

/** Thrown internally to unwind to the nearest recovery point. */
class ParseAbort extends Error {}

/** Binding powers. Higher binds tighter. Assignment is handled separately. */
const PRECEDENCE: Partial<Record<TokenKind, number>> = {
  '|>': 2,
  '||': 3,
  or: 3,
  '&&': 4,
  and: 4,
  '==': 5,
  '!=': 5,
  '<': 6,
  '<=': 6,
  '>': 6,
  '>=': 6,
  '..': 7,
  '+': 8,
  '-': 8,
  '*': 9,
  '/': 9,
  '%': 9,
  '**': 10,
};

/**
 * Operators that group to the right, so `2 ** 3 ** 2` is `2 ** (3 ** 2)`.
 *
 * Exponentiation is the only one. It is the convention in mathematics and in
 * every language that has the operator, and the left-associative reading is
 * never what anybody means: `(2 ** 3) ** 2` is `2 ** 6`, and is spelled that
 * way instead.
 */
const RIGHT_ASSOCIATIVE: readonly TokenKind[] = ['**'];

const ASSIGN_OPS: readonly TokenKind[] = ['=', '+=', '-=', '*=', '/='];

/** Tokens that make a preceding line break insignificant. */
const CONTINUATION: readonly TokenKind[] = ['|>', '.', '?.'];

/** Statement-introducing keywords, used as resynchronisation points. */
const STMT_START: readonly TokenKind[] = [
  'let', 'var', 'fn', 'struct', 'enum', 'return', 'while', 'for',
  'break', 'continue', 'import', 'export', 'if', 'match',
];

const MAX_ERRORS = 25;

/** Whether an expression names a place a value can be put. */
function isAssignTarget(expr: Expr): boolean {
  switch (expr.kind) {
    case 'Ident':
    case 'MemberExpr':
    case 'IndexExpr':
      return true;
    case 'ListLit':
      // Empty would assign nothing, which is a typo rather than an intention.
      return expr.items.length > 0 && expr.items.every(isAssignTarget);
    default:
      return false;
  }
}

/**
 * Whether a token could be a field or key name — which includes every keyword,
 * since a keyword before a `:` inside braces cannot be anything else.
 */
function isNameLike(tok: Token): boolean {
  return tok.kind === 'ident' || tok.kind === 'string' || KEYWORDS.has(tok.text);
}

/** The deepest the parser will recurse before reporting `PA016`. */
const MAX_NESTING = 250;

export class Parser {
  private i = 0;
  private readonly diagnostics: Diagnostic[] = [];
  /** When > 0, `{` is a block, never a map or struct literal. */
  private noBraceLit = 0;
  /** How many `if`/`while`/guard conditions enclose the current expression. */
  private conditions = 0;
  /** Current parser recursion depth. See `nested`. */
  private depth = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly file: string,
    private readonly source: string,
    /**
     * Where this parser's nesting budget starts.
     *
     * Each `${…}` is parsed by a *new* `Parser`, so a nested interpolation used
     * to reset the budget to zero and recurse as far as the host's stack
     * allowed. Passing the depth in makes one budget span the whole file,
     * however many sub-parsers it takes to read it.
     */
    depth = 0,
    /**
     * What this parser is reading, for the "found the end of …" half of a
     * message.
     *
     * Each `${…}` is parsed by its own `Parser` over the fragment's source, so
     * its `eof` is the end of the *fragment* — and a parse error inside one
     * said "expected an expression, found end of file" pointing at line 2 of a
     * ten-line file. Every other position in the diagnostic was right, which
     * made the one wrong word harder to disbelieve.
     */
    private readonly reading: 'file' | 'interpolation' = 'file',
  ) {
    this.depth = depth;
  }

  /** `describeToken`, with this parser's idea of where its input ends. */
  private found(tok: Token): string {
    if (tok.kind === 'eof' && this.reading === 'interpolation') {
      return 'the end of the interpolation';
    }
    return describeToken(tok);
  }

  // ------------------------------------------------------------- navigation

  private cur(): Token {
    // The stream always ends with `eof`, so this is total for well-formed input.
    return this.tokens[this.i] ?? this.tokens[this.tokens.length - 1] ?? {
      kind: 'eof',
      text: '',
      span: span({ offset: 0, line: 1, col: 1 }, { offset: 0, line: 1, col: 1 }),
    };
  }

  private at(kind: TokenKind): boolean {
    return this.cur().kind === kind;
  }

  private atAny(...kinds: TokenKind[]): boolean {
    return kinds.includes(this.cur().kind);
  }

  private advance(): Token {
    const t = this.cur();
    if (!this.at('eof')) this.i += 1;
    return t;
  }

  private eat(kind: TokenKind): boolean {
    if (this.at(kind)) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, context?: string): Token {
    if (this.at(kind)) return this.advance();
    const where = context === undefined ? '' : ' ' + context;
    const notes = [...(this.habitNotes(kind) ?? []), ...this.openerNote(kind)];
    return this.fail(
      'PA001',
      'expected ' + describe(kind) + where + ', found ' + this.found(this.cur()),
      'expected ' + describe(kind),
      notes.length > 0 ? notes : undefined,
    );
  }

  /**
   * Where the bracket a closer would close was opened, when that is on an
   * earlier line.
   *
   * "expected `}` to close this block, found end of file" points at the end
   * of the file, and the mistake is a `{` two hundred lines up that nothing
   * closed — the one line the message did not name. Found by walking the
   * tokens back from here with a depth count, which is exact for the thing it
   * is used for and needs nothing from the grammar: the nearest unmatched
   * opener before the cursor is the one this closer was going to close. On the
   * same line the caret already shows it, and the note would be noise.
   */
  private openerNote(closer: TokenKind): Note[] {
    const opener = closer === ')' ? '(' : closer === ']' ? '[' : closer === '}' ? '{' : undefined;
    if (opener === undefined) return [];
    let depth = 0;
    for (let j = this.i - 1; j >= 0; j -= 1) {
      const tok = this.tokens[j];
      if (tok === undefined) break;
      if (tok.kind === closer) {
        depth += 1;
      } else if (tok.kind === opener) {
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        if (tok.span.start.line >= this.cur().span.start.line) return [];
        return [{ message: 'it opened here', span: tok.span }];
      }
    }
    return [];
  }

  /**
   * What the token in the way usually means when the fingers that typed it
   * learned another language first; see `hints.ts`. The error is unchanged —
   * `xs[0:2]` really is a `:` where `]` was expected — and gains the one line
   * that says how Lumen spells it.
   */
  private habitNotes(expected: TokenKind): Note[] | undefined {
    const tok = this.cur();
    if (tok.kind === 'in') {
      return [{ message: '`xs.contains(x)` asks whether a list holds a value; `in` only appears in `for x in xs`' }];
    }
    if (tok.kind === ':' && expected === ']') {
      return [{ message: 'a slice is `xs.slice(from, to)`, on a list or a string' }];
    }
    if (tok.kind === ':' && expected === '{') {
      return [{ message: 'a block starts with `{` and ends with `}`; Lumen does not use `:` and indentation' }];
    }
    // `f"hi {name}"`: a name pressed against a string, which is never Lumen.
    const prev = this.tokens[this.i - 1];
    if (
      (tok.kind === 'string' || tok.kind === 'template') &&
      prev !== undefined &&
      prev.kind === 'ident' &&
      STRING_PREFIXES.has(prev.text) &&
      prev.span.end.offset === tok.span.start.offset
    ) {
      return [{ message: 'there is no `' + prev.text + '` prefix: every string interpolates, `"hi ${name}"`' }];
    }
    return undefined;
  }

  /**
   * The same question after a whole statement, where the shape is a bare word
   * and then a value on the same line: `def f(x):`, `print "hello"`, `try {`.
   */
  private habitAfterStatement(stmt: Stmt | undefined): Note[] | undefined {
    const tok = this.cur();
    if (tok.kind === 'ident' && tok.text === 'elif') return [{ message: '`elif` is spelled `else if`' }];
    if (tok.kind === 'if') {
      return [{ message: 'Lumen\'s `if` is an expression and comes first: `let x = if c { 1 } else { 2 }`' }];
    }
    const word = trailingName(stmt);
    if (word === undefined) return undefined;
    const foreign = FOREIGN_KEYWORDS.get(word);
    if (foreign !== undefined) return [{ message: foreign }];
    // `print "hello"`: a bare name as the whole statement, then a value.
    const startsAValue =
      tok.kind === 'string' || tok.kind === 'template' || tok.kind === 'number' || tok.kind === 'ident';
    if (startsAValue && stmt?.kind === 'ExprStmt') {
      return [{ message: 'to call `' + word + '`, put its arguments in parentheses: `' + word + '(…)`' }];
    }
    return undefined;
  }

  private skipNewlines(): void {
    while (this.at('newline')) this.advance();
  }

  /**
   * Consume line breaks when what follows them continues the current
   * expression (rule 2 above).
   */
  private skipNewlinesBeforeContinuation(): void {
    if (!this.at('newline')) return;
    let j = this.i;
    while (this.tokens[j]?.kind === 'newline') j += 1;
    const next = this.tokens[j];
    if (next !== undefined && CONTINUATION.includes(next.kind)) this.i = j;
  }

  /**
   * Record a diagnostic, dropping it if it exactly repeats the previous one.
   * Recovery can revisit the same token, and a wall of identical errors is
   * worse than one.
   */
  private report(d: Diagnostic): void {
    const last = this.diagnostics[this.diagnostics.length - 1];
    if (last !== undefined && last.code === d.code && last.span.start.offset === d.span.start.offset) {
      return;
    }
    this.diagnostics.push(d);
  }

  /**
   * A name, in a position where only a name can appear.
   *
   * A keyword is only a keyword where a statement or an expression could
   * start. After a `.`, before the `:` of a map entry, as a struct field or an
   * import alias, there is nothing else it could be — so `{ if: 1 }` and
   * `m.for` and a JSON object with a key called `match` all have to work.
   * `parse('{"true": 1}')` produces exactly that, and before this there was no
   * way to write it or to reach it with a dot.
   */
  private expectName(context: string): Token {
    const tok = this.cur();
    if (tok.kind === 'ident' || KEYWORDS.has(tok.text)) {
      this.advance();
      return tok;
    }
    return this.expect('ident', context);
  }

  private fail(code: string, message: string, label?: string, notes?: readonly Note[]): never {
    this.report({
      severity: 'error',
      code,
      message,
      span: this.cur().span,
      ...(label === undefined ? {} : { label }),
      ...(notes === undefined ? {} : { notes }),
    });
    throw new ParseAbort();
  }

  /**
   * Skip tokens until something that plausibly starts a new statement.
   *
   * A `{ … }` opened past the error is part of what is being skipped. In
   * `} elif x == 2 { print(2) }` the mistake is `elif`; the block after it is
   * the body of the thing that failed, and used to be parsed on its own, so
   * that its closing `}` was then reported as unmatched — a second error for
   * one slip, and the wrong one to read first. A `}` at depth zero is the
   * end of the block the error was in, and stays for whoever opened it.
   */
  private synchronize(): void {
    let depth = 0;
    // Always make progress, or a malformed token loops forever.
    if (!this.atAny('newline', 'eof', '}')) {
      if (this.at('{')) depth += 1;
      this.advance();
    }
    for (;;) {
      if (this.at('eof')) return;
      if (this.at('{')) depth += 1;
      if (this.at('}')) {
        if (depth === 0) return;
        depth -= 1;
        this.advance();
        if (depth === 0) return;
        continue;
      }
      if (depth === 0) {
        if (this.at('newline')) {
          this.skipNewlines();
          return;
        }
        if (this.atAny(...STMT_START)) return;
      }
      this.advance();
    }
  }

  /** Brace literals are suppressed inside control-flow headers. */
  private inHeader<T>(parse: () => T): T {
    this.noBraceLit += 1;
    try {
      return parse();
    } finally {
      this.noBraceLit -= 1;
    }
  }

  /**
   * A condition: a header where `=` is almost always a mistyped `==`.
   *
   * Counted separately from `noBraceLit` because a `for` iterable and a
   * `match` subject are headers too, and `==` is no answer in either.
   */
  private inCondition<T>(parse: () => T): T {
    this.conditions += 1;
    try {
      return this.inHeader(parse);
    } finally {
      this.conditions -= 1;
    }
  }

  /** Inside `(`/`[`/argument lists, braces are unambiguous again. */
  private inBrackets<T>(parse: () => T): T {
    const saved = this.noBraceLit;
    this.noBraceLit = 0;
    try {
      return parse();
    } finally {
      this.noBraceLit = saved;
    }
  }

  private spanFrom(start: Token): Span {
    const prev = this.tokens[Math.max(0, this.i - 1)];
    return joinSpans(start.span, prev?.span ?? start.span);
  }

  // ----------------------------------------------------------------- module

  parseModule(): Module {
    const first = this.cur();
    const stmts: Stmt[] = [];
    this.skipNewlines();
    while (!this.at('eof')) {
      // A `}` with no matching `{` would otherwise stall recovery here.
      if (this.at('}')) {
        this.report({
          severity: 'error',
          code: 'PA014',
          message: 'unmatched `}`',
          span: this.cur().span,
          label: 'no block is open here',
        });
        this.advance();
        this.skipNewlines();
        continue;
      }
      const before = this.i;
      try {
        const stmt = this.parseStmt();
        stmts.push(stmt);
        this.endStatement(stmt);
      } catch (err) {
        if (!(err instanceof ParseAbort)) throw err;
        if (this.diagnostics.length >= MAX_ERRORS) break;
        this.synchronize();
        // Every iteration must consume at least one token.
        if (this.i === before) this.advance();
      }
      this.skipNewlines();
    }
    this.finish();
    return { kind: 'Module', file: this.file, stmts, span: this.spanFrom(first) };
  }

  /**
   * Parse exactly one expression, and nothing after it.
   *
   * Used for the text inside an interpolation, and by `parseExpression` for a
   * host that wants a single expression.
   *
   * `fail` unwinds with a `ParseAbort`, which every other entry point catches —
   * `parseModule` catches it to recover onto the next statement. This one did
   * not, so a bad expression escaped as an internal exception instead of the
   * `LumenError` the signature promises, and a caller had no way to render it.
   * There is nothing to recover *onto* here, so the catch is bare: collect the
   * diagnostic and let `finish` raise it properly.
   */
  parseExpressionEntry(): Expr {
    let expr: Expr | undefined;
    try {
      this.skipNewlines();
      expr = this.parseExpr();
      this.skipNewlines();
      if (!this.at('eof')) {
        this.fail(
          'PA002',
          'unexpected ' + this.found(this.cur()) + ' after expression',
          'not part of the expression',
        );
      }
    } catch (err) {
      if (!(err instanceof ParseAbort)) throw err;
    }
    this.finish();
    if (expr === undefined) {
      // `finish` raises whenever a diagnostic was recorded, and `fail` always
      // records one before aborting, so this is unreachable — but an entry
      // point that can return `undefined` typed as `Expr` is worse than a
      // check that never fires.
      throw new LumenError(
        [
          {
            severity: 'error',
            code: 'PA002',
            message: 'expected an expression',
            span: this.cur().span,
            label: 'nothing to parse',
          },
        ],
        this.file,
        this.source,
      );
    }
    return expr;
  }

  private finish(): void {
    if (this.diagnostics.length > 0) {
      throw new LumenError(this.diagnostics, this.file, this.source);
    }
  }

  /** A statement must be followed by a line break, `;`, `}`, or end of input. */
  private endStatement(stmt?: Stmt): void {
    if (this.eat(';')) {
      this.skipNewlines();
      return;
    }
    if (this.at('newline')) {
      this.skipNewlines();
      return;
    }
    if (this.atAny('}', 'eof')) return;
    // A `:` here almost always means a map literal was written where a `{`
    // opened a block. `1 => { a: 1 }` reads as an arm whose body is a block
    // containing the statement `a`, and then the `:` has nowhere to go — so the
    // standing advice, "expected a line break or `;` here", is advice that
    // cannot be followed: no line break makes that a map. Parentheses do.
    const looksLikeAMap = this.at(':');
    this.fail(
      'PA003',
      'unexpected ' + this.found(this.cur()) + ' after statement',
      'expected a line break or `;` here',
      looksLikeAMap
        ? [
            { message: 'a `{` after `=>`, or at the start of a statement, opens a block' },
            { message: 'for a map literal there, put it in parentheses: `({ a: 1 })`' },
          ]
        : (this.habitAfterStatement(stmt) ?? [
            { message: 'statements in Lumen end at the end of the line; semicolons are optional' },
          ]),
    );
  }

  // ------------------------------------------------------------- statements

  private parseStmt(): Stmt {
    // `fn (` with no name is an anonymous function *expression*, not a
    // declaration — which is how a block returns a closure as its value.
    if (this.at('fn') && this.tokens[this.i + 1]?.kind !== 'ident') {
      const start = this.cur();
      const expr = this.parseExpr();
      return { kind: 'ExprStmt', expr, span: this.spanFrom(start) };
    }

    switch (this.cur().kind) {
      case 'let':
      case 'var':
        return this.parseLet();
      case 'fn':
        return this.parseFn();
      case 'struct':
        return this.parseStruct();
      case 'enum':
        return this.parseEnum();
      case 'return':
        return this.parseReturn();
      case 'while':
        return this.parseWhile();
      case 'for':
        return this.parseFor();
      case 'break': {
        const tok = this.advance();
        return { kind: 'BreakStmt', span: tok.span };
      }
      case 'continue': {
        const tok = this.advance();
        return { kind: 'ContinueStmt', span: tok.span };
      }
      case 'import':
        return this.parseImport();
      case 'export':
        return this.parseExport();
      default: {
        const start = this.cur();
        const expr = this.parseExpr();
        return { kind: 'ExprStmt', expr, span: this.spanFrom(start) };
      }
    }
  }

  private parseLet(): Stmt {
    const start = this.advance(); // let | var
    const mutable = start.kind === 'var';

    // `let [a, b] = pair` takes the pattern that `match` and `for` already
    // use, so returning two things needs no special machinery.
    if (this.at('[')) {
      const pattern = this.parsePattern();
      this.expect('=', 'in a `' + start.kind + '` declaration');
      this.skipNewlines();
      const value = this.parseExpr();
      return {
        kind: 'DestructureDecl',
        pattern,
        mutable,
        value,
        span: this.spanFrom(start),
      };
    }

    const name = this.expect('ident', 'after `' + start.kind + '`');
    let type: TypeExpr | undefined;
    if (this.eat(':')) type = this.parseTypeExpr();
    this.expect('=', 'in a `' + start.kind + '` declaration');
    this.skipNewlines();
    const value = this.parseExpr();
    return {
      kind: 'LetDecl',
      name: name.text,
      nameSpan: name.span,
      mutable,
      type,
      value,
      span: this.spanFrom(start),
    };
  }

  private parseFn(): FnDecl {
    const start = this.advance(); // fn
    const name = this.expect('ident', 'after `fn`');
    const params = this.parseParamList();
    let ret: TypeExpr | undefined;
    if (this.eat('->')) {
      this.skipNewlines();
      ret = this.parseTypeExpr();
    }
    this.skipNewlines();
    const body = this.parseBlock();
    return {
      kind: 'FnDecl',
      name: name.text,
      nameSpan: name.span,
      params,
      ret,
      body,
      span: this.spanFrom(start),
    };
  }

  private parseParamList(): Param[] {
    this.expect('(', 'to start a parameter list');
    const params: Param[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at(')') && !this.at('eof')) {
        const restStart = this.cur();
        const rest = this.eat('..');
        const pStart = this.expect('ident', 'as a parameter name');
        let type: TypeExpr | undefined;
        if (this.eat(':')) type = this.parseTypeExpr();
        let defaultValue: Expr | undefined;
        if (this.eat('=')) {
          this.skipNewlines();
          defaultValue = this.parseExpr();
        }

        // A `..` parameter takes everything left over, so nothing can follow it
        // and a default could never be reached.
        if (rest && defaultValue !== undefined) {
          this.report({
            severity: 'error',
            code: 'PA017',
            message: '`..' + pStart.text + '` cannot have a default value',
            span: this.spanFrom(restStart),
            label: 'a `..` parameter is always given a list, possibly empty',
            notes: [{ message: 'drop the `= ...`; it can never be reached' }],
          });
          defaultValue = undefined;
        }
        if (params.some((p) => p.rest)) {
          this.report({
            severity: 'error',
            code: 'PA017',
            message: 'a `..` parameter must be the last one',
            span: this.spanFrom(restStart),
            label: 'nothing can follow it',
            notes: [{ message: 'it takes every remaining argument, so there are none left' }],
          });
        }

        params.push({
          name: pStart.text,
          nameSpan: pStart.span,
          type,
          defaultValue,
          rest,
          span: this.spanFrom(restStart),
        });
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect(')', 'to close the parameter list');
    return params;
  }

  private parseStruct(): Stmt {
    const start = this.advance(); // struct
    const name = this.expect('ident', 'after `struct`');
    this.skipNewlines();
    this.expect('{', 'to start the struct body');
    const fields: StructField[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at('}') && !this.at('eof')) {
        const fStart = this.expectName('as a field name');
        let type: TypeExpr | undefined;
        if (this.eat(':')) type = this.parseTypeExpr();
        fields.push({ name: fStart.text, type, span: this.spanFrom(fStart) });
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect('}', 'to close the struct body');
    return {
      kind: 'StructDecl',
      name: name.text,
      nameSpan: name.span,
      fields,
      span: this.spanFrom(start),
    };
  }

  private parseEnum(): Stmt {
    const start = this.advance(); // enum
    const name = this.expect('ident', 'after `enum`');
    this.skipNewlines();
    this.expect('{', 'to start the enum body');
    const variants: EnumVariant[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at('}') && !this.at('eof')) {
        const vStart = this.expect('ident', 'as a variant name');
        const payload: TypeExpr[] = [];
        if (this.eat('(')) {
          this.skipNewlines();
          while (!this.at(')') && !this.at('eof')) {
            payload.push(this.parseTypeExpr());
            this.skipNewlines();
            if (!this.eat(',')) break;
            this.skipNewlines();
          }
          this.expect(')', 'to close the variant payload');
        }
        variants.push({ name: vStart.text, fields: payload, span: this.spanFrom(vStart) });
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect('}', 'to close the enum body');
    return {
      kind: 'EnumDecl',
      name: name.text,
      nameSpan: name.span,
      variants,
      span: this.spanFrom(start),
    };
  }

  private parseReturn(): Stmt {
    const start = this.advance(); // return
    let value: Expr | undefined;
    if (!this.atAny('newline', ';', '}', 'eof')) value = this.parseExpr();
    return { kind: 'ReturnStmt', value, span: this.spanFrom(start) };
  }

  private parseWhile(): Stmt {
    const start = this.advance(); // while
    const condition = this.inCondition(() => this.parseExpr());
    this.skipNewlines();
    const body = this.parseBlock();
    return { kind: 'WhileStmt', condition, body, span: this.spanFrom(start) };
  }

  private parseFor(): Stmt {
    const start = this.advance(); // for
    const binding = this.parsePattern();
    this.expect('in', 'in a `for` loop');
    this.skipNewlines();
    const iterable = this.inHeader(() => this.parseExpr());
    this.skipNewlines();
    const body = this.parseBlock();
    return { kind: 'ForStmt', binding, iterable, body, span: this.spanFrom(start) };
  }

  private parseImport(): Stmt {
    const start = this.advance(); // import
    if (this.at('ident')) {
      // `import math`: the shape of every other language's import.
      this.fail(
        'PA001',
        'expected `{` to start an import list, found ' + this.found(this.cur()),
        'expected `{`',
        [{ message: 'an import names what it takes: `import { sqrt } from "std/math"`' }],
      );
    }
    this.expect('{', 'to start an import list');
    const specifiers: { name: string; alias: string | undefined; span: Span }[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at('}') && !this.at('eof')) {
        const nameTok = this.expectName('as an imported name');
        let alias: string | undefined;
        if (this.at('ident') && this.cur().text === 'as') {
          this.advance();
          alias = this.expectName('after `as`').text;
        }
        specifiers.push({ name: nameTok.text, alias, span: this.spanFrom(nameTok) });
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect('}', 'to close the import list');
    // `from` is a word here rather than a keyword, exactly like `as` above: it
    // means something in this one position and is an ordinary name everywhere
    // else, so `let from = ...` and `fn replace(s, from, to)` are programs a
    // person can write. See `KEYWORDS` for why it is worth the two lines.
    if (this.at('ident') && this.cur().text === 'from') this.advance();
    else {
      this.fail('PA004', 'expected `from` after an import list', 'expected `from`', [
        { message: 'imports look like: import { map } from "std/list"' },
      ]);
    }
    const pathTok = this.cur();
    if (pathTok.kind !== 'string') {
      this.fail('PA005', 'expected a module path string after `from`', 'expected a string');
    }
    this.advance();
    return {
      kind: 'ImportDecl',
      specifiers,
      from: pathTok.str ?? '',
      span: this.spanFrom(start),
    };
  }

  private parseExport(): ExportDecl {
    const start = this.advance(); // export
    if (!this.atAny('let', 'var', 'fn', 'struct', 'enum')) {
      this.fail(
        'PA006',
        'only `let`, `var`, `fn`, `struct` and `enum` can be exported',
        'cannot export this',
      );
    }
    const decl = this.parseStmt();
    if (
      decl.kind !== 'LetDecl' &&
      decl.kind !== 'FnDecl' &&
      decl.kind !== 'StructDecl' &&
      decl.kind !== 'EnumDecl'
    ) {
      this.fail('PA006', 'this declaration cannot be exported', 'cannot export this');
    }
    return { kind: 'ExportDecl', declaration: decl, span: this.spanFrom(start) };
  }

  private parseBlock(): Block {
    return this.nested(() => this.parseBlockInner());
  }

  private parseBlockInner(): Block {
    const start = this.expect('{', 'to start a block');
    const stmts: Stmt[] = [];
    const saved = this.noBraceLit;
    this.noBraceLit = 0;
    try {
      this.skipNewlines();
      while (!this.at('}') && !this.at('eof')) {
        const before = this.i;
        try {
          const stmt = this.parseStmt();
          stmts.push(stmt);
          this.endStatement(stmt);
        } catch (err) {
          if (!(err instanceof ParseAbort)) throw err;
          if (this.diagnostics.length >= MAX_ERRORS) break;
          this.synchronize();
          if (this.i === before) this.advance();
        }
        this.skipNewlines();
      }
    } finally {
      this.noBraceLit = saved;
    }
    this.expect('}', 'to close this block');
    return { kind: 'Block', stmts, span: this.spanFrom(start) };
  }

  // ------------------------------------------------------------------ types

  private parseTypeExpr(): TypeExpr {
    return this.nested(() => this.parseTypeExprInner());
  }

  private parseTypeExprInner(): TypeExpr {
    this.skipNewlines();
    const start = this.cur();
    if (this.at('fn')) {
      this.advance();
      this.expect('(', 'in a function type');
      const params: TypeExpr[] = [];
      this.inBrackets(() => {
        this.skipNewlines();
        while (!this.at(')') && !this.at('eof')) {
          params.push(this.parseTypeExpr());
          this.skipNewlines();
          if (!this.eat(',')) break;
          this.skipNewlines();
        }
      });
      this.expect(')', 'in a function type');
      let ret: TypeExpr | undefined;
      if (this.eat('->')) ret = this.parseTypeExpr();
      return { kind: 'TypeFn', params, ret, span: this.spanFrom(start) };
    }

    const name = this.expect('ident', 'as a type name');
    const args: TypeExpr[] = [];
    if (this.at('<')) {
      this.advance();
      this.inBrackets(() => {
        this.skipNewlines();
        while (!this.at('>') && !this.at('eof')) {
          args.push(this.parseTypeExpr());
          this.skipNewlines();
          if (!this.eat(',')) break;
          this.skipNewlines();
        }
      });
      this.expect('>', 'to close the type arguments');
    }
    return { kind: 'TypeName', name: name.text, args, span: this.spanFrom(start) };
  }

  // --------------------------------------------------------------- patterns

  private parsePattern(): Pattern {
    return this.nested(() => this.parsePatternInner());
  }

  private parsePatternInner(): Pattern {
    const start = this.cur();

    if (this.at('ident') && start.text === '_') {
      this.advance();
      return { kind: 'PWildcard', span: start.span };
    }

    if (this.atAny('number', 'string', 'true', 'false', 'nil')) {
      const value = this.parsePrimary();
      return { kind: 'PLiteral', value, span: this.spanFrom(start) };
    }

    // Negative numeric literal, e.g. `-1 => ...`.
    if (this.at('-') && this.tokens[this.i + 1]?.kind === 'number') {
      this.advance();
      const numTok = this.advance();
      return {
        kind: 'PLiteral',
        value: { kind: 'NumberLit', value: -(numTok.num ?? 0), span: this.spanFrom(start) },
        span: this.spanFrom(start),
      };
    }

    if (this.at('[')) {
      this.advance();
      const items: Pattern[] = [];
      let rest: string | undefined;
      this.inBrackets(() => {
        this.skipNewlines();
        while (!this.at(']') && !this.at('eof')) {
          if (this.eat('..')) {
            rest = this.expect('ident', 'after `..` in a list pattern').text;
            this.skipNewlines();
            break;
          }
          items.push(this.parsePattern());
          this.skipNewlines();
          if (!this.eat(',')) break;
          this.skipNewlines();
        }
        this.skipNewlines();
      });
      this.expect(']', 'to close a list pattern');
      return { kind: 'PList', items, rest, span: this.spanFrom(start) };
    }

    if (this.at('ident')) {
      const nameTok = this.advance();
      const name = nameTok.text;

      // Qualified variant: `Status.Done`, `Status.Circle(r)`.
      if (this.at('.')) {
        this.advance();
        const variant = this.expect('ident', 'after `.` in a pattern');
        const args = this.parsePatternArgs();
        return {
          kind: 'PEnum',
          enumName: name,
          variant: variant.text,
          args,
          span: this.spanFrom(start),
        };
      }

      // Struct pattern: `Task { title, done: true }`.
      if (this.at('{')) {
        this.advance();
        const fields: { name: string; pattern: Pattern }[] = [];
        this.inBrackets(() => {
          this.skipNewlines();
          while (!this.at('}') && !this.at('eof')) {
            const fName = this.expectName('as a field name in a struct pattern');
            let pattern: Pattern;
            if (this.eat(':')) {
              pattern = this.parsePattern();
            } else {
              // Shorthand `{ title }` binds the field to a variable of that name.
              pattern = { kind: 'PBinding', name: fName.text, span: fName.span };
            }
            fields.push({ name: fName.text, pattern });
            this.skipNewlines();
            if (!this.eat(',')) break;
            this.skipNewlines();
          }
          this.skipNewlines();
        });
        this.expect('}', 'to close a struct pattern');
        return { kind: 'PStruct', name, fields, span: this.spanFrom(start) };
      }

      // Unqualified variant with a payload: `Ok(v)`, `Some(x)`.
      if (this.at('(')) {
        const args = this.parsePatternArgs();
        return { kind: 'PEnum', enumName: undefined, variant: name, args, span: this.spanFrom(start) };
      }

      // A bare name. Lumen's naming convention decides: an initial capital is a
      // nullary variant (`None`, `Done`), anything else binds a variable.
      const initial = name[0] ?? '';
      if (initial >= 'A' && initial <= 'Z') {
        return { kind: 'PEnum', enumName: undefined, variant: name, args: [], span: start.span };
      }
      return { kind: 'PBinding', name, span: start.span };
    }

    return this.fail(
      'PA007',
      'expected a pattern, found ' + this.found(this.cur()),
      'not a pattern',
      [{ message: 'patterns are `_`, a name, a literal, `Name(..)`, `Name { .. }`, or `[..]`' }],
    );
  }

  private parsePatternArgs(): Pattern[] {
    if (!this.at('(')) return [];
    this.advance();
    const args: Pattern[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at(')') && !this.at('eof')) {
        args.push(this.parsePattern());
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect(')', 'to close a pattern');
    return args;
  }

  // ------------------------------------------------------------ expressions

  private parseExpr(): Expr {
    return this.nested(() => this.parseAssign());
  }

  /**
   * Bound how deeply the parser may recurse.
   *
   * Without this, source nested a thousand levels deep exhausted the host's
   * stack, and what the user saw was a bare "stack overflow — a function is
   * probably recursing without a base case": not what happened, and nothing
   * they could act on. A parser should not need the host's stack to still be
   * standing in order to report an error.
   *
   * The limit bounds every later walk of the tree as well — the resolver, the
   * type checker, `display`, equality — since none of them can meet a tree
   * deeper than the parser was willing to build.
   *
   * 250 is far past anything written by hand and well short of where the
   * stack gives out, which is somewhere between 500 and 1000.
   */
  /**
   * `PA016`, wherever the limit is reached.
   *
   * `what` names the thing there is too much of, because the two shapes that
   * get here are not the same shape: one is genuinely nested, the other is a
   * flat chain of operators that nests only in the tree it produces.
   */
  private tooDeep(what: string): never {
    return this.fail(
      'PA016',
      'nested too deeply',
      'more than ' + String(MAX_NESTING) + ' ' + what + ' here',
      [{ message: 'this is usually generated source; break it into named parts' }],
    );
  }

  private nested<T>(parse: () => T): T {
    if (this.depth >= MAX_NESTING) {
      return this.tooDeep('levels');
    }
    this.depth += 1;
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
  }

  private parseAssign(): Expr {
    const start = this.cur();
    const left = this.parseBinary(2);
    if (!this.atAny(...ASSIGN_OPS)) return left;

    const opTok = this.advance();
    this.skipNewlines();
    // Right-associative, and so recursive: `x = x = x = …` is a deep tree.
    const value = this.nested(() => this.parseAssign());
    // `[a, b] = [b, a]` assigns positionally, so a swap is one line. Only
    // plain `=`: `[a, b] += ...` has no sensible meaning.
    const destructuring = left.kind === 'ListLit' && opTok.kind === '=';
    if (destructuring && !isAssignTarget(left)) {
      this.report({
        severity: 'error',
        code: 'PA008',
        message: 'cannot assign to this expression',
        span: left.span,
        label: 'not every element is a place that can hold a value',
        notes: [
          { message: 'each element must be a variable, a field, or an index expression' },
        ],
      });
      throw new ParseAbort();
    }
    if (!destructuring && left.kind !== 'Ident' && left.kind !== 'MemberExpr' && left.kind !== 'IndexExpr') {
      // `if x > 0 and x = 4 {` is this: `=` binds loosest, so the target is
      // `x > 0 and x`. In a control-flow header the mistake is almost always
      // `==`, and the standing note about assignment targets, though true,
      // would send somebody looking for a different place to store a value.
      const inCondition = this.conditions > 0;
      this.report({
        severity: 'error',
        code: 'PA008',
        message: 'cannot assign to this expression',
        span: left.span,
        label: 'not a place that can hold a value',
        notes: [
          ...(inCondition
            ? [{ message: 'did you mean `==`? `=` assigns, and takes everything before it as the target' }]
            : []),
          {
            message:
              'assignment targets are variables, fields, index expressions, ' +
              'or a list of those: `[a, b] = [b, a]`',
          },
        ],
      });
      throw new ParseAbort();
    }
    return {
      kind: 'AssignExpr',
      op: opTok.kind as '=' | '+=' | '-=' | '*=' | '/=',
      target: left,
      value,
      span: this.spanFrom(start),
    };
  }

  private parseBinary(minPrec: number): Expr {
    const start = this.cur();
    let left = this.parseUnary();
    // Every operator chained at this level adds a level to the tree, even
    // though the parser is looping rather than recursing — and every later walk
    // of that tree *does* recurse. `nested`'s comment claims the limit "bounds
    // every later walk of the tree as well, since none of them can meet a tree
    // deeper than the parser was willing to build", and for a flat chain that
    // was not true: `1 + 1 + ...` three thousand times parsed at depth 1 and
    // then took the type checker's stack out with a bare `RangeError`.
    let chained = 0;

    for (;;) {
      this.skipNewlinesBeforeContinuation();
      const tok = this.cur();
      const prec = PRECEDENCE[tok.kind];
      if (prec === undefined || prec < minPrec) break;

      chained += 1;
      if (this.depth + chained >= MAX_NESTING) return this.tooDeep('chained operators');

      this.advance();
      this.skipNewlines();
      // A right-associative operator re-enters at its own level, so the next
      // one of the same kind lands in the right operand rather than closing
      // this one.
      // Counted: a right-associative operator re-enters at its own level, so a
      // chain of `**` recurses here rather than looping above, and the
      // `chained` counter never sees it.
      const right = this.nested(() =>
        this.parseBinary(RIGHT_ASSOCIATIVE.includes(tok.kind) ? prec : prec + 1),
      );
      const nodeSpan = this.spanFrom(start);

      switch (tok.kind) {
        case '|>':
          left = { kind: 'PipelineExpr', left, right, span: nodeSpan };
          break;
        case '&&':
        case 'and':
          left = { kind: 'Logical', op: '&&', left, right, span: nodeSpan };
          break;
        case '||':
        case 'or':
          left = { kind: 'Logical', op: '||', left, right, span: nodeSpan };
          break;
        case '..':
          left = { kind: 'RangeExpr', start: left, end: right, span: nodeSpan };
          break;
        default:
          left = {
            kind: 'Binary',
            op: tok.kind as BinaryOp,
            left,
            right,
            span: nodeSpan,
          };
      }
    }
    return left;
  }

  private parseUnary(): Expr {
    const start = this.cur();
    if (this.atAny('-', '!', 'not')) {
      const op = this.advance();
      this.skipNewlines();
      // Counted, because this recursion is the parser's own stack: `nested`
      // wraps a whole expression once, so three thousand `-` in a row all sat
      // at depth 1 and overflowed before any limit was consulted.
      const operand = this.nested(() => this.parseUnary());

      // `-2 ** 2` is refused rather than answered. Both readings are defensible
      // — Python reads it as `-(2 ** 2)`, which is -4, and binding the unary
      // first gives `(-2) ** 2`, which is 4 — and a reader coming from either
      // language is entitled to assume theirs. Choosing one silently means
      // somebody's arithmetic is wrong with nothing to show them why, so the
      // parentheses are required. JavaScript made the same call.
      if (this.at('**')) {
        const unary = op.kind === 'not' ? 'not' : op.text;
        this.fail(
          'PA018',
          'ambiguous `' + unary + '` before `**`',
          'add parentheses to say which comes first',
          [
            { message: 'write `' + unary + '(… ** …)` to raise first, then apply `' + unary + '`' },
            { message: 'write `(' + unary + ' …) ** …` to apply `' + unary + '` first, then raise' },
            ...(op.kind === '-'
              ? [{ message: 'Python reads `-2 ** 2` as the first, which is -4; Lumen will not guess' }]
              : []),
          ],
        );
      }

      return {
        kind: 'Unary',
        op: op.kind === 'not' ? 'not' : (op.kind as '-' | '!'),
        operand,
        span: this.spanFrom(start),
      };
    }
    if (this.at('await')) {
      this.advance();
      this.skipNewlines();
      const operand = this.parseUnary();
      return { kind: 'AwaitExpr', operand, span: this.spanFrom(start) };
    }
    // `return`, `break` and `continue` are also expressions. They produce no
    // value, so this is not about composing them — it is so a `match` arm or
    // an `if` branch can leave, which is where wanting them is common.
    if (this.atAny('return', 'break', 'continue')) {
      const word = this.advance();
      const jump = word.kind as 'return' | 'break' | 'continue';
      // A value binds as loosely as possible: `return a + b` returns the sum.
      // Everything that can close an expression ends it instead.
      const value =
        jump === 'return' && !this.atAny('newline', ';', ',', ')', ']', '}', 'eof')
          ? this.parseExpr()
          : undefined;
      return { kind: 'JumpExpr', jump, value, span: this.spanFrom(start) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    const start = this.cur();
    let expr = this.parsePrimary();
    // One level of tree per suffix, the same as a chained binary operator:
    // `a[0][0][0]…` and `m.a.a.a…` are loops here and a deep spine afterwards.
    let suffixes = 0;

    for (;;) {
      this.skipNewlinesBeforeContinuation();
      if (this.atAny('(', '[', '.', '?')) {
        suffixes += 1;
        if (this.depth + suffixes >= MAX_NESTING) return this.tooDeep('chained suffixes');
      }

      if (this.at('(')) {
        this.advance();
        const args = this.parseArgs();
        expr = { kind: 'CallExpr', callee: expr, args, span: this.spanFrom(start) };
        continue;
      }
      if (this.at('[')) {
        this.advance();
        const index = this.inBrackets(() => {
          this.skipNewlines();
          const e = this.parseExpr();
          this.skipNewlines();
          return e;
        });
        this.expect(']', 'to close an index expression');
        expr = { kind: 'IndexExpr', target: expr, index, span: this.spanFrom(start) };
        continue;
      }
      if (this.atAny('.', '?.')) {
        const opTok = this.advance();
        this.skipNewlines();
        const name = this.expectName('after `' + opTok.kind + '`');
        expr = {
          kind: 'MemberExpr',
          target: expr,
          name: name.text,
          optional: opTok.kind === '?.',
          span: this.spanFrom(start),
        };
        continue;
      }
      if (this.at('?')) {
        this.advance();
        expr = { kind: 'TryExpr', operand: expr, span: this.spanFrom(start) };
        continue;
      }
      return expr;
    }
  }

  private parseArgs(): Arg[] {
    const args: Arg[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at(')') && !this.at('eof')) {
        const argStart = this.cur();
        let name: string | undefined;
        // A named argument is `ident :` — unambiguous, since Lumen has no
        // ternary operator competing for the colon.
        if (
          (this.at('ident') || KEYWORDS.has(this.cur().text)) &&
          this.tokens[this.i + 1]?.kind === ':'
        ) {
          name = this.advance().text;
          this.advance(); // ':'
          this.skipNewlines();
        }
        const value = this.parseExpr();
        args.push({ name, value, span: this.spanFrom(argStart) });
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect(')', 'to close this call');
    return args;
  }

  /** True when the `{` at the cursor begins `{ key: value }` rather than a block. */
  private looksLikeBraceLiteral(): boolean {
    let j = this.i + 1; // past '{'
    while (this.tokens[j]?.kind === 'newline') j += 1;
    const first = this.tokens[j];
    if (first === undefined) return false;
    if (first.kind === '}') return true; // `{}` is an empty map / empty struct
    if (!isNameLike(first)) return false;
    return this.tokens[j + 1]?.kind === ':';
  }

  /**
   * As above, but for deciding whether to *complain* rather than to parse.
   *
   * `{}` is excluded: in a header it is far more likely an empty body — `if
   * ready {}` — than an empty struct, and a false accusation is worse than the
   * cascade it would have prevented.
   */
  private looksLikeStructLitInHeader(): boolean {
    let j = this.i + 1; // past '{'
    while (this.tokens[j]?.kind === 'newline') j += 1;
    const first = this.tokens[j];
    if (first === undefined) return false;
    if (!isNameLike(first)) return false;
    return this.tokens[j + 1]?.kind === ':';
  }

  private parsePrimary(): Expr {
    const tok = this.cur();

    switch (tok.kind) {
      case 'number':
        this.advance();
        return { kind: 'NumberLit', value: tok.num ?? 0, span: tok.span };

      case 'string':
        this.advance();
        return { kind: 'StringLit', value: tok.str ?? '', span: tok.span };

      case 'template':
        this.advance();
        return this.parseTemplate(tok);

      case 'true':
      case 'false':
        this.advance();
        return { kind: 'BoolLit', value: tok.kind === 'true', span: tok.span };

      case 'nil':
        this.advance();
        return { kind: 'NilLit', span: tok.span };

      case '(': {
        this.advance();
        const inner = this.inBrackets(() => {
          this.skipNewlines();
          const e = this.parseExpr();
          this.skipNewlines();
          return e;
        });
        this.expect(')', 'to close a parenthesised expression');
        return inner;
      }

      case '[': {
        this.advance();
        const items: Expr[] = [];
        this.inBrackets(() => {
          this.skipNewlines();
          while (!this.at(']') && !this.at('eof')) {
            items.push(this.parseExpr());
            this.skipNewlines();
            if (!this.eat(',')) break;
            this.skipNewlines();
          }
          this.skipNewlines();
        });
        this.expect(']', 'to close a list literal');
        return { kind: 'ListLit', items, span: this.spanFrom(tok) };
      }

      case '{': {
        if (this.noBraceLit > 0) {
          return this.fail(
            'PA009',
            'a map literal cannot appear here',
            'unexpected `{`',
            [
              {
                message:
                  'inside an `if`, `while`, `for` or `match` header a `{` starts the body; ' +
                  'wrap the map in parentheses if you meant a value',
              },
            ],
          );
        }
        return this.parseMapLit();
      }

      case 'fn': {
        this.advance();
        const params = this.parseParamList();
        let ret: TypeExpr | undefined;
        if (this.eat('->')) {
          this.skipNewlines();
          ret = this.parseTypeExpr();
        }
        this.skipNewlines();
        const body = this.parseBlock();
        return { kind: 'LambdaExpr', params, ret, body, span: this.spanFrom(tok) };
      }

      case 'if':
        return this.parseIf();

      case 'match':
        return this.parseMatch();

      case 'ident': {
        this.advance();
        // In a header the `{` belongs to the body, so a struct literal there is
        // ambiguous. Say so once, rather than letting the body be parsed as
        // field syntax and reporting nine errors about the wreckage.
        const ambiguousHeaderStruct =
          this.noBraceLit > 0 && this.at('{') && this.looksLikeStructLitInHeader();
        if (ambiguousHeaderStruct) {
          this.report({
            severity: 'error',
            code: 'PA015',
            message: 'a struct literal cannot appear here',
            span: this.cur().span,
            label: 'unexpected `{`',
            notes: [
              {
                message:
                  'inside an `if`, `while`, `for` or `match` header a `{` starts the body; ' +
                  'wrap the struct in parentheses if you meant a value: `(' +
                  tok.text +
                  ' { ... })`',
              },
            ],
          });
          // Then parse it as the struct literal it plainly is, so the rest of
          // the line still makes sense and this is the only error reported.
        }
        // `Name { field: value }` — a struct literal, unless we are in a header.
        if (
          this.at('{') &&
          (ambiguousHeaderStruct || (this.noBraceLit === 0 && this.looksLikeBraceLiteral()))
        ) {
          this.advance();
          const fields: FieldInit[] = [];
          this.inBrackets(() => {
            this.skipNewlines();
            while (!this.at('}') && !this.at('eof')) {
              const fName = this.expectName('as a field name');
              this.expect(':', 'after a field name');
              this.skipNewlines();
              const value = this.parseExpr();
              fields.push({ name: fName.text, value, span: this.spanFrom(fName) });
              this.skipNewlines();
              if (!this.eat(',')) break;
              this.skipNewlines();
            }
            this.skipNewlines();
          });
          this.expect('}', 'to close a struct literal');
          return {
            kind: 'StructLit',
            name: tok.text,
            nameSpan: tok.span,
            fields,
            span: this.spanFrom(tok),
          };
        }
        return { kind: 'Ident', name: tok.text, span: tok.span };
      }

      default:
        return this.fail(
          'PA010',
          'expected an expression, found ' + this.found(tok),
          'not an expression',
        );
    }
  }

  private parseMapLit(): Expr {
    const start = this.expect('{', 'to start a map literal');
    const entries: MapEntry[] = [];
    this.inBrackets(() => {
      this.skipNewlines();
      while (!this.at('}') && !this.at('eof')) {
        const eStart = this.cur();
        let key: Expr;
        if (this.at('ident') || KEYWORDS.has(this.cur().text)) {
          const k = this.advance();
          key = { kind: 'StringLit', value: k.text, span: k.span };
        } else if (this.at('string')) {
          const k = this.advance();
          key = { kind: 'StringLit', value: k.str ?? '', span: k.span };
        } else if (this.at('[')) {
          // Computed key: `[expr]: value`.
          this.advance();
          key = this.parseExpr();
          this.expect(']', 'to close a computed key');
        } else {
          this.fail(
            'PA011',
            'expected a map key, found ' + this.found(this.cur()),
            'not a key',
            [{ message: 'keys are names, strings, or `[expr]` for a computed key' }],
          );
        }
        this.expect(':', 'after a map key');
        this.skipNewlines();
        const value = this.parseExpr();
        entries.push({ key, value, span: this.spanFrom(eStart) });
        this.skipNewlines();
        if (!this.eat(',')) break;
        this.skipNewlines();
      }
      this.skipNewlines();
    });
    this.expect('}', 'to close a map literal');
    return { kind: 'MapLit', entries, span: this.spanFrom(start) };
  }

  private parseIf(): Expr {
    const start = this.expect('if', 'to start a conditional');
    const condition = this.inCondition(() => this.parseExpr());
    this.skipNewlines();
    const then = this.parseBlock();

    let otherwise: Block | Expr | undefined;
    // `else` may sit on the next line.
    const savedIndex = this.i;
    this.skipNewlines();
    if (this.at('else')) {
      this.advance();
      this.skipNewlines();
      otherwise = this.at('if') ? this.parseIf() : this.parseBlock();
    } else {
      this.i = savedIndex;
    }

    if (otherwise !== undefined && otherwise.kind !== 'Block' && otherwise.kind !== 'IfExpr') {
      // parseIf only ever yields IfExpr, so this is unreachable in practice.
      this.fail('PA012', 'malformed `else` branch', 'expected a block or `if`');
    }
    return {
      kind: 'IfExpr',
      condition,
      then,
      otherwise: otherwise as Block | undefined,
      span: this.spanFrom(start),
    };
  }

  private parseMatch(): Expr {
    const start = this.expect('match', 'to start a match');
    const subject = this.inHeader(() => this.parseExpr());
    this.skipNewlines();
    this.expect('{', 'to start the match arms');

    const arms: MatchArm[] = [];
    const saved = this.noBraceLit;
    this.noBraceLit = 0;
    try {
      this.skipNewlines();
      while (!this.at('}') && !this.at('eof')) {
        const armStart = this.cur();
        const pattern = this.parsePattern();
        let guard: Expr | undefined;
        if (this.eat('if')) {
          this.skipNewlines();
          guard = this.inCondition(() => this.parseExpr());
        }
        this.expect('=>', 'after a match pattern');
        this.skipNewlines();
        // A `{` here is a block body, not a map literal.
        const body: Expr = this.at('{')
          ? (() => {
              const block = this.parseBlock();
              return { kind: 'BlockExpr' as const, block, span: block.span };
            })()
          : this.parseExpr();
        arms.push({ pattern, guard, body, span: this.spanFrom(armStart) });
        this.skipNewlines();
        if (!this.eat(',')) {
          this.skipNewlines();
          if (!this.at('}') && !this.at('eof')) continue;
          break;
        }
        this.skipNewlines();
      }
    } finally {
      this.noBraceLit = saved;
    }
    this.expect('}', 'to close the match arms');
    if (arms.length === 0) {
      this.report({
        severity: 'error',
        code: 'PA013',
        message: 'a `match` must have at least one arm',
        span: this.spanFrom(start),
        label: 'no arms here',
      });
    }
    return { kind: 'MatchExpr', subject, arms, span: this.spanFrom(start) };
  }

  /**
   * Build a template literal, re-lexing and re-parsing each `${...}` from its
   * captured source. The sub-lexer is seeded with the fragment's absolute
   * position so diagnostics inside an interpolation point at the real file.
   */
  private parseTemplate(tok: Token): Expr {
    const parts: ({ kind: 'text'; value: string } | { kind: 'expr'; expr: Expr })[] = [];
    for (const part of tok.parts ?? []) {
      if (part.kind === 'text') {
        parts.push({ kind: 'text', value: part.value });
        continue;
      }
      try {
        const subTokens = lex(part.source, this.file, part.span.start);
        // The depth is passed on, so `"${"${…}"}"` shares one budget with the
        // file it is in rather than starting again from zero.
        const sub = new Parser(subTokens, this.file, this.source, this.depth + 1, 'interpolation');
        parts.push({ kind: 'expr', expr: sub.parseExpressionEntry() });
      } catch (err) {
        if (err instanceof LumenError) {
          this.diagnostics.push(...err.diagnostics);
          throw new ParseAbort();
        }
        throw err;
      }
    }
    return { kind: 'TemplateLit', parts, span: tok.span };
  }
}

/** Parse a whole module. Throws `LumenError` with every diagnostic found. */
export function parse(source: string, file = '<input>'): Module {
  const tokens = lex(source, file);
  return new Parser(tokens, file, source).parseModule();
}

/**
 * Parse exactly one expression, rejecting anything after it.
 *
 * Part of the embedding surface rather than of the pipeline: the REPL parses
 * whole statements, like everything else that runs a program. This is for a
 * host that wants one expression and no more — a watch window, a `--eval` flag,
 * a language server asked about a selection. Its docstring used to claim the
 * REPL used it, which was how it went unnoticed that nothing did.
 */
export function parseExpression(source: string, file = '<input>'): Expr {
  const tokens = lex(source, file);
  return new Parser(tokens, file, source).parseExpressionEntry();
}

/**
 * The bare name a statement ends in, if it ends in one: `def` in `def f(x):`,
 * `lambda` in `let f = lambda x: x + 1`, `new` in `p = new Point()`.
 */
function trailingName(stmt: Stmt | undefined): string | undefined {
  if (stmt === undefined) return undefined;
  const expr =
    stmt.kind === 'ExprStmt'
      ? stmt.expr.kind === 'AssignExpr'
        ? stmt.expr.value
        : stmt.expr
      : stmt.kind === 'LetDecl' || stmt.kind === 'ReturnStmt'
        ? stmt.value
        : undefined;
  return expr?.kind === 'Ident' ? expr.name : undefined;
}
