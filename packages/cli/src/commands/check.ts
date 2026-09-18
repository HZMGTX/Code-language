/**
 * `lumen check [path]` — every static check, and nothing else.
 *
 * Parse, resolve, type-check; do not run. It is what an editor, a pre-commit
 * hook or a CI step wants: an answer about a whole tree of files in the time
 * it takes to read them, with no side effects at all. Running a program to
 * find out whether it has a typo is a poor trade when the program writes
 * files or serves a port.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { LumenError, checkModule, formatDiagnostic, parse } from '@lumen-lang/core';

import { checkOptions, collectFiles, displayPath, newInterpreter, useColor } from '../support.js';

export async function checkFiles(targets: string | readonly string[]): Promise<void> {
  const roots = (typeof targets === 'string' ? [targets] : targets).map((t) => path.resolve(t));
  const where = roots.length === 1 ? roots[0] : roots.length + ' paths';
  const files = await collectFiles(roots, '.lm');

  if (files.length === 0) {
    process.stdout.write('no `.lm` files found under ' + where + '\n');
    process.exit(1);
  }

  const color = useColor();
  // One interpreter for the prelude names; nothing is executed with it.
  const options = checkOptions(newInterpreter().globals.ownNames());

  let clean = 0;
  let withProblems = 0;
  let warned = 0;
  for (const file of files) {
    const relative = displayPath(file);
    const source = await fsp.readFile(file, 'utf8');
    try {
      const warnings = checkModule(parse(source, file), source, options);
      clean += 1;
      warned += warnings.length;
      for (const warning of warnings) {
        process.stdout.write(formatDiagnostic(warning, source, file, color) + '\n\n');
      }
    } catch (error) {
      withProblems += 1;
      process.stdout.write(
        // A non-`LumenError` is a bug rather than a bad file, and `String(error)`
        // put the host's own words on the terminal with no file name attached —
        // `RangeError: Maximum call stack size exceeded` and nothing else, which
        // in a multi-file run was the only line about the file that failed.
        error instanceof LumenError
          ? error.render(color) + '\n\n'
          : 'lumen: internal error while checking ' + file + '\n' +
            (error instanceof Error ? error.message : String(error)) + '\n\n',
      );
      continue;
    }
    if (files.length === 1 && warned === 0) process.stdout.write('ok   ' + relative + '\n');
  }

  // A warning never fails the check. That is the whole difference between a
  // warning and an error: `lumen check` is what a pre-commit hook and a CI step
  // run, and a build that fails over an unused binding is a build people learn
  // to pass with `--no-verify`.
  const counted =
    warned === 0 ? '' : ', ' + String(warned) + (warned === 1 ? ' warning' : ' warnings');
  const summary =
    withProblems === 0
      ? String(clean) + (clean === 1 ? ' file checked, no problems' : ' files checked, no problems') + counted
      : String(withProblems) + ' of ' + String(files.length) + ' files have problems' + counted;
  process.stdout.write(summary + '\n');
  process.exit(withProblems === 0 ? 0 : 1);
}
