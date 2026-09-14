/**
 * Test harness for running Lumen source in a controlled, deterministic world.
 *
 * Everything that could vary between machines is pinned: the clock returns a
 * fixed value, the environment is a fixed table, and the file name given to the
 * parser is a bare basename so diagnostics never contain an absolute path.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { LumenError, checkModule, parse, type Host } from '@lumen-lang/core';
import { checkOptions, createInterpreter, createNodeResolver } from '@lumen-lang/stdlib';

/** The environment every fixture sees. `mock` keeps `std/ai` offline. */
const FIXED_ENV: Readonly<Record<string, string>> = {
  LUMEN_AI_PROVIDER: 'mock',
};

export interface RunResult {
  /** Everything written to stdout and stderr, plus any rendered diagnostic. */
  readonly output: string;
  readonly failed: boolean;
}

/**
 * A host with a scripted console.
 *
 * `stdin` supplies the lines `input()` will read; once they run out it reports
 * end of input. Fixtures therefore exercise the real code path and stay
 * deterministic, instead of blocking on a terminal that is not there.
 */
export function makeHost(collect: (text: string) => void, stdin: readonly string[] = []): Host {
  const queue = [...stdin];
  return {
    writeOut: collect,
    writeErr: collect,
    getEnv: (name: string): string | undefined => FIXED_ENV[name],
    now: (): number => 0,
    readLine: async (prompt: string): Promise<string | undefined> => {
      collect(prompt);
      return queue.shift();
    },
  };
}

/** Run Lumen source and capture everything it produced, errors included. */
export async function runSource(
  source: string,
  fileName = 'fixture.lm',
  stdin: readonly string[] = [],
  baseDir?: string,
): Promise<RunResult> {
  return await execute(source, fileName, stdin, true, baseDir);
}

/**
 * Run without the static checks, the way a host that embedded the interpreter
 * directly would.
 *
 * The specification promises the interpreter enforces operand types, arity and
 * field names itself, so that such a host is not left unguarded (§6). Once the
 * type checker started catching `"a" + 1` before it ran, nothing exercised that
 * promise any more: every test went through `checkModule` first and saw the
 * static error instead. This is how both layers get tested.
 */
export async function runUnchecked(
  source: string,
  fileName = 'fixture.lm',
  stdin: readonly string[] = [],
): Promise<RunResult> {
  return await execute(source, fileName, stdin, false);
}

async function execute(
  source: string,
  fileName: string,
  stdin: readonly string[],
  check: boolean,
  baseDir?: string,
): Promise<RunResult> {
  let output = '';
  const host = makeHost((text) => {
    output += text;
  }, stdin);
  const interpreter = createInterpreter({
    host,
    ...(baseDir === undefined ? {} : { resolver: createNodeResolver({ base: baseDir }) }),
  });

  try {
    const module = parse(source, fileName);
    if (check) checkModule(module, source, checkOptions(interpreter.globals.ownNames()));
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

/**
 * Run a `.lm` fixture from disk.
 *
 * Parsed under its bare name so a golden file reads `thing.lm:3:1` and is the
 * same on every machine, but resolved from its real directory, so a fixture may
 * import a helper beside it.
 */
export async function runFixture(file: string): Promise<RunResult> {
  const source = await fsp.readFile(file, 'utf8');
  return await runSource(source, path.basename(file), [], path.dirname(file));
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
