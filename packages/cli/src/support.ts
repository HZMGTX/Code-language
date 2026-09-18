/** Shared plumbing for the `lumen` commands. */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { Interpreter, LumenError, formatDiagnostic, type Diagnostic } from '@lumen-lang/core';
import { createInterpreter } from '@lumen-lang/stdlib';

export const VERSION = '0.2.0';

/** Colour is on for a terminal and off when piped, so output stays diffable. */
export function useColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '') return true;
  return process.stderr.isTTY === true;
}

/**
 * The arguments to hand the program, set once the command line is understood.
 *
 * The CLI is the only thing that knows how many words were its own: `run` takes
 * one more than the bare `lumen script.lm` shorthand. Working it out from a
 * fixed offset into `process.argv` is what made `args()` return the script's own
 * path for one spelling and not the other.
 */
let programArgs: readonly string[] = [];

export function setProgramArgs(args: readonly string[]): void {
  programArgs = args;
}

export function newInterpreter(): Interpreter {
  // The factory installs the prelude and the method tables, so the CLI, the
  // REPL and the tests all agree on what is in scope.
  return createInterpreter({ args: programArgs });
}

/**
 * Everything `checkModule` needs to know about the world outside the file.
 *
 * Re-exported from the standard library rather than assembled here, because
 * `globals` is the only part that differs between callers — the REPL's scope
 * grows as you type — and what the library exports and what any of it means
 * never does. Four commands call it: `run`, `check`, `test` and the REPL. A
 * check one of them performs and another skips is a program that passes
 * `lumen check` and fails `lumen run`.
 */
export { checkOptions } from '@lumen-lang/stdlib';

/**
 * Show warnings, and say nothing when there are none.
 *
 * Written once because four commands check a file, and a warning a command
 * swallows is a warning nobody ever acts on. They go to stderr so that piping
 * a program's output somewhere still gets the program's output — a warning is
 * about the source, not part of what the program produced.
 */
export function reportWarnings(
  warnings: readonly Diagnostic[],
  file: string,
  source: string,
): void {
  if (warnings.length === 0) return;
  const color = useColor();
  for (const warning of warnings) {
    process.stderr.write(formatDiagnostic(warning, source, file, color) + '\n\n');
  }
}

/**
 * Every file under `target` whose name ends with `suffix`, sorted.
 *
 * `check`, `test` and `fmt` all walk a tree the same way, and they must agree
 * about it: a file one of them skips and another visits is a file that can fail
 * in CI without failing locally. `node_modules` and dot-directories are
 * somebody else's business.
 *
 * A `target` that does not exist yields nothing rather than raising, so each
 * command words its own "nothing found" message.
 */
export async function collectFiles(
  targets: string | readonly string[],
  suffix: string,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (at: string): Promise<void> => {
    let stat;
    try {
      stat = await fsp.stat(at);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (at.endsWith(suffix)) found.push(at);
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = await fsp.readdir(at, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      await walk(path.join(at, entry.name));
    }
  };
  for (const target of typeof targets === 'string' ? [targets] : targets) {
    await walk(path.resolve(target));
  }
  // A file named twice — `lumen check src src/app.lm` — is one file, and the
  // order is the walk's, which is already sorted per target.
  return [...new Set(found)];
}

export async function readSource(file: string): Promise<{ file: string; source: string }> {
  const resolved = path.resolve(file);
  try {
    return { file: resolved, source: await fsp.readFile(resolved, 'utf8') };
  } catch {
    process.stderr.write('lumen: cannot read `' + file + '`\n');
    process.exit(1);
  }
}

/**
 * Print an error the way a compiler should: a rendered diagnostic for a Lumen
 * error, and an honest internal-error report for anything else.
 */
export function reportError(error: unknown): never {
  if (error instanceof LumenError) {
    process.stderr.write(error.render(useColor()) + '\n');
    process.exit(1);
  }
  if (error instanceof Error && error.name === 'RangeError' && /call stack/i.test(error.message)) {
    // A last resort, and deliberately vague about the cause. It used to say "a
    // function is probably recursing without a base case", which was reported
    // for programs that declare no function at all: seven kinds of deeply
    // nested *source* reached here, because the parser's depth limit counted
    // the parser's own recursion and not the depth of the tree it built. Those
    // are `PA016` now and real runaway recursion is `RT045`, naming the
    // function and its depth — so anything still arriving here is something
    // nobody has diagnosed yet, and guessing at it would send the reader after
    // the wrong thing.
    process.stderr.write(
      'lumen: stack overflow — the program or the source is nested deeper than Lumen can walk\n' +
        '       runaway recursion is reported as `RT045` and deeply nested source as `PA016`,\n' +
        '       so this is a case neither of them caught: please report the file\n',
    );
    process.exit(1);
  }
  process.stderr.write('lumen: internal error\n' + describeEscaped(error) + '\n');
  process.exit(70);
}

/**
 * Whatever escaped, in words somebody could act on.
 *
 * `String(error)` is right for an `Error` and useless for anything else: a
 * `return` written outside a function threw the interpreter's own
 * `ReturnSignal`, which is a plain object, and this line printed
 * `[object Object]` — an internal error report that says less than nothing.
 *
 * A bug report needs to name what escaped, so the class name comes first and
 * the fields after it. Nothing here can throw: an unprintable value must not
 * turn the report of a problem into a second problem.
 */
function describeEscaped(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  // Everything below this line is something Lumen threw that is not an error,
  // which is a bug here rather than in the program being run — so each of them
  // ends with the same sentence, and the only question is how to name it.
  const note = '\n       this is a bug in Lumen rather than in the program: please report it';
  if (error === null || typeof error !== 'object') return String(error) + note;

  const name = error.constructor?.name ?? 'object';
  let fields: string | undefined;
  try {
    fields = JSON.stringify(error, (_key, value: unknown) =>
      typeof value === 'bigint' || typeof value === 'function' ? String(value) : value,
    );
  } catch {
    // A cyclic object, or a getter that throws. Reporting a problem must not
    // become a second problem.
    fields = undefined;
  }
  return name + ' ' + (fields === undefined ? '(its fields could not be rendered)' : fields) + note;
}

/**
 * How to name a file on screen.
 *
 * `path.relative` is right for a file under the working directory and wrong
 * for one outside it: `../../../tmp/probe/a_test.lm` is longer than the
 * absolute path and harder to read. So the shorter of the two wins.
 */
export function displayPath(file: string): string {
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith('..') || relative === '' ? file : relative;
}
