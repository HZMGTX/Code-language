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
import { Err, Ok, arg, expectInt, expectList, expectStr, fn, moduleOf, withDocs, withSignatures } from './support.js';

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
  // An explicit argument takes effect only when it *names* something. An empty
  // string does not, so step 1 of the documented order does not apply to it and
  // step 2 does.
  //
  // That is the whole of a nasty bug. `provider: ""` made `named` the empty
  // string, so `LUMEN_AI_PROVIDER` was never consulted, and the guard below
  // then fell through to the key-based default — which means
  // `chat(prompt, provider: config.getOr("provider", ""))`, reading the
  // provider from a config file with an empty default, silently cancelled
  // `LUMEN_AI_PROVIDER=mock` and sent the prompt to the real API with the real
  // key. That setting is what keeps every test and all of CI offline.
  const given = explicit.k === 'str' && explicit.v !== '' ? explicit.v : undefined;
  const named = given ?? ctx.host.getEnv('LUMEN_AI_PROVIDER');
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

/**
 * A failed request, said in Lumen's words and naming which request it was.
 *
 * `fetch` rejects with the two words "fetch failed" and hides the reason in
 * `cause`, so both providers answered `Err("fetch failed")` — no provider, no
 * endpoint, and no cause. `docs/stdlib.md` singles that exact message out as
 * the thing not to do: *"`std/http` names the request that failed, since 'fetch
 * failed' on its own says nothing when several are in flight."* `std/http` does
 * it properly; these two did not, and a program that asks a model something is
 * a program with one request in flight and no other clue about it.
 */
function requestFailed(provider: string, endpoint: string, error: unknown): Value {
  const cause =
    error !== null && typeof error === 'object' && 'cause' in error
      ? (error as { cause: unknown }).cause
      : undefined;
  const detail =
    cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return Err(str(provider + ' request to ' + endpoint + ' failed: ' + detail));
}

function mockReply(
  messages: readonly Message[],
  scripted: string | undefined,
  why: 'asked' | 'no-key',
): string {
  // `LUMEN_AI_MOCK_REPLY` makes the mock say exactly one thing. A program that
  // asks the model for JSON and then parses it has two paths worth testing —
  // the reply parsed, and the reply did not — and without this only the second
  // is reachable without a key. It is a testing affordance, not a model: the
  // mock never looks at the prompt to decide what to say.
  if (scripted !== undefined && scripted !== '') return scripted;

  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content ?? '';
  // Two different reasons to be here, and they want different advice. Telling
  // somebody to set a key they have already set — because `mock` was *asked*
  // for, by argument or by environment, and overrides the key — is advice that
  // cannot be followed, and the reader is left assuming their key is broken.
  const advice =
    why === 'asked'
      ? 'The mock provider was asked for, so no key is being used.'
      : 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real answer.';
  return (
    '(mock) ' +
    (why === 'asked'
      ? 'This is a canned reply. '
      : 'No AI provider is configured, so this is a canned reply. ') +
    'You asked: "' + prompt + '". ' +
    advice
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
    return requestFailed('anthropic', 'https://api.anthropic.com/v1/messages', error);
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
    return requestFailed('openai', 'https://api.openai.com/v1/chat/completions', error);
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
    default: {
      // Whether `mock` was asked for or merely fallen back to changes what
      // advice the reply can honestly give.
      const asked =
        (providerValue.k === 'str' && providerValue.v !== '') ||
        (ctx.host.getEnv('LUMEN_AI_PROVIDER') ?? '') !== '';
      return Ok(
        str(mockReply(messages, ctx.host.getEnv('LUMEN_AI_MOCK_REPLY'), asked ? 'asked' : 'no-key')),
      );
    }
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

/**
 * A model call can always fail — no key, no network, a refusal — so `chat` and
 * `converse` answer a `Result` rather than raising. `model`, `system` and
 * `provider` default to nil, meaning "whatever the environment says", so they
 * take a Str or nil and are typed `Any`.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  chat:
    '(prompt: Str, model: Any = nil, system: Any = nil, maxTokens: Num = 1024, provider: Any = nil) -> Result',
  converse:
    '(messages: List, model: Any = nil, system: Any = nil, maxTokens: Num = 1024, provider: Any = nil) -> Result',
  message: '(role: Str, content: Str) -> Map',
  provider: '() -> Str',
  providers: '() -> List<Str>',
};

/** One line each, for `help()` and the generated reference. */
const DOCS: Readonly<Record<string, string>> = {
  chat: 'One question to a model: `Ok(reply)`, or `Err(message)` for no key, no network, or a refusal.',
  converse: 'A multi-turn conversation from a list of `{ role, content }` messages, answering like `chat`.',
  message: 'A `{ role, content }` message for `converse`.',
  provider: 'Which provider will be used, from the environment: anthropic, openai or mock.',
  providers: 'The providers this build knows about.',
};

export function stdAi(): Map<string, Value> {
  return withSignatures(
    withDocs(
    moduleOf(
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
    ),
    DOCS,
    ),
    SIGNATURES,
  );
}
