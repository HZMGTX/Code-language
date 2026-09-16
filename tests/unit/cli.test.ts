/**
 * The `lumen` command's own surface: what it accepts, and what it says when
 * it does not.
 *
 * A command-line tool's error messages are the first thing a new user meets,
 * and they are easy to leave untested because nothing in the language breaks
 * when they are wrong.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
const HELLO = fileURLToPath(new URL('../../../examples/hello.lm', import.meta.url));

async function run(args: readonly string[]): Promise<{ code: number; out: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? 0, out }));
  });
}

/**
 * `exit(n)` really stops the process, with `n` as its status.
 *
 * It now goes through `Host.exit` rather than calling `process.exit()` from
 * inside the standard library, which is the change this pins: the CLI's host
 * supplies one, so the observable behaviour must be exactly what it was. Only
 * the real binary can show an exit status, so this is where it is checked.
 */
describe('exit', () => {
  const script = (body: string): { dir: string; file: string } => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-exit-'));
    const file = path.join(dir, 'a.lm');
    writeFileSync(file, body, 'utf8');
    return { dir, file };
  };

  it('stops with the status it was given, without running what follows', async () => {
    const { dir, file } = script(
      'import { exit } from "std/core"\nprint("before")\nexit(3)\nprint("after")\n',
    );
    try {
      const { code, out } = await run([file]);
      assert.equal(code, 3);
      assert.equal(out, 'before\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaults to a status of zero', async () => {
    const { dir, file } = script('import { exit } from "std/core"\nexit()\n');
    try {
      assert.equal((await run([file])).code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `args()` has to mean the same thing whichever way the program was started.
 *
 * It did not: it was `process.argv.slice(3)`, which is one word further along
 * for `lumen run x.lm a b` than for `lumen x.lm a b`, so the first spelling
 * handed the program its own path as `args()[0]`. A test that only exercised one
 * of the two would have gone on passing, which is why this exercises both
 * through the real command.
 */
describe('program arguments', () => {
  const script = (): { dir: string; file: string } => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-args-'));
    const file = path.join(dir, 'a.lm');
    writeFileSync(file, 'import { args } from "std/core"\nprint(args())\n', 'utf8');
    return { dir, file };
  };

  it('is the same list for `run file` and for a bare `file`', async () => {
    const { dir, file } = script();
    try {
      const viaRun = await run(['run', file, 'one', 'two']);
      const viaShorthand = await run([file, 'one', 'two']);
      assert.equal(viaRun.code, 0, viaRun.out);
      assert.equal(viaShorthand.code, 0, viaShorthand.out);
      assert.equal(viaRun.out.trim(), '["one", "two"]');
      assert.equal(viaShorthand.out.trim(), viaRun.out.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never includes the script’s own path', async () => {
    const { dir, file } = script();
    try {
      for (const argv of [['run', file], [file]]) {
        const { code, out } = await run(argv);
        assert.equal(code, 0, out);
        assert.equal(out.trim(), '[]', 'from `lumen ' + argv.join(' ') + '`');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an option no command has, whichever command it is', async () => {
    // `run` and `serve` have rejected one since somebody typed
    // `lumen run --colour app.lm` and was told the *file* `--colour` could not
    // be read. Four commands never got the same treatment, and two of them made
    // the identical mistake in a different shape:
    //
    //     lumen check --colour   →   no `.lm` files found under ./--colour
    //
    // A path is where those commands put anything that is not an option, so a
    // mistyped flag became a directory nobody meant. `repl` and `lsp` ignored
    // whatever they were handed, which is the quieter version of the same.
    for (const command of ['check', 'test', 'repl', 'lsp', 'fmt']) {
      const { code, out } = await run([command, '--bogus']);
      assert.equal(code, 2, command + ' accepted an unknown option: ' + out);
      assert.match(out, new RegExp('unknown option `--bogus` for `' + command + '`', 'u'), out);
    }
  });

  it('still accepts the options that do exist', async () => {
    // The other half, and the reason the check takes an allow-list rather than
    // refusing every flag: `fmt --check` is a real option and has to survive.
    const { code } = await run(['fmt', '--check']);
    assert.equal(code, 0);
  });

  it('passes flag-shaped arguments through to the program', async () => {
    // The CLI rejects unknown options of its own, so these have to be
    // recognised as the program's rather than its.
    const { dir, file } = script();
    try {
      const { code, out } = await run(['run', file, '--verbose', '-n', '3']);
      assert.equal(code, 0, out);
      assert.equal(out.trim(), '["--verbose", "-n", "3"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `lumen ast` and `lumen tokens`.
 *
 * Neither had a test, which is how `lumen ast` came to print `(node)` where an
 * argument, a match arm or a parameter should be — in the one command whose whole
 * job is showing how Lumen read the file. Nothing in the language breaks when a
 * debugging tool's output goes vague, so nothing was going to catch it.
 */
describe('inspecting a file', () => {
  const SOURCE = [
    'fn greet(name, greeting = "hi") {',
    '  match name {',
    '    "ada" => "${greeting}, Ada",',
    '    _ => greeting,',
    '  }',
    '}',
    'print(greet("ada", greeting: "hello"))',
    'let m = { a: 1 }',
    '',
  ].join('\n');

  const inspect = async (command: string): Promise<string> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-ast-'));
    const file = path.join(dir, 'a.lm');
    writeFileSync(file, SOURCE, 'utf8');
    try {
      const { code, out } = await run([command, file]);
      assert.equal(code, 0, out);
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('never prints a node it cannot name', async () => {
    const out = await inspect('ast');
    assert.doesNotMatch(out, /\(node\)/, 'an unnamed node in the tree:\n' + out);
  });

  it('marks each element of a list, so a list reads as one', async () => {
    const out = await inspect('ast');
    // Two parameters, two match arms, two arguments: each element carries a `-`,
    // or `pattern: body: pattern: body:` gives no clue where the first arm ends.
    const arms = out.slice(out.indexOf('arms:'));
    assert.equal((arms.match(/^\s+- pattern:/gm) ?? []).length, 2, 'arms not marked:\n' + arms);
    const params = out.slice(out.indexOf('params:'), out.indexOf('body:'));
    assert.equal((params.match(/^\s+- name=/gm) ?? []).length, 2, 'params not marked:\n' + params);
  });

  it('keeps a named argument’s name', async () => {
    const out = await inspect('ast');
    assert.match(out, /name="greeting"/);
  });

  it('shows the nodes the source actually contains', async () => {
    const out = await inspect('ast');
    for (const expected of ['FnDecl name="greet"', 'MatchExpr', 'PWildcard', 'MapLit', 'TemplateLit']) {
      assert.ok(out.includes(expected), 'missing ' + expected + ' from:\n' + out);
    }
  });

  it('lists tokens with their positions', async () => {
    const out = await inspect('tokens');
    assert.match(out, /^1:1\s+fn\s*$/m);
    assert.match(out, /ident\s+= greet/);
    assert.match(out, /template/);
    assert.match(out, /newline/);
  });

  it('reports a file it cannot read rather than crashing', async () => {
    for (const command of ['ast', 'tokens']) {
      const { code, out } = await run([command, 'no-such-file.lm']);
      assert.notEqual(code, 0);
      assert.match(out, /cannot read/);
    }
  });

  it('needs a file', async () => {
    for (const command of ['ast', 'tokens']) {
      const { code, out } = await run([command]);
      assert.equal(code, 2);
      assert.match(out, /needs a file/);
    }
  });
});

describe('the lumen command', () => {
  it('prints a version', async () => {
    const { code, out } = await run(['--version']);
    assert.equal(code, 0);
    assert.match(out, /^\d+\.\d+\.\d+/);
  });

  it('runs a file named without a subcommand', async () => {
    const { code, out } = await run([HELLO]);
    assert.equal(code, 0);
    assert.match(out, /\w/);
  });

  it('names a mistyped command, and guesses the one meant', async () => {
    const { code, out } = await run(['tets']);
    assert.equal(code, 2);
    assert.match(out, /unknown command `tets`/);
    assert.match(out, /did you mean `test`/);
  });

  it('does not mistake a mistyped command for a missing file', async () => {
    const { out } = await run(['nonexistent-command']);
    assert.match(out, /unknown command/);
    assert.doesNotMatch(out, /cannot read/);
  });

  it('rejects an option it does not know, rather than reading it as a file', async () => {
    const { code, out } = await run(['run', '--weird', HELLO]);
    assert.equal(code, 2);
    assert.match(out, /unknown option `--weird`/);
  });

  it('says which command was missing its file', async () => {
    const { code, out } = await run(['ast']);
    assert.equal(code, 2);
    assert.match(out, /`ast` needs a file/);
  });

  it('reports a file that really is missing as a file', async () => {
    const { code, out } = await run(['run', 'no-such-program.lm']);
    assert.equal(code, 1);
    assert.match(out, /cannot read/);
  });

  it('checks a tree of files without running any of them', async () => {
    const examples = fileURLToPath(new URL('../../../examples', import.meta.url));
    const { code, out } = await run(['check', examples]);
    assert.equal(code, 0);
    assert.match(out, /files checked, no problems/);
    // `hello.lm` prints when it runs. Checking must not.
    assert.doesNotMatch(out, /Hello/);
  });

  it('reports a static error from check, and exits non-zero', async () => {
    const bad = fileURLToPath(
      new URL('../../../tests/conformance/static/unreached-typo.lm', import.meta.url),
    );
    const { code, out } = await run(['check', bad]);
    assert.equal(code, 1);
    assert.match(out, /RS001/);
    assert.match(out, /have problems/);
  });

  it('exits non-zero when the program has an error', async () => {
    const { code } = await run(['run', fileURLToPath(new URL('../../../package.json', import.meta.url))]);
    assert.notEqual(code, 0);
  });
});

/**
 * The `lumen` launcher a checkout ships.
 *
 * There was none. `lumen run x.lm` appears throughout the documentation and
 * existed nowhere in the repository, so `./lumen run app.lm` — the first thing
 * anyone tries after cloning — failed with "not recognized", and on Windows
 * there was nothing else to reach for short of `npm run lumen --`.
 *
 * Only the shell script can be executed here. The Windows one is checked for
 * the things that would silently break it instead: it has to be found by the
 * same name, point at the same file, and pass its arguments through.
 */
describe('the lumen launcher', () => {
  const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
  const CLI_RELATIVE = 'packages/cli/dist/index.js';

  const launcher = async (
    args: readonly string[],
    cwd: string,
  ): Promise<{ code: number; out: string }> =>
    await new Promise((resolve, reject) => {
      const child = spawn(path.join(ROOT, 'lumen'), args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
      });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? 0, out }));
    });

  it('runs a program', async () => {
    const { code, out } = await launcher(['run', HELLO], ROOT);
    assert.equal(code, 0);
    assert.match(out, /Hello from Lumen!/);
  });

  it('works from a directory that is not the checkout', async () => {
    // The reason it resolves its own location rather than trusting `.`: a
    // launcher that only works when you are standing in the repository is a
    // launcher that fails the first time somebody uses it for real.
    const { code, out } = await launcher(['run', HELLO], os.tmpdir());
    assert.equal(code, 0);
    assert.match(out, /Hello from Lumen!/);
  });

  it('passes the program its own arguments', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-launch-'));
    try {
      const file = path.join(dir, 'a.lm');
      writeFileSync(file, 'import { args } from "std/core"\nprint(args())\n', 'utf8');
      const { code, out } = await launcher([file, 'one', 'two'], ROOT);
      assert.equal(code, 0);
      assert.equal(out.trim(), '["one", "two"]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the exit status of a failing program', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lumen-launch-'));
    try {
      const file = path.join(dir, 'a.lm');
      writeFileSync(file, 'print(cuont)\n', 'utf8');
      const { code, out } = await launcher(['run', file], ROOT);
      assert.equal(code, 1);
      assert.match(out, /RS001/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships a Windows launcher that points at the same CLI', () => {
    const windows = readFileSync(path.join(ROOT, 'lumen.cmd'), 'utf8');
    // Written with backslashes, but naming the same file the shell script does.
    assert.ok(
      windows.includes(CLI_RELATIVE.replace(/\//g, '\\')),
      'lumen.cmd does not run ' + CLI_RELATIVE,
    );
    assert.ok(windows.includes('%~dp0'), 'lumen.cmd does not resolve its own directory');
    assert.ok(windows.includes('%*'), 'lumen.cmd does not pass its arguments through');
    assert.ok(
      windows.includes('exit /b %ERRORLEVEL%'),
      'lumen.cmd does not report the exit status',
    );

    const shell = readFileSync(path.join(ROOT, 'lumen'), 'utf8');
    assert.ok(shell.includes(CLI_RELATIVE), 'lumen does not run ' + CLI_RELATIVE);
  });
});
