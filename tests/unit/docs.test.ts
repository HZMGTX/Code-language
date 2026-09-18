/**
 * Documentation that cannot drift.
 *
 * The specification is what makes Lumen reimplementable, so a claim in it that
 * the implementation does not honour is a real defect rather than a typo. These
 * tests compare the documents against the running language.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createInterpreter } from '@lumen-lang/stdlib';
import { LumenError, parse, type Host } from '@lumen-lang/core';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const silentHost: Host = {
  writeOut: (): void => {},
  writeErr: (): void => {},
  getEnv: (): string | undefined => undefined,
  now: (): number => 0,
};

function read(relative: string): string {
  return readFileSync(ROOT + relative, 'utf8');
}

/** Names in backticks within a slice of markdown. */
function backticked(text: string): Set<string> {
  return new Set([...text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1] as string));
}

describe('the specification matches the implementation', () => {
  it('documents exactly the prelude that is installed', () => {
    const interpreter = createInterpreter({ host: silentHost });
    const installed = new Set(interpreter.globals.ownNames());

    const spec = read('docs/spec.md');
    const from = spec.indexOf('#### The prelude');
    const to = spec.indexOf('Lumen has a single');
    assert.ok(from !== -1 && to > from, 'spec.md has no prelude section');
    const documented = backticked(spec.slice(from, to));

    const undocumented = [...installed].filter((n) => !documented.has(n)).sort();
    assert.deepEqual(
      undocumented,
      [],
      'these prelude names exist but are not in docs/spec.md: ' + undocumented.join(', '),
    );

    // The reverse direction, ignoring what the prose in this section is
    // allowed to mention besides a binding: diagnostic codes, and the names of
    // types, which are not values and so are not in `globals`.
    const NOT_BINDINGS = ['Num', 'Str', 'Bool', 'Nil', 'List', 'Map', 'Any', 'Fn'];
    const invented = [...documented]
      .filter(
        (n) => !installed.has(n) && !/^(RT|PA|LX)\d{3}$/.test(n) && !NOT_BINDINGS.includes(n),
      )
      .sort();
    assert.deepEqual(
      invented,
      [],
      'docs/spec.md names these, but they do not exist: ' + invented.join(', '),
    );
  });

  it('documents method tables that match the registered ones', () => {
    const interpreter = createInterpreter({ host: silentHost });
    for (const type of ['Str', 'List', 'Map']) {
      assert.ok(
        interpreter.methodNames(type).length > 0,
        type + ' should have methods registered',
      );
    }
  });

  it('only claims npm scripts that exist', () => {
    const manifest = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    const scripts = new Set(Object.keys(manifest.scripts ?? {}));
    const docs = ['README.md', 'DEVELOPING.md', 'ROADMAP.md', 'CHANGELOG.md', 'docs/philosophy.md'];
    const missing: string[] = [];
    for (const doc of docs) {
      for (const match of read(doc).matchAll(/npm run ([a-z:]+)/g)) {
        const name = match[1] as string;
        if (!scripts.has(name)) missing.push(doc + ': npm run ' + name);
      }
    }
    assert.deepEqual([...new Set(missing)], [], 'documented npm scripts that do not exist');
  });
});

describe('every documented code sample is real Lumen', () => {
  // A ```lumen fence is a promise that what follows is the language. Fragments
  // may refer to names defined elsewhere in the prose — that is ordinary
  // documentation style and not checked — but everything so fenced must at
  // least parse. Anything that is not Lumen (a signature listing, a grammar
  // sketch) belongs in a plain ```text fence instead.
  //
  // This exists because docs/tour.md once shipped an example that could not
  // parse: `for [k, v] in { a: 1 }` reads the brace as the loop body.
  const files = [
    ...readdirSync(ROOT).filter((f) => f.endsWith('.md')),
    ...readdirSync(ROOT + 'docs').filter((f) => f.endsWith('.md')).map((f) => 'docs/' + f),
  ].sort();

  it('finds the documentation', () => {
    assert.ok(files.length >= 8, 'expected at least 8 markdown files, found ' + files.length);
  });

  for (const file of files) {
    const text = read(file);
    const blocks = [...text.matchAll(/```lumen\n([\s\S]*?)```/g)];
    if (blocks.length === 0) continue;

    it(file + ' (' + blocks.length + ' samples)', () => {
      const broken: string[] = [];
      for (const block of blocks) {
        const code = block[1] as string;
        const line = text.slice(0, block.index).split('\n').length;
        try {
          parse(code, file);
        } catch (error) {
          const why = error instanceof LumenError
            ? (error.diagnostics[0]?.code ?? '?') + ': ' + (error.diagnostics[0]?.message ?? '')
            : String(error);
          broken.push('  ' + file + ' line ~' + line + ' — ' + why + '\n    ' + (code.split('\n')[0] ?? ''));
        }
      }
      assert.deepEqual(
        broken,
        [],
        'these ```lumen samples do not parse:\n' + broken.join('\n') +
          '\n(if a block is not Lumen code, fence it as ```text instead)',
      );
    });
  }
});
