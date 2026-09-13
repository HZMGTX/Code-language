#!/usr/bin/env node
/**
 * Run the test suite.
 *
 * Node's test runner only learned to expand glob patterns in v22, and shell
 * globbing does not exist on Windows `cmd`. Finding the files here and passing
 * them explicitly keeps one command working on every supported Node and OS.
 *
 * Pass `--update` to rewrite the conformance golden files.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = path.join(ROOT, 'tests', 'dist', 'unit');

if (!existsSync(TEST_DIR)) {
  process.stderr.write('No compiled tests at ' + TEST_DIR + ' — run `npm run build` first.\n');
  process.exit(1);
}

function collect(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collect(full));
    else if (entry.name.endsWith('.test.js')) found.push(full);
  }
  return found.sort();
}

const files = collect(TEST_DIR);
if (files.length === 0) {
  process.stderr.write('No *.test.js files found under ' + TEST_DIR + '\n');
  process.exit(1);
}

const update = process.argv.includes('--update');
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: update ? { ...process.env, UPDATE_SNAPSHOTS: '1' } : process.env,
});

process.exit(result.status ?? 1);
