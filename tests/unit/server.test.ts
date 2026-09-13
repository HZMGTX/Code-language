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
import { serve, page, json, notFound, escape, form, isServer, file } from "std/web"

fn handle(req) {
  if req.path == "/" {
    page(title: "Test", body: "<h1>hello</h1>")
  } else if req.path == "/json" {
    json({ ok: true, method: req.method })
  } else if req.path == "/echo" {
    json({ body: req.body, name: req.query.name })
  } else if req.path == "/form" {
    json(form(req))
  } else if req.path.startsWith("/static/") {
    file(req.path.slice(7), root: "PUBLIC_DIR")
  } else if req.path == "/mode" {
    json({ serving: isServer() })
  } else if req.path == "/boom" {
    panic("deliberate failure")
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
});
