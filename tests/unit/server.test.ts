/**
 * End-to-end test for the website story.
 *
 * A real `lumen` process serves a real Lumen program over a real socket, and
 * this test makes real HTTP requests against it. Nothing here is stubbed —
 * "you can build a website with this" is a claim worth testing honestly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));

/** Ask the OS for a port nothing is using. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const SERVER_SOURCE = (port: number, publicDir: string): string => `
import { serve, page, json, notFound, escape, form, formAll, isServer, file } from "std/web"

fn handle(req) {
  if req.path == "/" {
    page(title: "Test", body: "<h1>hello</h1>")
  } else if req.path == "/json" {
    json({ ok: true, method: req.method })
  } else if req.path == "/echo" {
    json({ body: req.body, name: req.query.name })
  } else if req.path == "/form" {
    json(form(req))
  } else if req.path == "/form-all" {
    json({ one: form(req), all: formAll(req) })
  } else if req.path.startsWith("/static/") {
    file(req.path.slice(7), root: "PUBLIC_DIR")
  } else if req.path == "/mode" {
    json({ serving: isServer() })
  } else if req.path == "/boom" {
    panic("deliberate failure")
  } else if req.path == "/split" {
    // A header value carrying what a visitor sent, which is how response
    // splitting is attempted. Refusing it is right; the refusal used to be a
    // raw Node TypeError, on the operator's stderr and in the served body.
    { status: 200, headers: { "x-echo": req.query.v }, body: "ok" }
  } else if req.path == "/size" {
    json({ got: req.body.len() })
  } else {
    notFound("<p>no \${escape(req.path)}</p>")
  }
}

serve(handler: handle, port: ${port})
`;

describe('web server', () => {
  let child: ChildProcess | undefined;
  let base = '';
  let workdir = '';
  let publicDir = '';
  /** The bytes of the image served below, to compare against what comes back. */
  let imageBytes = Buffer.alloc(0);

  before(async () => {
    const port = await freePort();
    base = 'http://127.0.0.1:' + String(port);
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-server-'));

    // A small site to serve, plus a file next to it that must stay unreachable.
    publicDir = path.join(workdir, 'public');
    await fsp.mkdir(path.join(publicDir, 'deep'), { recursive: true });
    await fsp.writeFile(path.join(publicDir, 'index.html'), '<h1>static index</h1>', 'utf8');
    await fsp.writeFile(path.join(publicDir, 'style.css'), 'body { color: red }', 'utf8');
    await fsp.writeFile(path.join(publicDir, 'deep', 'note.txt'), 'nested', 'utf8');
    await fsp.writeFile(path.join(publicDir, 'a file.txt'), 'spaced', 'utf8');
    // Every byte value, so any re-encoding on the way out shows up.
    imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: 256 }, (_, i) => i)]);
    await fsp.writeFile(path.join(publicDir, 'pixel.png'), imageBytes);
    await fsp.writeFile(path.join(workdir, 'secret.txt'), 'TOP SECRET', 'utf8');

    // A symlink out of the root, a symlink to a directory out of it, and one
    // that stays inside. Nothing about a request has to be strange for one of
    // these to exist: an upload directory, a linked build artefact, a
    // `current -> releases/v3` deployment.
    await fsp.symlink(path.join(workdir, 'secret.txt'), path.join(publicDir, 'leak.txt'));
    await fsp.symlink(workdir, path.join(publicDir, 'up'));
    await fsp.symlink('deep', path.join(publicDir, 'alias'));

    // The other way a web root leaks: the files a checkout has in it anyway.
    await fsp.mkdir(path.join(publicDir, '.git'), { recursive: true });
    await fsp.writeFile(path.join(publicDir, '.git', 'config'), 'TOP SECRET', 'utf8');
    await fsp.writeFile(path.join(publicDir, '.env'), 'TOP SECRET', 'utf8');
    await fsp.mkdir(path.join(publicDir, '.well-known', 'acme-challenge'), { recursive: true });
    await fsp.writeFile(
      path.join(publicDir, '.well-known', 'acme-challenge', 'token'),
      'challenge-response',
      'utf8',
    );

    const script = path.join(workdir, 'server.lm');
    await fsp.writeFile(script, SERVER_SOURCE(port, publicDir).replace('PUBLIC_DIR', publicDir), 'utf8');

    child = spawn(process.execPath, [CLI, 'serve', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });

    // Wait for the server to announce itself rather than sleeping a guess.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start in time')), 15000);
      let seen = '';
      child?.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8');
        if (seen.includes('Lumen serving')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child?.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('server exited early with code ' + String(code)));
      });
    });
  });

  after(async () => {
    child?.kill('SIGKILL');
    if (workdir !== '') await fsp.rm(workdir, { recursive: true, force: true });
  });

  it('answers a pathological path promptly, because routing does not backtrack', async () => {
    // `std/regex` has no backtracking guard — `docs/stdlib.md` says so, and
    // `(a+)+$` against thirty characters is a program that does not come back.
    // What keeps that out of a *server* is that a route is matched by splitting
    // the path into segments and comparing them, never by a regular expression.
    //
    // That is a property rather than an accident, so it is held here: a request
    // whose path is built to blow up a backtracking matcher has to be answered
    // like any other. A refactor to regex-based routing fails this test rather
    // than shipping a server one request can hang.
    const nasty = '/' + 'a'.repeat(400) + '!' + '/' + 'a('.repeat(100);
    const started = process.hrtime.bigint();
    const res = await fetch(base + encodeURI(nasty));
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;

    assert.equal(res.status, 404);
    // Generous by three orders of magnitude against an exponential blow-up,
    // which does not come back at all rather than coming back slowly — so this
    // cannot be flaky on a loaded machine without also being broken.
    assert.ok(tookMs < 2000, 'took ' + tookMs.toFixed(0) + 'ms to answer a pathological path');
  });

  it('serves a full HTML document', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const body = await res.text();
    assert.match(body, /<!doctype html>/);
    assert.match(body, /<title>Test<\/title>/);
    assert.match(body, /<h1>hello<\/h1>/);
  });

  it('serves JSON with the right content type', async () => {
    const res = await fetch(base + '/json');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.deepEqual(await res.json(), { ok: true, method: 'GET' });
  });

  it('exposes the request body and query string', async () => {
    const res = await fetch(base + '/echo?name=ada', { method: 'POST', body: 'payload' });
    assert.deepEqual(await res.json(), { body: 'payload', name: 'ada' });
  });

  it('reads a GET form out of the query string', async () => {
    const res = await fetch(base + '/form?name=ada&city=London');
    assert.deepEqual(await res.json(), { name: 'ada', city: 'London' });
  });

  it('reads a POST form out of a urlencoded body, decoding as it goes', async () => {
    const res = await fetch(base + '/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Ada Lovelace', note: 'a+b & c' }).toString(),
    });
    assert.deepEqual(await res.json(), { name: 'Ada Lovelace', note: 'a+b & c' });
  });

  it('treats a body that is not a form as no form at all', async () => {
    const res = await fetch(base + '/form', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"ada"}',
    });
    assert.deepEqual(await res.json(), {});
  });

  it('keeps every value of a repeated field, which a Map cannot', async () => {
    // `?tag=a&tag=b&tag=c` is a checkbox group, and `<select multiple>` is the
    // same shape — ordinary HTML. `form` answers with a Map of single values,
    // which is what almost every field is and what makes `fields["name"]` read
    // well, so three tags went in and one came out, silently.
    //
    // Additive rather than a change to `form`, the same way `std/http` answered
    // the identical question about `Set-Cookie`.
    for (const [how, init] of [
      ['GET', undefined],
      [
        'POST',
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'tag=a&tag=b&tag=c&name=Ada',
        },
      ],
    ] as const) {
      const where = how === 'GET' ? '/form-all?tag=a&tag=b&tag=c&name=Ada' : '/form-all';
      const res = await fetch(base + where, init);
      assert.deepEqual(
        await res.json(),
        { one: { tag: 'c', name: 'Ada' }, all: { tag: ['a', 'b', 'c'], name: ['Ada'] } },
        how + ' lost a repeated field',
      );
    }
  });

  it('reports that it is serving, not running', async () => {
    const res = await fetch(base + '/mode');
    assert.deepEqual(await res.json(), { serving: true });
  });

  it('serves a file with a content type taken from its extension', async () => {
    const res = await fetch(base + '/static/style.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(await res.text(), 'body { color: red }');
  });

  it('serves a directory as its index.html', async () => {
    const res = await fetch(base + '/static/');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /static index/);
  });

  it('serves a nested file', async () => {
    const res = await fetch(base + '/static/deep/note.txt');
    assert.equal(await res.text(), 'nested');
  });

  it('decodes percent-encoding in the path', async () => {
    const res = await fetch(base + '/static/a%20file.txt');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'spaced');
  });

  it('returns binary bytes unchanged', async () => {
    const res = await fetch(base + '/static/pixel.png');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/png/);
    const got = Buffer.from(await res.arrayBuffer());
    // Every byte value round-tripped, or the response was re-encoded somewhere.
    assert.deepEqual([...got], [...imageBytes]);
  });

  it('refuses to leave the root, however the path is spelled', async () => {
    // Each of these resolves outside `public/` if the boundary is not enforced.
    for (const attempt of [
      '/static/../secret.txt',
      '/static/%2e%2e%2fsecret.txt',
      '/static/%2E%2E/secret.txt',
      '/static/deep/../../secret.txt',
      '/static//etc/passwd',
      '/static/....//secret.txt',
    ]) {
      const res = await fetch(base + attempt, { redirect: 'manual' });
      const body = await res.text();
      assert.equal(res.status, 404, attempt + ' was not refused');
      assert.doesNotMatch(body, /TOP SECRET/, attempt + ' leaked the file');
    }
  });

  it('refuses a symlink that leaves the root, and allows one that does not', async () => {
    // The path check compares the path as *written*, and a symlink makes that a
    // lie: a link inside `public/` pointing anywhere at all resolves to
    // something that looks inside it. Both of these were served before the
    // boundary was checked against what the filesystem really has.
    for (const attempt of ['/static/leak.txt', '/static/up/secret.txt']) {
      const res = await fetch(base + attempt, { redirect: 'manual' });
      const body = await res.text();
      assert.equal(res.status, 404, attempt + ' was not refused');
      assert.doesNotMatch(body, /TOP SECRET/, attempt + ' leaked the file');
    }

    // And the reason this checks rather than refusing outright: a symlink that
    // stays inside the root is how deployments are arranged.
    const allowed = await fetch(base + '/static/alias/note.txt');
    assert.equal(allowed.status, 200, 'a symlink inside the root was refused');
    assert.equal(await allowed.text(), 'nested');
  });

  it('does not serve a name beginning with a dot, except .well-known', async () => {
    // `.env` and `.git/config` are the most-exploited misconfiguration on the
    // web, and `file`'s default root is the directory the program runs in —
    // which in a checkout holds both.
    for (const attempt of ['/static/.env', '/static/.git/config']) {
      const res = await fetch(base + attempt, { redirect: 'manual' });
      assert.equal(res.status, 404, attempt + ' was served');
      assert.doesNotMatch(await res.text(), /TOP SECRET/, attempt + ' leaked the file');
    }

    // The exception, and it is not optional: this is where a certificate
    // authority looks to prove the site is yours, so blocking it breaks HTTPS
    // rather than protecting anything.
    const challenge = await fetch(base + '/static/.well-known/acme-challenge/token');
    assert.equal(challenge.status, 200, '.well-known was blocked');
    assert.equal(await challenge.text(), 'challenge-response');
  });

  it('returns 404 for a file that is simply missing', async () => {
    const res = await fetch(base + '/static/nope.txt');
    assert.equal(res.status, 404);
  });

  it('returns 404 with the handler body', async () => {
    const res = await fetch(base + '/missing');
    assert.equal(res.status, 404);
    assert.match(await res.text(), /no \/missing/);
  });

  it('turns a failing handler into a 500 rather than hanging', async () => {
    const res = await fetch(base + '/boom');
    assert.equal(res.status, 500);
    assert.match(await res.text(), /deliberate failure/);
  });

  it('is still serving after a handler failed', async () => {
    const res = await fetch(base + '/json');
    assert.equal(res.status, 200);
  });

  it('refuses a header value carrying a line break, in its own words', async () => {
    // Response splitting: a value a visitor supplied, put into a header. Node
    // refuses it, and used to do so as `TypeError [ERR_INVALID_CHAR]` written
    // to the operator's stderr *and* served to whoever sent the request.
    const res = await fetch(base + '/split?v=' + encodeURIComponent('a\r\nSet-Cookie: p=1'));
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('set-cookie'), null, 'the injected header was sent');
    assert.match(await res.text(), /header cannot contain a line break/u);
  });

  it('serves an ordinary header value beside it', async () => {
    const res = await fetch(base + '/split?v=plain');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-echo'), 'plain');
  });

  it('is still serving after both', async () => {
    assert.equal((await fetch(base + '/json')).status, 200);
  });
});
