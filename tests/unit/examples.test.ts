/**
 * Every example in `examples/` must actually run.
 *
 * This is the cheapest guard against "the language broke": it exercises the
 * lexer, parser, interpreter, standard library and module resolver together on
 * code a reader is expected to copy.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runSource } from '../support/harness.js';

const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples', import.meta.url));

/** `website.lm` never returns by design, so it gets its own server test. */
const BLOCKING = new Set(['website.lm']);

const files = (await fsp.readdir(EXAMPLES_DIR))
  .filter((name) => name.endsWith('.lm'))
  .sort();

describe('examples', () => {
  it('finds the example programs', () => {
    assert.ok(files.length >= 4, 'expected at least 4 examples, found ' + files.length);
  });

  for (const name of files) {
    if (BLOCKING.has(name)) continue;
    it(name + ' runs without error', async () => {
      const source = await fsp.readFile(path.join(EXAMPLES_DIR, name), 'utf8');
      const result = await runSource(source, name);
      assert.equal(result.failed, false, 'example failed:\n' + result.output);
      assert.ok(result.output.length > 0, 'example produced no output');
    });
  }

  it('hello.lm greets', async () => {
    const source = await fsp.readFile(path.join(EXAMPLES_DIR, 'hello.lm'), 'utf8');
    const { output } = await runSource(source, 'hello.lm');
    assert.match(output, /Hello from Lumen/);
  });

  it('tour.lm demonstrates each feature it claims to', async () => {
    const source = await fsp.readFile(path.join(EXAMPLES_DIR, 'tour.lm'), 'utf8');
    const { output } = await runSource(source, 'tour.lm');
    assert.match(output, /2\/3 complete/, 'struct + enum + match section');
    assert.match(output, /total cost: 16/, 'pipeline section');
    assert.match(output, /Ok\(8\)/, 'Result section');
    assert.match(output, /Err\("no price for linker"\)/, '? propagation');
    assert.match(output, /a list starting with 1 and 2 more/, 'list pattern');
    assert.match(output, /1 2 3/, 'closure section');
  });

  it('ai_agent.lm falls back to the mock provider with no API key', async () => {
    const source = await fsp.readFile(path.join(EXAMPLES_DIR, 'ai_agent.lm'), 'utf8');
    const { output } = await runSource(source, 'ai_agent.lm');
    assert.match(output, /provider: mock/);
    assert.match(output, /recursion: \(mock\)/);
    assert.doesNotMatch(output, /could not summarize/);
  });

  it('website.lm parses even though it is not run here', async () => {
    const source = await fsp.readFile(path.join(EXAMPLES_DIR, 'website.lm'), 'utf8');
    const { parse } = await import('@lumen-lang/core');
    assert.doesNotThrow(() => parse(source, 'website.lm'));
  });
});
