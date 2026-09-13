/**
 * The Lumen abstract syntax tree.
 *
 * Notes on shape:
 *  - `if` and `match` are expressions, not statements. Using one as a statement
 *    is just an `ExprStmt`, so there is exactly one node kind for each.
 *  - A `Block` carries statements only. Its value is the value of its final
 *    statement when that statement is an expression — which is what makes
 *    `if c { 1 } else { 2 }` produce a value.
 *  - Type annotations are parsed and retained on every declaration but are not
 *    yet enforced. Keeping them in the tree from v0.1 means the v0.2 checker
 *    lands without changing a single line of existing Lumen source.
 */

import type { Span } from './diagnostics.js';

export interface NodeBase {
  readonly span: Span;
}

// ------------------------------------------------------------------- types

/** A type annotation, e.g. `Str`, `List<Num>`, `fn(Num) -> Str`. */
export type TypeExpr = TypeName | TypeFn;

export interface TypeName extends NodeBase {
  readonly kind: 'TypeName';
  readonly name: string;
  readonly args: readonly TypeExpr[];
}

export interface TypeFn extends NodeBase {
  readonly kind: 'TypeFn';
  readonly params: readonly TypeExpr[];
  readonly ret: TypeExpr | undefined;
}

// ------------------------------------------------------------- expressions

export type Expr =
  | NumberLit
  | StringLit
  | TemplateLit
  | BoolLit
  | NilLit
  | Ident
  | Unary
  | Binary
  | Logical
  | CallExpr
  | IndexExpr
  | MemberExpr
  | AssignExpr
  | LambdaExpr
  | ListLit
  | MapLit
  | StructLit
  | MatchExpr
  | IfExpr
  | PipelineExpr
  | RangeExpr
  | TryExpr
  | AwaitExpr
  | JumpExpr
  | BlockExpr;

export interface NumberLit extends NodeBase {
  readonly kind: 'NumberLit';
  readonly value: number;
}

export interface StringLit extends NodeBase {
  readonly kind: 'StringLit';
  readonly value: string;
}

/** An interpolated string: alternating literal text and embedded expressions. */
export interface TemplateLit extends NodeBase {
  readonly kind: 'TemplateLit';
  readonly parts: readonly (
    | { readonly kind: 'text'; readonly value: string }
    | { readonly kind: 'expr'; readonly expr: Expr }
  )[];
}

export interface BoolLit extends NodeBase {
  readonly kind: 'BoolLit';
  readonly value: boolean;
}

export interface NilLit extends NodeBase {
  readonly kind: 'NilLit';
}

export interface Ident extends NodeBase {
  readonly kind: 'Ident';
  readonly name: string;
}

export type UnaryOp = '-' | '!' | 'not';

export interface Unary extends NodeBase {
  readonly kind: 'Unary';
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface Binary extends NodeBase {
  readonly kind: 'Binary';
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

/** `&&` / `and` / `||` / `or` — separate from Binary because it short-circuits. */
export interface Logical extends NodeBase {
  readonly kind: 'Logical';
  readonly op: '&&' | '||';
  readonly left: Expr;
  readonly right: Expr;
}

/** One argument in a call. `name` is set for named arguments (`port: 3000`). */
export interface Arg extends NodeBase {
  readonly name: string | undefined;
  readonly value: Expr;
}

export interface CallExpr extends NodeBase {
  readonly kind: 'CallExpr';
  readonly callee: Expr;
  readonly args: readonly Arg[];
}

export interface IndexExpr extends NodeBase {
  readonly kind: 'IndexExpr';
  readonly target: Expr;
  readonly index: Expr;
}

export interface MemberExpr extends NodeBase {
  readonly kind: 'MemberExpr';
  readonly target: Expr;
  readonly name: string;
  /** `?.` — evaluates to nil instead of erroring when the target is nil. */
  readonly optional: boolean;
}

export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=';

export interface AssignExpr extends NodeBase {
  readonly kind: 'AssignExpr';
  readonly op: AssignOp;
  /**
   * Ident, MemberExpr, IndexExpr, or — for `=` only — a ListLit of those,
   * which assigns positionally. Validated by the parser.
   */
  readonly target: Expr;
  readonly value: Expr;
}

export interface Param extends NodeBase {
  readonly name: string;
  readonly type: TypeExpr | undefined;
  readonly defaultValue: Expr | undefined;
  /**
   * `fn log(..parts)` — collects every remaining positional argument into a
   * `List`. At most one, always last, never with a default.
   */
  readonly rest: boolean;
}

export interface LambdaExpr extends NodeBase {
  readonly kind: 'LambdaExpr';
  readonly params: readonly Param[];
  readonly ret: TypeExpr | undefined;
  readonly body: Block;
}

export interface ListLit extends NodeBase {
  readonly kind: 'ListLit';
  readonly items: readonly Expr[];
}

export interface MapEntry extends NodeBase {
  /** Either a literal key (`name:`) or a computed one (`[expr]:`). */
  readonly key: Expr;
  readonly value: Expr;
}

export interface MapLit extends NodeBase {
  readonly kind: 'MapLit';
  readonly entries: readonly MapEntry[];
}

export interface FieldInit extends NodeBase {
  readonly name: string;
  readonly value: Expr;
}

export interface StructLit extends NodeBase {
  readonly kind: 'StructLit';
  readonly name: string;
  readonly fields: readonly FieldInit[];
}

export interface MatchArm extends NodeBase {
  readonly pattern: Pattern;
  /** Optional `if` guard: the arm only fires when this is truthy. */
  readonly guard: Expr | undefined;
  readonly body: Expr;
}

export interface MatchExpr extends NodeBase {
  readonly kind: 'MatchExpr';
  readonly subject: Expr;
  readonly arms: readonly MatchArm[];
}

export interface IfExpr extends NodeBase {
  readonly kind: 'IfExpr';
  readonly condition: Expr;
  readonly then: Block;
  /** A Block for `else { }`, an IfExpr for `else if`, or undefined. */
  readonly otherwise: Block | IfExpr | undefined;
}

/** `x |> f(a)` desugars to `f(x, a)` at evaluation time. */
export interface PipelineExpr extends NodeBase {
  readonly kind: 'PipelineExpr';
  readonly left: Expr;
  readonly right: Expr;
}

/** `0..10` — exclusive of the upper bound. */
export interface RangeExpr extends NodeBase {
  readonly kind: 'RangeExpr';
  readonly start: Expr;
  readonly end: Expr;
}

/** Postfix `?`: unwrap `Ok`/`Some`, or return the `Err`/`None` from the caller. */
export interface TryExpr extends NodeBase {
  readonly kind: 'TryExpr';
  readonly operand: Expr;
}

/**
 * `await expr`. Lumen awaits I/O implicitly, so this is rarely needed; it
 * exists for explicitness and for awaiting a value produced by a host API.
 */
export interface AwaitExpr extends NodeBase {
  readonly kind: 'AwaitExpr';
  readonly operand: Expr;
}

/**
 * `return`, `break` or `continue` written where a value is expected.
 *
 * These never produce a value — they leave. Allowing them in expression
 * position is what lets a `match` arm bail out:
 *
 *     match parse(line) {
 *       Ok(n)  => n,
 *       Err(e) => return Err(e),
 *     }
 *
 * The statement forms are parsed separately and mean exactly the same thing.
 */
export interface JumpExpr extends NodeBase {
  readonly kind: 'JumpExpr';
  readonly jump: 'return' | 'break' | 'continue';
  /** Only ever set for `return`, and only when a value was written. */
  readonly value: Expr | undefined;
}

/**
 * A braced block used in expression position. The parser only produces this
 * where a `{` is unambiguously a block rather than a map literal — currently
 * match-arm bodies. Its value is the value of its last statement.
 */
export interface BlockExpr extends NodeBase {
  readonly kind: 'BlockExpr';
  readonly block: Block;
}

// ---------------------------------------------------------------- patterns

export type Pattern = PWildcard | PBinding | PLiteral | PEnum | PStruct | PList;

/** `_` — matches anything, binds nothing. */
export interface PWildcard extends NodeBase {
  readonly kind: 'PWildcard';
}

/** `x` — matches anything and binds it. */
export interface PBinding extends NodeBase {
  readonly kind: 'PBinding';
  readonly name: string;
}

/** `1`, `"a"`, `true`, `nil` — matches by equality. */
export interface PLiteral extends NodeBase {
  readonly kind: 'PLiteral';
  readonly value: Expr;
}

/** `Status.Done`, `Ok(v)`, `Some(x)` — matches an enum variant and binds payloads. */
export interface PEnum extends NodeBase {
  readonly kind: 'PEnum';
  /** `Status` in `Status.Done`; undefined for bare `Ok(v)` / `Some(x)` / `None`. */
  readonly enumName: string | undefined;
  readonly variant: string;
  readonly args: readonly Pattern[];
}

/** `Task { title, done: true }` — matches a struct and destructures fields. */
export interface PStruct extends NodeBase {
  readonly kind: 'PStruct';
  readonly name: string;
  readonly fields: readonly { readonly name: string; readonly pattern: Pattern }[];
}

/** `[a, b]` or `[first, ..rest]`. */
export interface PList extends NodeBase {
  readonly kind: 'PList';
  readonly items: readonly Pattern[];
  /** Name bound to the remaining elements by a trailing `..rest`. */
  readonly rest: string | undefined;
}

// -------------------------------------------------------------- statements

export type Stmt =
  | LetDecl
  | DestructureDecl
  | FnDecl
  | StructDecl
  | EnumDecl
  | ReturnStmt
  | WhileStmt
  | ForStmt
  | BreakStmt
  | ContinueStmt
  | ExprStmt
  | ImportDecl
  | ExportDecl;

export interface Block extends NodeBase {
  readonly kind: 'Block';
  readonly stmts: readonly Stmt[];
}

/** `let` (immutable) and `var` (mutable) share one node, discriminated by `mutable`. */
export interface LetDecl extends NodeBase {
  readonly kind: 'LetDecl';
  readonly name: string;
  readonly mutable: boolean;
  readonly type: TypeExpr | undefined;
  readonly value: Expr;
}

/**
 * `let [a, b] = pair` — a binding whose left side is a pattern.
 *
 * Separate from `LetDecl` because the overwhelmingly common case is one name,
 * and giving that case a plain `name` keeps every consumer of it simple. The
 * pattern language is the same one `match` and `for` use, so a destructuring
 * `let` needed no new matching rules.
 */
export interface DestructureDecl extends NodeBase {
  readonly kind: 'DestructureDecl';
  readonly pattern: Pattern;
  readonly mutable: boolean;
  readonly value: Expr;
}

export interface FnDecl extends NodeBase {
  readonly kind: 'FnDecl';
  readonly name: string;
  readonly params: readonly Param[];
  readonly ret: TypeExpr | undefined;
  readonly body: Block;
}

export interface StructField extends NodeBase {
  readonly name: string;
  readonly type: TypeExpr | undefined;
}

export interface StructDecl extends NodeBase {
  readonly kind: 'StructDecl';
  readonly name: string;
  readonly fields: readonly StructField[];
}

export interface EnumVariant extends NodeBase {
  readonly name: string;
  readonly fields: readonly TypeExpr[];
}

export interface EnumDecl extends NodeBase {
  readonly kind: 'EnumDecl';
  readonly name: string;
  readonly variants: readonly EnumVariant[];
}

export interface ReturnStmt extends NodeBase {
  readonly kind: 'ReturnStmt';
  readonly value: Expr | undefined;
}

export interface WhileStmt extends NodeBase {
  readonly kind: 'WhileStmt';
  readonly condition: Expr;
  readonly body: Block;
}

export interface ForStmt extends NodeBase {
  readonly kind: 'ForStmt';
  readonly binding: Pattern;
  readonly iterable: Expr;
  readonly body: Block;
}

export interface BreakStmt extends NodeBase {
  readonly kind: 'BreakStmt';
}

export interface ContinueStmt extends NodeBase {
  readonly kind: 'ContinueStmt';
}

export interface ExprStmt extends NodeBase {
  readonly kind: 'ExprStmt';
  readonly expr: Expr;
}

export interface ImportSpecifier extends NodeBase {
  readonly name: string;
  readonly alias: string | undefined;
}

export interface ImportDecl extends NodeBase {
  readonly kind: 'ImportDecl';
  readonly specifiers: readonly ImportSpecifier[];
  /** Module path as written, e.g. `"std/list"` or `"./util.lm"`. */
  readonly from: string;
}

export interface ExportDecl extends NodeBase {
  readonly kind: 'ExportDecl';
  readonly declaration: LetDecl | FnDecl | StructDecl | EnumDecl;
}

// ------------------------------------------------------------------ module

export interface Module extends NodeBase {
  readonly kind: 'Module';
  readonly file: string;
  readonly stmts: readonly Stmt[];
}
