/**
 * `lumen lsp` — speak the Language Server Protocol on stdin and stdout.
 *
 * An editor starts this and talks to it; a person never runs it directly, which
 * is why it says so and exits when stdin is a terminal. Discovering that your
 * shell has hung because you typed a command meant for a program is a bad
 * minute, and one line of output prevents it.
 */

import { serve } from '@lumen-lang/lsp';

export async function startLanguageServer(): Promise<void> {
  if (process.stdin.isTTY === true) {
    process.stderr.write(
      'lumen lsp speaks the Language Server Protocol on stdin and stdout.\n' +
        'It is meant to be started by an editor, not typed at a terminal.\n' +
        'See editors/vscode for a client that does.\n',
    );
    process.exit(2);
  }
  // Exiting is the point of LSP's `exit` notification, and resolving a promise
  // is not exiting: attaching a reader put stdin into flowing mode, and Node
  // keeps a process with a live stdin pipe alive however the stream is left.
  // Without this line the server survives a clean shutdown forever, so every
  // editor session leaves an orphan behind — which is the one thing `exit`
  // exists to prevent. The status is the protocol's: 0 after a `shutdown`, 1
  // for an `exit` that did not follow one.
  process.exit(await serve(process.stdin, process.stdout));
}
