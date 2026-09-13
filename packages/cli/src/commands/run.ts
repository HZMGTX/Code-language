/** `lumen run <file>` — parse and execute a Lumen program. */

import { parse } from '@lumen-lang/core';
import { newInterpreter, readSource, reportError } from '../support.js';

export async function runFile(file: string): Promise<void> {
  const { file: resolved, source } = await readSource(file);
  try {
    const module = parse(source, resolved);
    await newInterpreter().runModule(module, source);
  } catch (error) {
    reportError(error);
  }
}
