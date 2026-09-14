/**
 * The standard module registry.
 *
 * Kept in its own file so that `prelude.ts` can name the modules without
 * importing `index.ts`, which imports the prelude in turn.
 */

import type { Value } from '@lumen-lang/core';

import { stdAi } from './ai.js';
import { stdCore } from './core.js';
import { stdFs } from './fs.js';
import { stdHttp } from './http.js';
import { stdJson } from './json.js';
import { stdList } from './list.js';
import { stdMap } from './map.js';
import { stdMath } from './math.js';
import { stdOption } from './option.js';
import { stdResult } from './result.js';
import { stdSet } from './set.js';
import { stdStr } from './str.js';
import { stdTime } from './time.js';
import { stdWeb } from './web.js';

/**
 * Every standard module, keyed by the path you `import` it from.
 *
 * A `Map`, because the key comes from the program: looking `constructor` up in
 * an object literal answers with a JavaScript function, and `import { x } from
 * "constructor"` then crashed the interpreter instead of saying there is no
 * such module.
 */
export const STD_MODULES: ReadonlyMap<string, () => Map<string, Value>> = new Map<
  string,
  () => Map<string, Value>
>([
  ['std/core', stdCore],
  ['std/str', stdStr],
  ['std/list', stdList],
  ['std/map', stdMap],
  ['std/math', stdMath],
  ['std/json', stdJson],
  ['std/option', stdOption],
  ['std/result', stdResult],
  ['std/set', stdSet],
  ['std/time', stdTime],
  ['std/fs', stdFs],
  ['std/http', stdHttp],
  ['std/web', stdWeb],
  ['std/ai', stdAi],
]);

export const STD_MODULE_NAMES: readonly string[] = [...STD_MODULES.keys()].sort();

/** Built once; instantiating fourteen modules per checked file would be waste. */
let exportNames: ReadonlyMap<string, readonly string[]> | undefined;

/**
 * What every standard module exports, as names.
 *
 * This is what lets `lumen check` catch `import { nope } from "std/list"`
 * without running the program. The resolver in `@lumen-lang/core` cannot
 * import the standard library — that is the dependency rule the whole project
 * rests on — so it takes the answer as data instead, through
 * `ResolveOptions.moduleExports`.
 *
 * Derived by instantiating each module rather than written down beside it, so
 * a new export cannot be added without the checker learning about it.
 */
export function stdModuleExports(): ReadonlyMap<string, readonly string[]> {
  if (exportNames !== undefined) return exportNames;
  const built = new Map<string, readonly string[]>();
  for (const [name, factory] of STD_MODULES) built.set(name, [...factory().keys()]);
  exportNames = built;
  return built;
}
