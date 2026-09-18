/** Parser unit tests: precedence, associativity, ambiguity rules, recovery. */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  LumenError,
  formatDiagnostic,
  parse,
  parseExpression,
  pos,
  type Expr,
  type Stmt,
} from '@lumen-lang/core';

/** Compact s-expression rendering, so assertions read like the grammar. */
function sexp(node: unknown): string {
  const n = node as Record<string, unknown> & { kind: string };
  switch (n.kind) {
    case 'Module':
      return (n['stmts'] as Stmt[]).map(sexp).join(' ');
    case 'Block':
      return '{' + (n['stmts'] as Stmt[]).map(sexp).join(' ') + '}';
    case 'ExprStmt':
      return sexp(n['expr']);
    case 'LetDecl':
      return '(' + (n['mutable'] === true ? 'var' : 'let') + ' ' + String(n['name']) + ' ' + sexp(n['value']) + ')';
    case 'NumberLit':
      return String(n['value']);
    case 'StringLit':
      return JSON.stringify(n['value']);
    case 'BoolLit':
      return String(n['value']);
    case 'NilLit':
      return 'nil';
    case 'Ident':
      return String(n['name']);
    case 'Unary':
      return '(' + String(n['op']) + ' ' + sexp(n['operand']) + ')';
    case 'Binary':
    case 'Logical':
      return '(' + String(n['op']) + ' ' + sexp(n['left']) + ' ' + sexp(n['right']) + ')';
    case 'PipelineExpr':
      return '(|> ' + sexp(n['left']) + ' ' + sexp(n['right']) + ')';
    case 'RangeExpr':
      return '(.. ' + sexp(n['start']) + ' ' + sexp(n['end']) + ')';
    case 'AssignExpr':
      return '(' + String(n['op']) + ' ' + sexp(n['target']) + ' ' + sexp(n['value']) + ')';
    case 'CallExpr':
      return (
        '(call ' + sexp(n['callee']) +
        (n['args'] as { name?: string; value: Expr }[])
          .map((a) => ' ' + (a.name === undefined ? '' : a.name + ':') + sexp(a.value))
          .join('') + ')'
      );
    case 'MemberExpr':
      return '(' + (n['optional'] === true ? '?.' : '.') + ' ' + sexp(n['target']) + ' ' + String(n['name']) + ')';
    case 'IndexExpr':
      return '(idx ' + sexp(n['target']) + ' ' + sexp(n['index']) + ')';
    case 'TryExpr':
      return '(try ' + sexp(n['operand']) + ')';
    case 'MapLit':
      return 'map{' + (n['entries'] as { key: Expr; value: Expr }[]).map((e) => sexp(e.key) + ':' + sexp(e.value)).join(' ') + '}';
    case 'ListLit':
      return '[' + (n['items'] as Expr[]).map(sexp).join(' ') + ']';
    case 'StructLit':
      return String(n['name']) + '{' + (n['fields'] as { name: string; value: Expr }[]).map((f) => f.name + ':' + sexp(f.value)).join(' ') + '}';
    case 'IfExpr':
      return '(if ' + sexp(n['condition']) + ' ' + sexp(n['then']) + (n['otherwise'] === undefined ? '' : ' ' + sexp(n['otherwise'])) + ')';
    case 'LambdaExpr':
      return '(lambda ' + sexp(n['body']) + ')';
    default:
      return '<' + n.kind + '>';
  }
}

function tree(source: string): string {
  return sexp(parse(source, 't.lm'));
}

function codes(source: string): string[] {
  try {
    parse(source, 't.lm');
    return [];
  } catch (error) {
    assert.ok(error instanceof LumenError);
    return error.diagnostics.map((d) => d.code);
  }
}

describe('parser precedence', () => {
  it('binds * tighter than +', () => {
    assert.equal(tree('1 + 2 * 3'), '(+ 1 (* 2 3))');
  });

  it('honours parentheses', () => {
    assert.equal(tree('(1 + 2) * 3'), '(* (+ 1 2) 3)');
  });

  it('makes - and / left-associative', () => {
    assert.equal(tree('10 - 3 - 2'), '(- (- 10 3) 2)');
    assert.equal(tree('8 / 4 / 2'), '(/ (/ 8 4) 2)');
  });

  it('orders comparison below equality and above addition', () => {
    assert.equal(tree('1 + 2 < 4 == true'), '(== (< (+ 1 2) 4) true)');
  });

  it('binds && tighter than ||', () => {
    assert.equal(tree('a || b && c'), '(|| a (&& b c))');
  });

  it('treats the word operators as their symbol forms', () => {
    assert.equal(tree('a or b and c'), '(|| a (&& b c))');
  });

  it('puts the pipeline below every arithmetic operator', () => {
    assert.equal(tree('1 + 2 |> f'), '(|> (+ 1 2) f)');
  });

  it('makes the pipeline left-associative', () => {
    assert.equal(tree('a |> f |> g'), '(|> (|> a f) g)');
  });

  it('makes assignment right-associative', () => {
    assert.equal(tree('a = b = 1'), '(= a (= b 1))');
  });

  it('binds unary tighter than binary', () => {
    assert.equal(tree('-a + b'), '(+ (- a) b)');
  });

  it('binds calls and members tightest', () => {
    assert.equal(tree('-a.b(1)'), '(- (call (. a b) 1))');
  });
});

describe('parser ambiguity rules', () => {
  it('reads a brace after a condition as a block, not a struct literal', () => {
    assert.equal(tree('if t.done { 1 }'), '(if (. t done) {1})');
  });

  it('still reads a struct literal in an ordinary expression', () => {
    assert.equal(tree('let p = Point { x: 1 }'), '(let p Point{x:1})');
  });

  it('reads a bare brace in expression position as a map literal', () => {
    assert.equal(tree('let m = { a: 1 }'), '(let m map{"a":1})');
  });

  it('rejects a map literal in a control-flow header', () => {
    assert.deepEqual(codes('if { a: 1 } { 1 }').slice(0, 1), ['PA009']);
  });

  it('reads an anonymous fn in statement position as an expression', () => {
    assert.equal(tree('fn(x) { x }'), '(lambda {x})');
  });
});

describe('parser line handling', () => {
  it('makes semicolons optional', () => {
    assert.equal(tree('let a = 1\nlet b = 2'), '(let a 1) (let b 2)');
    assert.equal(tree('let a = 1; let b = 2'), '(let a 1) (let b 2)');
  });

  it('continues an expression after a trailing operator', () => {
    assert.equal(tree('let a = 1 +\n  2'), '(let a (+ 1 2))');
  });

  it('continues an expression when the next line starts with |> or .', () => {
    assert.equal(tree('let a = x\n  |> f()'), '(let a (|> x (call f)))');
    assert.equal(tree('let a = x\n  .b'), '(let a (. x b))');
  });

  it('ignores line breaks inside brackets', () => {
    assert.equal(tree('f(\n 1,\n 2,\n)'), '(call f 1 2)');
    assert.equal(tree('[\n 1,\n 2,\n]'), '[1 2]');
  });

  it('rejects two statements run together on one line', () => {
    assert.deepEqual(codes('let a = 1 let b = 2'), ['PA003']);
  });
});

describe('parser calls', () => {
  it('parses named arguments', () => {
    assert.equal(tree('serve(port: 3000, handler: h)'), '(call serve port:3000 handler:h)');
  });

  it('mixes positional and named arguments', () => {
    assert.equal(tree('f(1, b: 2)'), '(call f 1 b:2)');
  });

  it('parses postfix ? and optional chaining', () => {
    assert.equal(tree('a?.b?'), '(try (?. a b))');
  });
});

describe('parser error recovery', () => {
  it('reports a bad assignment target', () => {
    assert.deepEqual(codes('1 = 2'), ['PA008']);
  });

  it('terminates on a stray closing brace instead of looping', () => {
    const found = codes('let a = 1\n}\nlet b = 2');
    assert.deepEqual(found, ['PA014']);
  });

  it('bounds the number of errors from badly malformed input', () => {
    // Recovery must always consume a token, so this cannot cascade forever.
    assert.ok(codes('fn f( { }').length <= 5);
  });

  it('leaves valid programs alone', () => {
    assert.deepEqual(codes('fn f() { 1 }\nlet a = f()'), []);
  });
});

/**
 * `parseExpression` — the embedding surface, not the pipeline.
 *
 * Everything that runs a program parses statements, so this had no caller at all
 * and its docstring claimed the REPL used it. That is the state a public
 * function should never be in: exported, unexercised, and described wrongly.
 * A host wanting one expression and no more — a watch window, an `--eval` flag,
 * a language server asked about a selection — needs it to behave exactly so.
 */
describe('parseExpression', () => {
  it('returns the expression itself, not a module wrapping it', () => {
    const expr = parseExpression('1 + 2 * 3');
    assert.equal(expr.kind, 'Binary');
    assert.equal(sexp(expr), '(+ 1 (* 2 3))');
  });

  it('accepts leading and trailing newlines', () => {
    assert.equal(sexp(parseExpression('\n\n  x.len()  \n\n')), '(call (. x len))');
  });

  it('rejects a second expression rather than quietly keeping the first', () => {
    // The whole reason to have this instead of `parse`: `1 + 2` followed by
    // anything at all is not one expression, and answering `3` would be a lie.
    assert.throws(
      () => parseExpression('1 + 2\n3 + 4'),
      (error: unknown) => error instanceof LumenError && /PA002/.test(error.render(false)),
    );
  });

  it('rejects a statement, which is not an expression', () => {
    assert.throws(() => parseExpression('let x = 1'), LumenError);
  });
});

/**
 * The renderer's `'warning'` branch.
 *
 * Nothing emits a warning yet — every check either rejects a program or says
 * nothing — so the yellow arm of `formatDiagnostic` has never once run. It is
 * there for the unused-binding check the roadmap wants, and a rendering path
 * that has never executed is a rendering path that does not work. This runs it.
 */
describe('diagnostic severity', () => {
  const source = 'let unused = 1\n';
  const warning = {
    severity: 'warning' as const,
    code: 'RS999',
    message: '`unused` is never read',
    span: { start: pos(4, 1, 5), end: pos(10, 1, 11) },
    label: 'never read',
  };

  it('renders a warning with the same shape as an error', () => {
    const text = formatDiagnostic(warning, source, 'a.lm');
    assert.match(text, /^warning\[RS999\]: `unused` is never read\n/);
    assert.match(text, / --> a\.lm:1:5\n/);
    assert.match(text, /\^{6} never read/);
  });

  it('paints it yellow rather than red', () => {
    const painted = formatDiagnostic(warning, source, 'a.lm', true);
    const ESC = String.fromCharCode(27);
    assert.ok(painted.includes(ESC + '[33m'), 'expected yellow');
    assert.ok(!painted.includes(ESC + '[31m'), 'expected no red');
  });
});
