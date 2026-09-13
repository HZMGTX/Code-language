/**
 * `std/web` — build and serve a website from a Lumen file.
 *
 * A handler is any function from a request to a response:
 *
 *     serve(port: 3000, handler: fn(req) {
 *       html("<h1>Hello</h1>")
 *     })
 *
 * A request is a map with `method`, `path`, `query`, `headers` and `body`.
 * A response is a map with `status`, `headers` and `body` — the helpers below
 * build one for you, and returning a bare string is treated as HTML.
 */

import * as http from 'node:http';

import { NIL, bool, display, map, num, str, type Value } from '@lumen-lang/core';
import { toJson } from './json.js';
import { arg, expectFn, expectInt, expectStr, fn, moduleOf } from './support.js';

/**
 * Whether this process was started as a server — `lumen serve` rather than
 * `lumen run`. The CLI sets it; nothing else does.
 *
 * It exists so one file can be both a site and a script: serve the routes when
 * asked to serve, and print a sample of what they return when asked to run.
 * That keeps a website testable from the command line without a request.
 */
let serveMode = false;

/** Called by the CLI for `lumen serve`. */
export function setServeMode(on: boolean): void {
  serveMode = on;
}

function response(status: number, contentType: string, body: string): Value {
  return map(
    new Map<string, Value>([
      ['status', num(status)],
      ['headers', map(new Map<string, Value>([['content-type', str(contentType)]]))],
      ['body', str(body)],
    ]),
  );
}

/** Turn whatever the handler returned into a status, headers and body. */
function normalize(result: Value): { status: number; headers: Record<string, string>; body: string } {
  if (result.k === 'str') {
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: result.v };
  }
  if (result.k !== 'map') {
    return {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: display(result),
    };
  }
  const statusValue = result.entries.get('status');
  const bodyValue = result.entries.get('body');
  const headerValue = result.entries.get('headers');
  const headers: Record<string, string> = {};
  if (headerValue !== undefined && headerValue.k === 'map') {
    for (const [key, value] of headerValue.entries) {
      headers[key] = value.k === 'str' ? value.v : display(value);
    }
  }
  if (headers['content-type'] === undefined) headers['content-type'] = 'text/html; charset=utf-8';
  return {
    status: statusValue !== undefined && statusValue.k === 'num' ? statusValue.v : 200,
    headers,
    body: bodyValue === undefined ? '' : bodyValue.k === 'str' ? bodyValue.v : display(bodyValue),
  };
}

function requestToValue(
  req: http.IncomingMessage,
  body: string,
): Value {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = new Map<string, Value>();
  for (const [key, value] of url.searchParams) query.set(key, str(value));
  const headers = new Map<string, Value>();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key.toLowerCase(), str(value));
    else if (Array.isArray(value)) headers.set(key.toLowerCase(), str(value.join(', ')));
  }
  return map(
    new Map<string, Value>([
      ['method', str(req.method ?? 'GET')],
      ['path', str(url.pathname)],
      ['query', map(query)],
      ['headers', map(headers)],
      ['body', str(body)],
    ]),
  );
}

/** Escape text for safe interpolation into HTML. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stdWeb(): Map<string, Value> {
  return moduleOf(
    fn('html', ['body', { name: 'status', defaultValue: num(200) }], (a, c) =>
      response(
        expectInt(arg(a, 1), c, 'html status'),
        'text/html; charset=utf-8',
        expectStr(arg(a, 0), c, 'html(body)'),
      ),
    ),

    fn('text', ['body', { name: 'status', defaultValue: num(200) }], (a, c) =>
      response(
        expectInt(arg(a, 1), c, 'text status'),
        'text/plain; charset=utf-8',
        expectStr(arg(a, 0), c, 'text(body)'),
      ),
    ),

    fn('json', ['value', { name: 'status', defaultValue: num(200) }], (a, c) => {
      const data = toJson(arg(a, 0));
      if (data === undefined) return c.panic('cannot serialise this value as JSON');
      return response(
        expectInt(arg(a, 1), c, 'json status'),
        'application/json; charset=utf-8',
        JSON.stringify(data),
      );
    }),

    fn('notFound', [{ name: 'body', defaultValue: str('Not Found') }], (a, c) =>
      response(404, 'text/html; charset=utf-8', expectStr(arg(a, 0), c, 'notFound(body)')),
    ),

    fn('redirect', ['location', { name: 'status', defaultValue: num(302) }], (a, c) =>
      map(
        new Map<string, Value>([
          ['status', num(expectInt(arg(a, 1), c, 'redirect status'))],
          ['headers', map(new Map([['location', str(expectStr(arg(a, 0), c, 'redirect(location)'))]]))],
          ['body', str('')],
        ]),
      ),
    ),

    fn('escape', ['text'], (a, c) => str(escapeHtml(expectStr(arg(a, 0), c, 'escape(text)')))),

    /**
     * The fields a form submitted, whichever way it was sent.
     *
     * A `<form method="get">` arrives as a query string and a
     * `<form method="post">` as a urlencoded body; this reads both the same
     * way, so a handler does not have to care which the page used. Anything
     * else — a JSON body, a file upload — comes back empty, and `req.body` is
     * still there to parse yourself.
     */
    fn('form', ['req'], (a, c) => {
      const request = arg(a, 0);
      if (request.k !== 'map') {
        return c.panic('form(req) needs a request map', ['got ' + display(request)]);
      }
      const method = request.entries.get('method');
      const verb = method?.k === 'str' ? method.v.toUpperCase() : 'GET';

      if (verb === 'GET' || verb === 'HEAD') {
        const query = request.entries.get('query');
        return query !== undefined && query.k === 'map' ? query : map(new Map<string, Value>());
      }

      // Only a urlencoded body is a form. Guessing at any other content type
      // would quietly return nonsense for a JSON post.
      const headers = request.entries.get('headers');
      const contentType =
        headers?.k === 'map' ? headers.entries.get('content-type') : undefined;
      const kind = contentType?.k === 'str' ? contentType.v : '';
      if (!kind.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
        return map(new Map<string, Value>());
      }

      const body = request.entries.get('body');
      const fields = new Map<string, Value>();
      if (body?.k === 'str') {
        for (const [key, value] of new URLSearchParams(body.v)) fields.set(key, str(value));
      }
      return map(fields);
    }),

    /** Wrap body HTML in a complete, responsive document. */
    fn(
      'page',
      ['title', 'body', { name: 'style', defaultValue: str('') }],
      (a, c) => {
        const title = expectStr(arg(a, 0), c, 'page(title)');
        const body = expectStr(arg(a, 1), c, 'page(body)');
        const style = expectStr(arg(a, 2), c, 'page style');
        const document =
          '<!doctype html>\n<html lang="en">\n<head>\n' +
          '<meta charset="utf-8">\n' +
          '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
          '<title>' + escapeHtml(title) + '</title>\n' +
          '<style>\n' +
          ':root { color-scheme: light dark; }\n' +
          'body { font: 16px/1.6 system-ui, sans-serif; max-width: 42rem; margin: 0 auto; padding: 2rem 1rem; }\n' +
          style +
          '\n</style>\n</head>\n<body>\n' + body + '\n</body>\n</html>\n';
        return response(200, 'text/html; charset=utf-8', document);
      },
    ),

    /**
     * Start an HTTP server and keep serving until the process is stopped.
     * This never returns, which is exactly what a server should do.
     */
    fn(
      'serve',
      [
        'handler',
        { name: 'port', defaultValue: num(3000) },
        { name: 'host', defaultValue: str('127.0.0.1') },
      ],
      async (a, c) => {
        const handler = expectFn(arg(a, 0), c, 'serve(handler)');
        const port = expectInt(arg(a, 1), c, 'serve port');
        const host = expectStr(arg(a, 2), c, 'serve host');

        const server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            void (async () => {
              try {
                const result = await c.call(handler, [requestToValue(req, body)]);
                const { status, headers, body: out } = normalize(result);
                res.writeHead(status, headers);
                res.end(out);
              } catch (error) {
                // A handler that throws becomes a 500 with the Lumen error text,
                // so a broken page never silently hangs the connection.
                const message =
                  error !== null && typeof error === 'object' && 'render' in error
                    ? (error as { render: (color: boolean) => string }).render(false)
                    : String(error);
                c.host.writeErr(message + '\n');
                res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('Internal Server Error\n\n' + message);
              }
            })();
          });
        });

        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, host, () => resolve());
        });
        c.host.writeOut('Lumen serving on http://' + host + ':' + port + '\n');

        // Keep the process alive for as long as the server is listening.
        await new Promise<never>(() => {
          /* never settles */
        });
        return NIL;
      },
    ),

    /** True when started with `lumen serve`, false under `lumen run`. */
    fn('isServer', [], () => bool(serveMode)),
  );
}
