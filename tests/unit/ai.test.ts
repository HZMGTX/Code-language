/**
 * The AI slice, driven through every path a model-backed program has.
 *
 * A real reply is text, so a program that asks for JSON has two outcomes worth
 * testing — parsed, and not parsed — and until `LUMEN_AI_MOCK_REPLY` existed
 * only the second was reachable without an API key. These run
 * `examples/triage.lm`, which is the program those paths belong to.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
const TRIAGE = fileURLToPath(new URL('../../../examples/triage.lm', import.meta.url));

async function triage(reply?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: '1',
      LUMEN_AI_PROVIDER: 'mock',
    };
    // A real key in the environment would send these tests to the network.
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    if (reply === undefined) delete env.LUMEN_AI_MOCK_REPLY;
    else env.LUMEN_AI_MOCK_REPLY = reply;

    const child = spawn(process.execPath, [CLI, 'run', TRIAGE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', () => resolve(out));
  });
}

describe('a model-backed program', () => {
  it('falls back to its own rule when the reply is prose', async () => {
    const out = await triage();
    assert.match(out, /0 of 5 classified by the model/);
    // The keyword rule still has to be right, or the fallback is worthless.
    assert.match(out, /T-1\s+billing/);
    assert.match(out, /T-2\s+bug/);
    assert.match(out, /T-3\s+feature/);
    assert.match(out, /T-4\s+account/);
    assert.match(out, /T-5\s+other/);
  });

  it('uses the reply when it parses and says something allowed', async () => {
    const out = await triage('{"category":"billing","urgency":4}');
    assert.match(out, /5 of 5 classified by the model/);
    assert.match(out, /T-1\s+billing\s+4\s+model/);
  });

  it('unwraps a code fence, which models add whether or not you ask', async () => {
    const out = await triage('```json\n{"category":"bug","urgency":5}\n```');
    assert.match(out, /5 of 5 classified by the model/);
    assert.match(out, /T-1\s+bug\s+5\s+model/);
  });

  it('rejects a reply that parses but says something it was not offered', async () => {
    const out = await triage('{"category":"urgent","urgency":9}');
    assert.match(out, /0 of 5 classified by the model/);
  });

  it('rejects a reply whose urgency is out of range', async () => {
    const out = await triage('{"category":"bug","urgency":99}');
    assert.match(out, /0 of 5 classified by the model/);
  });

  it('rejects a reply missing a field entirely', async () => {
    const out = await triage('{"category":"bug"}');
    assert.match(out, /0 of 5 classified by the model/);
  });
});
