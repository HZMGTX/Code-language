/**
 * Test harness for running Lumen source in a controlled, deterministic world.
 *
 * Everything that could vary between machines is pinned: the clock returns a
 * fixed value, the environment is a fixed table, and the file name given to the
 * parser is a bare basename so diagnostics never contain an absolute path.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { Interpreter, LumenError, parse, type Host } from '@lumen-lang/core';
import { createNodeResolver } from '@lumen-lang/stdlib';

/** The environment every fixture sees. `mock` keeps `std/ai` offline. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  LUMEN_AI_PROVIDER: 'mock',
};

export interface RunResult {
  /** Everything written to stdout and stderr, plus any rendered diagnostic. */
  readonly output: string;
  readonly failed: boolean;
}

export function makeHost(collect: (text: string) => void): Host {
  return {
    writeOut: collect,
    writeErr: collect,
    getEnv: (name: string): string | undefined => FIXED_ENV[name],
    now: (): number => 0,
  };
}

/** Run Lumen source and capture everything it produced, errors included. */
export async function runSource(source: string, fileName = 'fixture.lm'): Promise<RunResult> {
  let output = '';
  const host = makeHost((text) => {
    output += text;
  });
  const interpreter = new Interpreter({ host, resolver: createNodeResolver() });

  try {
    const module = parse(source, fileName);
    await interpreter.runModule(module, source);
    return { output, failed: false };
  } catch (error) {
    if (error instanceof LumenError) {
      // A trailing newline keeps golden files ending cleanly.
      return { output: output + error.render(false) + '\n', failed: true };
    }
    return { output: output + 'INTERNAL ERROR: ' + String(error) + '\n', failed: true };
  }
}

/** Run a `.lm` fixture from disk. */
export async function runFixture(file: string): Promise<RunResult> {
  const source = await fsp.readFile(file, 'utf8');
  return await runSource(source, path.basename(file));
}

/** Every `.lm` file under `root`, depth-first and sorted, for stable ordering. */
export async function findFixtures(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.lm')) found.push(full);
    }
  };
  await walk(root);
  return found;
}
