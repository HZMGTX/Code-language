/** Shared plumbing for the `lumen` commands. */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { Interpreter, LumenError } from '@lumen-lang/core';
import { createInterpreter } from '@lumen-lang/stdlib';

export const VERSION = '0.1.0';

/** Colour is on for a terminal and off when piped, so output stays diffable. */
export function useColor(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return false;
  if (process.env['FORCE_COLOR'] !== undefined && process.env['FORCE_COLOR'] !== '') return true;
  return process.stderr.isTTY === true;
}

export function newInterpreter(): Interpreter {
  // The factory installs the prelude and the method tables, so the CLI, the
  // REPL and the tests all agree on what is in scope.
  return createInterpreter();
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
export async function collectFiles(target: string, suffix: string): Promise<string[]> {
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
  await walk(path.resolve(target));
  return found;
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
    process.stderr.write(
      'lumen: stack overflow — a function is probably recursing without a base case\n',
    );
    process.exit(1);
  }
  process.stderr.write(
    'lumen: internal error\n' + (error instanceof Error ? (error.stack ?? error.message) : String(error)) + '\n',
  );
  process.exit(70);
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
