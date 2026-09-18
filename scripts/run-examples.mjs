#!/usr/bin/env node
/**
 * Smoke-test every example by running it through the real CLI.
 *
 * This catches breakage that unit tests can miss, because it goes through
 * argument parsing, file reading, module resolution and the process exit code —
 * the same path a user takes.
 *
 * `website.lm` is started, requested over HTTP, and stopped, rather than run to
 * completion: a web server that exits on its own would be a bug.
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const EXAMPLES = path.join(ROOT, 'examples');

/** Examples that serve forever instead of terminating. */
const SERVERS = new Map([['website.lm', 3000]]);

const env = { ...process.env, LUMEN_AI_PROVIDER: 'mock', NO_COLOR: '1' };

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'run', path.join(EXAMPLES, file)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function portIsFree(port) {
  return await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function runServer(file, port) {
  if (!(await portIsFree(port))) {
    return { code: 0, out: 'skipped: port ' + port + ' is already in use', skipped: true };
  }

  const child = spawn(process.execPath, [CLI, 'serve', path.join(EXAMPLES, file)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start within 15s')), 15000);
      const check = setInterval(() => {
        if (out.includes('Lumen serving')) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 100);
      child.on('exit', (code) => {
        clearTimeout(timer);
        clearInterval(check);
        reject(new Error('server exited early with code ' + code));
      });
    });

    const res = await fetch('http://127.0.0.1:' + port + '/');
    const body = await res.text();
    if (res.status !== 200 || !body.includes('<html')) {
      return { code: 1, out: out + '\nunexpected response: ' + res.status + '\n' + body.slice(0, 200) };
    }
    return { code: 0, out: out + 'GET / -> ' + res.status + ', ' + body.length + ' bytes' };
  } catch (error) {
    return { code: 1, out: out + '\n' + String(error) };
  } finally {
    child.kill('SIGKILL');
  }
}

// Single-file examples, plus the entry point of each multi-file one. Its
// helper modules are not listed: they are imported, not run, and running one on
// its own would prove nothing.
const MULTI_FILE_ENTRIES = ['notes/main.lm'];

const files = [
  ...readdirSync(EXAMPLES).filter((f) => f.endsWith('.lm')),
  ...MULTI_FILE_ENTRIES,
].sort();
let failed = 0;

for (const file of files) {
  const serverPort = SERVERS.get(file);
  const result = serverPort === undefined ? await run(file) : await runServer(file, serverPort);

  if (result.code === 0) {
    const note = result.skipped === true ? ' (' + result.out + ')' : '';
    process.stdout.write('ok   ' + file + note + '\n');
  } else {
    failed += 1;
    process.stdout.write('FAIL ' + file + '\n' + result.out + '\n');
  }
}

process.stdout.write('\n' + (files.length - failed) + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
