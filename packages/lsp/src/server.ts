/**
 * The Lumen language server.
 *
 * Five features, each independently useful, in the order they were worth
 * building:
 *
 *   1. **Diagnostics** — nearly free. `parse` and `checkModule` already produce
 *      a code, a span, a message and notes; LSP wants exactly that.
 *   2. **Hover** — the type the checker derived, plus the documentation `help()`
 *      already carries. Both read out of the same analysis, so the editor
 *      cannot tell you something `lumen check` disagrees with.
 *   3. **Completion** — names in scope, and after a `.`, the methods that exist
 *      on the receiver's type. The second half is worthless without the typed
 *      standard library and rather good with it.
 *   4. **Go to definition** — the resolver knows every binding site; it now says
 *      so instead of discarding them.
 *   5. **Formatting** — `format()` already exists and already guarantees it
 *      changes nothing but whitespace.
 *
 * Everything is computed on demand from the last analysis of the document. No
 * caches beyond that, no incremental anything: a Lumen file is small, and the
 * whole analysis of the largest one in this repository takes under a
 * millisecond. Complexity that buys nothing is complexity that can be wrong.
 */

import { format, type Diagnostic, type Expr, type Ty } from '@lumen-lang/core';
import {
  createInterpreter,
  stdMethodSignatures,
  stdModuleExports,
  stdSignatures,
} from '@lumen-lang/stdlib';

import {
  analyse,
  analyseForCompletion,
  describeTy,
  offsetOf,
  rangeOf,
  referenceAt,
  typeAt,
  within,
  type Analysis,
  type Position,
  type Range,
} from './analysis.js';
import { ERROR, encode, MessageBuffer, type Message } from './rpc.js';

/** LSP severities. Lumen only ever produces errors; see `Severity`. */
const SEVERITY = { error: 1, warning: 2 } as const;

/** LSP `CompletionItemKind`, the few this server uses. */
const KIND = { function: 3, field: 5, variable: 6, module: 9, keyword: 14, struct: 22 } as const;

/** Words the language reserves, offered when nothing better applies. */
const KEYWORDS = [
  'let', 'var', 'fn', 'return', 'if', 'else', 'while', 'for', 'in', 'match',
  'struct', 'enum', 'import', 'export', 'from', 'break', 'continue',
  'true', 'false', 'nil', 'and', 'or', 'not',
];

interface Documented {
  readonly detail: string;
  readonly doc: string | undefined;
}

export interface Connection {
  /** Send one framed message to the client. */
  write(chunk: Buffer): void;
}

export class Server {
  private readonly documents = new Map<string, Analysis>();
  private readonly buffer = new MessageBuffer();
  /** Names in scope with no import, and what each one is. */
  private readonly globals: ReadonlyMap<string, Documented>;
  private readonly globalNames: readonly string[];
  private shuttingDown = false;
  private exited = false;

  constructor(private readonly connection: Connection) {
    // A real interpreter, so the server offers exactly what a program can use.
    // Building the list separately would be a second answer to "what is in
    // scope", and the two would drift the first time the prelude changed.
    const interpreter = createInterpreter();
    const signatures = stdSignatures();
    const described = new Map<string, Documented>();
    for (const name of interpreter.globals.ownNames()) {
      const value = interpreter.globals.lookup(name)?.value;
      const signature = signatures.get(name);
      described.set(name, {
        detail: signature === undefined ? kindOf(value) : name + showSignatureish(signature),
        doc: value !== undefined && value.k === 'native' ? value.doc : undefined,
      });
    }
    this.globals = described;
    this.globalNames = [...described.keys()];
  }

  /** Feed bytes from the client. Replies are written as they are produced. */
  receive(chunk: Buffer): void {
    this.buffer.append(chunk);
    for (;;) {
      const message = this.buffer.next();
      if (message === undefined) return;
      this.dispatch(message);
    }
  }

  /** True once the client has sent `exit`, so the process may stop. */
  get done(): boolean {
    return this.exited;
  }

  private send(message: Message): void {
    this.connection.write(encode({ jsonrpc: '2.0', ...message }));
  }

  private reply(id: Message['id'], result: unknown): void {
    if (id === undefined) return; // a notification wants no answer
    this.send({ id, result });
  }

  private fail(id: Message['id'], code: number, message: string): void {
    if (id === undefined) return;
    this.send({ id, error: { code, message } });
  }

  private dispatch(message: Message): void {
    const { id, method } = message;
    if (method === undefined) return; // a response to something we sent; we send none
    const params = (message.params ?? {}) as Record<string, unknown>;

    if (this.shuttingDown && method !== 'exit') {
      this.fail(id, ERROR.invalidAfterShutdown, 'the server is shutting down');
      return;
    }

    try {
      switch (method) {
        case 'initialize':
          this.reply(id, this.capabilities());
          return;
        case 'initialized':
          return;
        case 'shutdown':
          this.shuttingDown = true;
          this.reply(id, null);
          return;
        case 'exit':
          this.exited = true;
          return;

        case 'textDocument/didOpen': {
          const doc = params['textDocument'] as { uri: string; version?: number; text: string };
          this.update(doc.uri, doc.version ?? 0, doc.text);
          return;
        }
        case 'textDocument/didChange': {
          const doc = params['textDocument'] as { uri: string; version?: number };
          const changes = (params['contentChanges'] ?? []) as { text: string }[];
          // Full-document sync, which is what `capabilities` asks for: the last
          // change carries the whole text.
          const last = changes[changes.length - 1];
          if (last !== undefined) this.update(doc.uri, doc.version ?? 0, last.text);
          return;
        }
        case 'textDocument/didClose': {
          const doc = params['textDocument'] as { uri: string };
          this.documents.delete(doc.uri);
          // Clear what the editor is still drawing for a file nobody has open.
          this.publish(doc.uri, [], undefined);
          return;
        }
        case 'textDocument/didSave':
          return;

        case 'textDocument/hover':
          this.reply(id, this.hover(params));
          return;
        case 'textDocument/completion':
          this.reply(id, this.completion(params));
          return;
        case 'textDocument/definition':
          this.reply(id, this.definition(params));
          return;
        case 'textDocument/formatting':
          this.reply(id, this.formatting(params));
          return;

        default:
          // A notification this server does not implement is not an error — the
          // protocol is large and a client may send anything. A *request* is,
          // because the client is waiting for an answer.
          if (id !== undefined) this.fail(id, ERROR.methodNotFound, 'no such method: ' + method);
          return;
      }
    } catch (error) {
      // A bug here must not take the editor's language support down with it.
      this.fail(id, ERROR.internal, String(error));
    }
  }

  private capabilities(): unknown {
    return {
      capabilities: {
        // 1 is full-document sync. Incremental sync would be a second
        // implementation of "what does this document say" for no gain: these
        // files are small enough to re-analyse on every keystroke.
        textDocumentSync: { openClose: true, change: 1 },
        hoverProvider: true,
        definitionProvider: true,
        documentFormattingProvider: true,
        completionProvider: { triggerCharacters: ['.'] },
      },
      serverInfo: { name: 'lumen-lsp' },
    };
  }

  // ----------------------------------------------------------- documents

  private update(uri: string, version: number, text: string): void {
    const analysis = analyse(uri, version, text, this.globalNames);
    this.documents.set(uri, analysis);
    this.publish(uri, analysis.diagnostics, version);
  }

  private publish(uri: string, diagnostics: readonly Diagnostic[], version: number | undefined): void {
    this.send({
      method: 'textDocument/publishDiagnostics',
      params: {
        uri,
        ...(version === undefined ? {} : { version }),
        diagnostics: diagnostics.map((d) => ({
          range: rangeOf(d.span),
          severity: SEVERITY[d.severity],
          code: d.code,
          source: 'lumen',
          message: [d.message, ...(d.notes ?? []).map((n) => n.message)].join('\n'),
        })),
      },
    });
  }

  private at(params: Record<string, unknown>): { analysis: Analysis; offset: number } | undefined {
    const doc = params['textDocument'] as { uri: string } | undefined;
    const position = params['position'] as Position | undefined;
    if (doc === undefined) return undefined;
    const analysis = this.documents.get(doc.uri);
    if (analysis === undefined) return undefined;
    const offset = position === undefined ? 0 : offsetOf(analysis.text, position);
    return { analysis, offset };
  }

  // --------------------------------------------------------------- hover

  private hover(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return null;
    const { analysis, offset } = found;

    const lines: string[] = [];
    let range: Range | undefined;

    const reference = referenceAt(analysis, offset);
    const typed = typeAt(analysis, offset);

    // A name first: it is the more specific answer, and the one that can carry
    // documentation. Falling back to the expression covers `xs[0]` and `p.x`,
    // where there is no name under the cursor but there is very much a type.
    if (reference !== undefined) {
      range = rangeOf(reference.use);
      const described = this.globals.get(reference.name);
      const ty = typed?.ty ?? this.typeOfName(analysis, reference.name, offset);
      lines.push(
        '```lumen\n' +
          (described?.detail ?? reference.name + (ty === undefined ? '' : ': ' + describeTy(ty))) +
          '\n```',
      );
      if (described?.doc !== undefined) lines.push(described.doc);
      else lines.push('*' + reference.kind + '*');
    } else if (typed !== undefined) {
      range = rangeOf(typed.expr.span);
      lines.push('```lumen\n' + describeTy(typed.ty) + '\n```');
    } else {
      return null;
    }

    return { contents: { kind: 'markdown', value: lines.join('\n\n') }, range };
  }

  /** The type of a name, from the smallest typed expression that *is* it. */
  private typeOfName(analysis: Analysis, name: string, offset: number): Ty | undefined {
    for (const { expr, ty } of analysis.types) {
      if (expr.kind === 'Ident' && expr.name === name && within(expr.span, offset)) return ty;
    }
    return undefined;
  }

  // ---------------------------------------------------------- completion

  private completion(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return [];
    const { offset } = found;
    // Completion is asked for on a document that is being typed into, so it is
    // usually a document that does not parse — `s.` is not an expression yet.
    // This repairs it enough to have an answer; see `analyseForCompletion`.
    const analysis = analyseForCompletion(found.analysis.uri, found.analysis.text, offset, this.globalNames);

    // After a `.`, offer what can follow it: the methods on whatever is to the
    // left. This is the half that the typed standard library made possible —
    // before it, the receiver's type was `Any` and the only honest answer was
    // every method of every type at once.
    const dot = dotBefore(analysis.text, offset);
    if (dot !== undefined) return this.methodsFor(analysis, dot);

    const items = new Map<string, unknown>();
    for (const [name, described] of this.globals) {
      items.set(name, {
        label: name,
        kind: KIND.function,
        detail: described.detail,
        ...(described.doc === undefined ? {} : { documentation: described.doc }),
      });
    }
    for (const { name, ty, kind } of declarationsIn(analysis)) {
      items.set(name, {
        label: name,
        kind: kind === 'struct' ? KIND.struct : kind === 'function' ? KIND.function : KIND.variable,
        detail: ty === undefined ? kind : name + ': ' + describeTy(ty),
      });
    }
    for (const word of KEYWORDS) {
      if (!items.has(word)) items.set(word, { label: word, kind: KIND.keyword });
    }
    for (const moduleName of stdModuleExports().keys()) {
      items.set(moduleName, { label: moduleName, kind: KIND.module, detail: 'standard module' });
    }
    return [...items.values()];
  }

  /** Every method available on whatever ends at `dot`. */
  private methodsFor(analysis: Analysis, dot: number): unknown {
    const receiver = typeAt(analysis, dot - 1);
    const methods = stdMethodSignatures();
    const typeName = receiver === undefined ? undefined : nameOfTy(receiver.ty);

    const items: unknown[] = [];
    for (const [key, ty] of methods) {
      const [owner, method] = splitKey(key);
      // `*` is the handful that belong to every value — `str`, `type`, `clone`.
      if (typeName !== undefined && owner !== typeName && owner !== '*') continue;
      if (method === undefined) continue;
      items.push({
        label: method,
        kind: KIND.function,
        detail: method + showSignatureish(ty),
        ...(owner === '*' ? { sortText: 'z' + method } : {}),
      });
    }

    // A struct's own fields, which are not methods but are what a `.` most
    // often means for one.
    if (receiver !== undefined && receiver.ty.k === 'struct') {
      for (const field of fieldsOf(analysis, receiver.ty.name)) {
        items.push({ label: field.name, kind: KIND.field, detail: field.name + ': ' + field.type });
      }
    }
    return items;
  }

  // ---------------------------------------------------------- definition

  private definition(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return null;
    const { analysis, offset } = found;
    const reference = referenceAt(analysis, offset);
    if (reference === undefined) return null;
    // A zero-width declaration is a built-in or a prelude name: there is no
    // place in this file to jump to, and jumping to line 1 would be a lie.
    if (reference.declaration.end.offset === reference.declaration.start.offset) return null;
    return { uri: analysis.uri, range: rangeOf(reference.declaration) };
  }

  // ---------------------------------------------------------- formatting

  private formatting(params: Record<string, unknown>): unknown {
    const doc = params['textDocument'] as { uri: string } | undefined;
    if (doc === undefined) return null;
    const analysis = this.documents.get(doc.uri);
    if (analysis === undefined) return null;

    const formatted = format(analysis.text);
    if (formatted === analysis.text) return [];
    // One edit replacing everything. `format` only ever changes whitespace, so
    // a client that folds this into its undo history loses nothing, and a
    // minimal diff would be effort spent to produce the same result.
    const lines = analysis.text.split('\n');
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lines.length - 1, character: (lines[lines.length - 1] ?? '').length },
        },
        newText: formatted,
      },
    ];
  }
}

// ------------------------------------------------------------- helpers

/** Where the `.` is when the cursor is just after one, ignoring a part-typed name. */
function dotBefore(text: string, offset: number): number | undefined {
  let at = offset;
  while (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1] ?? '')) at -= 1;
  if (at > 0 && text[at - 1] === '.') return at - 1;
  return undefined;
}

/** `"Str.upper"` as its two halves, without splitting a name that has a dot. */
function splitKey(key: string): [string, string | undefined] {
  const at = key.indexOf('.');
  return at === -1 ? [key, undefined] : [key.slice(0, at), key.slice(at + 1)];
}

/** What a value is, for a completion with no signature to show. */
function kindOf(value: { k: string } | undefined): string {
  if (value === undefined) return 'built-in';
  switch (value.k) {
    case 'native':
    case 'fn':
      return 'function';
    case 'enumType':
      return 'enum';
    case 'structType':
      return 'struct';
    default:
      return value.k;
  }
}

/** A `fn` type as a parameter list, for a detail line. */
function showSignatureish(ty: Ty): string {
  if (ty.k !== 'fn') return ': ' + describeTy(ty);
  const params = ty.params
    .map((p) => (p.name ?? '_') + (p.ty.k === 'any' ? '' : ': ' + describeTy(p.ty)) + (p.optional ? ' = ...' : ''))
    .join(', ');
  return '(' + params + ')' + (ty.ret.k === 'any' ? '' : ' -> ' + describeTy(ty.ret));
}

/** The name a method table is registered under, for a type. */
function nameOfTy(ty: Ty): string | undefined {
  switch (ty.k) {
    case 'str':
      return 'Str';
    case 'num':
      return 'Num';
    case 'list':
      return 'List';
    case 'map':
      return 'Map';
    case 'enum':
    case 'struct':
      return ty.name;
    default:
      return undefined;
  }
}

interface Declared {
  readonly name: string;
  readonly kind: string;
  readonly ty: Ty | undefined;
}

/** Top-level declarations in a document, for completion. */
function declarationsIn(analysis: Analysis): readonly Declared[] {
  const out: Declared[] = [];
  const module = analysis.module;
  if (module === undefined) return out;
  for (const statement of module.stmts) {
    const stmt = statement.kind === 'ExportDecl' ? statement.declaration : statement;
    switch (stmt.kind) {
      case 'LetDecl':
        out.push({ name: stmt.name, kind: stmt.mutable ? 'var' : 'let', ty: undefined });
        break;
      case 'FnDecl':
        out.push({ name: stmt.name, kind: 'function', ty: undefined });
        break;
      case 'StructDecl':
        out.push({ name: stmt.name, kind: 'struct', ty: undefined });
        break;
      case 'EnumDecl':
        out.push({ name: stmt.name, kind: 'enum', ty: undefined });
        for (const variant of stmt.variants) {
          out.push({ name: variant.name, kind: 'variant', ty: undefined });
        }
        break;
      case 'ImportDecl':
        for (const spec of stmt.specifiers) {
          out.push({ name: spec.alias ?? spec.name, kind: 'import', ty: undefined });
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/** A struct's fields, read back out of the document that declared it. */
function fieldsOf(analysis: Analysis, name: string): readonly { name: string; type: string }[] {
  const module = analysis.module;
  if (module === undefined) return [];
  for (const statement of module.stmts) {
    const stmt = statement.kind === 'ExportDecl' ? statement.declaration : statement;
    if (stmt.kind !== 'StructDecl' || stmt.name !== name) continue;
    return stmt.fields.map((field) => ({
      name: field.name,
      type: field.type === undefined ? 'Any' : describeTypeExpr(field.type),
    }));
  }
  return [];
}

/** A written annotation, as written. */
function describeTypeExpr(type: { kind: string; name?: string; args?: readonly unknown[] }): string {
  if (type.kind !== 'TypeName') return 'fn';
  const args = (type.args ?? []) as { kind: string; name?: string; args?: readonly unknown[] }[];
  const inner = args.map(describeTypeExpr).join(', ');
  return (type.name ?? 'Any') + (inner === '' ? '' : '<' + inner + '>');
}

/** Kept so `Expr` is named in this file's imports for the reader's benefit. */
export type { Expr };
