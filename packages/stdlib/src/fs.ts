/**
 * `std/fs` — file access.
 *
 * Every operation that can fail returns a Result, so a missing file is a value
 * to handle rather than an exception to remember.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { NIL, bool, list, str, type Value } from '@lumen-lang/core';
import { Err, Ok, arg, expectStr, fn, moduleOf } from './support.js';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stdFs(): Map<string, Value> {
  return moduleOf(
    fn('read', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'read(path)');
      try {
        return Ok(str(await fsp.readFile(target, 'utf8')));
      } catch (error) {
        return Err(str(messageOf(error)));
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
        return Err(str(messageOf(error)));
      }
    }),

    fn('append', ['path', 'contents'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'append(path)');
      const contents = expectStr(arg(a, 1), c, 'append(contents)');
      try {
        await fsp.appendFile(target, contents, 'utf8');
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error)));
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
        return Err(str(messageOf(error)));
      }
    }),

    fn('remove', ['path'], async (a, c) => {
      const target = expectStr(arg(a, 0), c, 'remove(path)');
      try {
        await fsp.rm(target, { recursive: true, force: true });
        return Ok(NIL);
      } catch (error) {
        return Err(str(messageOf(error)));
      }
    }),
  );
}
