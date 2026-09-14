/**
 * `std/fs` — file access.
 *
 * Every operation that can fail returns a Result, so a missing file is a value
 * to handle rather than an exception to remember.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { NIL, bool, list, str, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectStr, fn, moduleOf, withSignatures } from './support.js';

/**
 * Turn a Node filesystem error into a message Lumen owns.
 *
 * Node's own text — `ENOENT: no such file or directory, open '/x'` — names an
 * errno, a syscall and a quoting style that differ between platforms and
 * versions. Letting that through would make the same Lumen program produce
 * different output on Windows, and would pin this library's error strings to
 * whatever Node prints next year. The `code` is stable; the sentence is ours.
 */
function messageOf(error: unknown, action: string, target: string): string {
  const code =
    error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
  const subject = action + ' `' + target + '`';
  switch (code) {
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
};

export function stdFs(): Map<string, Value> {
  return withSignatures(
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
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, contents, 'utf8');
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error, 'write to', target)));
      }
    }),

    fn('append', ['path', 'contents'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'append(path)');
      const contents = expectStr(arg(a, 1), c, 'append(contents)');
      try {
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
    ),
    SIGNATURES,
  );
}
