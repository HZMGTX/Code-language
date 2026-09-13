/**
 * `lumen tokens <file>` and `lumen ast <file>` — look at what the front end
 * actually produced. Useful when debugging the language itself, and the fastest
 * way to answer "how does Lumen read this?".
 */

import { lex, parse } from '@lumen-lang/core';
import { readSource, reportError } from '../support.js';

export async function dumpTokens(file: string): Promise<void> {
  const { file: resolved, source } = await readSource(file);
  try {
    for (const token of lex(source, resolved)) {
      const where = String(token.span.start.line) + ':' + String(token.span.start.col);
      const payload =
        token.kind === 'number'
          ? ' = ' + String(token.num)
          : token.kind === 'string'
            ? ' = ' + JSON.stringify(token.str)
            : token.kind === 'template'
              ? ' = ' +
                (token.parts ?? [])
                  .map((p) => (p.kind === 'text' ? JSON.stringify(p.value) : '${' + p.source + '}'))
                  .join(' + ')
              : token.kind === 'ident'
                ? ' = ' + token.text
                : '';
      process.stdout.write(where.padEnd(8) + token.kind.padEnd(10) + payload + '\n');
    }
  } catch (error) {
    reportError(error);
  }
}

const SKIP = new Set(['span', 'kind']);

/** Render any AST node as an indented tree, hiding spans. */
function render(node: unknown, indent: number, out: string[]): void {
  const pad = '  '.repeat(indent);

  if (Array.isArray(node)) {
    if (node.length === 0) {
      out.push(pad + '(empty)');
      return;
    }
    for (const item of node) render(item, indent, out);
    return;
  }

  if (node === null || node === undefined) {
    out.push(pad + 'nil');
    return;
  }

  if (typeof node !== 'object') {
    out.push(pad + JSON.stringify(node));
    return;
  }

  const record = node as Record<string, unknown>;
  const kind = typeof record['kind'] === 'string' ? record['kind'] : undefined;
  const scalars: string[] = [];
  const nested: [string, unknown][] = [];

  for (const [key, value] of Object.entries(record)) {
    if (SKIP.has(key)) continue;
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object') {
      scalars.push(key + '=' + JSON.stringify(value));
      continue;
    }
    nested.push([key, value]);
  }

  if (kind !== undefined) {
    out.push(pad + kind + (scalars.length > 0 ? ' ' + scalars.join(' ') : ''));
    for (const [key, value] of nested) {
      out.push(pad + '  ' + key + ':');
      render(value, indent + 2, out);
    }
    return;
  }

  // A node with no `kind` of its own: an argument, a match arm, a parameter, a
  // map entry. These are structure rather than syntax — there is no `Arg` in the
  // grammar, only a call with things in it — and labelling them `(node)`, as this
  // used to, spent a line saying nothing in the one command whose whole job is
  // showing how Lumen read the file.
  //
  // Every one of these gets a `-`, whatever it holds. Without a marker a list of
  // them runs together — two match arms print as `pattern: body: pattern: body:`,
  // and the reader has no way to see where the first ends. Marking only the ones
  // with several parts was tried and read worse: one argument list then had some
  // elements bulleted and some not, which looks like a distinction and is not.
  //
  // Every type that reaches here — argument, parameter, match arm, map entry,
  // struct field, enum variant — appears only inside a list, so the marker is
  // always right.
  const first = out.length;
  const single = scalars.length === 0 && nested.length === 1;
  if (scalars.length > 0) out.push(pad + '  ' + scalars.join(' '));
  for (const [key, value] of nested) {
    if (single) {
      // Nothing of its own to say, so the element *is* its child.
      render(value, indent + 1, out);
      continue;
    }
    out.push(pad + '  ' + key + ':');
    render(value, indent + 2, out);
  }
  const head = out[first];
  if (head !== undefined) out[first] = pad + '- ' + head.slice(pad.length + 2);
}

export async function dumpAst(file: string): Promise<void> {
  const { file: resolved, source } = await readSource(file);
  try {
    const module = parse(source, resolved);
    const out: string[] = [];
    render(module, 0, out);
    process.stdout.write(out.join('\n') + '\n');
  } catch (error) {
    reportError(error);
  }
}
