/** `lumen run <file>` — check and execute a Lumen program. */

import { checkModule, parse } from '@lumen-lang/core';
import { newInterpreter, readSource, reportError } from '../support.js';

export async function runFile(file: string): Promise<void> {
  const { file: resolved, source } = await readSource(file);
  try {
    const module = parse(source, resolved);
    const interpreter = newInterpreter();
    // Static checks first: a typo on a branch that never runs is still a typo.
    checkModule(module, source, { globals: interpreter.globals.ownNames() });
    await interpreter.runModule(module, source);
  } catch (error) {
    reportError(error);
  }
}
