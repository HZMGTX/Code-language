/**
 * One document, analysed once: diagnostics, types, and where names come from.
 *
 * Every editor feature reads from here rather than re-deriving anything. Hover
 * asking the checker a second time would be a second implementation of "what is
 * this", free to disagree with `lumen check` — and an editor that disagrees
 * with the compiler is worse than an editor with no hover.
 *
 * Positions line up exactly, which is luck worth writing down: the Lumen lexer
 * advances one JavaScript string index at a time, so a span's `offset` and
 * `col` count UTF-16 code units — which is precisely what LSP means by a
 * character, under its default `utf-16` encoding. The conversion is off-by-one
 * on the line and the column and nothing else.
 */

import {
  LumenError,
  checkModule,
  lex,
  parse,
  showTy,
  type Diagnostic,
  type Expr,
  type Module,
  type Reference,
  type Span,
  type Ty,
} from '@lumen-lang/core';
import { checkOptions } from '@lumen-lang/stdlib';

/** An LSP position: zero-based line, zero-based UTF-16 character. */
export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** Everything known about one open document. */
export interface Analysis {
  readonly uri: string;
  readonly version: number;
  readonly text: string;
  /** Undefined when the source could not be parsed at all. */
  readonly module: Module | undefined;
  /** Errors when the file has them, otherwise whatever warnings it has. */
  readonly diagnostics: readonly Diagnostic[];
  /** Every expression the checker typed, innermost last at a given position. */
  readonly types: readonly { expr: Expr; ty: Ty }[];
  /** Every name that resolved, and where it was declared. */
  readonly references: readonly Reference[];
}

/**
 * Parse and check one document.
 *
 * Never throws: an editor sends a document after every keystroke, and half of
 * those do not parse. A failure is diagnostics, which is what the editor wants
 * to draw anyway.
 */
export function analyse(uri: string, version: number, text: string, globals: readonly string[]): Analysis {
  const types: { expr: Expr; ty: Ty }[] = [];
  const references: Reference[] = [];
  const file = fileOf(uri);

  let module: Module | undefined;
  try {
    module = parse(text, file);
  } catch (error) {
    return {
      uri,
      version,
      text,
      module: undefined,
      diagnostics: diagnosticsOf(error),
      types,
      references,
    };
  }

  // `checkModule` throws on an error and *returns* the warnings, so the return
  // value is not a leftover to discard: dropping it is how an editor ends up
  // silent about `RS011` while `lumen check` reports it, which is exactly the
  // disagreement this module exists to prevent.
  let warnings: readonly Diagnostic[];
  try {
    warnings = checkModule(module, text, {
      ...checkOptions(globals),
      record: (expr, ty) => types.push({ expr, ty }),
      reference: (reference) => references.push(reference),
    });
  } catch (error) {
    return { uri, version, text, module, diagnostics: diagnosticsOf(error), types, references };
  }

  return { uri, version, text, module, diagnostics: warnings, types, references };
}

function diagnosticsOf(error: unknown): readonly Diagnostic[] {
  if (error instanceof LumenError) return error.diagnostics;
  // Anything else is a bug in the language rather than in the document, and
  // reporting it at the top of the file beats an editor that silently shows
  // nothing.
  return [
    {
      severity: 'error',
      code: 'LSP001',
      message: 'the language server failed to analyse this file: ' + String(error),
      span: {
        start: { offset: 0, line: 1, col: 1 },
        end: { offset: 0, line: 1, col: 1 },
      },
    },
  ];
}

/**
 * A placeholder name, inserted where the cursor is so a half-typed document
 * parses. Unlikely enough to collide with anything a person would write, and
 * a legal identifier so the parser is happy with it.
 */
const PLACEHOLDER = '__lumen_cursor__';

/**
 * Analyse a document that is being typed into, at a given offset.
 *
 * Completion is *always* asked for on source that does not parse — you have
 * just typed `s.` and there is no expression after the dot yet — so a server
 * that only understands complete documents has no receiver type exactly when
 * it needs one, and can only offer every method of every type at once.
 *
 * So the text is repaired first, in two attempts, and neither changes anything
 * before the cursor: the offsets of everything to the left stay exactly where
 * they were, which is what lets the caller ask about the receiver afterwards.
 *
 *   1. Put a name where the cursor is. `print(s.)` becomes `print(s.x)`, which
 *      is the case an editor that closes brackets for you produces.
 *   2. Failing that, keep only the text up to the cursor, add the name, and
 *      close whatever is still open. `print(s.` becomes `print(s.x)`. The rest
 *      of the document is discarded, which is right: if attempt 1 failed, the
 *      tail is what could not be parsed.
 *
 * Returns the original analysis when both fail, rather than nothing, so the
 * caller still has whatever the last complete version knew.
 */
export function analyseForCompletion(
  uri: string,
  text: string,
  offset: number,
  globals: readonly string[],
): Analysis {
  const whole = analyse(uri, 0, text, globals);
  if (whole.module !== undefined) return whole;

  // The placeholder has to be a name the resolver knows, or it reports it as
  // undefined and `checkModule` stops before the type checker runs — leaving
  // the repaired document parsed and completely untyped, which is the one
  // thing this function exists to avoid. In `print(s.x)` it is a member name
  // and nothing notices; in `padStart(x` it is an expression and everything
  // does.
  const known = [...globals, PLACEHOLDER];

  const inserted = text.slice(0, offset) + PLACEHOLDER + text.slice(offset);
  const withName = analyse(uri, 0, inserted, known);
  if (withName.module !== undefined) return withName;

  const prefix = text.slice(0, offset);
  const closed = prefix + PLACEHOLDER + closersFor(prefix);
  const truncated = analyse(uri, 0, closed, known);
  return truncated.module === undefined ? whole : truncated;
}

/**
 * The brackets left open in `text`, in the order that closes them.
 *
 * Counted from the token stream rather than from the characters, so a `(`
 * inside a string or a comment is not mistaken for one that needs closing.
 * A text that will not even lex has nothing to close as far as this is
 * concerned, which leaves the caller with the unrepaired analysis.
 */
function closersFor(text: string): string {
  const open: string[] = [];
  try {
    for (const token of lex(text, '<completion>')) {
      if (token.kind === '(' || token.kind === '[' || token.kind === '{') open.push(token.kind);
      else if (token.kind === ')' || token.kind === ']' || token.kind === '}') open.pop();
    }
  } catch {
    return '';
  }
  const close: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  return open
    .reverse()
    .map((bracket) => close[bracket] ?? '')
    .join('');
}

/** The path inside a `file://` URI, for diagnostics that name their file. */
export function fileOf(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return uri;
  }
}

// ------------------------------------------------------------- positions

/** A Lumen span as an LSP range. Lines and columns are one-based in Lumen. */
export function rangeOf(span: Span): Range {
  return {
    start: { line: span.start.line - 1, character: span.start.col - 1 },
    end: { line: span.end.line - 1, character: span.end.col - 1 },
  };
}

/**
 * An LSP position as an offset into the text.
 *
 * Clamped rather than trusted: an editor can ask about a position past the end
 * of a line it has just edited, and answering with `NaN` would turn a harmless
 * race into a broken feature.
 */
export function offsetOf(text: string, position: Position): number {
  let offset = 0;
  let line = 0;
  while (line < position.line) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return text.length;
    offset = next + 1;
    line += 1;
  }
  const lineEnd = text.indexOf('\n', offset);
  const limit = lineEnd === -1 ? text.length : lineEnd;
  return Math.min(offset + position.character, limit);
}

/** Whether `offset` falls inside `span`, treating the end as exclusive. */
export function within(span: Span, offset: number): boolean {
  return offset >= span.start.offset && offset < span.end.offset;
}

/** How many characters a span covers. Used to pick the smallest one. */
export function widthOf(span: Span): number {
  return span.end.offset - span.start.offset;
}

// --------------------------------------------------------------- queries

/**
 * The smallest typed expression containing `offset`.
 *
 * Smallest, because the types are recorded outermost first and every enclosing
 * expression also contains the position: hovering the `x` in `f(x) + 1` should
 * say what `x` is, not what the addition is.
 */
export function typeAt(analysis: Analysis, offset: number): { expr: Expr; ty: Ty } | undefined {
  let best: { expr: Expr; ty: Ty } | undefined;
  for (const entry of analysis.types) {
    if (!within(entry.expr.span, offset)) continue;
    if (best === undefined || widthOf(entry.expr.span) <= widthOf(best.expr.span)) best = entry;
  }
  return best;
}

/** The name used at `offset`, with where it was declared. */
export function referenceAt(analysis: Analysis, offset: number): Reference | undefined {
  let best: Reference | undefined;
  for (const reference of analysis.references) {
    if (!within(reference.use, offset)) continue;
    if (best === undefined || widthOf(reference.use) <= widthOf(best.use)) best = reference;
  }
  return best;
}

/** A type rendered for a person, with `Any` spelled out rather than omitted. */
export function describeTy(ty: Ty): string {
  return ty.k === 'any' ? 'Any' : showTy(ty);
}
