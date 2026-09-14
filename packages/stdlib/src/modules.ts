/**
 * The standard module registry.
 *
 * Kept in its own file so that `prelude.ts` can name the modules without
 * importing `index.ts`, which imports the prelude in turn.
 */

import { signatureTy, type Ty, type Value } from '@lumen-lang/core';

import { stdAi } from './ai.js';
import { stdCore } from './core.js';
import { stdFs } from './fs.js';
import { stdHttp } from './http.js';
import { stdJson } from './json.js';
import { stdList } from './list.js';
import { stdMap } from './map.js';
import { stdMath } from './math.js';
import { stdOption } from './option.js';
import { stdPath } from './path.js';
import { stdRegex } from './regex.js';
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
  ['std/path', stdPath],
  ['std/regex', stdRegex],
  ['std/time', stdTime],
  ['std/fs', stdFs],
  ['std/http', stdHttp],
  ['std/web', stdWeb],
  ['std/ai', stdAi],
]);

export const STD_MODULE_NAMES: readonly string[] = [...STD_MODULES.keys()].sort();

/** Built once; instantiating fourteen modules per checked file would be waste. */
let exportTypes: ReadonlyMap<string, ReadonlyMap<string, Ty>> | undefined;

/**
 * What every standard module exports, and the type of each.
 *
 * This is what lets `lumen check` catch `import { nope } from "std/list"`, and
 * then `upper(1)` once `upper` has been imported, without running the program.
 * The static passes in `@lumen-lang/core` cannot import the standard library —
 * that is the dependency rule the whole project rests on — so they take the
 * answer as data instead, through `ResolveOptions.moduleExports`.
 *
 * Derived by instantiating each module rather than written down beside it, so
 * a new export cannot be added without the checker learning about it. An export
 * with no declared signature is `Any`, exactly as it was before any of the
 * library was typed.
 */
export function stdModuleExports(): ReadonlyMap<string, ReadonlyMap<string, Ty>> {
  if (exportTypes !== undefined) return exportTypes;
  const built = new Map<string, ReadonlyMap<string, Ty>>();
  for (const [moduleName, factory] of STD_MODULES) {
    const types = new Map<string, Ty>();
    for (const [name, value] of factory()) {
      types.set(name, typeOfExport(value));
    }
    built.set(moduleName, types);
  }
  exportTypes = built;
  return built;
}

/** Anything the library has not described: compatible with everything. */
const ANY: Ty = { k: 'any' };

/**
 * One export's type, and `Any` for anything undeclared or unparseable.
 *
 * `signatureTy` raises on a signature that will not parse, which is right for
 * the primitive. Here it must not: this runs on the way to running a program,
 * so a typo in one signature would stop every Lumen program with a diagnostic
 * about a file the user has never seen. `tests/unit/signatures.test.ts`
 * asserts that every signature parses, so it is a failed build instead.
 */
function typeOfExport(value: Value): Ty {
  if (value.k !== 'native' || value.signature === undefined) return ANY;
  try {
    return signatureTy(value.signature);
  } catch {
    return ANY;
  }
}
