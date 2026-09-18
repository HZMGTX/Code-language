#!/usr/bin/env node
/**
 * Guard the two decisions this project cannot afford to lose by accident.
 *
 * **Closed source.** Lumen is proprietary. Every package manifest carries
 * `"private": true`, which makes `npm publish` fail by design. This fails the
 * build if that ever stops being true, so an accidental publish is not the thing
 * that discovers it.
 *
 * **Zero runtime dependencies.** The README, `docs/philosophy.md` and the
 * language server's own design all rest on it, and it was kept entirely by hand
 * — the one claim the project makes most loudly and checked nowhere. A package
 * may depend on its workspace siblings and on nothing else, and `core` may not
 * even do that: `docs/philosophy.md` lists *"the core reaching for a host API
 * directly"* as something that would falsify the project's claims, so it imports
 * no sibling and nothing from `node:` either.
 *
 * The manifests are **found** rather than listed. The list used to be written
 * out, and `packages/lsp` was added to the repository and not to it — so for
 * the whole of v0.2 the language server could have been published and nothing
 * would have said a word. A list of things that exist goes stale exactly as
 * fast as a count of them.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGES = path.join(ROOT, 'packages');

/** The workspace's own scope: a dependency on one of these is not a dependency. */
const OURS = '@lumen-lang/';

/** Every manifest in the repository: the root, and one per package. */
function manifests() {
  const found = ['package.json'];
  for (const entry of readdirSync(PACKAGES)) {
    const relative = path.join('packages', entry, 'package.json');
    try {
      if (statSync(path.join(ROOT, relative)).isFile()) found.push(relative);
    } catch {
      // A directory with no manifest is not a package.
    }
  }
  return found;
}

const failures = [];
const found = manifests();

// A guard on the guard. If `packages/` moved or could not be read, this would
// otherwise pass having checked the root manifest alone and reported success.
if (found.length < 4) {
  failures.push('found only ' + found.length + ' manifests, which cannot be right');
}

for (const relative of found) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));
  } catch (error) {
    failures.push('cannot read ' + relative + ': ' + String(error));
    continue;
  }

  if (pkg.private !== true) failures.push(relative + ' is missing "private": true');

  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!name.startsWith(OURS)) {
      failures.push(relative + ' depends on `' + name + '`, which is not ours');
    }
  }
}

// `core` is the one that has to import nothing at all, since everything else
// rests on it being portable to a browser. `node:` is the tell.
const CORE = path.join(ROOT, 'packages', 'core', 'src');
for (const entry of readdirSync(CORE)) {
  if (!entry.endsWith('.ts')) continue;
  const source = readFileSync(path.join(CORE, entry), 'utf8');
  for (const [, from] of source.matchAll(/from\s+'([^']+)'/gu)) {
    if (from.startsWith('.')) continue;
    failures.push('packages/core/src/' + entry + ' imports `' + from + '`, and core imports nothing');
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(failure + '\n');
  process.stderr.write(
    '\nRefusing to pass: this repository must not be publishable, and must carry\n' +
      'no runtime dependency it did not write.\n',
  );
  process.exit(1);
}

process.stdout.write(
  'all ' + found.length + ' manifests are private and depend on nothing but each other\n',
);
