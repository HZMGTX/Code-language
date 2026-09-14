/**
 * Source positions, spans, and human-readable diagnostics.
 *
 * Every error Lumen reports carries a span, and every span can be rendered
 * against the original source with a caret pointing at the offending text.
 * Good error messages are a language feature, not a nicety.
 */

/** A single point in a source file. `line` and `col` are 1-based. */
export interface Pos {
  readonly offset: number;
  readonly line: number;
  readonly col: number;
}

/** A half-open range `[start, end)` in a source file. */
export interface Span {
  readonly start: Pos;
  readonly end: Pos;
}

/**
 * How loud a diagnostic is.
 *
 * Only `'error'` is ever produced today: every static check in this language
 * either rejects a program or says nothing, because a check that is merely
 * advisory trains people to ignore the output. `'warning'` exists for the
 * unused-binding check the roadmap wants, which is the first thing that should
 * be reported without failing the build, and the renderer already knows to draw
 * it yellow — see the `renders a warning` test, which is what keeps that branch
 * honest until something emits one.
 */
export type Severity = 'error' | 'warning';

/** An extra line of explanation attached to a diagnostic, optionally located. */
export interface Note {
  readonly message: string;
  readonly span?: Span;
}

export interface Diagnostic {
  readonly severity: Severity;
  /** Stable machine-readable code, e.g. `LX002`, `PA007`, `RT003`. */
  readonly code: string;
  readonly message: string;
  readonly span: Span;
  /** Short text rendered next to the caret, e.g. "expected `)`". */
  readonly label?: string;
  readonly notes?: readonly Note[];
}

export function pos(offset: number, line: number, col: number): Pos {
  return { offset, line, col };
}

export function span(start: Pos, end: Pos): Span {
  return { start, end };
}

/** Smallest span covering both inputs. */
export function joinSpans(a: Span, b: Span): Span {
  return {
    start: a.start.offset <= b.start.offset ? a.start : b.start,
    end: a.end.offset >= b.end.offset ? a.end : b.end,
  };
}

/**
 * The one error type Lumen throws out of compilation and execution.
 * It carries diagnostics rather than a flat message so the CLI can render
 * all of them against the source.
 */
export class LumenError extends Error {
  readonly diagnostics: readonly Diagnostic[];
  readonly file: string;
  readonly source: string;

  constructor(diagnostics: readonly Diagnostic[], file: string, source: string) {
    const first = diagnostics[0];
    super(first ? first.message : 'unknown error');
    this.name = 'LumenError';
    this.diagnostics = diagnostics;
    this.file = file;
    this.source = source;
  }

  /** Full rendered report, ready to print to stderr. */
  render(color = false): string {
    return this.diagnostics
      .map((d) => formatDiagnostic(d, this.source, this.file, color))
      .join('\n\n');
  }
}

const ESC = String.fromCharCode(27);
const RESET = ESC + '[0m';
const BOLD = ESC + '[1m';
const DIM = ESC + '[2m';
const RED = ESC + '[31m';
const YELLOW = ESC + '[33m';
const BLUE = ESC + '[34m';

function paint(text: string, code: string, color: boolean): string {
  return color ? code + text + RESET : text;
}

function lineOf(source: string, lineNo: number): string {
  return source.split('\n')[lineNo - 1] ?? '';
}

/** How much of a source line to show around the caret before eliding. */
const MAX_LINE = 120;
/** Characters of context kept on each side of the caret when eliding. */
const CONTEXT = 40;

/**
 * Narrow a very long source line to a window around the caret.
 *
 * A minified file, or generated source, can put the whole program on one line,
 * and printing it in full buries the caret somewhere off the right of the
 * screen — which makes the diagnostic worse than no diagnostic. Returns the
 * text to show and the column the caret now sits at.
 */
function window(text: string, caretCol: number, width: number): { text: string; col: number } {
  if (text.length <= MAX_LINE) return { text, col: caretCol };

  const ellipsis = '...';
  const from = Math.max(0, caretCol - 1 - CONTEXT);
  // Keep the whole caret run if it fits, so the elision never lands inside it.
  const to = Math.min(text.length, caretCol - 1 + Math.min(width, CONTEXT) + CONTEXT);
  const head = from > 0 ? ellipsis : '';
  const tail = to < text.length ? ellipsis : '';
  return { text: head + text.slice(from, to) + tail, col: caretCol - from + head.length };
}

/**
 * Render one diagnostic in the style:
 *
 * ```
 * error[PA004]: expected `)` to close this call
 *   --> app.lm:12:10
 *    |
 * 12 |   print(x
 *    |          ^ expected `)`
 *    |
 *    = note: the call opened on line 12
 * ```
 */
export function formatDiagnostic(
  d: Diagnostic,
  source: string,
  file: string,
  color = false,
): string {
  const sevColor = d.severity === 'error' ? RED : YELLOW;
  const out: string[] = [
    paint(d.severity + '[' + d.code + ']', BOLD + sevColor, color) +
      ': ' +
      paint(d.message, BOLD, color),
  ];

  const lineNo = d.span.start.line;
  const pad = ' '.repeat(String(lineNo).length);
  const bar = paint('|', BLUE, color);

  out.push(pad + paint('-->', BLUE, color) + ' ' + file + ':' + lineNo + ':' + d.span.start.col);
  out.push(pad + ' ' + bar);

  const full = lineOf(source, lineNo);

  // Caret run: at least one character wide, clipped to the line's length.
  const startCol = Math.max(1, d.span.start.col);
  const onOneLine = d.span.end.line === lineNo;
  const room = Math.max(1, full.length - startCol + 1);
  const wanted = onOneLine ? d.span.end.col - d.span.start.col : room;
  const width = Math.max(1, Math.min(wanted, room));

  const shown = window(full, startCol, width);
  const caretWidth = Math.max(1, Math.min(width, shown.text.length - shown.col + 1));
  out.push(paint(String(lineNo), BLUE, color) + ' ' + bar + ' ' + shown.text);

  const label = d.label ? ' ' + paint(d.label, sevColor, color) : '';
  out.push(
    pad + ' ' + bar + ' ' + ' '.repeat(shown.col - 1) +
      paint('^'.repeat(caretWidth), BOLD + sevColor, color) + label,
  );
  out.push(pad + ' ' + bar);

  for (const note of d.notes ?? []) {
    const where = note.span ? ' (' + file + ':' + note.span.start.line + ':' + note.span.start.col + ')' : '';
    out.push(pad + ' ' + paint('=', BLUE, color) + ' ' + paint('note', DIM, color) + ': ' + note.message + where);
  }

  return out.join('\n');
}
