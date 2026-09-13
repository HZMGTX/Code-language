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

import type { Host, ModuleResolver, ResolvedModule, Value } from '@lumen-lang/core';

import { stdAi } from './ai.js';
import { stdCore } from './core.js';
import { stdFs } from './fs.js';
import { stdHttp } from './http.js';
import { stdJson } from './json.js';
import { stdList } from './list.js';
import { stdMap } from './map.js';
import { stdMath } from './math.js';
import { stdStr } from './str.js';
import { stdWeb } from './web.js';

export { toJson } from './json.js';

/** Every standard module, keyed by the path you `import` it from. */
export const STD_MODULES: Readonly<Record<string, () => Map<string, Value>>> = {
  'std/core': stdCore,
  'std/str': stdStr,
  'std/list': stdList,
  'std/map': stdMap,
  'std/math': stdMath,
  'std/json': stdJson,
  'std/fs': stdFs,
  'std/http': stdHttp,
  'std/web': stdWeb,
  'std/ai': stdAi,
};

export const STD_MODULE_NAMES: readonly string[] = Object.keys(STD_MODULES).sort();

/** A `Host` backed by the Node process: stdout, stderr, env, and the clock. */
export function createNodeHost(): Host {
  return {
    writeOut: (text: string): void => {
      process.stdout.write(text);
    },
    writeErr: (text: string): void => {
      process.stderr.write(text);
    },
    getEnv: (name: string): string | undefined => process.env[name],
    now: (): number => Date.now(),
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
