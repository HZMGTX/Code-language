/**
 * The REPL, driven as a user drives it: a real process, real piped lines.
 *
 * It is a large surface — multi-line input, meta commands, a scope that
 * persists, error recovery — and until now none of it was tested, so a
 * refactor could have broken any of it silently.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));

async function repl(lines: readonly string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'repl'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', () => resolve(out));
    child.stdin.end([...lines, ':quit'].join('\n') + '\n');
  });
}

describe('repl', () => {
  it('evaluates an expression and prints its value', async () => {
    assert.match(await repl(['1 + 2']), /\n?3/);
  });

  it('keeps definitions across inputs', async () => {
    const out = await repl(['let x = 21', 'fn double(n) { n * 2 }', 'double(x)']);
    assert.match(out, /42/);
  });

  it('continues an unfinished line onto the next', async () => {
    const out = await repl(['let xs = [1, 2,', '3]', 'xs']);
    assert.match(out, /\[1, 2, 3\]/);
  });

  it('abandons a half-written expression on a blank line', async () => {
    // Without this there is no way out of a continuation but to finish it:
    // every later line, `:quit` included, is swallowed as more of the same
    // expression.
    const out = await repl(['1 +', '', 'let recovered = 7', 'recovered']);
    assert.match(out, /\(abandoned\)/);
    assert.match(out, /7/);
  });

  it('reports an error and carries on', async () => {
    const out = await repl(['nope', 'let after = 5', 'after']);
    assert.match(out, /RS001/);
    assert.match(out, /5/);
  });

  it('answers a top-level `return` instead of crashing on it', async () => {
    // `return` written outside any function reaches the interpreter's own
    // return signal, which a module catches and the REPL did not — so it
    // escaped to the CLI's last resort and printed `lumen: internal error`
    // followed by `[object Object]`, a signal being a plain object that
    // `String` says nothing about.
    //
    // The REPL is a module boundary like any other; the difference is that
    // here the value is exactly what the person typing wanted to see.
    const out = await repl(['return 1', 'let after = 5', 'after']);
    assert.doesNotMatch(out, /internal error|\[object Object\]/);
    // The prompt shares the line with the value it answered.
    assert.match(out, /lumen> 1$/mu);
    // And the session is still alive, which is the half that matters.
    assert.match(out, /lumen> 5$/mu);
  });

  it('reports an unhandled `?` the way a file does, and carries on', async () => {
    // The sibling of the case above, and the reason that one was not enough:
    // `runModule` and `runStatements` each decided for themselves which of the
    // four control-flow signals to catch, and disagreed. A `?` at the top level
    // printed `lumen: internal error`, `TryPropagate {…}`, and exited 70 —
    // while the same program in a file reported `RT001` and carried on.
    const out = await repl([
      'import { parse } from "std/json"',
      'parse("nope")?',
      'let after = 6',
      'after',
    ]);
    assert.doesNotMatch(out, /internal error|TryPropagate/);
    assert.match(out, /RT001/);
    assert.match(out, /unhandled at top level/);
    assert.match(out, /lumen> 6$/mu);
  });

  it('does not check a session binding as the prelude name it shadows', async () => {
    // `fixed` is `std/math.fixed`, whose signature the checker seeds its root
    // scope with. A session binding of the same name was passed across as a
    // *name* and nothing more, so it resolved but carried no type and the
    // prelude's won:
    //
    //     lumen> let fixed = 1
    //     lumen> fixed + 1
    //     error[TY005]: cannot add fn(Num, Num) -> Str and Num
    //
    // Rejecting a line that works, which is the one thing these passes must
    // never do.
    const out = await repl(['let fixed = 1', 'fixed + 1']);
    assert.doesNotMatch(out, /TY005|TY006|fn\(Num, Num\)/);
    assert.match(out, /lumen> 2$/mu);
  });

  it('still checks a prelude name the session has not shadowed', async () => {
    // The other direction, and the reason the fix drops one signature rather
    // than all of them: the checker has to keep working on everything a session
    // has *not* rebound, including methods, which come from the receiver's type
    // and never from scope.
    const out = await repl(['fixed("x")', '[1].take("two")']);
    assert.match(out, /TY001.*`fixed` expects Num/u);
    assert.match(out, /TY001.*`take` expects Num/u);
  });

  it('answers :type', async () => {
    assert.match(await repl([':type "abc"']), /Str/);
  });

  it('answers :env, and says so when nothing is bound', async () => {
    assert.match(await repl([':env']), /nothing bound yet/i);
    assert.match(await repl(['let only = 1', ':env']), /only/);
  });

  it('forgets everything on :clear', async () => {
    const out = await repl(['let gone = 1', ':clear', 'gone']);
    assert.match(out, /RS001/);
  });

  it('lists the standard modules', async () => {
    const out = await repl([':modules']);
    assert.match(out, /std\/list/);
    assert.match(out, /std\/web/);
  });

  it('answers :ast with the same tree `lumen ast` prints', async () => {
    // It used to print the raw JSON with spans stripped: twenty-eight lines for
    // `1 + 2 ** 3` where the tree is seven, and a second rendering of one
    // structure that could drift from the command's.
    const out = await repl([':ast 1 + 2 ** 3']);
    assert.match(out, /Binary op="\+"/, out);
    assert.match(out, /NumberLit value=1/, out);
    assert.doesNotMatch(out, /"kind":/, 'still printing JSON:\n' + out);
  });

  it('reports a :ast that does not parse, and carries on', async () => {
    const out = await repl([':ast nope +', '1 + 1']);
    assert.match(out, /error\[PA\d+\]/, out);
    assert.match(out, /\n?2/, out);
  });

  it('asks for an expression when :ast is given none', async () => {
    assert.match(await repl([':ast']), /usage: :ast/);
  });

  it('rejects an unknown command without dying', async () => {
    const out = await repl([':nonsense', '1 + 1']);
    assert.match(out, /unknown command/);
    assert.match(out, /2/);
  });
});
