/**
 * `std/crypto` — hashing, HMAC, secure random, and constant-time comparison.
 *
 * Four things, chosen because a program that serves anything needs all four and
 * gets at least one of them wrong by hand: an ETag, a content-addressed cache
 * key, a webhook signature to verify, a session token to issue.
 *
 * **What is not here, and why.** No encryption, no key exchange, no password
 * hashing. Each of those needs choices — a mode, a padding, a work factor, a
 * salt policy — that change with the year and with the threat, and a standard
 * library that makes them silently is a standard library that is wrong in
 * 2031 for everybody at once. Encryption also fails silently when it is done
 * badly, which is the worst property a thing can have.
 *
 * **`sha1` and `md5` are here and are broken.** Both are trivially collidable
 * and neither is fit for a signature or a password. They are here because real
 * work requires them — a Git object id, an S3 ETag, an old API's checksum — and
 * a language that omits them does not stop anybody using them; it makes them
 * write it themselves, worse. Their documentation says so in the one place a
 * reader will see it.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { bool, num, str, type Value } from '@lumen-lang/core';
import {
  arg,
  expectInt,
  expectStr,
  fn,
  moduleOf,
  withDocs,
  withSignatures,
} from './support.js';

/** Hex, lowercase, always — the form every other tool prints and compares. */
function digest(algorithm: string, text: string): string {
  return createHash(algorithm).update(text, 'utf8').digest('hex');
}

const SIGNATURES: Readonly<Record<string, string>> = {
  sha256: '(text: Str) -> Str',
  sha512: '(text: Str) -> Str',
  sha1: '(text: Str) -> Str',
  md5: '(text: Str) -> Str',
  hmacSha256: '(key: Str, text: Str) -> Str',
  token: '(bytes: Num = 32) -> Str',
  equals: '(a: Str, b: Str) -> Bool',
};

export function stdCrypto(): Map<string, Value> {
  return withSignatures(
    withDocs(
      moduleOf(
        fn('sha256', ['text'], (a, c) => str(digest('sha256', expectStr(arg(a, 0), c, 'sha256(text)')))),
        fn('sha512', ['text'], (a, c) => str(digest('sha512', expectStr(arg(a, 0), c, 'sha512(text)')))),
        fn('sha1', ['text'], (a, c) => str(digest('sha1', expectStr(arg(a, 0), c, 'sha1(text)')))),
        fn('md5', ['text'], (a, c) => str(digest('md5', expectStr(arg(a, 0), c, 'md5(text)')))),

        /**
         * HMAC-SHA256, which is how a webhook proves who sent it.
         *
         * The thing to do with the result is compare it with `equals`, never
         * with `==`: see below for why that matters more than it looks like it
         * should.
         */
        fn('hmacSha256', ['key', 'text'], (a, c) =>
          str(
            createHmac('sha256', expectStr(arg(a, 0), c, 'hmacSha256(key)'))
              .update(expectStr(arg(a, 1), c, 'hmacSha256(text)'), 'utf8')
              .digest('hex'),
          ),
        ),

        /**
         * Random hex from the operating system, for a session id or a token.
         *
         * **Not** from `std/math.random`, and not affected by `seed` — that
         * generator exists so a test can be repeated, which is the exact
         * opposite of what a token needs. Using it for a session id would make
         * every session predictable to anybody who could guess the seed, and
         * the two functions being in different modules is deliberate.
         *
         * The default of 32 bytes is 256 bits, which is past the point where
         * anybody guesses one.
         */
        fn('token', [{ name: 'bytes', defaultValue: num(32) }], (a, c) => {
          const size = expectInt(arg(a, 0), c, 'token(bytes)');
          if (size < 1 || size > 1024) {
            return c.panic('token() wants between 1 and 1024 bytes, got ' + size);
          }
          return str(randomBytes(size).toString('hex'));
        }),

        /**
         * Compare two secrets without leaking how much of them matched.
         *
         * `==` on strings stops at the first differing character, so how long
         * it takes says how many characters were right. Over enough tries that
         * recovers a signature one character at a time, without ever guessing
         * the whole of it — which is why every library that does this has a
         * function like this one, and why comparing a signature with `==` is a
         * real vulnerability rather than a theoretical one.
         *
         * Lengths are compared first and in the open, because the length of a
         * hex digest is not a secret.
         */
        fn('equals', ['a', 'b'], (a, c) => {
          const left = Buffer.from(expectStr(arg(a, 0), c, 'equals(a)'), 'utf8');
          const right = Buffer.from(expectStr(arg(a, 1), c, 'equals(b)'), 'utf8');
          if (left.length !== right.length) return bool(false);
          return bool(timingSafeEqual(left, right));
        }),
      ),
      {
        sha256: 'SHA-256 of some text, as lowercase hex. The one to reach for.',
        sha512: 'SHA-512 of some text, as lowercase hex.',
        sha1: 'SHA-1 as hex. BROKEN for security; for Git ids and old formats only.',
        md5: 'MD5 as hex. BROKEN for security; for ETags and old formats only.',
        hmacSha256: 'HMAC-SHA256 as hex — how a webhook proves who sent it.',
        token: 'Random hex from the OS, for a session id. Never affected by seed().',
        equals: 'Compare two secrets without leaking how much of them matched.',
      },
    ),
    SIGNATURES,
  );
}
