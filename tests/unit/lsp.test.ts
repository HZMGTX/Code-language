/**
 * The language server, driven through the real protocol.
 *
 * A real `lumen lsp` process, real `Content-Length` framing, real JSON-RPC —
 * the same way `cli.test.ts` and `repl.test.ts` drive the real binary. A
 * language server tested by calling its handlers directly is a language server
 * whose framing has never been exercised, and framing is exactly where these
 * go wrong: a length counted in characters rather than bytes desynchronises on
 * the first emoji and never recovers.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';

import { MessageBuffer, encode, type Message } from '@lumen-lang/lsp';

const CLI = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
const URI = 'file:///tmp/lumen-lsp-test/app.lm';

/** A live server, with requests answered and notifications collected. */
class Client {
  private readonly child: ChildProcess;
  private readonly buffer = new MessageBuffer();
  private readonly answers = new Map<number, (message: Message) => void>();
  private readonly notices: Message[] = [];
  private readonly waiting: { method: string; resolve: (message: Message) => void }[] = [];
  private next = 1;
  private stderr = '';

  constructor() {
    this.child = spawn(process.execPath, [CLI, 'lsp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    });
    this.child.stderr?.on('data', (c: Buffer) => (this.stderr += c.toString('utf8')));
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer.append(chunk);
      for (;;) {
        const message = this.buffer.next();
        if (message === undefined) return;
        if (typeof message.id === 'number' && this.answers.has(message.id)) {
          const resolve = this.answers.get(message.id);
          this.answers.delete(message.id);
          resolve?.(message);
          continue;
        }
        this.notices.push(message);
        const at = this.waiting.findIndex((w) => w.method === message.method);
        if (at !== -1) this.waiting.splice(at, 1)[0]?.resolve(message);
      }
    });
  }

  async request(method: string, params: unknown): Promise<Message> {
    const id = this.next++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(method + ' was never answered\nstderr:\n' + this.stderr)),
        15000,
      );
      this.answers.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.child.stdin?.write(encode({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    this.child.stdin?.write(encode({ jsonrpc: '2.0', method, params }));
  }

  /** The next notification of a given method, or one already received. */
  async notice(method: string): Promise<Message> {
    const already = this.notices.findIndex((m) => m.method === method);
    if (already !== -1) return this.notices.splice(already, 1)[0] as Message;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no ' + method + ' arrived\nstderr:\n' + this.stderr)),
        15000,
      );
      this.waiting.push({
        method,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }

  /** Forget notifications received so far, so the next `notice` is a fresh one. */
  clear(): void {
    this.notices.length = 0;
  }

  open(text: string, version = 1): void {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: URI, languageId: 'lumen', version, text },
    });
  }

  change(text: string, version: number): void {
    this.notify('textDocument/didChange', {
      textDocument: { uri: URI, version },
      contentChanges: [{ text }],
    });
  }

  /** Close the client's end of the pipe, as an editor that has quit does. */
  closeInput(): void {
    this.child.stdin?.end();
  }

  /** The status the process stopped with, or `'running'` if it never did. */
  async settle(within = 5000): Promise<number | 'running'> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('running'), within);
      this.child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
  }

  stop(): void {
    this.child.kill('SIGKILL');
  }
}

/** A diagnostic notification's payload, typed enough to read. */
interface Published {
  uri: string;
  diagnostics: { range: { start: { line: number; character: number } }; code: string; message: string }[];
}

describe('language server', () => {
  let client: Client;

  before(async () => {
    client = new Client();
    const initialized = await client.request('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {},
    });
    const result = initialized.result as { capabilities: Record<string, unknown> };
    assert.ok(result.capabilities['hoverProvider'] === true, 'no hover capability');
    assert.ok(result.capabilities['definitionProvider'] === true, 'no definition capability');
    assert.ok(
      result.capabilities['documentFormattingProvider'] === true,
      'no formatting capability',
    );
    client.notify('initialized', {});
  });

  after(() => {
    client.stop();
  });

  it('publishes diagnostics for a document as it opens', async () => {
    client.clear();
    client.open('print(pirnt)\n');
    const published = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.equal(published.uri, URI);
    assert.equal(published.diagnostics.length, 1);
    assert.equal(published.diagnostics[0]?.code, 'RS001');
    // Zero-based, and pointing at `cuont` rather than at the line.
    assert.deepEqual(published.diagnostics[0]?.range.start, { line: 0, character: 6 });
    assert.match(published.diagnostics[0]?.message ?? '', /did you mean `print`/);
  });

  it('reports the types the standard library declares', async () => {
    client.clear();
    client.change('import { upper } from "std/str"\nprint(upper(1))\n', 2);
    const published = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.equal(published.diagnostics.length, 1);
    assert.equal(published.diagnostics[0]?.code, 'TY001');
  });

  it('reports warnings, not only errors', async () => {
    // `checkModule` throws on an error and *returns* the warnings, so a server
    // that only catches is a server that shows none of them — and an editor
    // silent about what `lumen check` reports is the disagreement the whole
    // analysis module exists to prevent.
    client.clear();
    client.change('import { upper } from "std/str"\nlet spare = 1\nprint("ok")\n', 21);
    const published = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.equal(published.diagnostics.length, 2);
    for (const diagnostic of published.diagnostics) {
      assert.equal(diagnostic.code, 'RS011');
      // 2 is LSP's warning. Reporting an unused import as an error would be a
      // red squiggle under working code.
      assert.equal((diagnostic as unknown as { severity: number }).severity, 2);
    }
    assert.match(published.diagnostics[0]?.message ?? '', /`upper` is never used/);
    assert.match(published.diagnostics[1]?.message ?? '', /`spare` is never used/);
  });

  it('clears the diagnostics once the document is correct', async () => {
    client.clear();
    client.change('print("ok")\n', 3);
    const published = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.deepEqual(published.diagnostics, []);
  });

  it('answers hover with a type and its documentation', async () => {
    client.clear();
    client.change('let n = [1, 2].len()\nprint(n)\n', 4);
    await client.notice('textDocument/publishDiagnostics');

    // Over `len`.
    const onMethod = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line: 0, character: 16 },
    });
    const method = onMethod.result as { contents: { value: string } } | null;
    assert.ok(method !== null, 'no hover over a method call');
    assert.match(method.contents.value, /Num/);

    // Over the `n` on the second line, which the checker knows is a Num
    // because `let` takes its value's type.
    const onName = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line: 1, character: 6 },
    });
    const name = onName.result as { contents: { value: string } } | null;
    assert.ok(name !== null, 'no hover over a local name');
    assert.match(name.contents.value, /Num/);
  });

  it('describes a prelude function on hover, with its signature', async () => {
    client.clear();
    client.change('print(range(3))\n', 5);
    await client.notice('textDocument/publishDiagnostics');
    const hovered = await client.request('textDocument/hover', {
      textDocument: { uri: URI },
      position: { line: 0, character: 8 },
    });
    const value = (hovered.result as { contents: { value: string } }).contents.value;
    assert.match(value, /range\(start: Num/);
    assert.match(value, /A list of numbers/);
  });

  it('completes names in scope, including ones the document declares', async () => {
    client.clear();
    client.change('fn helper(a) { a }\nlet mine = 1\nprint(h)\n', 6);
    await client.notice('textDocument/publishDiagnostics');
    const completed = await client.request('textDocument/completion', {
      textDocument: { uri: URI },
      position: { line: 2, character: 7 },
    });
    const labels = (completed.result as { label: string }[]).map((i) => i.label);
    assert.ok(labels.includes('helper'), 'a function declared above is not offered');
    assert.ok(labels.includes('mine'), 'a binding declared above is not offered');
    assert.ok(labels.includes('print'), 'a prelude name is not offered');
    assert.ok(labels.includes('match'), 'a keyword is not offered');
    assert.ok(labels.includes('std/list'), 'a standard module is not offered');
  });

  it('completes the methods of the receiver, and not of every other type', async () => {
    // The half that the typed standard library made possible: before it the
    // receiver was `Any` and the only honest answer was every method at once.
    client.clear();
    client.change('let s = "abc"\nprint(s.)\n', 7);
    await client.notice('textDocument/publishDiagnostics');
    const completed = await client.request('textDocument/completion', {
      textDocument: { uri: URI },
      position: { line: 1, character: 8 },
    });
    const items = completed.result as { label: string; detail?: string }[];
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes('upper'), 'Str has no `upper`');
    assert.ok(labels.includes('padStart'), 'Str has no `padStart`');
    assert.ok(!labels.includes('flatten'), 'a List method is offered on a Str');
    assert.ok(labels.includes('str'), 'a universal method is not offered');
    // And it says what each one takes, which is the reason to have types.
    const upper = items.find((i) => i.label === 'upper');
    assert.equal(upper?.detail, 'upper() -> Str');
  });

  it('goes to the definition of a name, and declines for a built-in', async () => {
    client.clear();
    client.change('fn helper(a) { a }\nprint(helper(1))\n', 8);
    await client.notice('textDocument/publishDiagnostics');

    const onLocal = await client.request('textDocument/definition', {
      textDocument: { uri: URI },
      position: { line: 1, character: 8 },
    });
    const location = onLocal.result as { uri: string; range: { start: { line: number } } } | null;
    assert.ok(location !== null, 'no definition for a function declared above');
    assert.equal(location.uri, URI);
    assert.equal(location.range.start.line, 0);

    // `print` is part of the language. There is nowhere in this file to jump
    // to, and jumping to line 1 would be a lie.
    const onBuiltin = await client.request('textDocument/definition', {
      textDocument: { uri: URI },
      position: { line: 1, character: 2 },
    });
    assert.equal(onBuiltin.result, null);
  });

  it('formats a document, changing nothing but whitespace', async () => {
    client.clear();
    const badly = 'fn f() {\nlet a = 1\n    let b = 2\nprint(a + b)\n}\n';
    client.change(badly, 9);
    await client.notice('textDocument/publishDiagnostics');
    const formatted = await client.request('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
    });
    const edits = formatted.result as { newText: string }[];
    assert.equal(edits.length, 1);
    assert.match(edits[0]?.newText ?? '', /\n {2}let a = 1\n {2}let b = 2\n/);
    // The guarantee `format` makes, restated where an editor would rely on it.
    assert.equal(
      (edits[0]?.newText ?? '').replace(/[ \t]/g, ''),
      badly.replace(/[ \t]/g, ''),
    );
  });

  it('returns no edits for a document already formatted', async () => {
    client.clear();
    client.change('fn f() {\n  let a = 1\n  print(a)\n}\n', 10);
    await client.notice('textDocument/publishDiagnostics');
    const formatted = await client.request('textDocument/formatting', {
      textDocument: { uri: URI },
      options: { tabSize: 2, insertSpaces: true },
    });
    assert.deepEqual(formatted.result, []);
  });

  it('keeps answering after a document that does not parse', async () => {
    // Half of what an editor sends is mid-keystroke and does not parse. A
    // server that falls over on one has failed at its only job.
    client.clear();
    client.change('fn f( {\n', 11);
    const broken = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.ok(broken.diagnostics.length > 0, 'no diagnostic for a document that does not parse');

    client.clear();
    client.change('print("fine")\n', 12);
    const fixed = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.deepEqual(fixed.diagnostics, []);
  });

  it('handles non-ASCII source, where a byte and a character differ', async () => {
    // The framing counts bytes and the positions count UTF-16 units. An emoji
    // is four bytes and two units, so a server that confuses the two reports
    // this diagnostic in the wrong place — or desynchronises entirely.
    client.clear();
    client.change('let emoji = "🎉🎉"\nprint(pirnt)\n', 13);
    const published = (await client.notice('textDocument/publishDiagnostics')).params as Published;
    assert.equal(published.diagnostics.length, 1);
    assert.deepEqual(published.diagnostics[0]?.range.start, { line: 1, character: 6 });
  });

  it('reports an unknown request rather than going quiet', async () => {
    const answered = await client.request('textDocument/nonsense', {});
    assert.equal(answered.error?.code, -32601);
  });
});

/** The framing itself, which the tests above exercise but do not pin. */
describe('language server framing', () => {
  it('reassembles a message delivered one byte at a time', () => {
    const buffer = new MessageBuffer();
    const framed = encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    for (let i = 0; i < framed.length - 1; i += 1) {
      buffer.append(framed.subarray(i, i + 1));
      assert.equal(buffer.next(), undefined, 'answered before the message was complete');
    }
    buffer.append(framed.subarray(framed.length - 1));
    assert.equal(buffer.next()?.method, 'initialize');
  });

  it('counts the header in bytes, not characters', () => {
    // "🎉" is one character to `length`, two UTF-16 units, and four bytes. A
    // header counted any way but bytes is a stream that never resynchronises.
    const buffer = new MessageBuffer();
    buffer.append(encode({ jsonrpc: '2.0', id: 2, method: 'x', params: { text: '🎉🎉🎉' } }));
    const message = buffer.next();
    assert.deepEqual(message?.params, { text: '🎉🎉🎉' });
    assert.equal(buffer.next(), undefined, 'found a message that was not there');
  });

  it('reads two messages arriving in one chunk', () => {
    const buffer = new MessageBuffer();
    buffer.append(
      Buffer.concat([
        encode({ jsonrpc: '2.0', id: 1, method: 'first' }),
        encode({ jsonrpc: '2.0', id: 2, method: 'second' }),
      ]),
    );
    assert.equal(buffer.next()?.method, 'first');
    assert.equal(buffer.next()?.method, 'second');
    assert.equal(buffer.next(), undefined);
  });

  it('reports malformed JSON inside a well-framed message', () => {
    const body = Buffer.from('{ not json', 'utf8');
    const buffer = new MessageBuffer();
    buffer.append(
      Buffer.concat([Buffer.from('Content-Length: ' + String(body.length) + '\r\n\r\n'), body]),
    );
    assert.equal(buffer.next()?.error?.code, -32700);
  });
});

/**
 * The four features the typed library and the recording resolver made possible.
 *
 * References and rename work by **identity**, not by name: two different `x` in
 * two different scopes are two different bindings, and a rename that changed
 * both would be a rename that broke the program. That is the property these
 * pin, and it is the one a name-matching implementation silently fails.
 */
describe('language server: references, rename and signature help', () => {
  let client: Client;

  const SOURCE = [
    'fn double(value) { value * 2 }',
    'fn other(value) { value + 1 }',
    'let total = double(3) + other(4)',
    'print(total)',
    '',
  ].join('\n');

  before(async () => {
    client = new Client();
    await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    client.notify('initialized', {});
    client.open(SOURCE);
    await client.notice('textDocument/publishDiagnostics');
  });

  after(() => {
    client.stop();
  });

  it('advertises the capabilities', async () => {
    const fresh = new Client();
    try {
      const answered = await fresh.request('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
      });
      const capabilities = (answered.result as { capabilities: Record<string, unknown> })
        .capabilities;
      assert.equal(capabilities['referencesProvider'], true);
      assert.equal(capabilities['documentHighlightProvider'], true);
      assert.ok(capabilities['renameProvider'] !== undefined, 'no rename capability');
      assert.ok(capabilities['signatureHelpProvider'] !== undefined, 'no signature help');
    } finally {
      fresh.stop();
    }
  });

  it('finds every use of a binding, and its declaration', async () => {
    // On `double` in the call on line 3.
    const answered = await client.request('textDocument/references', {
      textDocument: { uri: URI },
      position: { line: 2, character: 14 },
      context: { includeDeclaration: true },
    });
    const locations = answered.result as { range: { start: { line: number; character: number } } }[];
    assert.equal(locations.length, 2);
    const lines = locations.map((l) => l.range.start.line).sort();
    assert.deepEqual(lines, [0, 2]);
  });

  it('tells two bindings of the same name apart', async () => {
    // `value` is a parameter of `double` on line 1 and of `other` on line 2.
    // They share a name and nothing else; a name-matching implementation would
    // report four locations here and rename across both functions.
    const answered = await client.request('textDocument/references', {
      textDocument: { uri: URI },
      position: { line: 0, character: 19 },
      context: { includeDeclaration: true },
    });
    const locations = answered.result as { range: { start: { line: number } } }[];
    assert.equal(locations.length, 2, 'expected only the declaration and use on line 1');
    assert.deepEqual(
      locations.map((l) => l.range.start.line),
      [0, 0],
    );
  });

  it('renames a binding everywhere it is used, and nowhere else', async () => {
    const answered = await client.request('textDocument/rename', {
      textDocument: { uri: URI },
      position: { line: 0, character: 19 },
      newName: 'n',
    });
    const edit = answered.result as { changes: Record<string, { newText: string }[]> };
    const edits = edit.changes[URI] ?? [];
    assert.equal(edits.length, 2);
    assert.ok(edits.every((e) => e.newText === 'n'));
  });

  it('declines a new name that is not a name, and says why', async () => {
    // An editor sends whatever the person typed. Accepting `2 bad` would make a
    // file that does not parse, and silently breaking code is worse than
    // declining to do it.
    //
    // Declining with `null` would be silent in a different way: it is the valid
    // answer for "no edits", an editor draws nothing for it, and somebody who
    // typed a name that is not a name would press Enter and watch nothing
    // happen. An error is the only answer a person actually reads.
    const answered = await client.request('textDocument/rename', {
      textDocument: { uri: URI },
      position: { line: 0, character: 19 },
      newName: '2 bad',
    });
    assert.equal(answered.result, undefined, 'answered with a result instead of an error');
    assert.match(answered.error?.message ?? '', /`2 bad` is not a name/);
  });

  it('declines to rename something the language owns', async () => {
    // `print` on line 4. There is nothing in this file to rename, and renaming
    // every use of it everywhere is not what was asked for.
    const answered = await client.request('textDocument/prepareRename', {
      textDocument: { uri: URI },
      position: { line: 3, character: 2 },
    });
    assert.equal(answered.result, null);
  });

  it('prepares a rename with the text it would replace', async () => {
    const answered = await client.request('textDocument/prepareRename', {
      textDocument: { uri: URI },
      position: { line: 2, character: 14 },
    });
    const prepared = answered.result as { placeholder: string } | null;
    assert.ok(prepared !== null, 'no rename offered on a function this file declares');
    assert.equal(prepared.placeholder, 'double');
  });

  it('highlights a binding and its uses', async () => {
    const answered = await client.request('textDocument/documentHighlight', {
      textDocument: { uri: URI },
      position: { line: 2, character: 14 },
    });
    const highlights = answered.result as { kind: number }[];
    assert.equal(highlights.length, 2);
  });

  it('says what a call takes while it is being typed', async () => {
    // The feature the typed standard library most obviously buys: before it,
    // there was no answer to give. Note the document does not parse here —
    // which is exactly when the question is asked.
    client.clear();
    client.change('print("7".padStart(', 2);
    await client.notice('textDocument/publishDiagnostics');
    const answered = await client.request('textDocument/signatureHelp', {
      textDocument: { uri: URI },
      position: { line: 0, character: 19 },
    });
    const help = answered.result as
      | { signatures: { label: string }[]; activeParameter: number }
      | null;
    assert.ok(help !== null, 'no signature help inside a method call');
    assert.equal(help.signatures[0]?.label, 'padStart(width: Num, fill: Str = ...) -> Str');
    assert.equal(help.activeParameter, 0);
  });

  it('follows the cursor from one argument to the next', async () => {
    client.clear();
    client.change('print("7".padStart(3, ', 3);
    await client.notice('textDocument/publishDiagnostics');
    const answered = await client.request('textDocument/signatureHelp', {
      textDocument: { uri: URI },
      position: { line: 0, character: 22 },
    });
    const help = answered.result as { activeParameter: number } | null;
    assert.ok(help !== null, 'no signature help after a comma');
    assert.equal(help.activeParameter, 1);
  });

  it('offers nothing where no call is open', async () => {
    client.clear();
    client.change('let x = 1\n', 4);
    await client.notice('textDocument/publishDiagnostics');
    const answered = await client.request('textDocument/signatureHelp', {
      textDocument: { uri: URI },
      position: { line: 0, character: 9 },
    });
    assert.equal(answered.result, null);
  });
});

/**
 * Stopping, which is a feature and not an afterthought.
 *
 * LSP's `exit` notification asks the server to exit its **process**, and the
 * spec even says with which status: 0 when a `shutdown` came first, 1 when it
 * did not — the second is how an editor's log shows that a server had to be
 * killed rather than asked. A server that resolves a promise and keeps running
 * looks correct from inside and leaves one orphaned process per session, which
 * is exactly what `exit` exists to prevent. Driving the real binary is the only
 * way to see that: an in-process test would pass either way, because the thing
 * being tested is whether the process is still there.
 */
describe('language server shutdown', () => {
  it('exits 0 when the client shuts it down and then asks it to go', async () => {
    const client = new Client();
    try {
      await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
      // The reply to `shutdown` has to arrive *before* the process goes: a
      // client waits for it, and exiting early would hang the editor rather
      // than the server.
      const answered = await client.request('shutdown', null);
      assert.equal(answered.result, null);
      client.notify('exit', null);
      assert.equal(await client.settle(), 0);
    } finally {
      client.stop();
    }
  });

  it('exits 1 for an `exit` that did not follow a `shutdown`', async () => {
    const client = new Client();
    try {
      await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
      client.notify('exit', null);
      assert.equal(await client.settle(), 1);
    } finally {
      client.stop();
    }
  });

  it('exits 0 when the editor simply goes away', async () => {
    // No `shutdown`, no `exit`, just a closed pipe — an editor that crashed, or
    // was killed. The server has nothing to report about that, so it is not a
    // failure.
    const client = new Client();
    try {
      await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
      client.closeInput();
      assert.equal(await client.settle(), 0);
    } finally {
      client.stop();
    }
  });

  it('refuses a request after `shutdown`, as the protocol says to', async () => {
    const client = new Client();
    try {
      await client.request('initialize', { processId: null, rootUri: null, capabilities: {} });
      await client.request('shutdown', null);
      const answered = await client.request('textDocument/hover', {
        textDocument: { uri: URI },
        position: { line: 0, character: 0 },
      });
      assert.equal(answered.error?.code, -32600);
    } finally {
      client.stop();
    }
  });
});
