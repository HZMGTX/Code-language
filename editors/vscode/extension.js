/**
 * Lumen for Visual Studio Code.
 *
 * A language-server client written against the protocol directly, with no
 * dependency at all — not even `vscode-languageclient`, which is the obvious
 * thing to reach for. The rest of this project depends on nothing at run time,
 * and an editor plug-in is a poor place to make the first exception: the whole
 * client is the framing in `packages/lsp/src/rpc.ts` read backwards, plus five
 * providers that forward a request and translate the answer.
 *
 * It starts `lumen lsp` and speaks to it over stdio. Everything clever lives in
 * the server, where `lumen check` can reach it too.
 */

'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const HEADER_END = Buffer.from('\r\n\r\n');

/** The client half of the framing: Content-Length in bytes, then that many. */
class Framing {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  append(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END);
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (match === null) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + HEADER_END.length;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch {
        // A malformed message is the server's problem; the stream is in step.
      }
    }
  }
}

function encode(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Where to find `lumen`.
 *
 * A setting first, then a checkout — the launchers a repository ships sit at
 * its root, and somebody working on Lumen wants the one they are building
 * rather than one installed months ago. Failing both, whatever is on PATH.
 */
function findLumen(folder) {
  const configured = vscode.workspace.getConfiguration('lumen').get('path');
  if (typeof configured === 'string' && configured !== '') return configured;

  const launcher = process.platform === 'win32' ? 'lumen.cmd' : 'lumen';
  let at = folder;
  for (let depth = 0; at !== undefined && depth < 8; depth += 1) {
    const candidate = path.join(at, launcher);
    if (existsSync(candidate)) return candidate;
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return launcher;
}

class Client {
  constructor(command, output) {
    this.output = output;
    this.pending = new Map();
    this.next = 1;
    this.diagnostics = vscode.languages.createDiagnosticCollection('lumen');

    this.child = spawn(command, ['lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (chunk) => output.append(chunk.toString('utf8')));
    this.child.on('error', (error) => {
      vscode.window.showErrorMessage(
        `Lumen: could not start "${command} lsp" (${error.message}). ` +
          'Set "lumen.path" if it is somewhere else.',
      );
    });

    const framing = new Framing((message) => this.receive(message));
    this.child.stdout.on('data', (chunk) => framing.append(chunk));
  }

  receive(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      resolve(message.error === undefined ? message.result : undefined);
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = message.params;
      this.diagnostics.set(
        vscode.Uri.parse(uri),
        diagnostics.map((d) => {
          const range = new vscode.Range(
            d.range.start.line,
            d.range.start.character,
            d.range.end.line,
            d.range.end.character,
          );
          const made = new vscode.Diagnostic(range, d.message, vscode.DiagnosticSeverity.Error);
          made.code = d.code;
          made.source = 'lumen';
          return made;
        }),
      );
    }
  }

  notify(method, params) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  request(method, params) {
    const id = this.next++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
      // A server that never answers must not leave the editor waiting forever.
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(undefined);
      }, 5000);
    });
  }

  stop() {
    this.diagnostics.dispose();
    this.child.kill();
  }
}

/** A `vscode.TextDocument` as the protocol describes it. */
const identify = (document) => ({ uri: document.uri.toString(), version: document.version });
const isLumen = (document) => document.languageId === 'lumen';

function activate(context) {
  const output = vscode.window.createOutputChannel('Lumen');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const client = new Client(findLumen(folder), output);
  context.subscriptions.push({ dispose: () => client.stop() }, output);

  const open = (document) => {
    client.notify('textDocument/didOpen', {
      textDocument: {
        ...identify(document),
        languageId: 'lumen',
        text: document.getText(),
      },
    });
  };

  client.request('initialize', { processId: process.pid, rootUri: null, capabilities: {} }).then(() => {
    client.notify('initialized', {});
    // Anything already open when the extension started; `onDidOpenTextDocument`
    // only fires for what comes after.
    for (const document of vscode.workspace.textDocuments) {
      if (isLumen(document)) open(document);
    }
  });

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isLumen(document)) open(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!isLumen(event.document)) return;
      client.notify('textDocument/didChange', {
        textDocument: identify(event.document),
        contentChanges: [{ text: event.document.getText() }],
      });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (isLumen(document)) {
        client.notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } });
      }
    }),
  );

  const at = (document, position) => ({
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character },
  });

  context.subscriptions.push(
    vscode.languages.registerHoverProvider('lumen', {
      async provideHover(document, position) {
        const answer = await client.request('textDocument/hover', at(document, position));
        if (answer === undefined || answer === null) return undefined;
        return new vscode.Hover(new vscode.MarkdownString(answer.contents.value));
      },
    }),

    vscode.languages.registerCompletionItemProvider(
      'lumen',
      {
        async provideCompletionItems(document, position) {
          const answer = await client.request('textDocument/completion', at(document, position));
          if (!Array.isArray(answer)) return undefined;
          return answer.map((item) => {
            // The protocol's CompletionItemKind is one-based and VS Code's is
            // zero-based, over the same list in the same order, so the two
            // differ by exactly one and nothing else.
            const made = new vscode.CompletionItem(item.label, (item.kind ?? 1) - 1);
            if (item.detail !== undefined) made.detail = item.detail;
            if (item.documentation !== undefined) made.documentation = item.documentation;
            if (item.sortText !== undefined) made.sortText = item.sortText;
            return made;
          });
        },
      },
      '.',
    ),

    vscode.languages.registerDefinitionProvider('lumen', {
      async provideDefinition(document, position) {
        const answer = await client.request('textDocument/definition', at(document, position));
        if (answer === undefined || answer === null) return undefined;
        return new vscode.Location(
          vscode.Uri.parse(answer.uri),
          new vscode.Range(
            answer.range.start.line,
            answer.range.start.character,
            answer.range.end.line,
            answer.range.end.character,
          ),
        );
      },
    }),

    vscode.languages.registerDocumentFormattingEditProvider('lumen', {
      async provideDocumentFormattingEdits(document) {
        const answer = await client.request('textDocument/formatting', {
          textDocument: { uri: document.uri.toString() },
          options: { tabSize: 2, insertSpaces: true },
        });
        if (!Array.isArray(answer)) return undefined;
        return answer.map(
          (edit) =>
            new vscode.TextEdit(
              new vscode.Range(
                edit.range.start.line,
                edit.range.start.character,
                edit.range.end.line,
                edit.range.end.character,
              ),
              edit.newText,
            ),
        );
      },
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
