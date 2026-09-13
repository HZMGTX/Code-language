#!/usr/bin/env node
/**
 * Build the native standalone `lumen` executable (distribution tier 1).
 *
 * The output is a true single-file program: it embeds a JavaScript runtime, so
 * a user needs NO Node, NO npm and NO node_modules to run Lumen programs. Bun
 * is required to *build* it and never to run it.
 *
 *   node scripts/build-binary.mjs                 host platform  -> build/lumen
 *   node scripts/build-binary.mjs --all           every target   -> build/lumen-<platform>
 *   node scripts/build-binary.mjs --target=<t>    one target
 *
 * Tier 2 lives next door: `npm run bundle` writes build/lumen.cjs, one portable
 * CommonJS file that needs a Node >= 20 but no install.
 *
 * Dependency-free by design: node builtins only.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Locate the repository root without node:url, so the builtin list stays short. */
function scriptDirectory() {
  if (typeof import.meta.dirname === 'string') return import.meta.dirname;
  // Node < 20.11 has no import.meta.dirname; derive it from the module URL.
  let file = decodeURIComponent(import.meta.url.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(file)) file = file.slice(1); // Windows: /C:/x -> C:/x
  return path.dirname(file);
}

const ROOT = path.resolve(scriptDirectory(), '..');
const ENTRY = path.join('packages', 'cli', 'src', 'index.ts');
const OUT_DIR = path.join(ROOT, 'build');
const SUMS_FILE = path.join(OUT_DIR, 'SHA256SUMS.txt');

/**
 * The targets we cross-compile for. `bun` is the string bun understands;
 * `name` is the human one we ship, because nobody wants to explain "darwin".
 */
const TARGETS = [
  { bun: 'bun-linux-x64', name: 'lumen-linux-x64', aliases: ['linux-x64', 'linux-amd64'] },
  { bun: 'bun-linux-arm64', name: 'lumen-linux-arm64', aliases: ['linux-arm64', 'linux-aarch64'] },
  { bun: 'bun-darwin-x64', name: 'lumen-macos-x64', aliases: ['macos-x64', 'darwin-x64', 'mac-x64'] },
  {
    bun: 'bun-darwin-arm64',
    name: 'lumen-macos-arm64',
    aliases: ['macos-arm64', 'darwin-arm64', 'mac-arm64'],
  },
  {
    bun: 'bun-windows-x64',
    name: 'lumen-windows-x64.exe',
    aliases: ['windows-x64', 'win-x64', 'win32-x64', 'lumen-windows-x64'],
  },
];

const USAGE = `Build the native standalone lumen executable.

Usage
  node scripts/build-binary.mjs               build for this machine -> build/lumen
  node scripts/build-binary.mjs --all         cross-compile every target
  node scripts/build-binary.mjs --target=<t>  build one target

Targets
${TARGETS.map((t) => '  ' + t.bun.padEnd(18) + ' -> build/' + t.name).join('\n')}

The binaries embed a JavaScript runtime, so each is around 100 MB. That is
expected. They run with no Node, no npm and no node_modules installed.
`;

function fail(message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(1);
}

function findTarget(requested) {
  const wanted = requested.trim().toLowerCase();
  return (
    TARGETS.find((t) => t.bun === wanted || t.name === wanted || t.aliases.includes(wanted)) ?? null
  );
}

/** What bun would build for if we said nothing — used only to label the output. */
function hostLabel() {
  const arch = os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'x64' : os.arch();
  const platform =
    os.platform() === 'darwin' ? 'macos' : os.platform() === 'win32' ? 'windows' : os.platform();
  return platform + '-' + arch;
}

function megabytes(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Confirm bun exists before we promise anything, and report its version. */
function bunVersion() {
  let probe;
  try {
    probe = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  } catch (error) {
    probe = { error };
  }
  if (probe.error !== undefined || probe.status !== 0) {
    fail(
      'lumen: `bun` was not found on PATH.\n' +
        '\n' +
        'The native standalone binary is compiled by bun. Bun is needed at BUILD\n' +
        'time only — the binary it produces runs with no bun, no Node and no\n' +
        'node_modules at all.\n' +
        '\n' +
        'Install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash),\n' +
        'then run this command again.\n' +
        '\n' +
        'Prefer not to install anything? `npm run bundle` writes a portable\n' +
        'single file, build/lumen.cjs, which runs on any Node >= 20 with no\n' +
        'install and no node_modules:  node lumen.cjs run app.lm\n',
    );
  }
  return (probe.stdout ?? '').trim();
}

/**
 * Compile one artifact. `target` is null for the host build, which is what the
 * default path uses so bun picks the machine it is running on.
 */
function compile(target, outName) {
  const outFile = path.join(OUT_DIR, outName);
  const args = ['build', '--compile', ENTRY, '--outfile', outFile];
  if (target !== null) args.push('--target=' + target.bun);

  process.stdout.write(
    'compiling ' + outName + (target === null ? ' (host)' : ' (' + target.bun + ')') + '\n',
  );

  const result = spawnSync('bun', args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error !== undefined) {
    fail('lumen: could not run bun: ' + (result.error.message ?? String(result.error)));
  }
  if (result.status !== 0) {
    process.stderr.write(
      '\nlumen: bun failed to compile ' + outName + ' (exit ' + String(result.status) + ')\n',
    );
    process.exit(result.status === null ? 1 : result.status);
  }
  // bun appends .exe for windows targets; follow it so the checksum finds the file.
  const actual = existsSync(outFile) ? outFile : outFile + '.exe';
  if (!existsSync(actual)) {
    fail('lumen: bun reported success but ' + outFile + ' is missing.');
  }
  return { name: path.basename(actual), file: actual, size: statSync(actual).size };
}

/**
 * Write build/SHA256SUMS.txt in the usual `sha256  name` shape, merging with
 * whatever is already there so the portable bundle's entry survives our run.
 */
function writeChecksums(artifacts) {
  const sums = new Map();
  if (existsSync(SUMS_FILE)) {
    for (const line of readFileSync(SUMS_FILE, 'utf8').split('\n')) {
      const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
      if (match === null) continue;
      // Drop entries whose file has since been removed from build/.
      if (existsSync(path.join(OUT_DIR, match[2]))) sums.set(match[2], match[1]);
    }
  }
  for (const artifact of artifacts) sums.set(artifact.name, sha256(artifact.file));

  const names = [...sums.keys()].sort();
  writeFileSync(SUMS_FILE, names.map((n) => sums.get(n) + '  ' + n).join('\n') + '\n');
  return names.map((n) => ({ name: n, sum: sums.get(n) }));
}

function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    return;
  }

  const all = argv.includes('--all');
  const targetArg = argv.find((a) => a.startsWith('--target='));
  const unknown = argv.filter(
    (a) => a !== '--all' && !a.startsWith('--target=') && a !== '-h' && a !== '--help',
  );
  if (unknown.length > 0) {
    fail('lumen: unknown option `' + unknown[0] + '`\n\n' + USAGE);
  }
  if (all && targetArg !== undefined) {
    fail('lumen: use either --all or --target=<t>, not both.');
  }

  /** @type {{ target: object | null, out: string }[]} */
  let jobs;
  if (all) {
    jobs = TARGETS.map((target) => ({ target, out: target.name }));
  } else if (targetArg !== undefined) {
    const requested = targetArg.slice('--target='.length);
    const target = findTarget(requested);
    if (target === null) {
      fail(
        'lumen: unknown target `' +
          requested +
          '`\n\nKnown targets:\n' +
          TARGETS.map(
            (t) => '  ' + t.bun + '  (or ' + t.name.replace(/^lumen-/, '').replace(/\.exe$/, '') + ')',
          ).join('\n') +
          '\n',
      );
    }
    jobs = [{ target, out: target.name }];
  } else {
    jobs = [{ target: null, out: os.platform() === 'win32' ? 'lumen.exe' : 'lumen' }];
  }

  const version = bunVersion();
  mkdirSync(OUT_DIR, { recursive: true });

  process.stdout.write(
    'lumen native binary\n' +
      '  bun     ' +
      version +
      '\n' +
      '  entry   ' +
      ENTRY +
      '\n' +
      '  host    ' +
      hostLabel() +
      '\n' +
      '  output  ' +
      OUT_DIR +
      '\n\n',
  );

  const artifacts = [];
  for (const job of jobs) artifacts.push(compile(job.target, job.out));

  process.stdout.write('\nArtifacts\n');
  for (const artifact of artifacts) {
    process.stdout.write('  ' + artifact.file + '  ' + megabytes(artifact.size) + ' MB\n');
  }
  process.stdout.write(
    '\nEach binary embeds a JavaScript runtime, which is why it is ~100 MB. That is\n' +
      'expected, not a bug: it is what lets the binary run with no Node, no npm and\n' +
      'no node_modules anywhere on the machine.\n',
  );

  const sums = writeChecksums(artifacts);
  process.stdout.write('\n' + SUMS_FILE + '\n');
  for (const entry of sums) process.stdout.write('  ' + entry.sum + '  ' + entry.name + '\n');
}

main(process.argv.slice(2));
