/**
 * The distribution has to actually be distributable.
 *
 * Lumen ships in two tiers, and both make a claim about what a user needs
 * installed. Claims like that rot silently, so they are tested rather than
 * checked by hand once:
 *
 *   Tier 1  build/lumen      a native executable. Needs NO runtime at all.
 *   Tier 2  build/lumen.cjs  one CommonJS file. Needs a Node >= 20 and
 *                            nothing else — no npm install, no node_modules,
 *                            no source tree.
 *
 * The method is the same for both: copy the single artefact into a fresh
 * directory outside the repository, copy a program next to it, run it there,
 * and compare byte for byte against what the ordinary CLI produces. A bundler
 * that quietly reached back into `node_modules` would pass a test run from
 * inside the repo; it cannot pass this one.
 *
 * Both suites skip rather than fail when their artefact cannot exist on this
 * machine (no `scripts/bundle.mjs` yet, no bun installed). A red test for a
 * tool that is not supposed to be here is noise, not a signal.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, promises as fsp, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

/** Compiled tests live at tests/dist/unit/, so the repo root is three up. */
const ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const EXAMPLES_DIR = path.join(ROOT, 'examples');
const BUILD_DIR = path.join(ROOT, 'build');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const BUNDLE_SCRIPT = path.join(ROOT, 'scripts', 'bundle.mjs');

const BUNDLE_NAME = 'lumen.cjs';
const BUNDLE = path.join(BUILD_DIR, BUNDLE_NAME);
const BINARY = path.join(BUILD_DIR, process.platform === 'win32' ? 'lumen.exe' : 'lumen');

/**
 * The programs copied into every sandbox. `hello.lm` is the smallest possible
 * proof of life; `tour.lm` imports `std/list` and `std/str`, so it only runs if
 * the standard library really travelled inside the artefact.
 */
const PROGRAMS: readonly string[] = ['hello.lm', 'tour.lm'];

/** A deliberately unfinished program, to check diagnostics survive packaging. */
const BROKEN = 'broken.lm';
const BROKEN_SOURCE = 'let x = \n';

const RUN_TIMEOUT = 60_000;
const BUILD_TIMEOUT = 300_000;

type Env = Record<string, string | undefined>;

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

/** Run a command to completion and capture everything about it. */
function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: Env; timeout?: number },
): Outcome {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? RUN_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024,
  });
  // The types promise strings, but a process that never started yields null.
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

/** A readable dump of a run, for assertion messages worth reading. */
function report(label: string, outcome: Outcome): string {
  const lines = [
    label,
    '  status: ' + String(outcome.status),
    '  stdout: ' + JSON.stringify(outcome.stdout),
    '  stderr: ' + JSON.stringify(outcome.stderr),
  ];
  if (outcome.error !== undefined) lines.push('  error:  ' + outcome.error.message);
  return lines.join('\n');
}

/**
 * The current environment with every hook that could inject extra module
 * search paths removed. If the bundle needs `NODE_PATH` it is not portable.
 */
function sealedEnv(): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'NODE_PATH' || key === 'NODE_OPTIONS') continue;
    env[key] = value;
  }
  env['NO_COLOR'] = '1';
  env['LUMEN_AI_PROVIDER'] = 'mock';
  return env;
}

/**
 * What `env -i PATH=/nonexistent HOME=/tmp` gives you: nothing inherited, and
 * no directory on PATH that could possibly contain a `node`.
 */
function bareEnv(): Env {
  return { PATH: '/nonexistent', HOME: os.tmpdir() };
}

/** Every directory from `start` up to the filesystem root, inclusive. */
function ancestors(start: string): string[] {
  const chain: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    chain.push(current);
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/** Directories on the way up that carry a `node_modules` Node could find. */
function nodeModulesAbove(start: string): string[] {
  return ancestors(start).filter((dir) => existsSync(path.join(dir, 'node_modules')));
}

/** True when `bun` is installed. Only the *build* of tier 1 ever needs it. */
function hasBun(): boolean {
  const probe = spawnSync('bun', ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return probe.error === undefined && probe.status === 0;
}

/** A sandbox is only meaningful if it is nowhere near the repository. */
function assertOutsideRepo(dir: string): void {
  const relative = path.relative(ROOT, dir);
  assert.ok(
    relative.startsWith('..') || path.isAbsolute(relative),
    'the sandbox must live outside the repository, got ' + dir,
  );
}

describe('distribution tier 2 — the portable bundle', () => {
  /** Set when the suite cannot run here at all; every test skips on it. */
  let skipReason: string | undefined;
  /** Kept so a failed build is reported by a test rather than a dead hook. */
  let buildLog = '';
  let sandbox = '';
  const reference = new Map<string, Outcome>();

  before(
    async () => {
      if (!existsSync(BUNDLE_SCRIPT)) {
        skipReason = 'scripts/bundle.mjs does not exist yet';
        return;
      }
      if (!existsSync(CLI)) {
        skipReason = 'packages/cli/dist/index.js is missing — build the workspace first';
        return;
      }

      // Building takes a few seconds, so only do it when there is nothing to
      // test. LUMEN_DIST_REBUILD=1 forces a fresh one.
      if (!existsSync(BUNDLE) || process.env['LUMEN_DIST_REBUILD'] === '1') {
        const built = run(process.execPath, [BUNDLE_SCRIPT], {
          cwd: ROOT,
          env: process.env,
          timeout: BUILD_TIMEOUT,
        });
        buildLog = report('node scripts/bundle.mjs', built);
      }
      if (!existsSync(BUNDLE)) return;

      sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-bundle-'));
      await fsp.copyFile(BUNDLE, path.join(sandbox, BUNDLE_NAME));
      for (const name of PROGRAMS) {
        await fsp.copyFile(path.join(EXAMPLES_DIR, name), path.join(sandbox, name));
      }
      await fsp.writeFile(path.join(sandbox, BROKEN), BROKEN_SOURCE, 'utf8');

      // Ground truth: the ordinary CLI, pointed at the very same files, so
      // any file name appearing in a diagnostic is identical on both sides.
      for (const name of [...PROGRAMS, BROKEN]) {
        reference.set(
          name,
          run(process.execPath, [CLI, 'run', path.join(sandbox, name)], {
            cwd: ROOT,
            env: sealedEnv(),
          }),
        );
      }
    },
    { timeout: BUILD_TIMEOUT + RUN_TIMEOUT },
  );

  after(async () => {
    if (sandbox !== '') await fsp.rm(sandbox, { recursive: true, force: true });
  });

  /** The sandbox, or a loud failure carrying the build output. */
  function ready(): string {
    assert.notEqual(sandbox, '', 'build/lumen.cjs was never produced.\n' + buildLog);
    return sandbox;
  }

  function referenceFor(name: string): Outcome {
    const found = reference.get(name);
    if (found === undefined) throw new Error('no reference run was recorded for ' + name);
    return found;
  }

  it('is a single file', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    const stats = statSync(path.join(dir, BUNDLE_NAME));
    assert.ok(stats.isFile(), BUNDLE_NAME + ' is not a plain file');
    assert.ok(stats.size > 1024, BUNDLE_NAME + ' is suspiciously small: ' + String(stats.size));
  });

  it('sits in a directory with no node_modules anywhere above it', { timeout: RUN_TIMEOUT }, async (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    assertOutsideRepo(dir);

    const entries = (await fsp.readdir(dir)).sort();
    const expected = [...PROGRAMS, BROKEN, BUNDLE_NAME].sort();
    assert.deepEqual(entries, expected, 'the sandbox holds more than the bundle and the programs');

    // Node walks up the tree looking for node_modules, so the guarantee only
    // holds if there is none on the whole path to the filesystem root.
    const polluted = nodeModulesAbove(dir);
    assert.deepEqual(
      polluted,
      [],
      'the sandbox is not isolated — node_modules found at: ' + polluted.join(', '),
    );
  });

  it('runs hello.lm with nothing but node and itself', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    const expected = referenceFor('hello.lm');
    const actual = run(process.execPath, [BUNDLE_NAME, 'run', 'hello.lm'], {
      cwd: dir,
      env: sealedEnv(),
    });

    assert.equal(actual.status, 0, report('bundle run hello.lm', actual));
    assert.equal(actual.stderr, '', report('bundle run hello.lm', actual));
    assert.match(actual.stdout, /Hello from Lumen!/);
    assert.equal(actual.stdout, expected.stdout, 'the bundle disagrees with the CLI');
  });

  it('runs tour.lm, so the standard library travelled with it', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    const expected = referenceFor('tour.lm');
    const actual = run(process.execPath, [BUNDLE_NAME, 'run', 'tour.lm'], {
      cwd: dir,
      env: sealedEnv(),
    });

    assert.equal(actual.status, 0, report('bundle run tour.lm', actual));
    assert.equal(actual.stderr, '', report('bundle run tour.lm', actual));
    // tour.lm imports std/list and std/str; these lines are their output.
    assert.match(actual.stdout, /total cost: 16/);
    assert.match(actual.stdout, /shouted:    DONE/);
    assert.equal(actual.stdout, expected.stdout, 'the bundle disagrees with the CLI');
  });

  it('renders a diagnostic exactly as the CLI does', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    const expected = referenceFor(BROKEN);
    // Absolute on both sides, so the path inside the diagnostic matches.
    const actual = run(process.execPath, [BUNDLE_NAME, 'run', path.join(dir, BROKEN)], {
      cwd: dir,
      env: sealedEnv(),
    });

    assert.notEqual(actual.status, 0, 'a broken program must not exit 0');
    assert.equal(actual.status, expected.status);
    assert.match(actual.stderr, /error\[/, report('bundle run broken.lm', actual));
    assert.equal(actual.stderr, expected.stderr, 'the bundle renders errors differently');
  });

  it('does not care what the working directory is', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    const expected = referenceFor('hello.lm');
    const elsewhere = os.tmpdir();
    const actual = run(
      process.execPath,
      [path.join(dir, BUNDLE_NAME), 'run', path.join(dir, 'hello.lm')],
      { cwd: elsewhere, env: sealedEnv() },
    );

    assert.equal(actual.status, 0, report('bundle run from ' + elsewhere, actual));
    assert.equal(actual.stdout, expected.stdout);
  });
});

describe('distribution tier 1 — the native binary', () => {
  let skipReason: string | undefined;
  let sandbox = '';
  const reference = new Map<string, Outcome>();

  before(
    async () => {
      if (!existsSync(BINARY)) {
        skipReason = 'build/lumen does not exist — run `npm run binary`';
        return;
      }
      if (!hasBun()) {
        skipReason = 'bun is not installed, so the binary here cannot be trusted to be current';
        return;
      }
      if (!existsSync(CLI)) {
        skipReason = 'packages/cli/dist/index.js is missing — build the workspace first';
        return;
      }

      sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-binary-'));
      for (const name of PROGRAMS) {
        await fsp.copyFile(path.join(EXAMPLES_DIR, name), path.join(sandbox, name));
      }
      for (const name of PROGRAMS) {
        reference.set(
          name,
          run(process.execPath, [CLI, 'run', path.join(sandbox, name)], {
            cwd: ROOT,
            env: sealedEnv(),
          }),
        );
      }
    },
    { timeout: BUILD_TIMEOUT },
  );

  after(async () => {
    if (sandbox !== '') await fsp.rm(sandbox, { recursive: true, force: true });
  });

  function ready(): string {
    assert.notEqual(sandbox, '', 'the binary sandbox was never prepared');
    return sandbox;
  }

  function referenceFor(name: string): Outcome {
    const found = reference.get(name);
    if (found === undefined) throw new Error('no reference run was recorded for ' + name);
    return found;
  }

  it('runs a program', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    const expected = referenceFor('hello.lm');
    const actual = run(BINARY, ['run', 'hello.lm'], { cwd: dir, env: sealedEnv() });

    assert.equal(actual.status, 0, report('lumen run hello.lm', actual));
    assert.equal(actual.stdout, expected.stdout);
  });

  it('runs with an empty environment and no node on PATH', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    if (process.platform === 'win32') {
      // PATH=/nonexistent means nothing on Windows, so the trick proves nothing.
      t.skip('the empty-environment trick does not apply on Windows');
      return;
    }
    const dir = ready();
    const expected = referenceFor('hello.lm');
    // The equivalent of: env -i PATH=/nonexistent HOME=/tmp lumen run hello.lm
    const actual = run(BINARY, ['run', 'hello.lm'], { cwd: dir, env: bareEnv() });

    assert.equal(actual.status, 0, report('bare-environment lumen run hello.lm', actual));
    assert.equal(actual.stderr, '', report('bare-environment lumen run hello.lm', actual));
    assert.equal(actual.stdout, expected.stdout, 'the binary needs its environment after all');
  });

  it('runs the whole tour with nothing inherited at all', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    if (process.platform === 'win32') {
      t.skip('the empty-environment trick does not apply on Windows');
      return;
    }
    const dir = ready();
    const expected = referenceFor('tour.lm');
    // Not even PATH this time: the binary must carry its own runtime.
    const actual = run(BINARY, ['run', 'tour.lm'], { cwd: dir, env: {} });

    assert.equal(actual.status, 0, report('empty-environment lumen run tour.lm', actual));
    assert.match(actual.stdout, /total cost: 16/);
    assert.equal(actual.stdout, expected.stdout, 'the binary disagrees with the CLI');
  });

  it('is isolated from any node_modules', { timeout: RUN_TIMEOUT }, (t) => {
    if (skipReason !== undefined) {
      t.skip(skipReason);
      return;
    }
    const dir = ready();
    assertOutsideRepo(dir);
    const polluted = nodeModulesAbove(dir);
    assert.deepEqual(
      polluted,
      [],
      'the sandbox is not isolated — node_modules found at: ' + polluted.join(', '),
    );
  });
});
