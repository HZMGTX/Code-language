/**
 * `std/http` — the HTTP client.
 *
 * Requests return `Ok(response)` or `Err(message)`. A response is a map with
 * `status`, `headers` and `body`; a non-2xx status is still `Ok`, because the
 * request itself succeeded — check `status` to decide what it means.
 */

import { map, num, str, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectMap, expectStr, fn, moduleOf, withSignatures } from './support.js';

const NO_HEADERS: Value = map(new Map());

function headersToMap(headers: Headers): Value {
  const out = new Map<string, Value>();
  headers.forEach((value, key) => out.set(key.toLowerCase(), str(value)));
  return map(out);
}

function mapToHeaders(value: Value): Record<string, string> {
  // Keys come from the program, so `__proto__` must be a header, not a write
  // to the prototype.
  const out = Object.create(null) as Record<string, string>;
  if (value.k !== 'map') return out;
  for (const [key, item] of value.entries) {
    out[key] = item.k === 'str' ? item.v : String(item.k === 'num' ? item.v : '');
  }
  return out;
}

async function send(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<Value> {
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

export function stdHttp(): Map<string, Value> {
  return withSignatures(
    moduleOf(
    fn('get', ['url', { name: 'headers', defaultValue: NO_HEADERS }], async (a, c) =>
      await send(
        'GET',
        expectStr(arg(a, 0), c, 'get(url)'),
        undefined,
        mapToHeaders(expectMap(arg(a, 1), c, 'get headers')),
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
          mapToHeaders(expectMap(arg(a, 2), c, 'post headers')),
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
          mapToHeaders(expectMap(arg(a, 3), c, 'request headers')),
        );
      },
    ),
    ),
    SIGNATURES,
  );
}
