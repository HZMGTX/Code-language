/**
 * `lumen fmt` tests.
 *
 * The first half is the part that matters most: three invariants, checked
 * against **every Lumen file in the repository**. A formatter is a tool that
 * rewrites your source, so the interesting question is never "does it produce
 * nice output" but "can it damage anything":
 *
 *   1. only whitespace changes — no character of code is added or lost
 *   2. the token stream is identical — the program means exactly what it meant
 *   3. formatting twice is formatting once — the output is a fixed point
 *
 * Invariant 2 is the strong one. It is checked by lexing both texts and
 * comparing kind, text and payload token by token, which catches the one way a
 * whitespace-only edit can still change meaning: whitespace inside a
 * multi-line string is part of its value.
 *
 * The second half pins the individual rules, each with the smallest input that
 * distinguishes it, so a future change that breaks one gets a pointed failure
 * rather than "some file in examples/ changed".
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { format, lex } from '@lumen-lang/core';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every `.lm` file in the repository, from every corner of it. */
async function everyLumenFile(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.lm')) found.push(full);
    }
  };
  await walk(ROOT);
  return found.sort();
}

/**
 * The token stream as a comparable string, payloads included.
 *
 * `undefined` for source that does not lex. Some conformance fixtures are
 * deliberately unlexable — that is what they test — and for those the only
 * promise `fmt` makes is that it hands the file back untouched.
 */
function tokenKey(source: string): string | undefined {
  try {
    return JSON.stringify(
      lex(source, 'k.lm').map((t) => [t.kind, t.text, t.num ?? null, t.str ?? null]),
    );
  } catch {
    return undefined;
  }
}

/** Non-blank lines with their leading and trailing whitespace removed. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n');
}

const files = await everyLumenFile();

describe('fmt — invariants over every file in the repository', () => {
  it('finds the Lumen files', () => {
    assert.ok(files.length >= 100, 'expected at least 100 .lm files, found ' + files.length);
  });

  for (const file of files) {
    const shown = path.relative(ROOT, file);

    it(shown + ' survives formatting intact', async () => {
      const source = await fsp.readFile(file, 'utf8');
      const formatted = format(source, file);
      const before = tokenKey(source);

      if (before === undefined) {
        assert.equal(formatted, source, 'an unlexable file must come back untouched');
        return;
      }
      assert.equal(codeOnly(formatted), codeOnly(source), 'formatting changed more than whitespace');
      assert.equal(tokenKey(formatted), before, 'formatting changed the token stream');
      assert.equal(format(formatted, file), formatted, 'formatting is not idempotent');
    });
  }

  // Every file in the repository is already formatted, which is worth asserting
  // rather than assuming: it means the rules agree with what a person writing
  // Lumen by hand actually does. A rule that disagreed with 125 hand-written
  // files would be a rule about the formatter's taste, not about Lumen.
  for (const file of files) {
    const shown = path.relative(ROOT, file);
    it(shown + ' is already formatted', async () => {
      const source = await fsp.readFile(file, 'utf8');
      assert.equal(format(source, file), source);
    });
  }
});

describe('fmt — the rules', () => {
  const check = (name: string, input: string, expected: string): void => {
    it(name, () => {
      assert.equal(format(input, 'f.lm'), expected);
    });
  };

  check(
    'indents a block body one level',
    'fn f() {\nlet x = 1\n}\n',
    'fn f() {\n  let x = 1\n}\n',
  );

  // `{` ends its line, so there is nothing at column 8 to be lined up with and
  // the indentation is simply wrong.
  check(
    'brings an over-indented block body back',
    'fn f() {\n        let x = 1\n}\n',
    'fn f() {\n  let x = 1\n}\n',
  );

  // Two brackets, one level: what anyone writing this by hand does.
  check(
    'counts lines, not brackets',
    'print(match c {\n1 => "a",\n})\n',
    'print(match c {\n  1 => "a",\n})\n',
  );

  // The case a counter cannot get right: the `}` is not at the start of a line,
  // so knowing how far to come back out needs the opening line's indent.
  check(
    'returns to the opening line’s level when a bracket closes mid-line',
    'let rooms = {\nhall: Room {\nname: "Hall" },\nlibrary: Room { name: "Library" },\n}\n',
    'let rooms = {\n  hall: Room {\n    name: "Hall" },\n  library: Room { name: "Library" },\n}\n',
  );

  check(
    'pulls a line of closers all the way back out',
    'fn f() {\nprint(match c {\n1 => "a",\n})\n}\n',
    'fn f() {\n  print(match c {\n    1 => "a",\n  })\n}\n',
  );

  check(
    'gives a method chain a level of its own',
    'let n = xs\n.filter(f)\n.len()\n',
    'let n = xs\n  .filter(f)\n  .len()\n',
  );

  check('indents a pipeline the same way', 'let n = xs\n|> len()\n', 'let n = xs\n  |> len()\n');

  // The continuation already sits inside the `(`, so bumping it again would put
  // it at two levels where a person writes one.
  check(
    'does not double-indent a continuation already inside a bracket',
    'print(s\n|> len())\n',
    'print(s\n  |> len())\n',
  );

  check('collapses a run of blank lines to one', 'let a = 1\n\n\n\nlet b = 2\n', 'let a = 1\n\nlet b = 2\n');

  check('strips trailing whitespace', 'let a = 1   \n', 'let a = 1\n');

  check('ends the file with exactly one newline', 'let a = 1\n\n\n', 'let a = 1\n');

  check('adds the missing final newline', 'let a = 1', 'let a = 1\n');

  it('leaves a row aligned under its bracket alone', () => {
    // Column 9 is where `[1` starts, so the second row is lined up with the
    // first — a decision somebody made, and not the formatter's to overrule.
    const aligned = 'let a = [[1, 2, 3],\n         [4, 5, 6]]\n';
    assert.equal(format(aligned, 'f.lm'), aligned);
  });

  it('leaves an aligned import list alone', () => {
    // The column to match is where `upper` starts, not where the `{` is: there
    // is a space between them, and it is the element that is being lined up.
    const aligned = 'import { upper, lower,\n         trim } from "std/str"\n';
    assert.equal(format(aligned, 'f.lm'), aligned);
  });

  check(
    'snaps a continuation that lines up with nothing to the floor',
    'let xs = ["a", "b",\n       "c"]\n',
    'let xs = ["a", "b",\n  "c"]\n',
  );

  check(
    'moves an aligned row with the line it aligns to',
    // The opening line is over-indented and comes back four columns, so the row
    // aligned under its `[[` has to come back four too. Leaving it where it was
    // would align it to nothing, and the next run would pull it to the floor —
    // a formatter whose answer depends on how often you ask.
    'fn f() {\n      let a = [[1, 2, 3],\n               [4, 5, 6]]\n}\n',
    'fn f() {\n  let a = [[1, 2, 3],\n           [4, 5, 6]]\n}\n',
  );

  it('leaves aligned match arms alone', () => {
    const arms = [
      'let name = match n {',
      '  x if x % 15 == 0 => "FizzBuzz",',
      '  x if x % 3 == 0  => "Fizz",',
      '  _                => "${n}",',
      '}',
      '',
    ].join('\n');
    assert.equal(format(arms, 'f.lm'), arms);
  });

  it('does not touch the inside of a multi-line string', () => {
    // The indentation here is the string's value. Re-indenting it would be the
    // one way a whitespace-only formatter could change what a program prints.
    const source = 'fn f() {\nprint("one\n  two\n\nthree")\n}\n';
    const out = format(source, 'f.lm');
    assert.ok(out.includes('"one\n  two\n\nthree"'), 'string body changed:\n' + out);
    assert.equal(out, 'fn f() {\n  print("one\n  two\n\nthree")\n}\n');
  });

  it('keeps counting brackets across a multi-line string', () => {
    // `two"))` closes two real brackets on a line that is otherwise verbatim.
    // Missing them would leave everything after it one level too far in.
    const source = 'print(lines("one\ntwo"))\nlet after = 1\n';
    assert.equal(format(source, 'f.lm'), source);
  });

  it('does not touch the inside of a block comment', () => {
    const source = 'fn f() {\n/* one\n     two\n */\nlet x = 1\n}\n';
    const out = format(source, 'f.lm');
    assert.ok(out.includes('/* one\n     two\n */'), 'comment body changed:\n' + out);
  });

  it('indents a line comment like the code around it', () => {
    assert.equal(format('fn f() {\n// why\nlet x = 1\n}\n', 'f.lm'), 'fn f() {\n  // why\n  let x = 1\n}\n');
  });

  it('returns a file that does not lex unchanged', () => {
    // The file whose structure cannot be trusted is exactly the file not to
    // rewrite. An unterminated string would otherwise have its own body
    // re-indented on the way to a parse error the author is about to fix.
    const broken = 'fn f() {\n      let x = "unterminated\n}\n';
    assert.equal(format(broken, 'f.lm'), broken);
  });

  it('handles an empty file', () => {
    assert.equal(format('', 'f.lm'), '\n');
    assert.equal(format('\n\n\n', 'f.lm'), '\n');
  });

  it('survives more closing brackets than opening ones', () => {
    // Unbalanced source still lexes, so format() sees it. It must not throw or
    // produce negative indentation.
    const out = format('let a = 1\n}\n}\n}\nlet b = 2\n', 'f.lm');
    assert.equal(out, 'let a = 1\n}\n}\n}\nlet b = 2\n');
  });

  it('normalises tabs to spaces', () => {
    assert.equal(format('fn f() {\n\tlet x = 1\n}\n', 'f.lm'), 'fn f() {\n  let x = 1\n}\n');
  });
});

/**
 * The invariants again, but on input nobody wrote.
 *
 * Every file in the repository is already formatted, so checking them proves
 * the formatter leaves good code alone — not that it survives bad code. These
 * mangle the indentation of each real file every way a person plausibly could
 * (flush left, a random amount, tabs) and demand the same three guarantees. A
 * fixed seed, so a failure here is a failure anyone can reproduce.
 */
describe('fmt — invariants on mangled input', () => {
  const TRIALS = 10;
  let seed = 20240513;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  const mangle = (source: string): string =>
    source
      .split('\n')
      .map((line) => {
        const body = line.trimStart();
        if (body === '') return line;
        switch (rnd(4)) {
          case 0:
            return body;
          case 1:
            return ' '.repeat(rnd(13)) + body;
          case 2:
            return line;
          default:
            return '\t'.repeat(rnd(3)) + body;
        }
      })
      .join('\n');

  for (const file of files) {
    const shown = path.relative(ROOT, file);
    it('survives ' + String(TRIALS) + ' manglings of ' + shown, async () => {
      const original = await fsp.readFile(file, 'utf8');
      if (tokenKey(original) === undefined) return;

      for (let trial = 0; trial < TRIALS; trial += 1) {
        const mangled = mangle(original);
        const once = format(mangled, file);
        const note = ' (trial ' + String(trial) + ')';

        assert.equal(codeOnly(once), codeOnly(mangled), 'content changed' + note);
        assert.equal(format(once, file), once, 'not idempotent' + note);
        // Mangling can change a multi-line string's value, and then the token
        // streams are legitimately different. Compare only when it did not.
        if (tokenKey(mangled) === tokenKey(original)) {
          assert.equal(tokenKey(once), tokenKey(mangled), 'token stream changed' + note);
        }
      }
    });
  }
});
