#!/usr/bin/env node
/**
 * The `lumen` command line interface.
 *
 * Usage is deliberately small — a language is easier to trust when its tool
 * does a few things and explains itself.
 */

import { runFile } from './commands/run.js';
import { dumpAst, dumpTokens } from './commands/inspect.js';
import { startRepl } from './commands/repl.js';
import { runTests } from './commands/test.js';
import { existsSync } from 'node:fs';

import { suggest } from '@lumen-lang/core';
import { setServeMode } from '@lumen-lang/stdlib';
import { VERSION, reportError } from './support.js';

const USAGE = `Lumen ${VERSION} — one language for scripts, servers, websites, and AI.

Usage
  lumen <file.lm>          run a program
  lumen run <file.lm>      run a program
  lumen serve <file.lm>    run a program that starts a web server
  lumen repl               start an interactive session
  lumen test [path]        run every *_test.lm under path (default: .)
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

function usageError(message: string): never {
  process.stderr.write('lumen: ' + message + '\n\n' + USAGE);
  process.exit(2);
}

/** Every word `lumen` accepts in the first position. */
const COMMANDS = [
  'run', 'serve', 'repl', 'test', 'tokens', 'ast', 'help', 'version',
] as const;

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
      await startRepl();
      return;

    case 'run':
    case 'serve': {
      const file = fileArg(first, rest);
      // The two commands run the same program; the difference is what the
      // program is told. `isServer()` from std/web reports which was used, so
      // one file can serve its routes and also print them for inspection.
      setServeMode(first === 'serve');
      await runFile(file);
      return;
    }

    case 'test':
      await runTests(rest[0] ?? '.');
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
      await runFile(first);
    }
  }
}

await main(process.argv.slice(2)).catch(reportError);
