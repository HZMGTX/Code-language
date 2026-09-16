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

import {
  Interpreter,
  UNIVERSAL,
  methodTy,
  signatureTy,
  type Host,
  type ModuleResolver,
  type ResolveOptions,
  type ResolvedModule,
  type Ty,
  type Value,
} from '@lumen-lang/core';

import { STD_MODULES, STD_MODULE_NAMES, stdModuleExports } from './modules.js';
import { stdCore } from './core.js';
import { makeHelp, methodTables, preludeExtras, universalMethods } from './prelude.js';

export { toJson } from './json.js';
export { setServeMode } from './web.js';
// For the tests only: the property that two values share a key exactly when
// `==` calls them equal is what makes `std/set` correct, and it cannot be
// observed from Lumen — a set that got it wrong would just hold two of
// something without complaining.
export { setKeyForTesting } from './set.js';
export { STD_MODULES, STD_MODULE_NAMES, stdModuleExports } from './modules.js';
export { unmatchedSignaturesForTesting } from './support.js';
export { locateJsonErrorForTesting } from './json.js';

/**
 * A `Host` backed by the Node process: stdout, stderr, env, the clock, and the
 * program's arguments.
 *
 * `args` is passed in rather than read from `process.argv`, because only the
 * caller knows how much of the command line was its own.
 */
export function createNodeHost(options: { args?: readonly string[] } = {}): Host {
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
    args: (): readonly string[] => options.args ?? [],
    exit: (code: number): never => {
      process.exit(code);
    },
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
    readAll: async (): Promise<string> => {
      // Whatever `readLine` has already taken off the stream is still owed to
      // the caller: a program that reads a header line and then asks for the
      // rest must get the rest, not the rest minus whatever readline buffered.
      const iface = openConsole();
      if (ended) return pending.splice(0).join('\n');
      await new Promise<void>((resolve) => {
        iface.once('close', () => resolve());
      });
      return pending.splice(0).join('\n');
    },
  };
}

/**
 * Resolve `std/*` to a native module and anything else to a `.lm` file on disk,
 * relative to the importing file. Native modules are instantiated once, so two
 * files importing `std/list` share one instance.
 *
 * `base` is where a relative import resolves from when the importing file's own
 * name is not a path — which is how the test harness runs a fixture, parsing it
 * under its bare name so diagnostics read `thing.lm:3:1` rather than a machine
 * path that differs on every checkout. Without it, conformance could not cover
 * a local import at all.
 */
export function createNodeResolver(options: { base?: string } = {}): ModuleResolver {
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

      const base = path.dirname(path.resolve(options.base ?? '.', fromFile));
      const candidates = spec.endsWith('.lm')
        ? [path.resolve(base, spec)]
        : [path.resolve(base, spec + '.lm'), path.resolve(base, spec, 'index.lm')];

      for (const candidate of candidates) {
        try {
          const source = await fsp.readFile(candidate, 'utf8');
          // The cache key stays absolute — two spellings of one file must not
          // load it twice. The *reported* name is relative to `base` when there
          // is one, so a diagnostic raised inside an imported module reads
          // `helpers/say.lm:8:1` instead of a path that differs per checkout.
          // Resolving that name again re-bases it, so a chain of imports works.
          const file =
            options.base === undefined ? candidate : path.relative(options.base, candidate);
          return { key: candidate, file, source };
        } catch {
          // Try the next shape.
        }
      }
      return undefined;
    },
  };
}

/**
 * The type of every name the prelude puts in scope, for `checkTypes`.
 *
 * Read off a real interpreter rather than assembled separately, because a
 * second assembly is a second thing to keep in step: whatever is actually in
 * scope is what gets typed, and a name the prelude stops exporting disappears
 * from here on the same day.
 *
 * A native with no declared signature is simply absent, and stays `Any` in and
 * `Any` out — which is how the whole library behaved before any of it was
 * typed.
 */
export function stdSignatures(): ReadonlyMap<string, Ty> {
  if (globalSignatures !== undefined) return globalSignatures;
  const interpreter = createInterpreter();
  const built = new Map<string, Ty>();
  for (const name of interpreter.globals.ownNames()) {
    const value = interpreter.globals.lookup(name)?.value;
    if (value?.k === 'native' && value.signature !== undefined) {
      const ty = parsed(value.signature);
      if (ty !== undefined) built.set(name, ty);
    }
  }
  globalSignatures = built;
  return built;
}

/**
 * A declared signature as a type, or undefined if it will not parse.
 *
 * `signatureTy` raises, which is right for the primitive: a signature that does
 * not parse is a mistake somebody has to fix. But these maps are built on the
 * way to running a program, so raising here would mean a typo in one signature
 * stops every Lumen program on the machine with a diagnostic about a file the
 * user has never seen. Skipping it leaves that one function unchecked, which is
 * how it was before it was typed.
 *
 * `tests/unit/signatures.test.ts` asserts that every one of them parses, so a
 * bad signature is a failed build rather than something that quietly rots.
 */
function parsed(signature: string): Ty | undefined {
  try {
    return signatureTy(signature);
  } catch {
    return undefined;
  }
}

/**
 * The type of every method, keyed `"Str.upper"` — the receiver already removed.
 *
 * Keyed by what `typeName` reports at run time, because that is what method
 * tables are registered under: the checker and the interpreter have to agree
 * about what a method is called or they are checking different programs. The
 * handful that belong to every value are keyed under `UNIVERSAL`.
 */
export function stdMethodSignatures(): ReadonlyMap<string, Ty> {
  if (methodSignatures !== undefined) return methodSignatures;
  const built = new Map<string, Ty>();
  const add = (type: string, name: string, value: Value): void => {
    if (value.k !== 'native' || value.signature === undefined) return;
    const ty = parsed(value.signature);
    if (ty !== undefined) built.set(type + '.' + name, methodTy(ty));
  };
  for (const [type, functions] of Object.entries(methodTables())) {
    for (const [name, value] of functions) add(type, name, value);
  }
  const core = stdCore();
  const interpreter = createInterpreter();
  for (const [name, value] of universalMethods(
    (n) => interpreter.globals.lookup(n)?.value ?? core.get(n),
  )) {
    add(UNIVERSAL, name, value);
  }
  methodSignatures = built;
  return built;
}

/**
 * Everything `checkModule` needs to know about the world outside the file:
 * what the prelude holds, what the standard modules export, and what any of it
 * means. One function, because four callers need exactly this and a check one
 * of them performs and another skips is a program that passes `lumen check`
 * and fails `lumen run`.
 */
export function checkOptions(globals: readonly string[]): ResolveOptions {
  return {
    globals,
    moduleExports: stdModuleExports(),
    // Everything under `std/` is accounted for, so a path there that is not in
    // the map is a typo. A local `./helper.lm` is not, and stays trusted.
    closedPrefixes: ['std/'],
    signatures: stdSignatures(),
    methods: stdMethodSignatures(),
    effectful: effectfulFunctions(),
  };
}

/**
 * The modules whose every function is called for what it *does*.
 *
 * By module rather than by function, so a native added to `std/fs` tomorrow is
 * effectful without anybody remembering to say so — and a native added to
 * `std/str` is not, because one that reached the host would be a design error
 * in the first place.
 */
/**
 * What each module does to the world, which two different checks need to know.
 *
 * - **`pure`**: every function answers with a value and does nothing else, so
 *   discarding one is `TY010`, and a test may call any of them with whatever it
 *   likes.
 * - **`effectful`**: every function is called for what it *does*. Discarding an
 *   answer is ordinary, and a test must not call one blind — a sweep handing
 *   junk arguments to `std/fs` writes real files.
 * - **`mixed`**: some of each. `EFFECTFUL_NAMES` below names the ones that act,
 *   and the rest are treated as pure; a blind sweep still stays away, because
 *   `web.serve` never returns and `core.exit` stops the process.
 *
 * Every module must appear, and a test says so rather than trusting it. This
 * used to be two lists in two files that nearly agreed, and a module added to
 * neither would have been quietly called pure by one and swept blind by the
 * other — the second of which does real I/O with whatever arguments it invents.
 */
export const MODULE_EFFECTS: ReadonlyMap<string, 'pure' | 'mixed' | 'effectful'> = new Map([
  ['std/core', 'mixed'],
  ['std/str', 'pure'],
  ['std/list', 'mixed'],
  ['std/map', 'pure'],
  ['std/math', 'mixed'],
  ['std/json', 'pure'],
  ['std/csv', 'pure'],
  ['std/crypto', 'pure'],
  ['std/option', 'pure'],
  ['std/result', 'pure'],
  ['std/set', 'pure'],
  ['std/path', 'pure'],
  ['std/regex', 'pure'],
  ['std/process', 'effectful'],
  ['std/time', 'mixed'],
  ['std/fs', 'effectful'],
  ['std/http', 'effectful'],
  ['std/web', 'mixed'],
  ['std/ai', 'effectful'],
]);

/**
 * The effectful functions inside modules that are otherwise pure.
 *
 * `push` and `pop` are the two `docs/stdlib.md` names as the exceptions to
 * *"nothing mutates unless its name says so"*, and this is the list that makes
 * that rule a diagnostic instead of something to remember: their twenty
 * neighbours answer with new values, so discarding one is `TY010` and
 * discarding a `push` is not. `serve` starts a server; the rest read or write
 * the console, and are here rather than relying on their `Nil` return so that
 * changing one's return type cannot quietly turn it into a no-op warning.
 */
const EFFECTFUL_NAMES: readonly string[] = [
  'push',
  'pop',
  'serve',
  'print',
  'exit',
  'sleep',
  'seed',
  'input',
  'inputAll',
];

/**
 * Every effectful function's type, plus the method names that reach one.
 *
 * Types for the two channels that have them, because `std/fs.remove` and
 * `std/map.remove` are different functions with one name. Names for the method
 * channel, where a receiver's type is all there is to go on: a name meaning
 * both stays silent for both, which is the safe direction.
 */
function effectfulFunctions(): ReadonlySet<Ty | string> {
  const out = new Set<Ty | string>();
  const namesFromEffectfulModules = new Set<string>(EFFECTFUL_NAMES);

  for (const [module, exports] of stdModuleExports()) {
    const wholeModule = MODULE_EFFECTS.get(module) === 'effectful';
    for (const [name, ty] of exports) {
      if (wholeModule) namesFromEffectfulModules.add(name);
      if (wholeModule || EFFECTFUL_NAMES.includes(name)) out.add(ty);
    }
  }
  for (const [name, ty] of stdSignatures()) {
    if (namesFromEffectfulModules.has(name)) out.add(ty);
  }
  for (const name of namesFromEffectfulModules) out.add(name);
  return out;
}

/** Both built once; parsing 200 signatures per checked file would be waste. */
let globalSignatures: ReadonlyMap<string, Ty> | undefined;
let methodSignatures: ReadonlyMap<string, Ty> | undefined;

/**
 * Build a fully-equipped interpreter: the language, the standard library's
 * prelude, and method tables for the built-in types.
 *
 * Everything that runs Lumen — the CLI, the REPL, the test harness — goes
 * through here, so they cannot drift apart on what is in scope.
 */
export function createInterpreter(
  options: { host?: Host; resolver?: ModuleResolver; args?: readonly string[] } = {},
): Interpreter {
  const host = options.host ?? createNodeHost({ ...(options.args === undefined ? {} : { args: options.args }) });
  const resolver = options.resolver ?? createNodeResolver();
  const interpreter = new Interpreter({ host, resolver });

  // Methods first, so help() can report them.
  for (const [typeName, functions] of Object.entries(methodTables())) {
    interpreter.registerMethods(typeName, functions);
  }

  for (const [name, value] of preludeExtras()) {
    interpreter.globals.declare(name, value, false);
  }

  // Then the few that belong to every value. They come from two places — `str`
  // and `type` are core builtins in the globals, while `inspect`, `clone` and
  // `isNil` are `std/core` exports the prelude deliberately leaves out of scope
  // — so both are searched. Registered after the type tables, but a
  // type-specific method of the same name still wins at lookup, so this cannot
  // change what an existing call means.
  const core = stdCore();
  interpreter.registerUniversalMethods(
    universalMethods((name) => interpreter.globals.lookup(name)?.value ?? core.get(name)),
  );

  const help = makeHelp(
    (type) => interpreter.methodNames(type),
    () => interpreter.globals.ownNames(),
  );
  interpreter.globals.declare(help.name, help, false);

  return interpreter;
}
