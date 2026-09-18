/**
 * `lumen fmt [path]` — normalise indentation in place.
 *
 * Two modes, because a formatter is used two ways:
 *
 *   lumen fmt src           rewrite the files that need it
 *   lumen fmt --check src   say which files need it, and exit non-zero
 *
 * `--check` is what CI and a pre-commit hook want: an answer, no writes. It
 * prints the files rather than a diff, because the diff of a whitespace-only
 * change is noise and the fix is one command away.
 *
 * Files are only written when their contents actually change. That keeps
 * modification times, and therefore every build cache downstream of them,
 * meaning what it meant before the command ran.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { format } from '@lumen-lang/core';

import { collectFiles, displayPath } from '../support.js';

export async function formatFiles(
  targets: string | readonly string[],
  checkOnly: boolean,
): Promise<void> {
  const roots = (typeof targets === 'string' ? [targets] : targets).map((t) => path.resolve(t));
  const where = roots.length === 1 ? roots[0] : roots.length + ' paths';
  const files = await collectFiles(roots, '.lm');

  if (files.length === 0) {
    process.stdout.write('no `.lm` files found under ' + where + '\n');
    process.exit(1);
  }

  const touched: string[] = [];
  for (const file of files) {
    const source = await fsp.readFile(file, 'utf8');
    const formatted = format(source, file);
    if (formatted === source) continue;
    touched.push(displayPath(file));
    if (!checkOnly) await fsp.writeFile(file, formatted, 'utf8');
  }

  const plural = (n: number): string => String(n) + (n === 1 ? ' file' : ' files');

  if (touched.length === 0) {
    process.stdout.write(plural(files.length) + ' already formatted\n');
    return;
  }

  for (const file of touched) {
    process.stdout.write((checkOnly ? 'would reformat ' : 'formatted ') + file + '\n');
  }
  if (checkOnly) {
    const verb = touched.length === 1 ? ' needs' : ' need';
    process.stdout.write(plural(touched.length) + verb + ' formatting — run `lumen fmt ' + roots.join(' ') + '`\n');
    process.exit(1);
  }
  process.stdout.write(plural(touched.length) + ' reformatted\n');
}
