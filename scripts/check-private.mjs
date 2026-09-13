#!/usr/bin/env node
/**
 * Guard the "closed source" decision mechanically.
 *
 * Lumen is proprietary. Every package manifest carries `"private": true`, which
 * makes `npm publish` fail by design. This check fails the build if that ever
 * stops being true, so an accidental publish is not the thing that discovers it.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const MANIFESTS = [
  'package.json',
  path.join('packages', 'core', 'package.json'),
  path.join('packages', 'stdlib', 'package.json'),
  path.join('packages', 'cli', 'package.json'),
];

let failures = 0;

for (const relative of MANIFESTS) {
  const full = path.join(ROOT, relative);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    process.stderr.write('cannot read ' + relative + ': ' + String(error) + '\n');
    failures += 1;
    continue;
  }
  if (pkg.private !== true) {
    process.stderr.write(relative + ' is missing "private": true\n');
    failures += 1;
  }
}

if (failures > 0) {
  process.stderr.write('\nRefusing to pass: this repository must not be publishable.\n');
  process.exit(1);
}

process.stdout.write('all ' + MANIFESTS.length + ' manifests are marked private\n');
