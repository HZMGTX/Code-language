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

import { format, type Diagnostic, type Expr, type Span, type Ty } from '@lumen-lang/core';
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

/** LSP severities. `RS011` is a warning; everything else is an error. */
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

/**
 * A request declined with a reason, as against declined with `null`.
 *
 * The protocol distinguishes them and so does an editor: `null` is "nothing to
 * do here" and is drawn as nothing, while an error carries a message a person
 * actually reads. Anything a person could have done differently should be the
 * second one.
 */
class Refused {
  constructor(readonly why: string) {}
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

  /**
   * The status LSP says to exit with: 0 after a `shutdown`, 1 without one.
   *
   * The second is not pedantry. `exit` with no `shutdown` before it means the
   * client gave up on a server it could not shut down cleanly, and the status
   * is how that shows up in an editor's log rather than looking like an
   * ordinary stop.
   */
  get exitCode(): number {
    return this.shuttingDown ? 0 : 1;
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
        case 'textDocument/references':
          this.reply(id, this.references(params));
          return;
        case 'textDocument/documentHighlight':
          this.reply(id, this.highlights(params));
          return;
        case 'textDocument/prepareRename':
          this.reply(id, this.prepareRename(params));
          return;
        case 'textDocument/rename': {
          const answer = this.rename(params);
          // A refusal has to reach the person, not just the client. `null` is a
          // valid answer meaning "no edits", and an editor draws nothing for
          // it — so somebody who typed a name that is not a name would press
          // Enter and watch nothing happen, with no clue why.
          if (answer instanceof Refused) this.fail(id, ERROR.invalidRequest, answer.why);
          else this.reply(id, answer);
          return;
        }
        case 'textDocument/signatureHelp':
          this.reply(id, this.signatureHelp(params));
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
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        documentHighlightProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ','] },
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

  // ------------------------------------------- references and renaming

  /**
   * Every place one binding is used, found by *identity* rather than by name.
   *
   * Two different `x` in two different scopes are two different bindings, and a
   * rename that changed both would be a rename that broke the program. The
   * resolver hands over where each use was declared, so the set is exactly the
   * uses that resolve to the same declaration — which is the correct answer and
   * happens also to be the easy one.
   */
  private bindingAt(analysis: Analysis, offset: number): { declaration: Span; uses: Span[] } | undefined {
    // The cursor may be on a use, or on the declaration itself.
    const use = referenceAt(analysis, offset);
    const declaration =
      use?.declaration ?? analysis.references.find((r) => within(r.declaration, offset))?.declaration;
    if (declaration === undefined) return undefined;
    // A zero-width declaration is a built-in: there is nothing in this file to
    // rename, and every use of `print` in every file is not what was asked for.
    if (declaration.end.offset === declaration.start.offset) return undefined;

    const uses = analysis.references
      .filter((r) => r.declaration.start.offset === declaration.start.offset)
      .map((r) => r.use);
    return { declaration, uses };
  }

  private references(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return [];
    const binding = this.bindingAt(found.analysis, found.offset);
    if (binding === undefined) return [];
    const context = params['context'] as { includeDeclaration?: boolean } | undefined;
    const spans =
      context?.includeDeclaration === false ? binding.uses : [binding.declaration, ...binding.uses];
    return spans.map((span) => ({ uri: found.analysis.uri, range: rangeOf(span) }));
  }

  /** The same set, for the editor to shade while the cursor rests on one. */
  private highlights(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return [];
    const binding = this.bindingAt(found.analysis, found.offset);
    if (binding === undefined) return [];
    return [
      { range: rangeOf(binding.declaration), kind: 3 }, // Write
      ...binding.uses.map((span) => ({ range: rangeOf(span), kind: 2 })), // Read
    ];
  }

  /**
   * Whether a rename is possible here, and what text it would replace.
   *
   * Answering `null` makes the editor say so before opening its input box,
   * rather than accepting a new name and then quietly doing nothing — which is
   * what a client does when `rename` returns no edits.
   */
  private prepareRename(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return null;
    const binding = this.bindingAt(found.analysis, found.offset);
    if (binding === undefined) return null;
    const here = [binding.declaration, ...binding.uses].find((span) => within(span, found.offset));
    if (here === undefined) return null;
    return {
      range: rangeOf(here),
      placeholder: found.analysis.text.slice(here.start.offset, here.end.offset),
    };
  }

  private rename(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return null;
    const newName = params['newName'];
    if (typeof newName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      // An editor will happily send anything the person typed. A name that is
      // not a name would produce a file that does not parse, and silently
      // breaking somebody's code is worse than declining — but declining
      // silently is its own small cruelty, so say which name and why.
      return new Refused(
        '`' + String(newName) + '` is not a name: a name starts with a letter or `_` and ' +
          'continues with letters, digits or `_`',
      );
    }
    const binding = this.bindingAt(found.analysis, found.offset);
    if (binding === undefined) return null;
    // An unaliased import declares its binding at the *exported* name, so the
    // one edit that cannot be a plain replacement is the import itself:
    // rewriting `import { round }` to `import { rounded }` asks `std/math` for
    // an export it does not have, and the file stops compiling. Lumen has
    // aliases, and this is what they are for.
    const importedAs = unaliasedImportAt(found.analysis, binding.declaration);
    return {
      changes: {
        [found.analysis.uri]: [binding.declaration, ...binding.uses].map((span) => ({
          range: rangeOf(span),
          newText:
            importedAs !== undefined && span.start.offset === binding.declaration.start.offset
              ? importedAs + ' as ' + newName
              : newName,
        })),
      },
    };
  }

  // -------------------------------------------------------- signature help

  /**
   * What the call being typed takes, and which argument the cursor is on.
   *
   * The feature the typed standard library most obviously buys: `padStart(` is
   * a question the editor could not answer at all before, and can now answer
   * with `padStart(width: Num, fill: Str = ...)` and the current parameter in
   * bold.
   *
   * The open call is found by scanning backwards over balanced brackets rather
   * than from the syntax tree, because the document does not parse while it is
   * being typed — the call has no closing bracket yet, which is exactly why the
   * question is being asked.
   */
  private signatureHelp(params: Record<string, unknown>): unknown {
    const found = this.at(params);
    if (found === undefined) return null;
    const { offset } = found;
    // Repaired, like completion, and for the same reason: a call is asked about
    // while it is being typed, so it has no closing bracket yet and the
    // document does not parse. Without this there is no type for the receiver
    // at exactly the moment the question is asked. The repair never touches
    // anything before the cursor, so the scan below is unaffected.
    const analysis = analyseForCompletion(
      found.analysis.uri,
      found.analysis.text,
      offset,
      this.globalNames,
    );
    const open = openCallBefore(analysis.text, offset);
    if (open === undefined) return null;

    const name = nameBefore(analysis.text, open.at);
    if (name === undefined) return null;

    const ty = this.calleeTy(analysis, name, open.at);
    if (ty === undefined || ty.k !== 'fn') return null;

    const described = this.globals.get(name);
    return {
      signatures: [
        {
          label: name + showSignatureish(ty),
          ...(described?.doc === undefined ? {} : { documentation: described.doc }),
          parameters: ty.params.map((p) => ({
            label: (p.name ?? '_') + (p.ty.k === 'any' ? '' : ': ' + describeTy(p.ty)),
          })),
        },
      ],
      activeSignature: 0,
      // Past the last parameter there is nothing to highlight, and pointing at
      // one that does not exist makes a client draw nothing at all.
      activeParameter: Math.min(open.argument, Math.max(0, ty.params.length - 1)),
    };
  }

  /** The type of whatever `name` refers to at this point: a method, or a global. */
  private calleeTy(analysis: Analysis, name: string, at: number): Ty | undefined {
    // `x.f(` — the method on whatever is to the left of the dot.
    const beforeName = at - name.length - 1;
    if (beforeName >= 0 && analysis.text[beforeName] === '.') {
      const receiver = typeAt(analysis, beforeName - 1);
      const typeName = receiver === undefined ? undefined : nameOfTy(receiver.ty);
      const methods = stdMethodSignatures();
      if (typeName !== undefined) {
        const own = methods.get(typeName + '.' + name);
        if (own !== undefined) return own;
      }
      return methods.get('*.' + name);
    }
    return stdSignatures().get(name) ?? this.declaredTy(analysis, name);
  }

  /** The type of a function the document itself declares, from its annotation. */
  private declaredTy(analysis: Analysis, name: string): Ty | undefined {
    for (const { expr, ty } of analysis.types) {
      if (expr.kind === 'Ident' && expr.name === name && ty.k === 'fn') return ty;
    }
    return undefined;
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

/**
 * The innermost `(` still open before `offset`, and which argument follows it.
 *
 * Scanned backwards over the raw text, skipping balanced brackets and the
 * insides of strings, because the document does not parse while a call is
 * being typed. Counting commas at depth zero gives the argument the cursor is
 * on — which is the whole question signature help answers.
 */
function openCallBefore(text: string, offset: number): { at: number; argument: number } | undefined {
  let depth = 0;
  let argument = 0;
  for (let i = Math.min(offset, text.length) - 1; i >= 0; i -= 1) {
    const c = text[i];
    if (c === '"') {
      // Walk back out of the string. An unescaped quote ends it; `\"` does not.
      i -= 1;
      while (i >= 0 && !(text[i] === '"' && text[i - 1] !== '\\')) i -= 1;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '[' || c === '{') {
      if (depth === 0) return undefined; // a list or map, not a call
      depth -= 1;
    } else if (c === '(') {
      if (depth === 0) return { at: i, argument };
      depth -= 1;
    } else if (c === ',' && depth === 0) argument += 1;
    else if (c === '\n' && depth === 0) {
      // A newline at depth zero ends a statement in Lumen, so there is no call
      // open across it and scanning further back would find somebody else's.
      return undefined;
    }
  }
  return undefined;
}

/** The identifier immediately before `at`, if there is one. */
function nameBefore(text: string, at: number): string | undefined {
  let end = at;
  while (end > 0 && /\s/.test(text[end - 1] ?? '')) end -= 1;
  let start = end;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1] ?? '')) start -= 1;
  return start === end ? undefined : text.slice(start, end);
}

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

/**
 * The exported name, when `declaration` is an import that was not aliased.
 *
 * `import { round } from "std/math"` binds `round` at the same span the export
 * is named in, so the two cannot be told apart by position alone — the AST is
 * asked instead. An aliased import already has a span of its own for the local
 * name and needs nothing special.
 */
function unaliasedImportAt(analysis: Analysis, declaration: Span): string | undefined {
  for (const stmt of analysis.module?.stmts ?? []) {
    const decl = stmt.kind === 'ExportDecl' ? stmt.declaration : stmt;
    if (decl.kind !== 'ImportDecl') continue;
    for (const spec of decl.specifiers) {
      if (spec.alias !== undefined) continue;
      if (spec.localSpan.start.offset === declaration.start.offset) return spec.name;
    }
  }
  return undefined;
}
