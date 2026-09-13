/**
 * The `lumen` command's own surface: what it accepts, and what it says when
 * it does not.
 *
 * A command-line tool's error messages are the first thing a new user meets,
 * and they are easy to leave untested because nothing in the language breaks
 * when they are wrong.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
const HELLO = fileURLToPath(new URL('../../../examples/hello.lm', import.meta.url));

async function run(args: readonly string[]): Promise<{ code: number; out: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 0, out }));
  });
}

describe('the lumen command', () => {
  it('prints a version', async () => {
    const { code, out } = await run(['--version']);
    assert.equal(code, 0);
    assert.match(out, /^\d+\.\d+\.\d+/);
  });

  it('runs a file named without a subcommand', async () => {
    const { code, out } = await run([HELLO]);
    assert.equal(code, 0);
    assert.match(out, /\w/);
  });

  it('names a mistyped command, and guesses the one meant', async () => {
    const { code, out } = await run(['tets']);
    assert.equal(code, 2);
    assert.match(out, /unknown command `tets`/);
    assert.match(out, /did you mean `test`/);
  });

  it('does not mistake a mistyped command for a missing file', async () => {
    const { out } = await run(['nonexistent-command']);
    assert.match(out, /unknown command/);
    assert.doesNotMatch(out, /cannot read/);
  });

  it('rejects an option it does not know, rather than reading it as a file', async () => {
    const { code, out } = await run(['run', '--weird', HELLO]);
    assert.equal(code, 2);
    assert.match(out, /unknown option `--weird`/);
  });

  it('says which command was missing its file', async () => {
    const { code, out } = await run(['ast']);
    assert.equal(code, 2);
    assert.match(out, /`ast` needs a file/);
  });

  it('reports a file that really is missing as a file', async () => {
    const { code, out } = await run(['run', 'no-such-program.lm']);
    assert.equal(code, 1);
    assert.match(out, /cannot read/);
  });

  it('checks a tree of files without running any of them', async () => {
    const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
    const { code, out } = await run(['check', examples]);
    assert.equal(code, 0);
    assert.match(out, /files checked, no problems/);
    // `hello.lm` prints when it runs. Checking must not.
    assert.doesNotMatch(out, /Hello/);
  });

  it('reports a static error from check, and exits non-zero', async () => {
    const bad = fileURLToPath(
      new URL('../../../tests/conformance/static/unreached-typo.lm', import.meta.url),
    );
    const { code, out } = await run(['check', bad]);
    assert.equal(code, 1);
    assert.match(out, /RS001/);
    assert.match(out, /have problems/);
  });

  it('exits non-zero when the program has an error', async () => {
    const { code } = await run(['run', fileURLToPath(new URL('../../../package.json', import.meta.url))]);
    assert.notEqual(code, 0);
  });
});
