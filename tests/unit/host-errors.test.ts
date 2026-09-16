/**
 * No function in the library answers in the host's words.
 *
 * `docs/stdlib.md` states the rule: *"Error text belongs to Lumen, not to the
 * host."* It is there because the host's words are wrong twice over — they name
 * functions and parameters the reader never called, in a language they are not
 * writing, and they change between Node releases, so a Lumen program's output
 * would depend on which Node happened to be installed.
 *
 * It was a rule kept by hand until `std/process` broke it:
 *
 *     run("")   ->   cannot run ``: TypeError [ERR_INVALID_ARG_VALUE]:
 *                    The argument 'file' cannot be empty. Received ''
 *
 * One `catch` that stringified whatever it caught. Every sibling in the module
 * translated its errors properly, which is exactly why nobody looked at that
 * one — so this test asks the question of the whole library at once rather than
 * function by function: call every export with an argument of the wrong shape,
 * and look for the host in the answer.
 *
 * The wrong shapes are deliberately dull. The point is not to find a clever
 * input, it is to reach every type check and every `catch` there is; a wrong
 * argument is simply the shortest way to the error path.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { stdModuleExports } from '@lumen-lang/stdlib';

import { runSource } from '../support/harness.js';

/**
 * Text that means a host error escaped instead of being translated.
 *
 * `null` and `NaN` are deliberately **not** here. JSON spells nil `null`, so
 * `stringify(nil)` is `null` and `std/web.json(nil)` carries a body of `null`;
 * and `Infinity`/`NaN` are how `inspect` renders those values, which is Lumen's
 * own spelling rather than a leak. Including them made the sweep report two
 * correct answers as defects, which is the failure mode a check like this has
 * to avoid — a check nobody believes is worse than no check.
 */
const HOST_WORDS: readonly RegExp[] = [
  /TypeError/,
  /RangeError/,
  /ReferenceError/,
  /\bError:/,
  /ERR_[A-Z_]+/,
  /\berrno\b/,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bEISDIR\b/,
  /\bEEXIST\b/,
  /\[object [A-Z]/,
  /\bundefined\b/,
  /at Object\./,
  /node:internal/,
  /is not a function/,
  /Cannot read propert/,
  /Invalid regular expression/,
];

/**
 * Arguments that reach an error path: the wrong shape, and the awkward values.
 *
 * The wrong shapes reach the type checks. The **boundary values** matter just
 * as much and were missing from the first version of this test, which was
 * checked by putting the `std/process` bug back and finding that the sweep
 * still passed: `run("")` was the input that produced the raw `TypeError`, and
 * no wrong *type* goes anywhere near it. An empty string, a zero and an empty
 * collection are what a program computes by accident — a trimmed field, a
 * `len()` of nothing, a list that filtered down to none — so they are where the
 * unconsidered branch is.
 */
const WRONG_ARGUMENTS = ['nil', '[]', '{}', '0 - 1', '"x"', '""', '0', '[""]', '"/"'];

/**
 * Exports this cannot call.
 *
 * `serve` never returns, `exit` stops the process, and `sleep` and `input`
 * block. Each is covered by a test that gives it a seam — see `server.test.ts`
 * and `input.test.ts`.
 */
const UNCALLABLE: ReadonlySet<string> = new Set(['serve', 'exit', 'sleep', 'input']);

describe('no library function answers in the host’s words', () => {
  it('stays in Lumen’s own words for every wrong argument', async () => {
    const leaks: string[] = [];
    let calls = 0;

    for (const [moduleName, exports] of stdModuleExports()) {
      for (const [name, ty] of exports) {
        if (UNCALLABLE.has(name)) continue;
        // As many arguments as the function requires, not one. Passing a single
        // argument meant `copy(a, b)` and `rename(a, b)` failed on arity and
        // never reached their own error paths at all — which is exactly where
        // `ERR_FS_CP_NON_DIR_TO_DIR` and `ERR_FS_CP_EINVAL` were leaking, found
        // by a probe rather than by this sweep. A check that cannot reach half
        // the error paths in the library is not the check it claims to be.
        const arity =
          ty?.k === 'fn' ? ty.params.filter((p) => !p.optional).length : 1;
        for (const wrong of WRONG_ARGUMENTS) {
          const filled = Array.from({ length: Math.max(1, arity) }, () => wrong).join(', ');
          const source = `import { ${name} } from "${moduleName}"\nprint(${name}(${filled}))\n`;
          const result = await runSource(source);
          calls += 1;
          for (const word of HOST_WORDS) {
            if (!word.test(result.output)) continue;
            leaks.push(
              `${moduleName}.${name}(${filled}) matched ${String(word)}:\n` +
                result.output.trim().split('\n').slice(0, 6).join('\n'),
            );
            break;
          }
        }
      }
    }

    assert.deepEqual(leaks, []);
    // A guard on the sweep itself: if `stdModuleExports` ever came back empty,
    // or the skip list grew to cover everything, the assertion above would pass
    // while checking nothing at all.
    assert.ok(calls > 1400, 'only made ' + String(calls) + ' calls; the sweep is not reaching the library');
  });
});
