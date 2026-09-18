/** Lexer unit tests: token kinds, payloads, positions, and error reporting. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LumenError, lex, type Token, type TokenKind } from '@lumen-lang/core';

function kinds(source: string): TokenKind[] {
  return lex(source, 't.lm')
    .map((t) => t.kind)
    .filter((k) => k !== 'eof');
}

function only(source: string): Token {
  const tokens = lex(source, 't.lm').filter((t) => t.kind !== 'eof' && t.kind !== 'newline');
  assert.equal(tokens.length, 1, 'expected exactly one token from ' + JSON.stringify(source));
  return tokens[0] as Token;
}

function errorCodes(source: string): string[] {
  try {
    lex(source, 't.lm');
    return [];
  } catch (error) {
    assert.ok(error instanceof LumenError);
    return error.diagnostics.map((d) => d.code);
  }
}

describe('lexer', () => {
  it('lexes keywords as their own kinds, not identifiers', () => {
    assert.deepEqual(kinds('let x = 1'), ['let', 'ident', '=', 'number']);
  });

  it('matches the longest operator', () => {
    assert.deepEqual(kinds('a <= b'), ['ident', '<=', 'ident']);
    assert.deepEqual(kinds('a < b'), ['ident', '<', 'ident']);
    assert.deepEqual(kinds('a |> b'), ['ident', '|>', 'ident']);
    assert.deepEqual(kinds('a ?. b'), ['ident', '?.', 'ident']);
    assert.deepEqual(kinds('a ? b'), ['ident', '?', 'ident']);
  });

  it('reads every numeric form', () => {
    assert.equal(only('42').num, 42);
    assert.equal(only('3.5').num, 3.5);
    assert.equal(only('1_000').num, 1000);
    assert.equal(only('0xFF').num, 255);
    assert.equal(only('0b1010').num, 10);
    assert.equal(only('0o17').num, 15);
    assert.equal(only('1e3').num, 1000);
    assert.equal(only('2.5e-3').num, 0.0025);
  });

  it('does not treat the dot of a range as a decimal point', () => {
    assert.deepEqual(kinds('0..10'), ['number', '..', 'number']);
  });

  it('resolves escape sequences', () => {
    assert.equal(only('"a\\nb"').str, 'a\nb');
    assert.equal(only('"a\\tb"').str, 'a\tb');
    assert.equal(only('"q\\"q"').str, 'q"q');
    assert.equal(only('"\\u{1F600}"').str, String.fromCodePoint(0x1f600));
    assert.equal(only('"\\${x}"').str, '${x}');
  });

  it('splits interpolated strings into parts', () => {
    const token = only('"hi ${name}!"');
    assert.equal(token.kind, 'template');
    assert.deepEqual(
      (token.parts ?? []).map((p) => (p.kind === 'text' ? p.value : '<' + p.source + '>')),
      ['hi ', '<name>', '!'],
    );
  });

  it('tracks braces and nested strings inside an interpolation', () => {
    const token = only('"${ pick("}") } done"');
    const parts = token.parts ?? [];
    assert.equal(parts[0]?.kind, 'expr');
    assert.equal(parts[0]?.kind === 'expr' ? parts[0].source : '', ' pick("}") ');
  });

  it('collapses blank lines into a single newline token', () => {
    assert.deepEqual(kinds('a\n\n\nb'), ['ident', 'newline', 'ident']);
  });

  it('emits no leading newline token', () => {
    assert.deepEqual(kinds('\n\na'), ['ident']);
  });

  it('nests block comments', () => {
    assert.deepEqual(kinds('/* a /* b */ c */ x'), ['ident']);
  });

  it('records 1-based line and column positions', () => {
    const tokens = lex('let x\n  = 1', 't.lm');
    const eq = tokens.find((t) => t.kind === '=');
    assert.equal(eq?.span.start.line, 2);
    assert.equal(eq?.span.start.col, 3);
  });

  it('reports lexical errors with stable codes', () => {
    assert.deepEqual(errorCodes('"unterminated'), ['LX002']);
    assert.deepEqual(errorCodes('let a = 1 | 2'), ['LX001']);
    assert.deepEqual(errorCodes('"${ unclosed"'), ['LX003']);
    assert.deepEqual(errorCodes('/* unclosed'), ['LX006']);
    assert.deepEqual(errorCodes('"\\q"'), ['LX004']);
  });

  it('collects several errors rather than stopping at the first', () => {
    assert.equal(errorCodes("let s = 'a' + 'b'").length, 4);
  });

  it('continues a line in a file with either line ending', () => {
    // A backslash at the end of a line swallows the break. In a CRLF file the
    // character after the backslash is the carriage return, and only `\n` was
    // accepted — so the continuation worked on one operating system's files
    // and was `LX004` on another's, with a bare CR spliced into the message
    // where it named a character nobody can see.
    for (const [what, source] of [
      ['LF', 'let s = "abc\\\ndef"\n'],
      ['CRLF', 'let s = "abc\\\r\ndef"\r\n'],
      ['CR', 'let s = "abc\\\rdef"\r'],
    ] as const) {
      assert.deepEqual(errorCodes(source), [], what + ' reported: ' + JSON.stringify(source));
      const strings = lex(source).filter((t) => t.kind === 'string');
      assert.equal(strings[0]?.str, 'abcdef', what + ' gave ' + JSON.stringify(strings[0]?.str));
    }
  });
});
