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
export { STD_MODULES, STD_MODULE_NAMES } from './modules.js';

/** A `Host` backed by the Node process: stdout, stderr, env, and the clock. */
export function createNodeHost(): Host {
  // Created on first use and reused, so a program that calls input() in a loop
  // does not stack up readline interfaces on the same stdin.
  let console_: readline.Interface | undefined;

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
      if (console_ === undefined) {
        console_ = readline.createInterface({ input: process.stdin, output: process.stdout });
      }
      const iface = console_;
      return await new Promise<string | undefined>((resolve) => {
        let settled = false;
        // End of input resolves to undefined rather than hanging, so a piped
        // script that runs out of lines ends cleanly.
        const onClose = (): void => {
          if (settled) return;
          settled = true;
          resolve(undefined);
        };
        iface.once('close', onClose);
        iface.question(prompt, (answer) => {
          if (settled) return;
          settled = true;
          iface.removeListener('close', onClose);
          resolve(answer);
        });
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
      const factory = STD_MODULES[spec];
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
