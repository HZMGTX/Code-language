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
