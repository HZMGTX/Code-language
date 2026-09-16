/**
 * The AI slice, driven through every path a model-backed program has.
 *
 * A real reply is text, so a program that asks for JSON has two outcomes worth
 * testing — parsed, and not parsed — and until `LUMEN_AI_MOCK_REPLY` existed
 * only the second was reachable without an API key. These run
 * `examples/triage.lm`, which is the program those paths belong to.
 */

import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * Which provider a call actually reaches.
 *
 * `docs/stdlib.md` states the order: an explicit `provider:` argument, then
 * `LUMEN_AI_PROVIDER`, then `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, then
 * `mock`. An **empty** explicit argument does not name a provider, so step 1
 * does not apply to it and step 2 does — and it did not:
 *
 *     LUMEN_AI_PROVIDER=mock ANTHROPIC_API_KEY=sk-real
 *     chat("say hi", provider: "")     // went to the real API, with the key
 *
 * The empty string made the resolver skip the environment entirely and fall
 * through to the key. So `chat(prompt, provider: config.getOr("provider", ""))`
 * — reading the provider from a config file with an empty default, which is an
 * ordinary way to write it — silently cancelled the setting that keeps every
 * test and all of CI offline, and sent the prompt out.
 *
 * These run a one-line program with the environment set deliberately, and read
 * back which provider answered. A fake key is used, so the worst a regression
 * can do is produce a 401 rather than send anything real anywhere.
 */
let next = 0;

describe('which AI provider a call reaches', () => {
  async function ask(source: string, env: Record<string, string | undefined>): Promise<string> {
    return await new Promise((resolve, reject) => {
      const full: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
      for (const key of ['LUMEN_AI_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'LUMEN_AI_MOCK_REPLY']) {
        delete full[key];
      }
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) full[key] = value;
      }
      // A real file rather than `/dev/stdin`: the CLI reads the path it is
      // given, and `/dev/stdin` on a pipe a Node parent created is not
      // readable — it answers `cannot read /dev/stdin`, which would have made
      // all of these pass or fail for the wrong reason.
      const file = path.join(os.tmpdir(), 'lumen-provider-' + String(next++) + '.lm');
      writeFileSync(file, source, 'utf8');
      const child = spawn(process.execPath, [CLI, 'run', file], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: full,
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('error', reject);
      child.on('exit', () => {
        rmSync(file, { force: true });
        resolve(out);
      });
    });
  }

  const ASK = 'import { chat } from "std/ai"\nprint(chat("say hi", provider: PROVIDER))\n';

  it('does not let an empty provider argument cancel LUMEN_AI_PROVIDER', async () => {
    // The one that matters. A fake key, so a regression cannot send anything.
    const out = await ask(ASK.replace('PROVIDER', '""'), {
      LUMEN_AI_PROVIDER: 'mock',
      ANTHROPIC_API_KEY: 'sk-not-a-real-key',
    });
    assert.match(out, /\(mock\)/, 'an empty provider argument reached a real provider');
    assert.doesNotMatch(out, /Anthropic API/, 'the prompt was sent to Anthropic');
  });

  it('does not let a nil provider argument cancel it either', async () => {
    const out = await ask(ASK.replace('PROVIDER', 'nil'), {
      LUMEN_AI_PROVIDER: 'mock',
      ANTHROPIC_API_KEY: 'sk-not-a-real-key',
    });
    assert.match(out, /\(mock\)/);
  });

  it('lets a named provider argument win, which is step 1', async () => {
    const out = await ask(ASK.replace('PROVIDER', '"mock"'), {
      ANTHROPIC_API_KEY: 'sk-not-a-real-key',
    });
    assert.match(out, /\(mock\)/);
  });

  it('says the mock was asked for, rather than advising a key that is already set', async () => {
    // Advice that cannot be followed is worse than none: the key *is* set, and
    // `LUMEN_AI_PROVIDER=mock` overrides it, so "set a key" leaves the reader
    // assuming their key is broken.
    const out = await ask(ASK.replace('PROVIDER', '""'), {
      LUMEN_AI_PROVIDER: 'mock',
      ANTHROPIC_API_KEY: 'sk-not-a-real-key',
    });
    assert.match(out, /The mock provider was asked for/);
    assert.doesNotMatch(out, /Set ANTHROPIC_API_KEY/);
  });

  it('still advises setting a key when there is genuinely no provider', async () => {
    // The other direction: with nothing set, that advice is exactly right.
    const out = await ask(ASK.replace('PROVIDER', 'nil'), {});
    assert.match(out, /No AI provider is configured/);
    assert.match(out, /Set ANTHROPIC_API_KEY/);
  });
});
