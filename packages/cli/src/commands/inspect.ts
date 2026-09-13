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
  const kind = typeof record['kind'] === 'string' ? record['kind'] : '(node)';
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

  out.push(pad + kind + (scalars.length > 0 ? ' ' + scalars.join(' ') : ''));
  for (const [key, value] of nested) {
    out.push(pad + '  ' + key + ':');
    render(value, indent + 2, out);
  }
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
