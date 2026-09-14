/** `lumen run <file>` — check and execute a Lumen program. */

import { checkModule, parse } from '@lumen-lang/core';
import {
  checkOptions,
  newInterpreter,
  readSource,
  reportError,
  reportWarnings,
} from '../support.js';

export async function runFile(file: string): Promise<void> {
  const { file: resolved, source } = await readSource(file);
  try {
    const module = parse(source, resolved);
    const interpreter = newInterpreter();
    // Static checks first: a typo on a branch that never runs is still a typo.
    const warnings = checkModule(module, source, checkOptions(interpreter.globals.ownNames()));
    reportWarnings(warnings, resolved, source);
    await interpreter.runModule(module, source);
  } catch (error) {
    reportError(error);
  }
}
