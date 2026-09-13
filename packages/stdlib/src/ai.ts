/**
 * `std/ai` — talking to a language model.
 *
 * The module is provider-agnostic. Which backend runs is decided, in order, by:
 *
 *   1. an explicit `provider:` argument
 *   2. `LUMEN_AI_PROVIDER` in the environment
 *   3. `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`
 *   4. otherwise the built-in `mock` provider
 *
 * The mock provider is deliberate, not a stub: it makes examples, tests and CI
 * run with no key, no network, and a deterministic answer. Real credentials are
 * strictly opt-in.
 *
 * Every call returns a Result, so a rate limit or a network failure is a value
 * you handle rather than a crash.
 */

import { NIL, list, num, str, type CallCtx, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectInt, expectList, expectStr, fn, moduleOf } from './support.js';

type Provider = 'anthropic' | 'openai' | 'mock';

interface Message {
  readonly role: string;
  readonly content: string;
}

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o-mini',
  mock: 'mock-1',
};

function resolveProvider(explicit: Value, ctx: CallCtx): Provider {
  const named = explicit.k === 'str' ? explicit.v : ctx.host.getEnv('LUMEN_AI_PROVIDER');
  if (named !== undefined && named !== '') {
    const normalized = named.toLowerCase();
    if (normalized === 'anthropic' || normalized === 'openai' || normalized === 'mock') {
      return normalized;
    }
    return ctx.panic(
      'unknown AI provider "' + named + '"',
      ['supported providers are: anthropic, openai, mock'],
    );
  }
  if ((ctx.host.getEnv('ANTHROPIC_API_KEY') ?? '') !== '') return 'anthropic';
  if ((ctx.host.getEnv('OPENAI_API_KEY') ?? '') !== '') return 'openai';
  return 'mock';
}

function mockReply(messages: readonly Message[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content ?? '';
  return (
    '(mock) No AI provider is configured, so this is a canned reply. ' +
    'You asked: "' + prompt + '". ' +
    'Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real answer.'
  );
}

async function callAnthropic(
  ctx: CallCtx,
  model: string,
  system: string | undefined,
  maxTokens: number,
  messages: readonly Message[],
): Promise<Value> {
  const key = ctx.host.getEnv('ANTHROPIC_API_KEY');
  if (key === undefined || key === '') return Err(str('ANTHROPIC_API_KEY is not set'));
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...(system === undefined ? {} : { system }),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    const text = await res.text();
    if (!res.ok) return Err(str('Anthropic API error ' + res.status + ': ' + text));
    const data = JSON.parse(text) as { content?: { type?: string; text?: string }[] };
    const reply = (data.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    return Ok(str(reply));
  } catch (error) {
    return Err(str(error instanceof Error ? error.message : String(error)));
  }
}

async function callOpenai(
  ctx: CallCtx,
  model: string,
  system: string | undefined,
  maxTokens: number,
  messages: readonly Message[],
): Promise<Value> {
  const key = ctx.host.getEnv('OPENAI_API_KEY');
  if (key === undefined || key === '') return Err(str('OPENAI_API_KEY is not set'));
  try {
    const full = system === undefined ? messages : [{ role: 'system', content: system }, ...messages];
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        messages: full.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    const text = await res.text();
    if (!res.ok) return Err(str('OpenAI API error ' + res.status + ': ' + text));
    const data = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    return Ok(str(data.choices?.[0]?.message?.content ?? ''));
  } catch (error) {
    return Err(str(error instanceof Error ? error.message : String(error)));
  }
}

async function dispatch(
  ctx: CallCtx,
  providerValue: Value,
  modelValue: Value,
  systemValue: Value,
  maxTokensValue: Value,
  messages: readonly Message[],
): Promise<Value> {
  const provider = resolveProvider(providerValue, ctx);
  const model =
    modelValue.k === 'str' && modelValue.v !== ''
      ? modelValue.v
      : (ctx.host.getEnv('LUMEN_AI_MODEL') ?? DEFAULT_MODELS[provider]);
  const system = systemValue.k === 'str' ? systemValue.v : undefined;
  const maxTokens = expectInt(maxTokensValue, ctx, 'maxTokens');

  switch (provider) {
    case 'anthropic':
      return await callAnthropic(ctx, model, system, maxTokens, messages);
    case 'openai':
      return await callOpenai(ctx, model, system, maxTokens, messages);
    default:
      return Ok(str(mockReply(messages)));
  }
}

/** Read a `{ role: "user", content: "..." }` map out of a conversation list. */
function toMessage(value: Value, ctx: CallCtx): Message {
  if (value.k !== 'map') {
    return ctx.panic('each message must be a Map with `role` and `content`');
  }
  const role = value.entries.get('role');
  const content = value.entries.get('content');
  if (role === undefined || role.k !== 'str') ctx.panic('message `role` must be a Str');
  if (content === undefined || content.k !== 'str') ctx.panic('message `content` must be a Str');
  return { role: role.k === 'str' ? role.v : 'user', content: content.k === 'str' ? content.v : '' };
}

const COMMON_PARAMS = [
  { name: 'model', defaultValue: NIL },
  { name: 'system', defaultValue: NIL },
  { name: 'maxTokens', defaultValue: num(1024) },
  { name: 'provider', defaultValue: NIL },
] as const;

export function stdAi(): Map<string, Value> {
  return moduleOf(
    /** One-shot question. Returns `Ok(reply)` or `Err(message)`. */
    fn('chat', ['prompt', ...COMMON_PARAMS], async (a, c) => {
      const prompt = expectStr(arg(a, 0), c, 'chat(prompt)');
      return await dispatch(c, arg(a, 4), arg(a, 1), arg(a, 2), arg(a, 3), [
        { role: 'user', content: prompt },
      ]);
    }),

    /** Multi-turn conversation: a List of `{ role, content }` maps. */
    fn('converse', ['messages', ...COMMON_PARAMS], async (a, c) => {
      const messages = expectList(arg(a, 0), c, 'converse(messages)');
      return await dispatch(
        c,
        arg(a, 4),
        arg(a, 1),
        arg(a, 2),
        arg(a, 3),
        messages.items.map((item) => toMessage(item, c)),
      );
    }),

    /** Build a message for `converse`. */
    fn('message', ['role', 'content'], (a, c) => {
      const role = expectStr(arg(a, 0), c, 'message(role)');
      const content = expectStr(arg(a, 1), c, 'message(content)');
      return {
        k: 'map',
        entries: new Map<string, Value>([
          ['role', str(role)],
          ['content', str(content)],
        ]),
      };
    }),

    /** Which provider will actually be used — handy for diagnostics. */
    fn('provider', [], (_a, c) => str(resolveProvider(NIL, c))),

    /** The providers this build knows about. */
    fn('providers', [], () => list([str('anthropic'), str('openai'), str('mock')])),
  );
}
