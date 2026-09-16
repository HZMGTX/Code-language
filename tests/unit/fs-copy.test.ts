/**
 * `std/fs.copy` and a symlink.
 *
 * A unit test rather than a conformance fixture, because `std/fs` has no way to
 * *make* a symlink — so the tree has to be built from outside the language,
 * the same reason `process.test.ts` is a unit test.
 *
 * The property is the one a backup has to have: **a copy is self-contained.**
 * Node's `cp` resolves a relative symlink against the *source* and stores the
 * absolute result, so copying a tree containing `latest.txt -> report.txt` gave
 * a `backup/latest.txt` pointing at `tree/report.txt` — the original. Writing
 * through the copy's own link then edited what the copy was a backup of, and
 * deleting the original left the backup with a dangling link. Neither is a
 * copy.
 *
 * `verbatimSymlinks` keeps the link as it was written, so the copy's
 * `latest.txt` resolves inside the copy.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runSource } from '../support/harness.js';

describe('std/fs.copy keeps a tree self-contained', () => {
  it('copies a relative symlink as written, not as resolved', async () => {
    const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-copy-'));
    try {
      await fsp.mkdir(path.join(box, 'tree'));
      await fsp.writeFile(path.join(box, 'tree', 'report.txt'), 'original\n', 'utf8');
      // The ordinary arrangement: a stable name pointing at the current file.
      await fsp.symlink('report.txt', path.join(box, 'tree', 'latest.txt'));

      const result = await runSource(
        'import { copy } from "std/fs"\n' +
          `print(copy(${JSON.stringify(path.join(box, 'tree'))}, ${JSON.stringify(path.join(box, 'backup'))}))\n`,
      );
      assert.equal(result.output.trim(), 'Ok(nil)', result.output);

      const link = await fsp.readlink(path.join(box, 'backup', 'latest.txt'));
      assert.equal(link, 'report.txt', 'the copy’s symlink was rewritten to ' + link);

      // The property, rather than the implementation of it: writing through the
      // copy's link must not touch the original.
      await fsp.writeFile(path.join(box, 'backup', 'latest.txt'), 'edited\n', 'utf8');
      assert.equal(await fsp.readFile(path.join(box, 'backup', 'report.txt'), 'utf8'), 'edited\n');
      assert.equal(
        await fsp.readFile(path.join(box, 'tree', 'report.txt'), 'utf8'),
        'original\n',
        'writing into the copy edited the original',
      );

      // And the copy survives the original going away, which a backup must.
      await fsp.rm(path.join(box, 'tree'), { recursive: true, force: true });
      assert.equal(await fsp.readFile(path.join(box, 'backup', 'latest.txt'), 'utf8'), 'edited\n');
    } finally {
      await fsp.rm(box, { recursive: true, force: true });
    }
  });

  it('still copies ordinary files and nested directories', async () => {
    // The guard against fixing the symlink case by breaking everything else.
    const box = await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-copy-'));
    try {
      await fsp.mkdir(path.join(box, 'tree', 'deep'), { recursive: true });
      await fsp.writeFile(path.join(box, 'tree', 'a.txt'), 'A', 'utf8');
      await fsp.writeFile(path.join(box, 'tree', 'deep', 'b.txt'), 'B', 'utf8');

      const result = await runSource(
        'import { copy, read } from "std/fs"\n' +
          `print(copy(${JSON.stringify(path.join(box, 'tree'))}, ${JSON.stringify(path.join(box, 'backup'))}))\n` +
          `print(read(${JSON.stringify(path.join(box, 'backup', 'a.txt'))}))\n` +
          `print(read(${JSON.stringify(path.join(box, 'backup', 'deep', 'b.txt'))}))\n`,
      );
      assert.deepEqual(result.output.trim().split('\n'), ['Ok(nil)', 'Ok("A")', 'Ok("B")']);
    } finally {
      await fsp.rm(box, { recursive: true, force: true });
    }
  });
});
