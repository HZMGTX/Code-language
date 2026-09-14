/**
 * `@lumen-lang/lsp` — the Lumen language server.
 *
 * Speaks the Language Server Protocol on stdin and stdout, with no dependency
 * of any kind: LSP is JSON-RPC over a stream, and the framing is a few dozen
 * lines. Taking `vscode-languageserver` for the convenience would break the
 * promise the rest of this project is built on.
 *
 * Started by `lumen lsp`, which is how an editor should launch it.
 */

export { Server, type Connection } from './server.js';
export { MessageBuffer, encode, type Message } from './rpc.js';
export {
  analyse,
  analyseForCompletion,
  offsetOf,
  rangeOf,
  referenceAt,
  typeAt,
  type Analysis,
  type Position,
  type Range,
} from './analysis.js';

import { Server } from './server.js';

/**
 * Run the server against a pair of streams, resolving when the client exits.
 *
 * Taking the streams rather than reaching for `process` keeps the one rule this
 * package shares with the rest: the thing that knows about the host is the
 * thing at the edge. It is also what lets a test drive the real protocol
 * without a subprocess.
 *
 * Resolves with the status the caller should exit with — 0 after a `shutdown`,
 * 1 for an `exit` that did not follow one, and 0 for a stream that simply
 * ended, which means the editor is gone rather than that anything went wrong.
 * Actually exiting is the caller's to do: this function knows about two
 * streams and deliberately nothing else.
 */
export async function serve(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<number> {
  const server = new Server({
    write: (chunk) => {
      output.write(chunk);
    },
  });

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      input.off('data', onData);
      input.off('end', finish);
      // Stop consuming, not just stop listening: attaching the listener put the
      // stream into flowing mode, and leaving it there means still pulling
      // bytes from a client that has said goodbye.
      input.pause();
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      server.receive(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      if (server.done) finish();
    };
    input.on('data', onData);
    input.once('end', finish);
  });

  // A stream that ended without an `exit` is an editor that died, which is not
  // this server's failure to report.
  return server.done ? server.exitCode : 0;
}
