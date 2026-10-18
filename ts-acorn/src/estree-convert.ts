// Conversion from the internal syntax tree (ast.ts) to the ESTree
// objects that acorn's public API returns.
//
// The output is described with a generic JSON-like object type. The
// precise public typings live in the hand-written acorn.d.ts that is
// shipped alongside the build, just like in the JavaScript version.
//
// Properties are emitted in the same order the original
// implementation created them in, and properties that the original
// only added for some ECMAScript versions are left out when their
// internal value is `undefined`.

import {Position, SourceLocation} from "./locutil.ts"
import type {NormalizedOptions} from "./options.ts"
import type {Node, Span} from "./ast.ts"
import {unreachable} from "./util.ts"

export type ESTreeValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | RegExp
  | Position
  | SourceLocation
  | ESTreeObject
  | ESTreeValue[]

export interface ESTreeObject {
  [key: string]: ESTreeValue
}

export class Converter {
  options: NormalizedOptions
  // Nodes that are referenced from more than one place in the tree
  // (an import specifier's `local` and `imported`, for example)
  // convert to the same object.
  converted: Map<Node, ESTreeObject>

  constructor(options: NormalizedOptions) {
    this.options = options
    this.converted = new Map()
  }

  node(node: Node): ESTreeObject {
    let known = this.converted.get(node)
    if (known) return known
    let result = this.convert(node)
    this.converted.set(node, result)
    return result
  }

  nodeOrNull(node: Node | null): ESTreeObject | null {
    return node ? this.node(node) : null
  }

  // Like `nodeOrNull`, but keeps `undefined` (an absent property) apart.
  optional(node: Node | null | undefined): ESTreeObject | null | undefined {
    return node === undefined ? undefined : this.nodeOrNull(node)
  }

  list(nodes: ReadonlyArray<Node | null>): ESTreeValue[] {
    return nodes.map(node => this.nodeOrNull(node))
  }

  make(type: string, span: Span, fields: Array<[string, ESTreeValue]>): ESTreeObject {
    let out: ESTreeObject = {type, start: span.start, end: span.end}
    if (this.options.locations)
      out.loc = new SourceLocation(this.options, span.startLoc || unreachable("missing start location"), span.endLoc)
    if (this.options.directSourceFile)
      out.sourceFile = this.options.directSourceFile
    if (this.options.ranges)
      out.range = [span.start, span.end]
    for (let [key, value] of fields)
      if (value !== undefined) out[key] = value
    return out
  }

  convert(n: Node): ESTreeObject {
    switch (n.type) {
    case "Identifier":
    case "PrivateIdentifier":
      return this.make(n.type, n.span, [["name", n.name]])

    case "Literal": {
      let fields: Array<[string, ESTreeValue]> = [["value", n.value], ["raw", n.raw], ["bigint", n.bigint]]
      if (n.regex) fields.push(["regex", {pattern: n.regex.pattern, flags: n.regex.flags}])
      return this.make(n.type, n.span, fields)
    }

    case "Program": {
      let out = this.make(n.type, n.span, [["body", this.list(n.body)]])
      // The original assigned this even when it was undefined.
      out.sourceType = n.sourceType
      return out
    }

    case "ExpressionStatement":
      return this.make(n.type, n.span, [["expression", this.node(n.expression)], ["directive", n.directive]])

    case "BlockStatement":
    case "StaticBlock":
    case "ClassBody":
      return this.make(n.type, n.span, [["body", this.list(n.body)]])

    case "EmptyStatement":
    case "DebuggerStatement":
    case "ThisExpression":
    case "Super":
      return this.make(n.type, n.span, [])

    case "WithStatement":
      return this.make(n.type, n.span, [["object", this.node(n.object)], ["body", this.node(n.body)]])

    case "ReturnStatement":
      return this.make(n.type, n.span, [["argument", this.nodeOrNull(n.argument)]])

    case "LabeledStatement":
      return this.make(n.type, n.span, [["body", this.node(n.body)], ["label", this.node(n.label)]])

    case "BreakStatement":
    case "ContinueStatement":
      return this.make(n.type, n.span, [["label", this.nodeOrNull(n.label)]])

    case "IfStatement":
      return this.make(n.type, n.span, [
        ["test", this.node(n.test)], ["consequent", this.node(n.consequent)], ["alternate", this.nodeOrNull(n.alternate)]
      ])

    case "SwitchStatement":
      return this.make(n.type, n.span, [["discriminant", this.node(n.discriminant)], ["cases", this.list(n.cases)]])

    case "SwitchCase":
      return this.make(n.type, n.span, [["consequent", this.list(n.consequent)], ["test", this.nodeOrNull(n.test)]])

    case "ThrowStatement":
    case "SpreadElement":
    case "AwaitExpression":
      return this.make(n.type, n.span, [["argument", this.node(n.argument)]])

    case "RestElement":
      return this.make(n.type, n.span, [["argument", this.node(n.argument)]])

    case "TryStatement":
      return this.make(n.type, n.span, [
        ["block", this.node(n.block)], ["handler", this.nodeOrNull(n.handler)], ["finalizer", this.nodeOrNull(n.finalizer)]
      ])

    case "CatchClause":
      return this.make(n.type, n.span, [["param", this.nodeOrNull(n.param)], ["body", this.node(n.body)]])

    case "WhileStatement":
      return this.make(n.type, n.span, [["test", this.node(n.test)], ["body", this.node(n.body)]])

    case "DoWhileStatement":
      return this.make(n.type, n.span, [["body", this.node(n.body)], ["test", this.node(n.test)]])

    case "ForStatement":
      return this.make(n.type, n.span, [
        ["init", this.nodeOrNull(n.init)], ["test", this.nodeOrNull(n.test)],
        ["update", this.nodeOrNull(n.update)], ["body", this.node(n.body)]
      ])

    case "ForInStatement":
    case "ForOfStatement":
      return this.make(n.type, n.span, [
        ["await", n.await], ["left", this.node(n.left)], ["right", this.node(n.right)], ["body", this.node(n.body)]
      ])

    case "VariableDeclaration":
      return this.make(n.type, n.span, [["declarations", this.list(n.declarations)], ["kind", n.kind]])

    case "VariableDeclarator":
      return this.make(n.type, n.span, [["id", this.node(n.id)], ["init", this.nodeOrNull(n.init)]])

    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      let id = this.nodeOrNull(n.id), params = this.list(n.params), body = this.node(n.body)
      // Before ES6, `generator` and `expression` were not initialized
      // up front, and `expression` was only added after the body.
      if (n.generator === undefined)
        return this.make(n.type, n.span, [["id", id], ["params", params], ["body", body], ["expression", n.expression]])
      return this.make(n.type, n.span, [
        ["id", id], ["expression", n.expression], ["generator", n.generator], ["async", n.async],
        ["params", params], ["body", body]
      ])
    }

    case "ClassDeclaration":
    case "ClassExpression":
      return this.make(n.type, n.span, [
        ["id", this.nodeOrNull(n.id)], ["superClass", this.nodeOrNull(n.superClass)], ["body", this.node(n.body)]
      ])

    case "MethodDefinition":
      return this.make(n.type, n.span, [
        ["static", n.static], ["computed", n.computed], ["key", this.node(n.key)], ["kind", n.kind], ["value", this.node(n.value)]
      ])

    case "PropertyDefinition":
      return this.make(n.type, n.span, [
        ["static", n.static], ["computed", n.computed], ["key", this.node(n.key)], ["value", this.nodeOrNull(n.value)]
      ])

    case "ArrayExpression":
    case "ArrayPattern":
      return this.make(n.type, n.span, [["elements", this.list(n.elements)]])

    case "ObjectExpression":
    case "ObjectPattern":
      return this.make(n.type, n.span, [["properties", this.list(n.properties)]])

    case "Property":
      return this.make(n.type, n.span, [
        ["method", n.method], ["shorthand", n.shorthand], ["computed", n.computed],
        ["key", this.node(n.key)], ["value", this.node(n.value)], ["kind", n.kind]
      ])

    case "UnaryExpression":
    case "UpdateExpression":
      return this.make(n.type, n.span, [["operator", n.operator], ["prefix", n.prefix], ["argument", this.node(n.argument)]])

    case "BinaryExpression":
    case "LogicalExpression":
      return this.make(n.type, n.span, [["left", this.node(n.left)], ["operator", n.operator], ["right", this.node(n.right)]])

    case "AssignmentExpression":
      return this.make(n.type, n.span, [["operator", n.operator], ["left", this.node(n.left)], ["right", this.node(n.right)]])

    case "AssignmentPattern":
      return this.make(n.type, n.span, [["left", this.node(n.left)], ["right", this.node(n.right)]])

    case "MemberExpression":
      return this.make(n.type, n.span, [
        ["object", this.node(n.object)], ["property", this.node(n.property)], ["computed", n.computed], ["optional", n.optional]
      ])

    case "ConditionalExpression":
      return this.make(n.type, n.span, [
        ["test", this.node(n.test)], ["consequent", this.node(n.consequent)], ["alternate", this.node(n.alternate)]
      ])

    case "CallExpression":
      return this.make(n.type, n.span, [
        ["callee", this.node(n.callee)], ["arguments", this.list(n.arguments)], ["optional", n.optional]
      ])

    case "NewExpression":
      return this.make(n.type, n.span, [["callee", this.node(n.callee)], ["arguments", this.list(n.arguments)]])

    case "SequenceExpression":
      return this.make(n.type, n.span, [["expressions", this.list(n.expressions)]])

    case "YieldExpression":
      return this.make(n.type, n.span, [["delegate", n.delegate], ["argument", this.nodeOrNull(n.argument)]])

    case "TemplateLiteral":
      return this.make(n.type, n.span, [["expressions", this.list(n.expressions)], ["quasis", this.list(n.quasis)]])

    case "TemplateElement":
      return this.make(n.type, n.span, [["value", {raw: n.value.raw, cooked: n.value.cooked}], ["tail", n.tail]])

    case "TaggedTemplateExpression":
      return this.make(n.type, n.span, [["tag", this.node(n.tag)], ["quasi", this.node(n.quasi)]])

    case "MetaProperty":
      return this.make(n.type, n.span, [["meta", this.node(n.meta)], ["property", this.node(n.property)]])

    case "ChainExpression":
    case "ParenthesizedExpression":
      return this.make(n.type, n.span, [["expression", this.node(n.expression)]])

    case "ImportExpression":
      return this.make(n.type, n.span, [["source", this.node(n.source)], ["options", this.optional(n.options)]])

    case "ImportDeclaration":
      return this.make(n.type, n.span, [
        ["specifiers", this.list(n.specifiers)], ["source", this.node(n.source)], ["attributes", this.optionalList(n.attributes)]
      ])

    case "ImportSpecifier":
      return this.make(n.type, n.span, [["imported", this.node(n.imported)], ["local", this.node(n.local)]])

    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
      return this.make(n.type, n.span, [["local", this.node(n.local)]])

    case "ImportAttribute":
      return this.make(n.type, n.span, [["key", this.node(n.key)], ["value", this.node(n.value)]])

    case "ExportNamedDeclaration":
      return this.make(n.type, n.span, [
        ["declaration", this.nodeOrNull(n.declaration)], ["specifiers", this.list(n.specifiers)],
        ["source", this.nodeOrNull(n.source)], ["attributes", this.optionalList(n.attributes)]
      ])

    case "ExportSpecifier":
      return this.make(n.type, n.span, [["local", this.node(n.local)], ["exported", this.node(n.exported)]])

    case "ExportDefaultDeclaration":
      return this.make(n.type, n.span, [["declaration", this.node(n.declaration)]])

    case "ExportAllDeclaration":
      return this.make(n.type, n.span, [
        ["exported", this.optional(n.exported)], ["source", this.node(n.source)], ["attributes", this.optionalList(n.attributes)]
      ])
    }
  }

  optionalList(nodes: ReadonlyArray<Node> | undefined): ESTreeValue[] | undefined {
    return nodes === undefined ? undefined : this.list(nodes)
  }
}

// ## Appending to an existing program
//
// With the `program` option, parsed statements are added to the body
// of a program produced by an earlier parse, and that program object
// is updated in place.

export function isObject(value: ESTreeValue): value is ESTreeObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    !(value instanceof RegExp) && !(value instanceof Position) && !(value instanceof SourceLocation)
}

export function programBody(program: ESTreeObject): ESTreeValue[] {
  let body = program.body
  if (!body) {
    body = []
    program.body = body
  }
  return Array.isArray(body) ? body : unreachable("program option without a body array")
}

// Set `ExpressionStatement#directive` property for directive
// prologues, on statements in the public representation.
export function adaptDirectivePrologue(options: NormalizedOptions, input: string, statements: ESTreeValue[]): void {
  for (let i = 0; i < statements.length; ++i) {
    let statement = statements[i]
    if (!isObject(statement) || !isDirectiveCandidate(options, input, statement)) break
    let expression = statement.expression, raw = isObject(expression) ? expression.raw : undefined
    statement.directive = typeof raw === "string" ? raw.slice(1, -1) : unreachable("directive without raw text")
  }
}

function isDirectiveCandidate(options: NormalizedOptions, input: string, statement: ESTreeObject): boolean {
  let expression = statement.expression, start = statement.start
  return (
    options.ecmaVersion >= 5 &&
    statement.type === "ExpressionStatement" &&
    isObject(expression) &&
    expression.type === "Literal" &&
    typeof expression.value === "string" &&
    typeof start === "number" &&
    // Reject parenthesized strings.
    (input[start] === "\"" || input[start] === "'")
  )
}

// Finish the program node: set its type and end position.
export function finishProgram(options: NormalizedOptions, program: ESTreeObject, end: number, endLoc: Position | undefined): void {
  program.type = "Program"
  program.end = end
  if (options.locations) {
    let loc = program.loc
    if (loc instanceof SourceLocation) loc.end = endLoc
    else if (isObject(loc)) loc.end = endLoc
    else unreachable("program option without a location")
  }
  if (options.ranges) {
    let range = program.range
    if (Array.isArray(range)) range[1] = end
    else unreachable("program option without a range")
  }
}
