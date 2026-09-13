/**
 * `@lumen-lang/stdlib` — the Lumen standard library, plus the Node host and
 * module resolver that wire the language to a real machine.
 *
 * `@lumen-lang/core` never imports a Node API. Everything platform-specific
 * lives here, which is what keeps a browser target a wiring exercise rather
 * than a rewrite.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import * as readline from 'node:readline';

import { Interpreter, type Host, type ModuleResolver, type ResolvedModule, type Value } from '@lumen-lang/core';

import { STD_MODULES, STD_MODULE_NAMES } from './modules.js';
import { makeHelp, methodTables, preludeExtras } from './prelude.js';

export { toJson } from './json.js';
export { setServeMode } from './web.js';
// For the tests only: the property that two values share a key exactly when
// `==` calls them equal is what makes `std/set` correct, and it cannot be
// observed from Lumen — a set that got it wrong would just hold two of
// something without complaining.
export { setKeyForTesting } from './set.js';
export { STD_MODULES, STD_MODULE_NAMES } from './modules.js';

/** A `Host` backed by the Node process: stdout, stderr, env, and the clock. */
export function createNodeHost(): Host {
  // Created on first use and reused, so a program that calls input() in a loop
  // does not stack up readline interfaces on the same stdin.
  let console_: readline.Interface | undefined;
  // Lines that have arrived but nobody has asked for yet, and the readers
  // waiting for a line that has not arrived. Exactly one of these is ever
  // non-empty.
  //
  // A piped stdin delivers every line at once, well before the program asks
  // for the second one. Reading with `question` per call would drop the rest
  // on the floor, so the lines are queued as they arrive instead, and
  // `printf 'a\nb\n' | lumen run script.lm` reads both.
  const pending: string[] = [];
  const waiting: ((line: string | undefined) => void)[] = [];
  let ended = false;

  const interactive = process.stdin.isTTY === true;

  function openConsole(): readline.Interface {
    if (console_ !== undefined) return console_;
    const iface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: interactive,
    });
    iface.on('line', (line: string): void => {
      const next = waiting.shift();
      if (next === undefined) pending.push(line);
      else next(line);
    });
    // End of input resolves every outstanding read to undefined rather than
    // hanging, so a script that runs out of lines ends cleanly.
    iface.once('close', (): void => {
      ended = true;
      for (const resolve of waiting.splice(0)) resolve(undefined);
    });
    console_ = iface;
    return iface;
  }

  return {
    writeOut: (text: string): void => {
      process.stdout.write(text);
    },
    writeErr: (text: string): void => {
      process.stderr.write(text);
    },
    getEnv: (name: string): string | undefined => process.env[name],
    now: (): number => Date.now(),
    readLine: async (prompt: string): Promise<string | undefined> => {
      const iface = openConsole();
      // At a terminal readline owns the line it is editing, so it has to be
      // the one to write the prompt; piped, it is only text going past.
      if (interactive) {
        iface.setPrompt(prompt);
        iface.prompt();
      } else {
        process.stdout.write(prompt);
      }

      const queued = pending.shift();
      if (queued !== undefined) return queued;
      if (ended) return undefined;
      return await new Promise<string | undefined>((resolve) => {
        waiting.push(resolve);
      });
    },
  };
}

/**
 * Resolve `std/*` to a native module and anything else to a `.lm` file on disk,
 * relative to the importing file. Native modules are instantiated once, so two
 * files importing `std/list` share one instance.
 */
export function createNodeResolver(): ModuleResolver {
  const instantiated = new Map<string, Map<string, Value>>();

  return {
    async resolve(spec: string, fromFile: string): Promise<ResolvedModule | undefined> {
      const factory = STD_MODULES.get(spec);
      if (factory !== undefined) {
        let exports = instantiated.get(spec);
        if (exports === undefined) {
          exports = factory();
          instantiated.set(spec, exports);
        }
        return { key: spec, exports };
      }

      // Anything that is not a std module is a path to a Lumen source file.
      if (spec.startsWith('std/')) return undefined;

      const base = path.dirname(path.resolve(fromFile));
      const candidates = spec.endsWith('.lm')
        ? [path.resolve(base, spec)]
        : [path.resolve(base, spec + '.lm'), path.resolve(base, spec, 'index.lm')];

      for (const candidate of candidates) {
        try {
          const source = await fsp.readFile(candidate, 'utf8');
          return { key: candidate, file: candidate, source };
        } catch {
          // Try the next shape.
        }
      }
      return undefined;
    },
  };
}

/**
 * Build a fully-equipped interpreter: the language, the standard library's
 * prelude, and method tables for the built-in types.
 *
 * Everything that runs Lumen — the CLI, the REPL, the test harness — goes
 * through here, so they cannot drift apart on what is in scope.
 */
export function createInterpreter(options: { host?: Host; resolver?: ModuleResolver } = {}): Interpreter {
  const host = options.host ?? createNodeHost();
  const resolver = options.resolver ?? createNodeResolver();
  const interpreter = new Interpreter({ host, resolver });

  // Methods first, so help() can report them.
  for (const [typeName, functions] of Object.entries(methodTables())) {
    interpreter.registerMethods(typeName, functions);
  }

  for (const [name, value] of preludeExtras()) {
    interpreter.globals.declare(name, value, false);
  }

  const help = makeHelp(
    (type) => interpreter.methodNames(type),
    () => interpreter.globals.ownNames(),
  );
  interpreter.globals.declare(help.name, help, false);

  return interpreter;
}
