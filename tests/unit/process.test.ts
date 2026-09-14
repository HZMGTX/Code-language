/**
 * `std/process` — running another program.
 *
 * A unit test rather than a conformance fixture, because the programs it runs
 * differ between platforms and a golden file would be pinning the machine as
 * much as the language. What is pinned here is what the module promises: a
 * non-zero status is an answer, a missing program is an `Err` with a sentence,
 * an argument is never parsed by a shell, and a process that runs too long is
 * killed and said so.
 *
 * The shell-injection case is the one worth having: it is the reason the module
 * takes an argument list instead of a command line, and a change that
 * introduced `shell: true` for convenience would fail exactly here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { runSource } from '../support/harness.js';

/** Run a snippet and return its trimmed output, failing loudly if it errored. */
async function out(source: string): Promise<string> {
  const result = await runSource(source);
  assert.equal(result.failed, false, 'expected success but got:\n' + result.output);
  return result.output.trimEnd();
}

const IMPORT = 'import { run, which, isWindows } from "std/process"\n';

describe('std/process', () => {
  it('runs a program and reports what it said', async () => {
    const text = await out(
      IMPORT +
        'match run("echo", ["hello", "world"]) {\n' +
        '  Ok(r)    => print("${r.status} ${r.ok} ${r.out.trim()}"),\n' +
        '  Err(why) => print("ERR ${why}"),\n' +
        '}',
    );
    assert.equal(text, '0 true hello world');
  });

  it('treats a non-zero status as an answer, not a failure', async () => {
    // `grep` says "no match" this way. A library that made that an `Err` would
    // turn the commonest use of the commonest tool into something that reads
    // like a crash.
    const text = await out(
      IMPORT +
        'match run("sh", ["-c", "exit 3"]) {\n' +
        '  Ok(r)    => print("status ${r.status} ok ${r.ok}"),\n' +
        '  Err(why) => print("ERR ${why}"),\n' +
        '}',
    );
    assert.equal(text, 'status 3 ok false');
  });

  it('sends input in and keeps the two outputs apart', async () => {
    const text = await out(
      IMPORT +
        'match run("cat", [], input: "piped\\n") {\n' +
        '  Ok(r)    => print("out [${r.out.trim()}]"),\n' +
        '  Err(why) => print("ERR ${why}"),\n' +
        '}\n' +
        'match run("sh", ["-c", "echo oops >&2"]) {\n' +
        '  Ok(r)    => print("err [${r.err.trim()}] out [${r.out}]"),\n' +
        '  Err(why) => print("ERR ${why}"),\n' +
        '}',
    );
    assert.equal(text, 'out [piped]\nerr [oops] out []');
  });

  it('never lets a shell see an argument', async () => {
    // The reason the module takes a list rather than a command line. If this
    // ever prints anything but the text itself, something has started passing
    // `shell: true` and every call in every program has become a quoting
    // question again.
    const text = await out(
      IMPORT +
        'match run("echo", ["; rm -rf /"]) {\n' +
        '  Ok(r)    => print("[${r.out.trim()}]"),\n' +
        '  Err(why) => print("ERR ${why}"),\n' +
        '}',
    );
    assert.equal(text, '[; rm -rf /]');
  });

  it('reports a missing program with a sentence rather than an errno', async () => {
    const text = await out(
      IMPORT +
        'match run("definitely-not-a-program-xyz") {\n' +
        '  Ok(r)    => print("unexpectedly ran ${r.status}"),\n' +
        '  Err(why) => print("${why}"),\n' +
        '}',
    );
    assert.equal(text, 'cannot run `definitely-not-a-program-xyz`: no such program');
  });

  it('kills a process that runs too long, and says that is what happened', async () => {
    // Timed out and failed want different handling, so they are different
    // fields rather than one non-zero status to interpret.
    const text = await out(
      IMPORT +
        'match run("sleep", ["10"], timeout: 200) {\n' +
        '  Ok(r)    => print("timedOut ${r.timedOut} ok ${r.ok}"),\n' +
        '  Err(why) => print("ERR ${why}"),\n' +
        '}',
    );
    assert.equal(text, 'timedOut true ok false');
  });

  it('runs in a directory when given one', async () => {
    const text = await out(
      IMPORT + 'match run("pwd", [], cwd: "/") { Ok(r) => print(r.out.trim()), Err(w) => print(w) }',
    );
    assert.equal(text, '/');
  });

  it('finds a program on PATH, and answers None when there is none', async () => {
    const text = await out(
      IMPORT +
        'print(which("sh").isSome())\n' +
        'print(which("definitely-not-a-program-xyz"))\n' +
        'print(isWindows())',
    );
    assert.equal(text, 'true\nNone\nfalse');
  });

  it('checks the type of what it is given, like everything else', async () => {
    const result = await runSource(IMPORT + 'print(run("echo", ["a", 1]))');
    assert.equal(result.failed, true);
    assert.match(result.output, /run argument 2 must be a Str, got Num/);
  });
});
