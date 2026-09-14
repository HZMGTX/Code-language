/**
 * `lumen test [path]` — run Lumen test files.
 *
 * A test file is any `*_test.lm`. It passes if it runs to completion; it fails
 * if anything raises, which makes the built-in `assert` all the test framework
 * a small program needs.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { LumenError, checkModule, parse } from '@lumen-lang/core';
import { checkOptions, collectFiles, displayPath, newInterpreter, useColor } from '../support.js';

export async function runTests(target: string): Promise<void> {
  const root = path.resolve(target);
  const files = await collectFiles(root, '_test.lm');

  if (files.length === 0) {
    process.stdout.write('no `*_test.lm` files found under ' + root + '\n');
    process.exit(1);
  }

  const color = useColor();
  let passed = 0;
  const failures: { file: string; message: string }[] = [];

  for (const file of files) {
    const relative = displayPath(file);
    const source = await fsp.readFile(file, 'utf8');
    try {
      const module = parse(source, file);
      const interpreter = newInterpreter();
      checkModule(module, source, checkOptions(interpreter.globals.ownNames()));
      await interpreter.runModule(module, source);
      passed += 1;
      process.stdout.write('ok   ' + relative + '\n');
    } catch (error) {
      const message = error instanceof LumenError ? error.render(color) : String(error);
      failures.push({ file: relative, message });
      process.stdout.write('FAIL ' + relative + '\n');
    }
  }

  process.stdout.write('\n' + String(passed) + ' passed, ' + String(failures.length) + ' failed\n');

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write('\n--- ' + failure.file + ' ---\n' + failure.message + '\n');
    }
    process.exit(1);
  }
}
