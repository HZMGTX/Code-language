/**
 * `input()` against a real piped stdin.
 *
 * A pipe delivers every line at once, long before the program asks for the
 * second one. The host has to queue what arrives rather than reading one line
 * and letting the rest fall on the floor, so this spawns a real process and
 * feeds it several lines.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));

let workdir = '';

async function runWithInput(source: string, stdin: string): Promise<string> {
  const script = path.join(workdir, 'script.lm');
  await fsp.writeFile(script, source, 'utf8');
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'run', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('exit', () => resolve(out));
    child.stdin.end(stdin);
  });
}

describe('input() over a pipe', () => {
  before(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-input-'));
  });

  after(async () => {
    if (workdir !== '') await fsp.rm(workdir, { recursive: true, force: true });
  });

  const READ_THREE = `
var seen = []
for i in range(3) {
  match input("") {
    Some(line) => seen.push(line),
    None       => seen.push("<end>"),
  }
}
print(seen.join("|"))
`;

  it('reads every line, not only the first', async () => {
    const out = await runWithInput(READ_THREE, 'alpha\nbeta\ngamma\n');
    assert.match(out, /alpha\|beta\|gamma/);
  });

  it('reports the end of input rather than hanging', async () => {
    const out = await runWithInput(READ_THREE, 'only\n');
    assert.match(out, /only\|<end>\|<end>/);
  });

  it('gives None straight away when there is no input at all', async () => {
    const out = await runWithInput(READ_THREE, '');
    assert.match(out, /<end>\|<end>\|<end>/);
  });

  it('keeps a line that has no trailing newline', async () => {
    const out = await runWithInput(READ_THREE, 'first\nlast');
    assert.match(out, /first\|last\|<end>/);
  });
});
