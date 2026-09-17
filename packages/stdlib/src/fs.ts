/**
 * `std/fs` — file access.
 *
 * Every operation that can fail returns a Result, so a missing file is a value
 * to handle rather than an exception to remember.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { NIL, bool, list, map, num, str, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectStr, fn, moduleOf, withDocs, withSignatures } from './support.js';

/**
 * Turn a Node filesystem error into a message Lumen owns.
 *
 * Node's own text — `ENOENT: no such file or directory, open '/x'` — names an
 * errno, a syscall and a quoting style that differ between platforms and
 * versions. Letting that through would make the same Lumen program produce
 * different output on Windows, and would pin this library's error strings to
 * whatever Node prints next year. The `code` is stable; the sentence is ours.
 */
/**
 * Create a path's parent directories, without letting the attempt become the
 * answer.
 *
 * `mkdir -p` fails with `EEXIST` when a path component is a *file* rather than
 * a directory, and that errno was reported verbatim — so
 * `write("notadir/child.txt", "x")` said `EEXIST`, which is not merely cryptic
 * but the opposite of the truth: nothing exists that should not, a path segment
 * is a file. `append` and `makeDir` said "a path segment is not a directory"
 * for the identical path, because they reach the real operation and get
 * `ENOTDIR` from it.
 *
 * So the parent is created on a best-effort basis and any failure is dropped.
 * Whatever is really wrong then comes from the write itself, with the errno
 * that describes it — which is how the three functions came to disagree about
 * one path in the first place.
 */
async function makeParent(target: string): Promise<void> {
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
  } catch {
    // Deliberately ignored; see above.
  }
}

function messageOf(error: unknown, action: string, target: string, other?: string): string {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  // Both paths when there are two. `rename(file, dir)` used to say "cannot
  // rename `note.txt`: it is a directory" — and `note.txt` is not a directory,
  // `archive` is. A sentence naming the wrong path sends the reader to look at
  // the wrong thing, which is worse than one naming neither.
  const subject =
    other === undefined
      ? action + ' `' + target + '`'
      : action + ' `' + target + '` to `' + other + '`';
  switch (code) {
    // Node's own `cp` codes. `rename` already produced sentences for these
    // three mistakes and `copy` leaked the identifier, so the same mistake read
    // completely differently depending on which function you reached for.
    case 'ERR_FS_CP_NON_DIR_TO_DIR':
      return 'cannot ' + subject + ': the destination is a directory';
    case 'ERR_FS_CP_DIR_TO_NON_DIR':
      return 'cannot ' + subject + ': the destination is not a directory';
    case 'ERR_FS_CP_EINVAL':
      return 'cannot ' + subject + ': the source and the destination are the same';

    case 'ERR_FS_CP_SOCKET':
    case 'ERR_FS_CP_FIFO_PIPE':
    case 'ERR_FS_CP_UNKNOWN':
      return 'cannot ' + subject + ': the source is not a file or a directory';
    case 'ERR_FS_EISDIR':
      return 'cannot ' + subject + ': it is a directory';
    // A move across filesystems. `rename` cannot do it and nothing about the
    // bare errno says what to do instead.
    case 'EXDEV':
      return (
        'cannot ' + subject +
        ': they are on different filesystems — copy and then remove instead'
      );
    case 'ENOENT':
      return 'cannot ' + subject + ': no such file or directory';
    case 'EACCES':
    case 'EPERM':
      return 'cannot ' + subject + ': permission denied';
    case 'EISDIR':
      return 'cannot ' + subject + ': it is a directory';
    case 'ENOTDIR':
      return 'cannot ' + subject + ': a path segment is not a directory';
    case 'ENOTEMPTY':
      return 'cannot ' + subject + ': the directory is not empty';
    case 'EMFILE':
    case 'ENFILE':
      return 'cannot ' + subject + ': too many open files';
    case 'ENOSPC':
      return 'cannot ' + subject + ': no space left on the device';
    case 'EROFS':
      return 'cannot ' + subject + ': the filesystem is read-only';
    case 'ELOOP':
      return 'cannot ' + subject + ': too many symbolic links';
    case 'ENAMETOOLONG':
      return 'cannot ' + subject + ': the path is too long';
    default:
      // Something we have no sentence for. Keep the code, which is stable and
      // searchable, rather than inventing a vague message that hides it.
      return 'cannot ' + subject + (code === '' ? '' : ': ' + code);
  }
}

/**
 * Every one of these can fail — a file may not be there, a directory may not be
 * writable — so every one answers a `Result` rather than raising. `exists` is
 * the exception: asking whether something is there cannot itself fail.
 */
const SIGNATURES: Readonly<Record<string, string>> = {
  read: '(path: Str) -> Result',
  write: '(path: Str, contents: Str) -> Result',
  append: '(path: Str, contents: Str) -> Result',
  exists: '(path: Str) -> Bool',
  list: '(path: Str) -> Result',
  remove: '(path: Str) -> Result',
  stat: '(path: Str) -> Result',
  copy: '(source: Str, destination: Str) -> Result',
  rename: '(source: Str, destination: Str) -> Result',
  makeDir: '(path: Str) -> Result',
  isDir: '(path: Str) -> Bool',
  isFile: '(path: Str) -> Bool',
  walk: '(path: Str) -> Result',
};

/** One line each, for `help()` and the generated reference. */
const DOCS: Readonly<Record<string, string>> = {
  read: 'The whole of a file as text: `Ok(text)`, or `Err(message)`.',
  write: "Replace a file's contents, creating it and any parent directory it needs.",
  append: 'Add to the end of a file, creating it and any parent directory it needs.',
  exists: 'Whether anything is at a path.',
  list: 'The names directly inside a directory, sorted.',
  remove: 'Delete a file or a whole directory; a path that is already gone is not an error.',
  stat: 'What is known about a path: a Map of `size`, `isDir`, `isFile` and `modified`.',
  isDir: 'Whether a path is a directory.',
  isFile: 'Whether a path is a file.',
  copy: 'Copy a file or a whole directory, creating any parent directory the destination needs.',
  rename: 'Move or rename, creating any parent directory the destination needs.',
  makeDir: 'Create a directory and any parent it needs; one that already exists is fine.',
  walk: 'Every file under a directory, recursively, as sorted paths relative to it.',
};

export function stdFs(): Map<string, Value> {
  return withSignatures(
    withDocs(
    moduleOf(
    fn('read', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'read(path)');
      try {
        return Ok(str(await fsp.readFile(target, 'utf8')));
      } catch (error) {
        return Err(str(messageOf(error, 'read', target)));
      }
    }),

    fn('write', ['path', 'contents'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'write(path)');
      const contents = expectStr(arg(a, 1), c, 'write(contents)');
      try {
        await makeParent(target);
        await fsp.writeFile(target, contents, 'utf8');
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'write to', target)));
      }
    }),

    /** Add to the end, creating the file and its parent directories if needed. */
    fn('append', ['path', 'contents'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'append(path)');
      const contents = expectStr(arg(a, 1), c, 'append(contents)');
      try {
        // Like `write`, `copy` and `rename`. This was the one writing function
        // that did not, so `write(p, line)` worked and `append(p, line)` to the
        // same path did not — a split with no reason behind it, and the first
        // line of a log file is exactly where it bit.
        await makeParent(target);
        await fsp.appendFile(target, contents, 'utf8');
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'append to', target)));
      }
    }),

    fn('exists', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'exists(path)');
      try {
        await fsp.access(target);
        return bool(true);
      } catch {
        return bool(false);
      }
    }),

    fn('list', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'list(path)');
      try {
        const names = await fsp.readdir(target);
        return Ok(list(names.sort().map((name) => str(name))));
      } catch (error) {
        return Err(str(messageOf(error, 'list', target)));
      }
    }),

    fn('remove', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'remove(path)');
      try {
        await fsp.rm(target, { recursive: true, force: true });
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'remove', target)));
      }
    }),

    /**
     * What is known about a path without reading it.
     *
     * `size` in bytes, `isDir` and `isFile`, and `modified` as a Lumen instant
     * — milliseconds since the epoch, the same thing `std/time` takes, so
     * `stat(p).modified.iso()` works with no conversion. Node reports times as
     * `Date` objects and sizes as numbers; only one of those is a Lumen value,
     * and mixing the two units is how a program compares a timestamp against a
     * duration and gets a plausible wrong answer.
     */
    fn('stat', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'stat(path)');
      try {
        const found = await fsp.stat(target);
        return Ok(
          map(
            new Map<string, Value>([
              ['size', num(found.size)],
              ['isDir', bool(found.isDirectory())],
              ['isFile', bool(found.isFile())],
              ['modified', num(found.mtimeMs)],
            ]),
          ),
        );
      } catch (error) {
        return Err(str(messageOf(error, 'read', target)));
      }
    }),

    /**
     * Whether a path is a directory, and whether it is a file.
     *
     * `exists` answers neither — a program that writes to a path because it
     * "exists" and finds a directory there has learned the wrong thing — and
     * asking cannot itself fail, so these are Bools like `exists` rather than
     * Results like `stat`.
     */
    fn('isDir', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'isDir(path)');
      try {
        return bool((await fsp.stat(target)).isDirectory());
      } catch {
        return bool(false);
      }
    }),

    fn('isFile', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'isFile(path)');
      try {
        return bool((await fsp.stat(target)).isFile());
      } catch {
        return bool(false);
      }
    }),

    /**
     * Copy a file or a whole directory.
     *
     * Parent directories are created, as `write` already does: a copy that
     * fails because the destination's folder is missing is a copy that needs a
     * `makeDir` on the line above it, every time, and nobody enjoys writing it.
     */
    fn('copy', ['source', 'destination'], async (a, c) => {
      const source = expectStr(arg(a, 0), c, 'copy(source)');
      const destination = expectStr(arg(a, 1), c, 'copy(destination)');
      try {
        await makeParent(destination);
        // `verbatimSymlinks` keeps a link as it was written. Without it Node
        // resolves a relative link against the *source* and stores the absolute
        // result, so copying a tree containing `latest.txt -> report.txt` gave a
        // backup whose `latest.txt` pointed into the original — the copy was not
        // a copy, and writing through it edited what it was a backup of.
        await fsp.cp(source, destination, { recursive: true, verbatimSymlinks: true });
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'copy', source, destination)));
      }
    }),

    /** Move or rename. Parent directories are created, as with `copy`. */
    fn('rename', ['source', 'destination'], async (a, c) => {
      const source = expectStr(arg(a, 0), c, 'rename(source)');
      const destination = expectStr(arg(a, 1), c, 'rename(destination)');
      try {
        await makeParent(destination);
        await fsp.rename(source, destination);
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'rename', source, destination)));
      }
    }),

    /**
     * Create a directory, and any parent it needs.
     *
     * Succeeds when it is already there, because the thing a caller wants is
     * "make sure this exists" and an error for the case where it does means
     * every caller writes the same `if exists` around it.
     */
    fn('makeDir', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'makeDir(path)');
      try {
        await fsp.mkdir(target, { recursive: true });
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'create', target)));
      }
    }),

    /**
     * Every file under a directory, recursively, as paths relative to it.
     *
     * Sorted, so two runs over the same tree say the same thing — the same
     * reason `list` sorts. Directories are not listed themselves, only the
     * files in them, which is what a program walking a tree nearly always
     * wants; `list` is there for the other case.
     *
     * Symbolic links are not followed. A tree containing a link to its own
     * parent is not unusual, and walking it forever is not a useful answer.
     */
    fn('walk', ['path'], async (a, c) => {
      const root = expectStr(arg(a, 0), c, 'walk(path)');
      const found: string[] = [];
      const descend = async (at: string, prefix: string): Promise<void> => {
        const entries = await fsp.readdir(at, { withFileTypes: true });
        for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
          const relative = prefix === '' ? entry.name : prefix + '/' + entry.name;
          if (entry.isDirectory()) await descend(path.join(at, entry.name), relative);
          else if (entry.isFile()) found.push(relative);
        }
      };
      try {
        await descend(root, '');
        return Ok(list(found.sort().map((name) => str(name))));
      } catch (error) {
        return Err(str(messageOf(error, 'walk', root)));
      }
    }),
    ),
    DOCS,
    ),
    SIGNATURES,
  );
}
