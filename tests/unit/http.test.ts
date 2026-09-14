/**
 * `std/http`, against a real server, over a real socket.
 *
 * This was the only standard module with no executable coverage at all — no
 * fixture, no unit test, no example — which meant the client half of "you can
 * build a website with this" was never once run. `std/ai` solved the same
 * problem with a mock provider and `std/web` with a real socket; this takes the
 * second route, because the thing worth testing about an HTTP client is exactly
 * what a mock leaves out: status codes, headers, redirects, and what happens
 * when the connection fails.
 *
 * The server is a Lumen program using `std/web`, and the client is a Lumen
 * program using `std/http`. Both ends are the language under test.
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

/**
 * A server that answers exactly what each test needs to see.
 *
 * `/echo` reflects the request back, which is the only way to check that the
 * client sent what it claimed to: method, body and headers all come back as
 * JSON for the client to print.
 */
const SERVER = (port: number): string => `
import { serve, json, text, notFound } from "std/web"

fn handle(req) {
  if req.path == "/echo" {
    json({
      method: req.method,
      body:   req.body,
      agent:  req.headers.getOr("x-agent", "(none)"),
      type:   req.headers.getOr("content-type", "(none)"),
    })
  } else if req.path == "/plain" {
    text("plain words")
  } else if req.path == "/teapot" {
    text("no coffee", status: 418)
  } else {
    notFound("<p>nothing here</p>")
  }
}

serve(handler: handle, port: ${port})
`;

/** Everything `std/http` exports, exercised and printed in a stable order. */
const CLIENT = (base: string): string => `
import { get, post, request } from "std/http"

fn show(label, result) {
  match result {
    Ok(res)  => print("\${label} \${res.status} ok=\${res.ok} \${res.body}"),
    Err(why) => print("\${label} ERR \${why}"),
  }
}

fn main() {
  // A plain GET, and the status and body that come back.
  show("plain", get("${base}/plain"))

  // A status that is not 2xx is still Ok — the request succeeded, the answer
  // was just a refusal. That distinction is the module's central promise.
  show("teapot", get("${base}/teapot"))
  show("missing", get("${base}/nope"))

  // Headers go out...
  show("headers", get("${base}/echo", { "x-agent": "lumen-test" }))

  // ...and come back lowercased, whatever case the server used.
  match get("${base}/plain") {
    Ok(res)  => print("content-type \${res.headers.getOr("content-type", "(none)")}"),
    Err(why) => print("content-type ERR \${why}"),
  }

  // POST carries a body.
  show("post", post("${base}/echo", "a body", { "content-type": "text/plain" }))

  // 'request' spells any method, and uppercases what it is given.
  show("request", request("put", "${base}/echo", "put body"))
  show("bodyless", request("delete", "${base}/echo"))

  // A connection that cannot be made is Err, not a crash — port 1 is reserved
  // and nothing is listening on it.
  match get("http://127.0.0.1:1/") {
    Ok(res)  => print("unreachable UNEXPECTEDLY OK \${res.status}"),
    Err(why) => print("unreachable ERR \${why.startsWith("GET http://127.0.0.1:1/ failed:")}"),
  }
}
`;

describe('std/http', () => {
  let child: ChildProcess | undefined;
  let workdir = '';
  let lines: string[] = [];

  before(async () => {
    const port = await freePort();
    const base = 'http://127.0.0.1:' + String(port);
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-http-'));

    const server = path.join(workdir, 'server.lm');
    await fsp.writeFile(server, SERVER(port), 'utf8');
    child = spawn(process.execPath, [CLI, 'serve', server], {
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

    // One client run, whose output every assertion below reads: starting a
    // process per assertion would multiply a two-second test by ten.
    const client = path.join(workdir, 'client.lm');
    await fsp.writeFile(client, CLIENT(base), 'utf8');
    const output = await new Promise<string>((resolve, reject) => {
      const run = spawn(process.execPath, [CLI, 'run', client], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      });
      let out = '';
      run.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      run.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
      run.on('error', reject);
      run.on('exit', (code) => {
        if (code === 0) resolve(out);
        else reject(new Error('client exited with ' + String(code) + ':\n' + out));
      });
    });
    lines = output.trimEnd().split('\n');
  });

  after(async () => {
    child?.kill('SIGKILL');
    if (workdir !== '') await fsp.rm(workdir, { recursive: true, force: true });
  });

  /** The one line starting with `label`, so an assertion names what it reads. */
  const line = (label: string): string => {
    const found = lines.find((l) => l.startsWith(label + ' '));
    assert.ok(found !== undefined, 'no `' + label + '` line in:\n' + lines.join('\n'));
    return found;
  };

  it('gets a page and reports its status and body', () => {
    assert.equal(line('plain'), 'plain 200 ok=true plain words');
  });

  it('treats a non-2xx status as a completed request, not an error', () => {
    // The distinction the module is built around: the request worked, the
    // answer was a refusal. An `Err` here would make every 404 a crash.
    assert.equal(line('teapot'), 'teapot 418 ok=false no coffee');
    assert.match(line('missing'), /^missing 404 ok=false /);
  });

  it('sends the headers it is given', () => {
    const echoed = JSON.parse(line('headers').replace(/^headers 200 ok=true /, '')) as {
      method: string;
      agent: string;
    };
    assert.equal(echoed.method, 'GET');
    assert.equal(echoed.agent, 'lumen-test');
  });

  it('lowercases the header names it returns', () => {
    // Whatever case the server sent, so a program can look one up without
    // guessing — `Content-Type` and `content-type` are the same header.
    assert.match(line('content-type'), /^content-type text\/plain/);
  });

  it('posts a body', () => {
    const echoed = JSON.parse(line('post').replace(/^post 200 ok=true /, '')) as {
      method: string;
      body: string;
      type: string;
    };
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, 'a body');
    assert.equal(echoed.type, 'text/plain');
  });

  it('spells any method, uppercasing what it is given', () => {
    const put = JSON.parse(line('request').replace(/^request 200 ok=true /, '')) as {
      method: string;
      body: string;
    };
    assert.equal(put.method, 'PUT');
    assert.equal(put.body, 'put body');

    const del = JSON.parse(line('bodyless').replace(/^bodyless 200 ok=true /, '')) as {
      method: string;
      body: string;
    };
    assert.equal(del.method, 'DELETE');
    assert.equal(del.body, '');
  });

  it('returns Err naming the request when the connection fails', () => {
    // `fetch` rejects with a bare "fetch failed" and hides the reason in
    // `cause`; the module names the request instead, which is the only part a
    // reader can act on.
    assert.equal(line('unreachable'), 'unreachable ERR true');
  });
});
