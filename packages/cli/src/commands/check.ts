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

import { LumenError, checkModule, parse } from '@lumen-lang/core';

import { collectFiles, displayPath, newInterpreter, useColor } from '../support.js';

export async function checkFiles(target: string): Promise<void> {
  const root = path.resolve(target);
  const files = await collectFiles(root, '.lm');

  if (files.length === 0) {
    process.stdout.write('no `.lm` files found under ' + root + '\n');
    process.exit(1);
  }

  const color = useColor();
  // One interpreter for the prelude names; nothing is executed with it.
  const globals = newInterpreter().globals.ownNames();

  let clean = 0;
  let withProblems = 0;
  for (const file of files) {
    const relative = displayPath(file);
    const source = await fsp.readFile(file, 'utf8');
    try {
      checkModule(parse(source, file), source, { globals });
      clean += 1;
    } catch (error) {
      withProblems += 1;
      process.stdout.write(
        error instanceof LumenError ? error.render(color) + '\n\n' : String(error) + '\n\n',
      );
      continue;
    }
    if (files.length === 1) process.stdout.write('ok   ' + relative + '\n');
  }

  const summary =
    withProblems === 0
      ? String(clean) + (clean === 1 ? ' file checked, no problems' : ' files checked, no problems')
      : String(withProblems) + ' of ' + String(files.length) + ' files have problems';
  process.stdout.write(summary + '\n');
  process.exit(withProblems === 0 ? 0 : 1);
}
