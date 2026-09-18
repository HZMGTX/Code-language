/**
 * Conformance suite.
 *
 * Each `tests/conformance/<category>/<name>.lm` is executed and its complete
 * output — stdout plus any rendered diagnostic — is compared against the
 * matching `.expected` file. Adding a language feature means adding two small
 * files, and every behaviour already pinned stays pinned.
 *
 *   npm test              check against the golden files
 *   npm run test:update   rewrite the golden files from current behaviour
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { findFixtures, runFixture } from '../support/harness.js';

const CONFORMANCE_DIR = fileURLToPath(new URL('../../conformance', import.meta.url));
const UPDATE = process.env['UPDATE_SNAPSHOTS'] === '1';

const fixtures = await findFixtures(CONFORMANCE_DIR);

assert.ok(fixtures.length > 0, 'no conformance fixtures found in ' + CONFORMANCE_DIR);

// Group by the directory each fixture lives in, so failures read by category.
const byCategory = new Map<string, string[]>();
for (const fixture of fixtures) {
  const category = path.basename(path.dirname(fixture));
  const bucket = byCategory.get(category);
  if (bucket === undefined) byCategory.set(category, [fixture]);
  else bucket.push(fixture);
}

for (const [category, files] of [...byCategory].sort((a, b) => a[0].localeCompare(b[0]))) {
  describe(category, () => {
    for (const file of files) {
      const name = path.basename(file, '.lm');
      it(name, async () => {
        const { output } = await runFixture(file);
        const expectedPath = file.replace(/\.lm$/, '.expected');

        if (UPDATE) {
          await fsp.writeFile(expectedPath, output, 'utf8');
          return;
        }

        let expected: string;
        try {
          expected = await fsp.readFile(expectedPath, 'utf8');
        } catch {
          assert.fail(
            'missing golden file ' + path.relative(CONFORMANCE_DIR, expectedPath) +
              '\nrun `npm run test:update` to create it\n\nactual output was:\n' + output,
          );
        }
        assert.equal(output, expected);
      });
    }
  });
}

/**
 * A golden file can record a bug as correct, and one did.
 *
 * `npm run test:update` writes down whatever happens. When `TY010` — the first
 * warning the type checker ever produced — began stopping programs from running
 * at all, the fixture written for it was regenerated and recorded a file full of
 * diagnostics with none of its program's output. That looks exactly like a
 * fixture which only produces diagnostics, and its `-quiet` companion passed
 * because a program with no warnings ran fine. Nothing looked wrong.
 *
 * So the invariant is checked here rather than trusted to a reader: **a fixture
 * whose only diagnostics are warnings, and which prints at its top level, must
 * show what it printed.** An `error` in the golden file excuses it — a static
 * error never runs and a run-time one stops where it is — but a warning must
 * never stop anything, which is the whole distinction between the two.
 *
 * This needs no maintenance, which is why it is here as well as in
 * `warnings-run.test.ts`: that one asks the question of every warning *code* and
 * needs a case adding for each new one, while this asks it of every *fixture*
 * and fires on its own.
 */
describe('a golden file records a program that ran', () => {
  it('shows output for every fixture whose only diagnostics are warnings', async () => {
    const silent: string[] = [];
    let examined = 0;

    for (const file of fixtures) {
      const source = await fsp.readFile(file, 'utf8');
      // A `print` in the first column runs unless the program stopped. One
      // inside a function or a branch may legitimately never be reached.
      if (!/^print\(/mu.test(source)) continue;

      const golden = await fsp.readFile(file.replace(/\.lm$/u, '.expected'), 'utf8').catch(() => '');
      if (/^error\[/mu.test(golden) || !/^warning\[/mu.test(golden)) continue;
      examined += 1;

      // Everything a rendered diagnostic is made of: its header, its `-->`
      // line, its gutter and its notes. What is left is the program's own.
      const printed = golden
        .split('\n')
        .filter((line) => !/^(error|warning)\[/u.test(line))
        .filter((line) => !/^\s*(-->|\||=)/u.test(line))
        .filter((line) => !/^\s*\d+ \|/u.test(line))
        .filter((line) => line.trim() !== '');

      if (printed.length === 0) silent.push(path.relative(CONFORMANCE_DIR, file));
    }

    assert.deepEqual(
      silent,
      [],
      'these print but their golden file shows nothing, so the program did not run:\n  ' +
        silent.join('\n  '),
    );
    // A guard on the check itself: if no fixture pairs a warning with output,
    // this passes on nothing at all, which is how a check like this dies.
    assert.ok(examined > 0, 'no fixture produces warnings and prints — this checked nothing');
  });
});
