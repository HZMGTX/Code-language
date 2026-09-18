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

  it('keeps the whitespace at the end of a multi-line string’s first line', () => {
    // The line a multi-line string opens on ends *inside* the string, so what
    // looks like trailing whitespace there is the string's value. `trim()` was
    // applied to it — only the continuation lines were marked verbatim — and
    // deleted it, so `"a   ⏎b".len()` went from 6 to 3 on a file that had been
    // formatted. The formatter's one promise is that it changes whitespace and
    // not meaning; this is the one way it was breaking it.
    for (const tail of ['   ', ' ', '\t', '  \t ']) {
      const source = 'fn f() {\nlet s = "a' + tail + '\nb"\nprint(s)\n}\n';
      const out = format(source, 'f.lm');
      assert.ok(out.includes('"a' + tail + '\nb"'), JSON.stringify(tail) + ' was eaten:\n' + JSON.stringify(out));
      assert.equal(tokenKey(out), tokenKey(source), 'token stream changed for ' + JSON.stringify(tail));
    }
    // The indentation of such a line is still rewritten: that is what fmt is for.
    assert.equal(format('fn f() {\n      let s = "a  \nb"\n}\n', 'f.lm'), 'fn f() {\n  let s = "a  \nb"\n}\n');
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

/**
 * Formatting is a fixed point, checked exhaustively rather than at random.
 *
 * Invariant 3 was already asserted above, inside the mangling test — and it
 * passed while `format` was not idempotent at all, because `mangle` never
 * produced the one input that breaks it: a line indented to *exactly* the
 * column where its enclosing bracket's first element starts.
 *
 *     let m = [
 *             [1,        ← 8 spaces
 *              2],       ← 9 spaces, level with the `1`
 *     ]
 *
 * Alignment is detected against the input column and emitted at the output
 * column, so the first pass moved `2],` from column 9 to column 3 — at which
 * point it was no longer *past* its floor of 4, a `>` in the alignment test
 * stopped calling it alignment, and the second pass pulled it out to the floor.
 * `lumen fmt` followed by `lumen fmt --check` exited 1, which in a pre-commit
 * hook is a loop.
 *
 * Random mangling is the wrong instrument for that: the interesting column is
 * one specific number out of a dozen, and it has to coincide with a bracket on
 * another line. So this walks every combination instead. It is cheap — `format`
 * is a pure function over a handful of lines — and it is the shape of test that
 * would have caught this on the day the alignment rule was written.
 */
describe('formatting is a fixed point, for every indentation', () => {
  /**
   * Templates whose inner lines can be indented anywhere.
   *
   * Each `%` is a line whose leading whitespace is varied over every width
   * below; the others are fixed. Nested brackets are the point — alignment is a
   * relationship between a line and a bracket opened on an earlier one.
   */
  const TEMPLATES: readonly (readonly string[])[] = [
    ['let m = [', '%[1,', '%2],', ']', 'print(m)'],
    ['let m = [', '%[1,', '%2],', '%[3]', ']', 'print(m)'],
    ['print(sum(', '%[1,', '%2]', '))'],
    ['let m = {', '%a: [1,', '%2],', '%b: 3,', '}', 'print(m)'],
    ['let n = xs', '%.filter(fn(x) { x > 1 })', '%.len()', 'print(n)'],
    ['fn f() {', '%let m = [', '%[1,', '%2],', '%]', '}'],
  ];

  /** Every width worth trying: zero through past the widest bracket column. */
  const WIDTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12];

  for (const [index, template] of TEMPLATES.entries()) {
    it('template ' + String(index + 1) + ': every indentation reaches a fixed point', () => {
      const varying = template.filter((line) => line.startsWith('%')).length;
      let checked = 0;
      const failures: string[] = [];

      // Every combination of widths for the varying lines.
      const total = WIDTHS.length ** varying;
      for (let n = 0; n < total; n += 1) {
        let rest = n;
        const widths: number[] = [];
        for (let v = 0; v < varying; v += 1) {
          widths.push(WIDTHS[rest % WIDTHS.length] as number);
          rest = Math.floor(rest / WIDTHS.length);
        }

        let next = 0;
        const source =
          template
            .map((line) =>
              line.startsWith('%')
                ? ' '.repeat(widths[next++] as number) + line.slice(1)
                : line,
            )
            .join('\n') + '\n';

        const once = format(source, 'fixed.lm');
        const twice = format(once, 'fixed.lm');
        checked += 1;
        if (twice !== once && failures.length < 3) {
          failures.push(
            'widths ' + JSON.stringify(widths) + '\n--- input ---\n' + source +
              '--- once ---\n' + once + '--- twice ---\n' + twice,
          );
        }
      }

      assert.deepEqual(failures, []);
      assert.equal(checked, total);
    });
  }

  it('keeps the token stream while doing it', () => {
    // The fixed point is worth nothing if reaching it changed the program. This
    // is invariant 2 over the same exhaustive inputs, on the template with the
    // most brackets.
    const template = ['fn f() {', '%let m = [', '%[1,', '%2],', '%]', '}'];
    for (const a of [0, 3, 8, 9]) {
      for (const b of [0, 2, 9, 11]) {
        for (const c of [0, 3, 10, 12]) {
          for (const d of [0, 2, 8]) {
            const widths = [a, b, c, d];
            let next = 0;
            const source =
              template
                .map((line) =>
                  line.startsWith('%') ? ' '.repeat(widths[next++] as number) + line.slice(1) : line,
                )
                .join('\n') + '\n';
            const once = format(source, 'fixed.lm');
            assert.equal(tokenKey(once), tokenKey(source), 'token stream changed for ' + JSON.stringify(widths));
          }
        }
      }
    }
  });
});
