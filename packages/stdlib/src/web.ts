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

import { promises as fsp } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { NIL, bool, display, map, num, str, type Value } from '@lumen-lang/core';
import { toJson } from './json.js';
import { arg, expectFn, expectInt, expectList, expectStr, fn, moduleOf, withSignatures } from './support.js';

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

/** The one answer both "no such file" and "not yours to ask for" get. */
function notFoundResponse(): Value {
  return response(404, 'text/plain; charset=utf-8', 'Not Found');
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
  // Keys come from the handler, so build without a prototype to write into.
  const headers = Object.create(null) as Record<string, string>;
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

/**
 * What to call a file, by its extension.
 *
 * A short list on purpose: guessing wrong about a type is worse than saying
 * `application/octet-stream`, which every browser treats as "download this"
 * rather than as something to execute.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.pdf', 'application/pdf'],
  ['.wasm', 'application/wasm'],
]);


/**
 * One route's pattern, compiled once rather than on every request.
 *
 * `:name` matches one segment and records it; `*name` matches the rest of the
 * path, which is what serving a directory of files needs.
 */
interface Pattern {
  readonly segments: readonly string[];
  readonly rest: string | undefined;
}

function compilePattern(pattern: string): Pattern {
  const parts = splitPath(pattern);
  const last = parts[parts.length - 1];
  if (last !== undefined && last.startsWith('*')) {
    return { segments: parts.slice(0, -1), rest: last.slice(1) === '' ? 'rest' : last.slice(1) };
  }
  return { segments: parts, rest: undefined };
}

/**
 * A path as its segments, with the empty ones dropped.
 *
 * Dropping them is what makes `/a/`, `/a` and `//a` one path rather than three.
 * A trailing slash is a thing browsers and links add and remove freely, and a
 * router that treats the two as different routes produces 404s nobody can
 * explain.
 */
function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '');
}

/** The captured parameters when `pattern` matches `pathname`, or undefined. */
function matchPattern(pattern: Pattern, pathname: string): Map<string, Value> | undefined {
  const parts = splitPath(pathname);
  if (pattern.rest === undefined) {
    if (parts.length !== pattern.segments.length) return undefined;
  } else if (parts.length < pattern.segments.length) {
    return undefined;
  }

  const params = new Map<string, Value>();
  for (const [i, segment] of pattern.segments.entries()) {
    const part = parts[i] ?? '';
    if (segment.startsWith(':')) {
      // Percent-decoding here rather than in the handler: `/post/a%20b` should
      // hand over `a b`, which is the name the link meant.
      params.set(segment.slice(1), str(safeDecode(part)));
      continue;
    }
    if (segment !== part) return undefined;
  }
  if (pattern.rest !== undefined) {
    params.set(pattern.rest, str(parts.slice(pattern.segments.length).map(safeDecode).join('/')));
  }
  return params;
}

/**
 * Percent-decoding that cannot throw.
 *
 * `decodeURIComponent("%")` raises, and a malformed escape in a URL is
 * something a stranger can send. The raw segment is the honest fallback: it
 * will not match a route, which is the right outcome.
 */
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
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

/**
 * The schemes a link may carry. Everything else is refused outright.
 *
 * An allow-list rather than a block-list, because the list of schemes that can
 * run code is open-ended — `javascript:`, `data:text/html`, `vbscript:`, and
 * whatever a browser adds next — while the list people actually link to is
 * four items long and has not changed in twenty years.
 */
const LINKABLE = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * A URL safe to put in an `href`, or `about:blank` when it is not one.
 *
 * `escape` cannot do this job and never could: there is nothing in
 * `javascript:alert(1)` to escape, so it comes back untouched and runs the
 * moment somebody clicks. Escaping answers "could this text break out of where
 * I am putting it"; a link needs "does this text tell the browser to run
 * something", which is a different question with a different answer.
 *
 * The scheme is read the way a browser reads it. Leading whitespace and control
 * characters are stripped before the test, because they are stripped before the
 * scheme is decided — `java\tscript:alert(1)` and ` javascript:alert(1)` are
 * both `javascript:` to a browser and were both "not a scheme I know" to a
 * naive check. Case is ignored for the same reason.
 *
 * No scheme at all means a relative link — `/about`, `?q=1`, `#top` — which is
 * the common case and is safe. A protocol-relative `//host/path` is also left
 * alone: it navigates rather than executing, so it is an open-redirect question
 * for the program to answer rather than something this can decide.
 */
function linkableUrl(raw: string): string {
  const seen = raw.replace(/[\u0000-\u0020\u007F]/gu, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/u.exec(seen)?.[1]?.toLowerCase();
  if (scheme !== undefined && !LINKABLE.has(scheme)) return 'about:blank';
  return raw;
}

/**
 * A response is a `Map` with `status`, `headers` and `body`, and everything
 * that builds one says so. A handler is `fn(req) -> response`, which is spelled
 * `fn(Map) -> Map` — the one shape this module is organised around.
 *
 * `serve` never returns, so its type is `Nil` by default rather than by
 * meaning; the checker has no way to express "does not return" and does not
 * need one.
 */
/**
 * Whether any part of a relative path is a hidden name.
 *
 * `.well-known` is allowed through, and is the only one: it is where a
 * certificate authority looks to verify a domain, so blocking it breaks HTTPS
 * rather than protecting anything. Everything else beginning with a dot stays
 * unserved — `.env`, `.git`, `.ssh`, `.npmrc`, editor backups.
 */
function hiddenSegment(relative: string): boolean {
  return relative
    .split(/[/\\]/)
    .some((segment) => segment.startsWith('.') && segment !== '.well-known');
}

/**
 * Whether `target` is still inside `root` once every symlink is followed.
 *
 * The path is compared twice, as written and as the filesystem really has it,
 * because a symlink makes the first comparison a lie: a link inside the root
 * pointing anywhere at all resolves to a path that *looks* inside it. Nothing
 * about the request has to be strange for this — an upload directory, a build
 * artefact, a `node_modules` someone linked.
 *
 * The root is resolved too, and has to be: `/var/www -> /srv/www` is an
 * ordinary way to arrange a machine, and comparing a resolved target against an
 * unresolved root would answer 404 to every request on one.
 *
 * A symlink that stays inside the root still works, which is why this checks
 * rather than refuses: `current -> releases/v3` is how deployments are done.
 */
async function reallyInside(target: string, root: string): Promise<boolean> {
  try {
    const realRoot = await fsp.realpath(root);
    const realTarget = await fsp.realpath(target);
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
  } catch {
    // A path that cannot be resolved names nothing that could be served.
    return false;
  }
}

const SIGNATURES: Readonly<Record<string, string>> = {
  html: '(body: Str, status: Num = 200) -> Map',
  text: '(body: Str, status: Num = 200) -> Map',
  json: '(value: Any, status: Num = 200) -> Map',
  notFound: '(body: Str = "Not Found") -> Map',
  redirect: '(location: Str, status: Num = 302) -> Map',
  route: '(method: Str, path: Str, handler: fn(Map) -> Map) -> Map',
  router: '(routes: List, notFound: Any = nil) -> fn(Map) -> Map',
  escape: '(text: Str) -> Str',
  url: '(link: Str) -> Str',
  form: '(req: Map) -> Map',
  file: '(path: Str, root: Str = ".", type: Str = "") -> Map',
  page: '(title: Str, body: Str, style: Str = "") -> Map',
  serve: '(handler: fn(Map) -> Map, port: Num = 3000, host: Str = "127.0.0.1") -> Nil',
  isServer: '() -> Bool',
};

export function stdWeb(): Map<string, Value> {
  return withSignatures(
    moduleOf(
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

    /**
     * One route: a method, a path pattern, and what to do about it.
     *
     * The pattern is literal segments plus two kinds of hole:
     *
     *     "/health"            exactly that path
     *     "/post/:slug"        one segment, captured as `slug`
     *     "/static/*path"      the rest of the path, captured as `path`
     *
     * The handler is called with the request, and finds what was captured in
     * `req.params`. That keeps every handler the same shape — one argument —
     * whether it has parameters or not.
     *
     * `method` may be a single method or several separated by spaces, so
     * `"GET POST"` is one route for a page that both renders and accepts a form.
     */
    fn('route', ['method', 'path', 'handler'], (a, c) => {
      const methods = expectStr(arg(a, 0), c, 'route(method)')
        .toUpperCase()
        .split(' ')
        .filter((m) => m !== '');
      if (methods.length === 0) return c.panic('route(method) cannot be empty');
      const pattern = expectStr(arg(a, 1), c, 'route(path)');
      if (!pattern.startsWith('/')) {
        return c.panic('route path must start with "/", got ' + JSON.stringify(pattern));
      }
      const handler = expectFn(arg(a, 2), c, 'route(handler)');
      return map(
        new Map<string, Value>([
          ['method', str(methods.join(' '))],
          ['path', str(pattern)],
          ['handler', handler],
        ]),
      );
    }),

    /**
     * Turn a list of routes into a handler `serve` can take.
     *
     * Routes are tried in order, so put the specific ones first: `/post/new`
     * before `/post/:slug`, or the second will answer for both.
     *
     * Two things it does that a hand-written `if` chain usually does not:
     *
     *   - **405, not 404, when the path exists but the method does not.** A
     *     `POST` to a page that only answers `GET` is a different mistake from a
     *     `POST` to nothing at all, and the reply says which, with an `allow`
     *     header naming the methods that would have worked. A client debugging
     *     against a 404 has no way to tell a wrong URL from a wrong verb.
     *   - **A trailing slash is not a different route.** `/about` and `/about/`
     *     are one path, because links and browsers add and remove that slash
     *     freely.
     *
     * `notFound:` replaces the 404 body, and takes the request so it can say
     * what was missing.
     */
    fn('router', ['routes', { name: 'notFound', defaultValue: NIL }], (a, c) => {
      const routes = expectList(arg(a, 0), c, 'router(routes)');
      const fallback = arg(a, 1);

      // Compiled once here, not once per request: a router built at startup and
      // called a million times should not re-parse its own patterns.
      const compiled = routes.items.map((entry, index) => {
        if (entry.k !== 'map') {
          return c.panic(
            'router(routes) item ' + String(index + 1) + ' is not a route',
            ['build each one with `route(method, path, handler)`'],
          );
        }
        const method = entry.entries.get('method');
        const pattern = entry.entries.get('path');
        const handler = entry.entries.get('handler');
        if (method?.k !== 'str' || pattern?.k !== 'str' || handler === undefined) {
          return c.panic(
            'router(routes) item ' + String(index + 1) + ' is missing method, path or handler',
            ['build each one with `route(method, path, handler)`'],
          );
        }
        return {
          methods: method.v.split(' '),
          pattern: compilePattern(pattern.v),
          handler,
        };
      });

      return fn('handle', ['req'], async (inner, ctx) => {
        const request = arg(inner, 0);
        if (request.k !== 'map') return ctx.panic('a handler is called with a request Map');
        const method = request.entries.get('method');
        const pathValue = request.entries.get('path');
        const wanted = method?.k === 'str' ? method.v.toUpperCase() : 'GET';
        const pathname = pathValue?.k === 'str' ? pathValue.v : '/';

        // Methods that would have matched, gathered as we go, so a 405 can name
        // them without a second pass over the routes.
        const allowed = new Set<string>();
        for (const entry of compiled) {
          const params = matchPattern(entry.pattern, pathname);
          if (params === undefined) continue;
          if (!entry.methods.includes(wanted)) {
            for (const m of entry.methods) allowed.add(m);
            continue;
          }
          const withParams = new Map(request.entries);
          withParams.set('params', map(params));
          return await ctx.call(entry.handler, [map(withParams)]);
        }

        if (allowed.size > 0) {
          const methods = [...allowed].sort().join(', ');
          return map(
            new Map<string, Value>([
              ['status', num(405)],
              [
                'headers',
                map(
                  new Map<string, Value>([
                    ['content-type', str('text/plain; charset=utf-8')],
                    ['allow', str(methods)],
                  ]),
                ),
              ],
              ['body', str(wanted + ' is not allowed here. Try: ' + methods + '\n')],
            ]),
          );
        }

        if (fallback.k === 'fn' || fallback.k === 'native') {
          return await ctx.call(fallback, [request]);
        }
        return response(404, 'text/html; charset=utf-8', 'Not Found');
      });
    }),

    fn('escape', ['text'], (a, c) => str(escapeHtml(expectStr(arg(a, 0), c, 'escape(text)')))),

    /**
     * A visitor's link, ready to put straight into an `href`.
     *
     * `escape` is the wrong tool for this and the documentation used to say
     * otherwise: *"always use `escape` on anything a visitor supplied"*, which
     * for `<a href="${escape(link)}">` produces
     * `<a href="javascript:alert(document.cookie)">` — the advice followed
     * exactly, and a working cross-site script. There was nothing to escape.
     *
     * So this answers the question a link actually poses. An unlinkable scheme
     * becomes `about:blank`, which leaves the page working and the link dead
     * rather than silently dropping it, and the result is escaped for the
     * attribute as well, so it is one call rather than two.
     */
    fn('url', ['link'], (a, c) =>
      str(escapeHtml(linkableUrl(expectStr(arg(a, 0), c, 'url(link)')))),
    ),

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

    /**
     * Serve a file from a directory, or a 404 if it is not there.
     *
     * The `root` is a boundary, not a suggestion. `file(req.path, root: "public")`
     * is the obvious thing to write and is also the classic way to hand out
     * `/etc/passwd`, because `..%2f..%2fetc%2fpasswd` arrives already decoded
     * and `public/../../etc/passwd` is a perfectly good path. So the resolved
     * path is compared against the resolved root, and anything outside it is a
     * 404 — the same answer a missing file gets, because telling an attacker
     * which of the two happened is itself information.
     *
     * The boundary is checked twice, because once is not enough: the path as
     * written, and then the path the filesystem really has once symlinks are
     * followed. A link inside the root pointing anywhere at all resolves to
     * something that *looks* inside it, and nothing about the request has to be
     * strange for one to be there. A link that stays inside still works, since
     * `current -> releases/v3` is how deployments are done.
     *
     * A name beginning with a dot is not served either. `.env` and
     * `.git/config` are the most-exploited misconfiguration on the web, and the
     * default `root` is the directory the program is running in, which in a
     * checkout holds both. `.well-known` is the one exception, because it is
     * where a certificate authority looks to prove the site is yours.
     *
     * A directory resolves to `index.html` inside it, as a web server should.
     */
    fn(
      'file',
      ['path', { name: 'root', defaultValue: str('.') }, { name: 'type', defaultValue: str('') }],
      async (a, c) => {
        const requested = expectStr(arg(a, 0), c, 'file(path)');
        const root = expectStr(arg(a, 1), c, 'file root');
        const declaredType = expectStr(arg(a, 2), c, 'file type');

        const rootDir = path.resolve(root);

        // A URL path is percent-encoded, so `/my%20file.txt` names a file with
        // a space in it. Decode before resolving — and therefore before the
        // boundary check below, which is the order that matters: `%2e%2e%2f`
        // has to become `../` while something is still looking at it.
        let decoded;
        try {
          decoded = decodeURIComponent(requested);
        } catch {
          // Malformed encoding. Nothing can be named by it.
          return notFoundResponse();
        }
        // A NUL byte truncates a path in some system calls, so a name
        // containing one cannot be trusted to mean what it reads as.
        if (decoded.includes('\0')) return notFoundResponse();

        // A leading `/` in a URL path means the site root, not the filesystem
        // root, so strip it before joining or `path.resolve` would ignore the
        // root entirely.
        const relative = decoded.replace(/^[/\\]+/, '');
        let target = path.resolve(rootDir, relative);

        const inside = target === rootDir || target.startsWith(rootDir + path.sep);
        if (!inside) return notFoundResponse();

        // A name beginning with a dot is not served. `.env`, `.git/config` and
        // `.ssh/id_rsa` are the most-exploited misconfiguration on the web, and
        // the default `root` here is `"."` — the directory the program is
        // running in, which in a checkout holds all three. `.well-known` is the
        // exception because it is not optional: it is where a certificate
        // authority looks to prove the site is yours.
        if (hiddenSegment(relative)) return notFoundResponse();

        let stat;
        try {
          stat = await fsp.stat(target);
        } catch {
          return notFoundResponse();
        }
        if (stat.isDirectory()) {
          target = path.join(target, 'index.html');
          try {
            if (!(await fsp.stat(target)).isFile()) return notFoundResponse();
          } catch {
            return notFoundResponse();
          }
        } else if (!stat.isFile()) {
          return notFoundResponse();
        }

        // And again, against what the filesystem says these really are. The
        // check above compares the path as *written*, which a symlink makes a
        // lie: `public/keys.txt -> /etc/secrets` resolves to a path inside
        // `public` and reads a file that is not. The boundary is meant to be a
        // boundary, so it is checked on both.
        if (!(await reallyInside(target, rootDir))) return notFoundResponse();

        const type =
          declaredType !== ''
            ? declaredType
            : (CONTENT_TYPES.get(path.extname(target).toLowerCase()) ??
              'application/octet-stream');

        try {
          // Text is served as text; anything else goes out base64-decoded from
          // a latin1 read, which round-trips every byte unchanged.
          const binary = !type.startsWith('text/') && !type.includes('charset=');
          const body = await fsp.readFile(target, binary ? 'latin1' : 'utf8');
          return response(200, type, body);
        } catch {
          return notFoundResponse();
        }
      },
    ),

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
                // A Lumen Str is a sequence of code points, so a PNG read byte
                // for byte arrives here as one character per byte. Writing that
                // as utf8 would re-encode every byte above 127 into two and
                // corrupt the file; latin1 writes each character as the single
                // byte it came from. Text keeps utf8, which is what its
                // charset says.
                const type = headers['content-type'] ?? '';
                const isText = type.startsWith('text/') || type.includes('charset=');
                res.end(Buffer.from(out, isText ? 'utf8' : 'latin1'));
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
        }).catch((error: unknown) => {
          // The commonest way starting a server fails, by a wide margin: the
          // last one is still running, or something else owns the port. Node's
          // `EADDRINUSE` plus a stack trace through `node:net` says none of
          // that, and a stack trace into the runtime is never the answer to a
          // question about the machine.
          const code = (error as { code?: string } | null)?.code;
          if (code === 'EADDRINUSE') {
            return c.panic('port ' + port + ' is already in use', [
              'something else is listening on ' + host + ':' + port,
              'stop it, or serve on another port with `serve(handler: …, port: ' +
                (port + 1) + ')`',
            ]);
          }
          if (code === 'EACCES') {
            return c.panic('not allowed to listen on port ' + port, [
              'ports below 1024 need privileges on most systems',
              'use a port above 1024 and put a reverse proxy in front for production',
            ]);
          }
          if (code === 'EADDRNOTAVAIL') {
            return c.panic('cannot listen on host ' + JSON.stringify(host), [
              'that address does not belong to this machine',
              'use "127.0.0.1" for local only, or "0.0.0.0" for every interface',
            ]);
          }
          throw error;
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
    ),
    SIGNATURES,
  );
}
