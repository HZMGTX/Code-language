/**
 * JSON-RPC 2.0 over a stream, with the Language Server Protocol's framing.
 *
 * A message is a `Content-Length: N` header, a blank line, and then exactly N
 * **bytes** of UTF-8 JSON. Bytes, not characters — a header saying 42 with a
 * body containing one emoji is 42 bytes and 39 characters, and a server that
 * counts characters desynchronises on the first non-ASCII identifier and never
 * recovers. Everything here works in `Buffer` for that reason.
 *
 * This is the whole reason a language server needs no dependency. The protocol
 * is a few dozen lines of framing over stdio; `vscode-languageserver` is a
 * convenience, and taking it would break the promise the rest of the project is
 * built on — that Lumen depends on nothing at run time.
 */

const HEADER_END = Buffer.from('\r\n\r\n');

/** A request, a notification, or a response, as JSON-RPC describes them. */
export interface Message {
  readonly jsonrpc?: string;
  /** Absent on a notification. */
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** The JSON-RPC error codes this server can produce. */
export const ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  internal: -32603,
  /** The client asked after `shutdown`; LSP reserves this code for it. */
  invalidAfterShutdown: -32600,
} as const;

/**
 * Split a stream of bytes into messages.
 *
 * Kept separate from the reading so it can be tested directly: a client is free
 * to deliver a message in as many chunks as it likes, and delivering one header
 * byte at a time is a perfectly legal thing for it to do.
 */
export class MessageBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /** The next complete message, or undefined while one is still arriving. */
  next(): Message | undefined {
    const headerEnd = this.buffer.indexOf(HEADER_END);
    if (headerEnd === -1) return undefined;

    const header = this.buffer.subarray(0, headerEnd).toString('ascii');
    const length = readContentLength(header);
    if (length === undefined) {
      // A header with no usable length cannot be recovered from — there is no
      // way to know where the body ends. Drop it and resynchronise on the next
      // header rather than hanging forever waiting for a length nobody sent.
      this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length);
      return this.next();
    }

    const start = headerEnd + HEADER_END.length;
    if (this.buffer.length < start + length) return undefined;

    const body = this.buffer.subarray(start, start + length).toString('utf8');
    this.buffer = this.buffer.subarray(start + length);
    try {
      return JSON.parse(body) as Message;
    } catch {
      // Malformed JSON inside a well-framed message: the frame was still
      // correct, so the stream is in step and the next message is readable.
      return { id: null, error: { code: ERROR.parse, message: 'could not parse: ' + body } };
    }
  }
}

function readContentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    if (line.slice(0, at).trim().toLowerCase() !== 'content-length') continue;
    const value = Number(line.slice(at + 1).trim());
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return undefined;
}

/** Frame one message for sending: the header, a blank line, and the body. */
export function encode(message: Message): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from('Content-Length: ' + String(body.length) + '\r\n\r\n', 'ascii'), body]);
}
