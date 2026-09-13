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
import { stdStr } from './str.js';
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
  ['std/fs', stdFs],
  ['std/http', stdHttp],
  ['std/web', stdWeb],
  ['std/ai', stdAi],
]);

export const STD_MODULE_NAMES: readonly string[] = [...STD_MODULES.keys()].sort();
