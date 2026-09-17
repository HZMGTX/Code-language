/**
 * `std/http` — the HTTP client.
 *
 * Requests return `Ok(response)` or `Err(message)`. A response is a map with
 * `status`, `headers` and `body`; a non-2xx status is still `Ok`, because the
 * request itself succeeded — check `status` to decide what it means.
 */

import { list, map, num, str, typeName, type CallCtx, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectMap, expectStr, fn, moduleOf, withDocs, withSignatures } from './support.js';

const NO_HEADERS: Value = map(new Map());

function headersToMap(headers: Headers): Value {
  const out = new Map<string, Value>();
  headers.forEach((value, key) => out.set(key.toLowerCase(), str(value)));
  return map(out);
}

/**
 * Every `Set-Cookie` the response carried, in order.
 *
 * `Set-Cookie` is the one header the Fetch API deliberately does not combine,
 * because a cookie's value can contain a comma — `Expires=Wed, 09 Jun 2021` —
 * so a joined form could not be split back apart. `forEach` therefore yields
 * only one of them, and `headers["set-cookie"]` held the **last**: a login
 * response setting a session cookie and a CSRF token gave up one of the two,
 * silently, and reading `set-cookie` is very nearly the only reason to look at
 * a response's headers at all.
 *
 * So the complete list is its own field, which is additive: `set-cookie` still
 * says what the Fetch API says, and `cookies` is the answer to use whenever
 * there might be more than one.
 */
function cookiesOf(headers: Headers): Value {
  return list(headers.getSetCookie().map((cookie) => str(cookie)));
}

function mapToHeaders(value: Value, ctx: CallCtx, where: string): Record<string, string> {
  // Keys come from the program, so `__proto__` must be a header, not a write
  // to the prototype.
  const out = Object.create(null) as Record<string, string>;
  if (value.k !== 'map') return out;
  for (const [key, item] of value.entries) {
    if (item.k === 'str') {
      out[key] = item.v;
      continue;
    }
    if (item.k === 'num') {
      out[key] = String(item.v);
      continue;
    }
    // Anything else used to be sent as an **empty** header, which is the one
    // answer that is silently wrong: `headers: { authorization: token }` where
    // `token` came back `nil` — a config value that was not there — put
    // `authorization:` on the wire with nothing after it, and the server's 401
    // then sent the reader hunting for a token problem rather than a nil.
    ctx.panic(where + ' value for `' + key + '` must be a Str or Num, got ' + typeName(item), [
      'a header is text on the wire, and there is no reading of ' + typeName(item) + ' as text',
      'that a server would understand — convert it yourself with `.str()`',
    ]);
  }
  return out;
}

/**
 * Why a URL cannot be fetched, or undefined when it can.
 *
 * Checked here rather than left to the host, which names the wrong thing for
 * every one of them: `file:///etc/hostname` answered "not implemented... yet...",
 * `blob:http://…/x` answered "invalid method" — for a GET — and only `ws://`
 * happened to say "unknown scheme". None of those sends the reader to the
 * scheme, which is what is actually wrong.
 */
function badUrl(url: string): string | undefined {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'that is not a URL: it needs a scheme and a host, as in `https://example.com/path`';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'std/http speaks http and https, not `' + parsed.protocol.replace(/:$/, '') + '`';
  }
  return undefined;
}

async function send(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<Value> {
  const wrong = badUrl(url);
  if (wrong !== undefined) return Err(str(method + ' ' + url + ' failed: ' + wrong));
  try {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return Ok(
      map(
        new Map<string, Value>([
          ['status', num(response.status)],
          ['ok', { k: 'bool', v: response.ok }],
          ['headers', headersToMap(response.headers)],
          ['cookies', cookiesOf(response.headers)],
          ['body', str(text)],
        ]),
      ),
    );
  } catch (error) {
    // `fetch` rejects with "fetch failed" and hides the reason in `cause`,
    // whose text is Node's, not ours. Name the request instead, and keep the
    // underlying sentence after it — it is the only place the real reason is.
    const cause =
      error !== null && typeof error === 'object' && 'cause' in error
        ? (error as { cause: unknown }).cause
        : undefined;
    const detail =
      cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
    return Err(str(method + ' ' + url + ' failed: ' + detail));
  }
}

/**
 * Every request answers a `Result`: `Ok(response)` when the request completed,
 * `Err(message)` when it could not be made at all. A non-2xx status is still
 * `Ok` — the request succeeded, the answer was a refusal — so the status is in
 * the response map rather than in the shape of the result.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  get: '(url: Str, headers: Map = {}) -> Result',
  post: '(url: Str, body: Str, headers: Map = {}) -> Result',
  request: '(method: Str, url: Str, body: Any = nil, headers: Map = {}) -> Result',
};

/** One line each, for `help()` and the generated reference. */
const DOCS: Readonly<Record<string, string>> = {
  get: 'GET a URL: `Ok({status, ok, headers, cookies, body})`, or `Err(message)` when no request could be made.',
  post: 'POST a body to a URL; the answer has the same shape as `get`.',
  request: 'Any method against a URL, with an optional body; the answer has the same shape as `get`.',
};

export function stdHttp(): Map<string, Value> {
  return withSignatures(
    withDocs(
    moduleOf(
    fn('get', ['url', { name: 'headers', defaultValue: NO_HEADERS }], async (a, c) =>
      await send(
        'GET',
        expectStr(arg(a, 0), c, 'get(url)'),
        undefined,
        mapToHeaders(expectMap(arg(a, 1), c, 'get headers'), c, 'get headers'),
      ),
    ),

    fn(
      'post',
      ['url', 'body', { name: 'headers', defaultValue: NO_HEADERS }],
      async (a, c) =>
        await send(
          'POST',
          expectStr(arg(a, 0), c, 'post(url)'),
          expectStr(arg(a, 1), c, 'post(body)'),
          mapToHeaders(expectMap(arg(a, 2), c, 'post headers'), c, 'post headers'),
        ),
    ),

    fn(
      'request',
      ['method', 'url', { name: 'body', defaultValue: { k: 'nil' } }, { name: 'headers', defaultValue: NO_HEADERS }],
      async (a, c) => {
        const bodyValue = arg(a, 2);
        return await send(
          expectStr(arg(a, 0), c, 'request(method)').toUpperCase(),
          expectStr(arg(a, 1), c, 'request(url)'),
          bodyValue.k === 'nil' ? undefined : expectStr(bodyValue, c, 'request(body)'),
          mapToHeaders(expectMap(arg(a, 3), c, 'request headers'), c, 'request headers'),
        );
      },
    ),
    ),
    DOCS,
    ),
    SIGNATURES,
  );
}
