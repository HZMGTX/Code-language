#!/usr/bin/env node
/**
 * The `lumen` command line interface.
 *
 * Usage is deliberately small — a language is easier to trust when its tool
 * does a few things and explains itself.
 */

import { checkFiles } from './commands/check.js';
import { formatFiles } from './commands/fmt.js';
import { runFile } from './commands/run.js';
import { dumpAst, dumpTokens } from './commands/inspect.js';
import { startLanguageServer } from './commands/lsp.js';
import { startRepl } from './commands/repl.js';
import { runTests } from './commands/test.js';
import { existsSync } from 'node:fs';

import { suggest } from '@lumen-lang/core';
import { setServeMode } from '@lumen-lang/stdlib';
import { VERSION, reportError, setProgramArgs } from './support.js';

const USAGE = `Lumen ${VERSION} — one language for scripts, servers, websites, and AI.

Usage
  lumen <file.lm>          run a program
  lumen run <file.lm>      run a program
  lumen serve <file.lm>    run a program that starts a web server
  lumen repl               start an interactive session
  lumen lsp                speak the Language Server Protocol (for editors)
  lumen check [path...]    check every .lm under each path without running it
  lumen fmt [path...]      normalise indentation in place (--check to only ask)
  lumen test [path...]     run every *_test.lm under each path (default: .)
  lumen tokens <file.lm>   show the token stream
  lumen ast <file.lm>      show the parsed syntax tree

Options
  -h, --help               show this message
  -v, --version            show the version

Environment
  ANTHROPIC_API_KEY        used by std/ai
  OPENAI_API_KEY           used by std/ai
  LUMEN_AI_PROVIDER        anthropic | openai | mock  (default: auto-detect)
  NO_COLOR                 disable coloured diagnostics
`;

/**
 * A reader that stops early is not an error.
 *
 * `lumen run count.lm | head -2` closes the pipe once it has its two lines,
 * and the next `print` raises `EPIPE` on a stream with no `error` listener —
 * which Node rethrows, so an ordinary shell idiom ended in twenty-five lines
 * of V8 stack trace naming files inside `dist/`. `head`, `less` quit early and
 * `grep -q` all do this; the conventional answer is to stop, quietly.
 */
function quitWhenTheReaderLeaves(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0);
      throw error;
    });
  }
}

function usageError(message: string): never {
  process.stderr.write('lumen: ' + message + '\n\n' + USAGE);
  process.exit(2);
}

/** The paths a command was given, or the current directory when it was given none. */
function paths(rest: readonly string[]): readonly string[] {
  const given = rest.filter((a) => !a.startsWith('-'));
  return given.length === 0 ? ['.'] : given;
}

/** Every word `lumen` accepts in the first position. */
const COMMANDS = [
  'run', 'serve', 'repl', 'lsp', 'check', 'fmt', 'test', 'tokens', 'ast', 'help', 'version',
] as const;

/**
 * Refuse an option a command does not have.
 *
 * `fileArg` below has done this for `run` and `serve` since the day somebody
 * typed `lumen run --colour app.lm` and was told the file `--colour` could not
 * be read. Four commands never got the same treatment, and two of them made
 * exactly that mistake in a different shape:
 *
 *     lumen check --colour   →   no `.lm` files found under ./--colour
 *
 * A path is where these commands put anything that is not an option, so a
 * mistyped flag became a directory nobody meant. `repl` and `lsp` took no
 * arguments at all and silently ignored whatever they were given, which is the
 * quieter version of the same thing.
 */
function rejectOptions(command: string, rest: readonly string[], allowed: readonly string[] = []): void {
  for (const arg of rest) {
    if (!arg.startsWith('-') || allowed.includes(arg)) continue;
    usageError('unknown option `' + arg + '` for `' + command + '`');
  }
}

/**
 * The file argument for a command, rejecting options.
 *
 * Without this, `lumen run --colour app.lm` took `--colour` for the filename
 * and reported that it could not read it, which sends the reader looking for a
 * file that was never meant to exist.
 */
function fileArg(command: string, rest: readonly string[]): string {
  const file = rest[0];
  if (file === undefined) usageError('`' + command + '` needs a file');
  if (file.startsWith('-')) usageError('unknown option `' + file + '`');
  return file;
}

async function main(argv: readonly string[]): Promise<void> {
  const [first, ...rest] = argv;

  if (first === undefined) {
    await startRepl();
    return;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    process.stdout.write(VERSION + '\n');
    return;
  }

  switch (first) {
    case 'repl':
      rejectOptions('repl', rest);
      await startRepl();
      return;

    case 'lsp':
      rejectOptions('lsp', rest);
      await startLanguageServer();
      return;

    case 'run':
    case 'serve': {
      const file = fileArg(first, rest);
      // The two commands run the same program; the difference is what the
      // program is told. `isServer()` from std/web reports which was used, so
      // one file can serve its routes and also print them for inspection.
      setServeMode(first === 'serve');
      // Everything after the filename is the program's, not ours.
      setProgramArgs(rest.slice(1));
      await runFile(file);
      return;
    }

    // Every path, not the first one. `lumen check src/*.lm` is what a shell
    // hands over and what a person means, and taking `rest[0]` dropped the
    // rest in silence: `lumen check good.lm broken.lm` said "no problems" and
    // exited 0 without ever opening the second file — a false clean bill of
    // health from the command the README sends people to for a pre-commit hook
    // and a CI.
    case 'check':
      rejectOptions('check', rest);
      await checkFiles(paths(rest));
      return;

    case 'fmt': {
      // `--check` may come before or after the path: both orders are things
      // people type, and rejecting one of them teaches nothing.
      rejectOptions('fmt', rest, ['--check']);
      await formatFiles(paths(rest), rest.includes('--check'));
      return;
    }

    case 'test':
      rejectOptions('test', rest);
      await runTests(paths(rest));
      return;

    case 'tokens':
      await dumpTokens(fileArg('tokens', rest));
      return;

    case 'ast':
      await dumpAst(fileArg('ast', rest));
      return;

    default: {
      // `lumen app.lm` is shorthand for `lumen run app.lm`.
      if (first.startsWith('-')) usageError('unknown option `' + first + '`');

      // A bare word that names no file is far more likely a mistyped command
      // than a file someone meant to create. Saying "cannot read `tets`" sends
      // the reader hunting for a missing file instead of their own typo.
      const looksLikeAPath =
        first.endsWith('.lm') || first.includes('/') || first.includes('\\') || first === '.';
      if (!looksLikeAPath && !existsSync(first)) {
        const near = suggest(first, [...COMMANDS]);
        usageError(
          'unknown command `' + first + '`' + (near === undefined ? '' : ' — did you mean `' + near + '`?'),
        );
      }
      // `lumen app.lm a b` — the filename was the first word, so the
      // program's arguments are everything after it. One word less than
      // `lumen run app.lm a b`, which is the whole reason this is set here
      // rather than counted from `process.argv`.
      setProgramArgs(rest);
      await runFile(first);
    }
  }
}

quitWhenTheReaderLeaves();
await main(process.argv.slice(2)).catch(reportError);
