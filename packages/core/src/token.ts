/** Token kinds and the keyword table. */

import type { Span } from './diagnostics.js';

/**
 * Token kinds are spelled as the literal lexeme wherever one exists, so parser
 * code reads like the grammar: `expect('(')`, `match('|>')`, `at('else')`.
 */
export type TokenKind =
  // literals and names
  | 'number'
  | 'string'
  | 'template'
  | 'ident'
  // keywords
  | 'let'
  | 'var'
  | 'fn'
  | 'return'
  | 'if'
  | 'else'
  | 'while'
  | 'for'
  | 'in'
  | 'match'
  | 'struct'
  | 'enum'
  | 'import'
  | 'export'
  | 'from'
  | 'break'
  | 'continue'
  | 'true'
  | 'false'
  | 'nil'
  | 'and'
  | 'or'
  | 'not'
  | 'async'
  | 'await'
  // operators and punctuation
  | '+'
  | '-'
  | '*'
  | '**'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '='
  | '+='
  | '-='
  | '*='
  | '/='
  | '!'
  | '&&'
  | '||'
  | '|>'
  | '?'
  | '?.'
  | '.'
  | ','
  | ';'
  | ':'
  | '->'
  | '=>'
  | '..'
  | '('
  | ')'
  | '{'
  | '}'
  | '['
  | ']'
  // structural
  | 'newline'
  | 'eof';

/** One segment of an interpolated string: literal text, or an embedded expression. */
export type TemplatePart =
  | { readonly kind: 'text'; readonly value: string }
  /**
   * `source` is the raw text between `${` and `}`. `span` locates it in the
   * enclosing file so the sub-parser can report positions that point at the
   * real source rather than at an offset inside a detached substring.
   */
  | { readonly kind: 'expr'; readonly source: string; readonly span: Span };

export interface Token {
  readonly kind: TokenKind;
  /** The raw lexeme as it appeared in the source. */
  readonly text: string;
  readonly span: Span;
  /** Present when `kind === 'number'`. */
  readonly num?: number;
  /** Present when `kind === 'string'` — escapes already resolved. */
  readonly str?: string;
  /** Present when `kind === 'template'`. */
  readonly parts?: readonly TemplatePart[];
}

/** Where a comment was, for the formatter. Comments never reach the parser. */
export interface Comment {
  readonly span: Span;
  /** True for `/* ... *\/`, which may span lines. */
  readonly block: boolean;
}

/**
 * The reserved words, as a `Map` rather than an object literal.
 *
 * An object literal inherits `Object.prototype`, so `KEYWORDS['valueOf']`
 * would answer with a JavaScript function and the lexer would take it for a
 * keyword — which is how `let valueOf = 1` came to be a syntax error. A `Map`
 * has no inherited keys, so a Lumen identifier is only ever compared against
 * the words written below.
 */
export const KEYWORDS: ReadonlyMap<string, TokenKind> = new Map<string, TokenKind>(
  Object.entries({
  let: 'let',
  var: 'var',
  fn: 'fn',
  return: 'return',
  if: 'if',
  else: 'else',
  while: 'while',
  for: 'for',
  in: 'in',
  match: 'match',
  struct: 'struct',
  enum: 'enum',
  import: 'import',
  export: 'export',
  from: 'from',
  break: 'break',
  continue: 'continue',
  true: 'true',
  false: 'false',
  nil: 'nil',
  and: 'and',
  or: 'or',
  not: 'not',
  async: 'async',
  await: 'await',
  } as const),
);

/**
 * Multi-character operators, longest first. The lexer walks this list in order,
 * so `<=` is matched before `<` and `|>` before `|`.
 */
export const OPERATORS: readonly TokenKind[] = [
  '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=',
  // `**` must precede `*=`: `**=` is not an operator, but `2 **= 3` would
  // otherwise lex as `*` `*=` and report something about assignment.
  '**',
  '&&', '||', '|>', '?.', '->', '=>', '..',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '?',
  '.', ',', ';', ':', '(', ')', '{', '}', '[', ']',
];

/** Human phrasing for a token kind, for use inside error messages. */
export function describe(kind: TokenKind): string {
  switch (kind) {
    case 'ident':
      return 'an identifier';
    case 'number':
      return 'a number';
    case 'string':
    case 'template':
      return 'a string';
    case 'newline':
      return 'a line break';
    case 'eof':
      return 'end of file';
    default:
      return '`' + kind + '`';
  }
}

/** How a token actually appeared, for "found X" halves of error messages. */
export function describeToken(tok: Token): string {
  switch (tok.kind) {
    case 'ident':
      return '`' + tok.text + '`';
    case 'number':
      return '`' + tok.text + '`';
    case 'string':
    case 'template':
      return 'a string';
    case 'newline':
      return 'a line break';
    case 'eof':
      return 'end of file';
    default:
      return '`' + tok.kind + '`';
  }
}
