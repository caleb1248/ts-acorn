// Internal syntax tree representation.
//
// Every node is a plain object with a `type` discriminant and a
// `span`. Nodes are built once their contents are known, and are
// treated as immutable afterwards (with the exception of
// `ExpressionStatement.directive`, which is filled in once the
// directive prologue of a body is known). Conversions like turning an
// expression into an assignment pattern build new nodes.
//
// The public ESTree shape (see estree.ts) is produced from this by
// estree-convert.ts.

import type {Position} from "./locutil.ts"

export interface Span {
  start: number
  end: number
  // Only present when the `locations` option is on.
  startLoc: Position | undefined
  endLoc: Position | undefined
}

// The start position of a node whose end isn't known yet.
export interface NodeStart {
  start: number
  loc: Position | undefined
}

export type LiteralValue = string | number | boolean | bigint | RegExp | null

export interface Identifier {
  type: "Identifier"
  span: Span
  name: string
}

export interface PrivateIdentifier {
  type: "PrivateIdentifier"
  span: Span
  name: string
}

export interface Literal {
  type: "Literal"
  span: Span
  value: LiteralValue
  raw: string
  bigint: string | undefined
  regex: {pattern: string, flags: string} | undefined
}

export interface Program {
  type: "Program"
  span: Span
  body: Statement[]
  sourceType: "script" | "module" | undefined
}

// ## Statements

export interface ExpressionStatement {
  type: "ExpressionStatement"
  span: Span
  expression: Expression
  directive: string | undefined
}

export interface BlockStatement {
  type: "BlockStatement"
  span: Span
  body: Statement[]
}

export interface EmptyStatement {
  type: "EmptyStatement"
  span: Span
}

export interface DebuggerStatement {
  type: "DebuggerStatement"
  span: Span
}

export interface WithStatement {
  type: "WithStatement"
  span: Span
  object: Expression
  body: Statement
}

export interface ReturnStatement {
  type: "ReturnStatement"
  span: Span
  argument: Expression | null
}

export interface LabeledStatement {
  type: "LabeledStatement"
  span: Span
  body: Statement
  label: Identifier
}

export interface BreakStatement {
  type: "BreakStatement" | "ContinueStatement"
  span: Span
  label: Identifier | null
}

export interface IfStatement {
  type: "IfStatement"
  span: Span
  test: Expression
  consequent: Statement
  alternate: Statement | null
}

export interface SwitchStatement {
  type: "SwitchStatement"
  span: Span
  discriminant: Expression
  cases: SwitchCase[]
}

export interface SwitchCase {
  type: "SwitchCase"
  span: Span
  consequent: Statement[]
  test: Expression | null
}

export interface ThrowStatement {
  type: "ThrowStatement"
  span: Span
  argument: Expression
}

export interface TryStatement {
  type: "TryStatement"
  span: Span
  block: BlockStatement
  handler: CatchClause | null
  finalizer: BlockStatement | null
}

export interface CatchClause {
  type: "CatchClause"
  span: Span
  param: Pattern | null
  body: BlockStatement
}

export interface WhileStatement {
  type: "WhileStatement"
  span: Span
  test: Expression
  body: Statement
}

export interface DoWhileStatement {
  type: "DoWhileStatement"
  span: Span
  body: Statement
  test: Expression
}

export interface ForStatement {
  type: "ForStatement"
  span: Span
  init: VariableDeclaration | Expression | null
  test: Expression | null
  update: Expression | null
  body: Statement
}

export interface ForInStatement {
  type: "ForInStatement" | "ForOfStatement"
  span: Span
  // Only present on for-of loops when ecmaVersion >= 9
  await: boolean | undefined
  left: VariableDeclaration | Pattern
  right: Expression
  body: Statement
}

export type VariableKind = "var" | "let" | "const" | "using" | "await using"

export interface VariableDeclaration {
  type: "VariableDeclaration"
  span: Span
  declarations: VariableDeclarator[]
  kind: VariableKind
}

export interface VariableDeclarator {
  type: "VariableDeclarator"
  span: Span
  id: Pattern
  init: Expression | null
}

// ## Functions and classes

export interface FunctionNode {
  type: "FunctionDeclaration" | "FunctionExpression" | "ArrowFunctionExpression"
  span: Span
  id: Identifier | null
  // `generator` and `expression` are initialized together when
  // ecmaVersion >= 6. Before that, `generator` is absent and the
  // `expression` property is only added once the body is parsed.
  expression: boolean
  generator: boolean | undefined
  // Only present when ecmaVersion >= 8
  async: boolean | undefined
  params: Pattern[]
  body: BlockStatement | Expression
}

export interface ClassNode {
  type: "ClassDeclaration" | "ClassExpression"
  span: Span
  id: Identifier | null
  superClass: Expression | null
  body: ClassBody
}

export interface ClassBody {
  type: "ClassBody"
  span: Span
  body: ClassElement[]
}

export type ClassElement = MethodDefinition | PropertyDefinition | StaticBlock

export interface MethodDefinition {
  type: "MethodDefinition"
  span: Span
  static: boolean
  computed: boolean
  key: Expression
  kind: "constructor" | "method" | "get" | "set"
  value: FunctionNode
}

export interface PropertyDefinition {
  type: "PropertyDefinition"
  span: Span
  static: boolean
  computed: boolean
  key: Expression
  value: Expression | null
}

export interface StaticBlock {
  type: "StaticBlock"
  span: Span
  body: Statement[]
}

// ## Expressions

export interface ThisExpression {
  type: "ThisExpression"
  span: Span
}

export interface Super {
  type: "Super"
  span: Span
}

export interface ArrayExpression {
  type: "ArrayExpression"
  span: Span
  elements: Array<Expression | SpreadElement | null>
}

export interface ObjectExpression {
  type: "ObjectExpression"
  span: Span
  properties: Array<Property | SpreadElement>
}

export interface Property {
  type: "Property"
  span: Span
  // `method`, `shorthand`, and `computed` are only present when
  // ecmaVersion >= 6
  method: boolean | undefined
  shorthand: boolean | undefined
  computed: boolean | undefined
  key: Expression
  value: Expression | Pattern
  kind: "init" | "get" | "set"
}

export interface SpreadElement {
  type: "SpreadElement"
  span: Span
  argument: Expression
}

export interface UnaryExpression {
  type: "UnaryExpression"
  span: Span
  operator: string
  prefix: boolean
  argument: Expression
}

export interface UpdateExpression {
  type: "UpdateExpression"
  span: Span
  operator: string
  prefix: boolean
  argument: Expression
}

export interface BinaryExpression {
  type: "BinaryExpression" | "LogicalExpression"
  span: Span
  left: Expression
  operator: string
  right: Expression
}

export interface AssignmentExpression {
  type: "AssignmentExpression"
  span: Span
  operator: string
  left: Pattern
  right: Expression
}

export interface MemberExpression {
  type: "MemberExpression"
  span: Span
  object: Expression
  property: Expression
  computed: boolean
  // Only present when ecmaVersion >= 11
  optional: boolean | undefined
}

export interface ConditionalExpression {
  type: "ConditionalExpression"
  span: Span
  test: Expression
  consequent: Expression
  alternate: Expression
}

export interface CallExpression {
  type: "CallExpression"
  span: Span
  callee: Expression
  arguments: Array<Expression | SpreadElement>
  // Only present when ecmaVersion >= 11
  optional: boolean | undefined
}

export interface NewExpression {
  type: "NewExpression"
  span: Span
  callee: Expression
  arguments: Array<Expression | SpreadElement>
}

export interface SequenceExpression {
  type: "SequenceExpression"
  span: Span
  expressions: Expression[]
}

export interface YieldExpression {
  type: "YieldExpression"
  span: Span
  delegate: boolean
  argument: Expression | null
}

export interface AwaitExpression {
  type: "AwaitExpression"
  span: Span
  argument: Expression
}

export interface TemplateLiteral {
  type: "TemplateLiteral"
  span: Span
  expressions: Expression[]
  quasis: TemplateElement[]
}

export interface TemplateElement {
  type: "TemplateElement"
  span: Span
  value: {raw: string, cooked: string | null}
  tail: boolean
}

export interface TaggedTemplateExpression {
  type: "TaggedTemplateExpression"
  span: Span
  tag: Expression
  quasi: TemplateLiteral
}

export interface MetaProperty {
  type: "MetaProperty"
  span: Span
  meta: Identifier
  property: Identifier
}

export interface ChainExpression {
  type: "ChainExpression"
  span: Span
  expression: Expression
}

export interface ImportExpression {
  type: "ImportExpression"
  span: Span
  source: Expression
  // Only present when ecmaVersion >= 16
  options: Expression | null | undefined
}

export interface ParenthesizedExpression {
  type: "ParenthesizedExpression"
  span: Span
  expression: Expression | Pattern
}

// ## Patterns

export interface ObjectPattern {
  type: "ObjectPattern"
  span: Span
  properties: Array<Property | RestElement>
}

export interface ArrayPattern {
  type: "ArrayPattern"
  span: Span
  elements: Array<Pattern | null>
}

export interface RestElement {
  type: "RestElement"
  span: Span
  argument: Pattern
}

export interface AssignmentPattern {
  type: "AssignmentPattern"
  span: Span
  left: Pattern
  right: Expression
}

// ## Modules

export interface ImportDeclaration {
  type: "ImportDeclaration"
  span: Span
  specifiers: ImportSpecifierNode[]
  source: Literal
  // Only present when ecmaVersion >= 16
  attributes: ImportAttribute[] | undefined
}

export type ImportSpecifierNode = ImportSpecifier | ImportDefaultSpecifier

export interface ImportSpecifier {
  type: "ImportSpecifier"
  span: Span
  imported: Identifier | Literal
  local: Identifier
}

export interface ImportDefaultSpecifier {
  type: "ImportDefaultSpecifier" | "ImportNamespaceSpecifier"
  span: Span
  local: Identifier
}

export interface ImportAttribute {
  type: "ImportAttribute"
  span: Span
  key: Identifier | Literal
  value: Literal
}

export interface ExportNamedDeclaration {
  type: "ExportNamedDeclaration"
  span: Span
  declaration: Statement | null
  specifiers: ExportSpecifier[]
  source: Literal | null
  // Only present when ecmaVersion >= 16
  attributes: ImportAttribute[] | undefined
}

export interface ExportSpecifier {
  type: "ExportSpecifier"
  span: Span
  local: Identifier | Literal
  exported: Identifier | Literal
}

export interface ExportDefaultDeclaration {
  type: "ExportDefaultDeclaration"
  span: Span
  declaration: FunctionNode | ClassNode | Expression
}

export interface ExportAllDeclaration {
  type: "ExportAllDeclaration"
  span: Span
  // Only present when ecmaVersion >= 11
  exported: Identifier | Literal | null | undefined
  source: Literal
  // Only present when ecmaVersion >= 16
  attributes: ImportAttribute[] | undefined
}

// ## Unions

// Acorn is lenient about what may appear in expression position
// internally (`super` and private names are parsed by the expression
// parser and rejected later where needed), so this union is broader
// than the ESTree one.
export type Expression =
  | Identifier
  | PrivateIdentifier
  | Literal
  | ThisExpression
  | Super
  | ArrayExpression
  | ObjectExpression
  | FunctionNode
  | ClassNode
  | UnaryExpression
  | UpdateExpression
  | BinaryExpression
  | AssignmentExpression
  | MemberExpression
  | ConditionalExpression
  | CallExpression
  | NewExpression
  | SequenceExpression
  | YieldExpression
  | AwaitExpression
  | TemplateLiteral
  | TaggedTemplateExpression
  | MetaProperty
  | ChainExpression
  | ImportExpression
  | ParenthesizedExpression

export type Pattern =
  | Identifier
  | MemberExpression
  | ObjectPattern
  | ArrayPattern
  | RestElement
  | AssignmentPattern
  | ParenthesizedExpression

export type Statement =
  | ExpressionStatement
  | BlockStatement
  | EmptyStatement
  | DebuggerStatement
  | WithStatement
  | ReturnStatement
  | LabeledStatement
  | BreakStatement
  | IfStatement
  | SwitchStatement
  | ThrowStatement
  | TryStatement
  | WhileStatement
  | DoWhileStatement
  | ForStatement
  | ForInStatement
  | VariableDeclaration
  | FunctionNode
  | ClassNode
  | ImportDeclaration
  | ExportNamedDeclaration
  | ExportDefaultDeclaration
  | ExportAllDeclaration

export type Node =
  | Expression
  | Pattern
  | Statement
  | Program
  | SwitchCase
  | CatchClause
  | VariableDeclarator
  | ClassBody
  | MethodDefinition
  | PropertyDefinition
  | StaticBlock
  | Property
  | SpreadElement
  | TemplateElement
  | ImportSpecifier
  | ImportDefaultSpecifier
  | ImportAttribute
  | ExportSpecifier

export function isPattern(node: Node): node is Pattern {
  switch (node.type) {
  case "Identifier": case "MemberExpression": case "ObjectPattern": case "ArrayPattern":
  case "RestElement": case "AssignmentPattern": case "ParenthesizedExpression":
    return true
  default:
    return false
  }
}
