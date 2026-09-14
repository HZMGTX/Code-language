/**
 * `std/process` — running another program.
 *
 * **There is no shell.** A command is a name and a list of arguments, never one
 * string to be taken apart by `/bin/sh`. That is the whole security design, and
 * it is a design rather than a precaution: with a shell, every call has to
 * decide how to quote whatever it interpolates, and the one that forgets turns
 * a file called `; rm -rf ~` into a disaster. With an argument list there is
 * nothing to quote, because nothing is ever parsed.
 *
 * What is given up with it is worth naming: no `*` expansion (use
 * `std/fs.walk`), no `|` between programs (run them in turn and pass `input`),
 * no `>` redirection (take `out` and use `std/fs.write`), and no `&&`. Each of
 * those is a line of Lumen instead, which is a fair price for never having to
 * think about quoting again — and every one of them is clearer written out.
 *
 * **Nothing raises.** A command that does not exist, a command that fails, and
 * a command that takes too long are all `Result`s, because "did this program
 * work" is the question the caller is asking and a non-zero exit is an answer
 * rather than an accident. `status` is in the result; `Err` is reserved for not
 * having run at all.
 */

import { spawn } from 'node:child_process';
import { constants, promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';

import { bool, list, map, num, str, type Value } from '@lumen-lang/core';
import {
  Err,
  None,
  Ok,
  Some,
  arg,
  expectInt,
  expectList,
  expectStr,
  fn,
  moduleOf,
  withDocs,
  withSignatures,
} from './support.js';

interface Finished {
  readonly status: number;
  readonly out: string;
  readonly err: string;
  readonly timedOut: boolean;
}

/**
 * Run a program and collect everything it said.
 *
 * `timeout` of zero waits forever, which is what you want for a build and
 * exactly what you do not want for something a stranger's input chose. A
 * process that runs out of time is killed and reported as having timed out
 * rather than as having failed, because the two want different handling.
 */
async function execute(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
  timeout: number,
): Promise<Finished | string> {
  return await new Promise<Finished | string>((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], {
        // Never a shell. See the header: this is the whole point of the module.
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(cwd === '' ? {} : { cwd }),
      });
    } catch (error) {
      resolve('cannot run `' + command + '`: ' + String(error));
      return;
    }

    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;

    const timer =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeout)
        : undefined;

    const finish = (value: Finished | string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };

    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));

    child.on('error', (error: NodeJS.ErrnoException) => {
      // `ENOENT` here means the program is not on PATH, which is the commonest
      // failure by a distance and deserves a sentence rather than an errno.
      finish(
        error.code === 'ENOENT'
          ? 'cannot run `' + command + '`: no such program'
          : error.code === 'EACCES'
            ? 'cannot run `' + command + '`: permission denied'
            : 'cannot run `' + command + '`: ' + error.message,
      );
    });

    child.on('close', (code, signal) => {
      finish({
        // A process killed by a signal has no exit code. Reporting it as the
        // shell convention does — 128 plus the signal number — keeps `status`
        // a number that is non-zero exactly when something went wrong.
        status: code ?? (signal === null ? 1 : 128 + signalNumber(signal)),
        out,
        err,
        timedOut,
      });
    });

    if (input !== '') child.stdin?.write(input);
    child.stdin?.end();
  });
}

/** The number behind a signal name, for the `128 + n` convention. */
function signalNumber(signal: NodeJS.Signals): number {
  const known: Record<string, number> = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGSEGV: 11, SIGPIPE: 13,
  };
  return known[signal] ?? 0;
}

const SIGNATURES: Readonly<Record<string, string>> = {
  run: '(command: Str, args: List<Str> = [], input: Str = "", cwd: Str = "", timeout: Num = 0) -> Result',
  which: '(command: Str) -> Option',
  isWindows: '() -> Bool',
};

export function stdProcess(): Map<string, Value> {
  return withSignatures(
    withDocs(
      moduleOf(
        /**
         * Run a program and wait for it.
         *
         * `Ok({status, out, err, timedOut})` when it ran, whatever it then did;
         * `Err(why)` only when it could not be started at all. A non-zero
         * status is an answer, not an error — `grep` says "no match" that way,
         * and a library that treated it as a failure would make the commonest
         * use of the commonest tool look like a crash.
         */
        fn(
          'run',
          [
            'command',
            { name: 'args', defaultValue: list([]) },
            { name: 'input', defaultValue: str('') },
            { name: 'cwd', defaultValue: str('') },
            { name: 'timeout', defaultValue: num(0) },
          ],
          async (a, c) => {
            const command = expectStr(arg(a, 0), c, 'run(command)');
            const given = expectList(arg(a, 1), c, 'run(args)');
            const args = given.items.map((item, i) =>
              expectStr(item, c, 'run argument ' + String(i + 1)),
            );
            const result = await execute(
              command,
              args,
              expectStr(arg(a, 2), c, 'run(input)'),
              expectStr(arg(a, 3), c, 'run(cwd)'),
              expectInt(arg(a, 4), c, 'run(timeout)'),
            );
            if (typeof result === 'string') return Err(str(result));
            return Ok(
              map(
                new Map<string, Value>([
                  ['status', num(result.status)],
                  ['out', str(result.out)],
                  ['err', str(result.err)],
                  ['ok', bool(result.status === 0 && !result.timedOut)],
                  ['timedOut', bool(result.timedOut)],
                ]),
              ),
            );
          },
        ),

        /**
         * Where a program is, if it is anywhere.
         *
         * `Some(path)` or `None`, so a script can check for a tool and say
         * something useful instead of failing on the line that uses it. It
         * looks along `PATH` itself rather than shelling out to `which`, which
         * would need the shell this module does not have — and would not exist
         * on Windows anyway.
         */
        fn('which', ['command'], async (a, c) => {
          const command = expectStr(arg(a, 0), c, 'which(command)');
          const found = await locate(command);
          return found === undefined ? None : Some(str(found));
        }),

        /**
         * Whether this is Windows.
         *
         * The one platform question a script running programs genuinely has to
         * ask, because the programs themselves are named differently. Anything
         * finer belongs to the caller, not here.
         */
        fn('isWindows', [], () => bool(process.platform === 'win32')),
      ),
      {
        run: 'Run a program and wait. Ok({status, out, err, ok, timedOut}) if it ran at all.',
        which: 'Where a program is on PATH. Some(path), or None if it is not there.',
        isWindows: 'True on Windows, where programs are named differently.',
      },
    ),
    SIGNATURES,
  );
}

/** Walk `PATH` for an executable, the way the loader would. */
async function locate(command: string): Promise<string | undefined> {
  // An explicit path is not searched for; it either is or is not there.
  if (command.includes('/') || command.includes('\\')) {
    return (await runnable(command)) ? command : undefined;
  }

  const paths = (process.env['PATH'] ?? '').split(process.platform === 'win32' ? ';' : ':');
  // On Windows a command has no extension of its own and the loader tries
  // several; `node` is `node.exe`, and looking only for `node` finds nothing.
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : [''];

  for (const directory of paths) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = nodePath.join(directory, command + extension);
      if (await runnable(candidate)) return candidate;
    }
  }
  return undefined;
}

async function runnable(candidate: string): Promise<boolean> {
  try {
    await fsp.access(candidate, constants.X_OK);
    return (await fsp.stat(candidate)).isFile();
  } catch {
    return false;
  }
}
