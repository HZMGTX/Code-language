/**
 * `@lumen-lang/core` — the Lumen language itself.
 *
 * This package contains the lexer, parser, AST, value model, and interpreter,
 * and deliberately imports nothing from Node. Everything the language needs
 * from the outside world arrives through the `Host` interface, which is what
 * keeps a future browser or embedded target a wiring exercise rather than a
 * rewrite.
 */

export const VERSION = '0.2.0';

export {
  LumenError,
  formatDiagnostic,
  joinSpans,
  pos,
  span,
  type Diagnostic,
  type Note,
  type Pos,
  type Severity,
  type Span,
} from './diagnostics.js';

export {
  KEYWORDS,
  OPERATORS,
  describe,
  describeToken,
  type Comment,
  type TemplatePart,
  type Token,
  type TokenKind,
} from './token.js';

export { Lexer, lex, lexWithComments } from './lexer.js';

export { format } from './format.js';

export { Parser, parse, parseExpression } from './parser.js';

export { resolve, checkModule, type Reference, type ResolveOptions } from './resolver.js';

export {
  UNIVERSAL,
  accepts,
  checkTypes,
  methodTy,
  showSignature,
  showTy,
  signatureTy,
  typeNameOf,
  type CheckOptions,
  type ParamTy,
  type Ty,
} from './types.js';

export type * as ast from './ast.js';
export type {
  Arg,
  Block,
  Expr,
  Module,
  Param,
  Pattern,
  Stmt,
  TypeExpr,
} from './ast.js';

export {
  Env,
  FALSE,
  NIL,
  NONE,
  TRUE,
  bool,
  display,
  editDistance,
  enumValue,
  err,
  inspect,
  list,
  map,
  num,
  ok,
  some,
  str,
  suggest,
  truthy,
  typeName,
  valuesEqual,
  type BoolValue,
  type CallCtx,
  type EnumTypeValue,
  type EnumValue,
  type FnValue,
  type Host,
  type ListValue,
  type MapValue,
  type ModuleValue,
  type NativeParam,
  type NativeValue,
  type NilValue,
  type NumValue,
  type Slot,
  type SourceUnit,
  type StrValue,
  type StructTypeValue,
  type StructValue,
  type Value,
} from './values.js';

export {
  Interpreter,
  native,
  variadic,
  type EvaluatedArg,
  type InterpreterOptions,
  type ModuleResolver,
  type ResolvedModule,
} from './interp.js';
