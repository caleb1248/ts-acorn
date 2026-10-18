// A recursive descent parser operates by defining functions for all
// syntactic elements, and recursively calling those, each function
// advancing the input stream and returning an AST node. Precedence
// of constructs (for example, the fact that `!x[1]` means `!(x[1])`
// instead of `(!x)[1]` is handled by the fact that the parser
// function that parses unary prefix operators is called first, and
// in turn calls the function that parses `[]` subscripts — that
// way, it'll receive the node for `x[1]` already parsed, and wraps
// *that* in the unary operator node.
//
// Acorn uses an [operator precedence parser][opp] to handle binary
// operator precedence, because it is much more compact than using
// the technique outlined above, which uses different, nesting
// functions to specify precedence, for all of the ten binary
// precedence levels that JavaScript defines.
//
// [opp]: http://en.wikipedia.org/wiki/Operator-precedence_parser

import {types as tt, type TokenType} from "./tokentype.ts"
import {types as tokenCtxTypes, overrideContext} from "./tokencontext.ts"
import type {Parser, RegExpTokenValue} from "./state.ts"
import type {Position} from "./locutil.ts"
import type {
  Expression, Identifier, Literal, LiteralValue, Node, NodeStart, Pattern, PrivateIdentifier,
  Property, RestElement, SpreadElement, TemplateElement, TemplateLiteral, FunctionNode,
  ObjectExpression, ObjectPattern, ImportExpression, MetaProperty, BlockStatement
} from "./ast.ts"
import {isPattern} from "./ast.ts"
import {
  DestructuringErrors, eat, expect, unexpected, isContextual, canInsertSemicolon,
  afterTrailingComma, checkPatternErrors, checkExpressionErrors, checkYieldAwaitInDefaultParams,
  isSimpleAssignTarget, catchStackOverflow, strictDirective
} from "./parseutil.ts"
import {lineBreak} from "./whitespace.ts"
import {functionFlags, SCOPE_ARROW, SCOPE_SUPER, SCOPE_DIRECT_SUPER, BIND_OUTSIDE, BIND_VAR, SCOPE_VAR} from "./scopeflags.ts"
import {raise, raiseRecoverable} from "./location.ts"
import {next, readRegexp} from "./tokenize.ts"
import {startNode, startNodeAt, finishSpan, finishSpanAt} from "./node.ts"
import {
  toAssignable, toAssignableList, checkLValSimple, checkLValPattern, checkLValInnerPattern,
  parseMaybeDefault, parseBindingList, parseRestBinding, parseSpread
} from "./lval.ts"
import {
  enterScope, exitScope, inGenerator, inAsync, canAwait, allowSuper, allowDirectSuper,
  allowNewDotTarget, currentThisScope, inClassStaticBlock
} from "./scope.ts"
import {parseFunction, parseClass, parseBlock, adaptDirectivePrologue} from "./statement.ts"
import {noNulls, unreachable} from "./util.ts"

// The `forInit` argument is true when parsing the init part of a
// `for` statement (where `in` is not an operator), and "await" when
// parsing the head of a `for await` loop.
export type ForInit = boolean | "await"

// The value of the current token, for token types whose value is
// always a string.
export function tokenString(p: Parser): string {
  let value = p.value
  return typeof value === "string" ? value : unreachable("expected a string token value")
}

export function tokenLiteralValue(p: Parser): LiteralValue {
  let value = p.value
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value === null)
    return value
  return unreachable("expected a literal token value")
}

function tokenRegExpValue(p: Parser): RegExpTokenValue {
  let value = p.value
  if (typeof value === "object" && value !== null) return value
  return unreachable("expected a regexp token value")
}

// Check if property name clashes with already added.
// Object/class getters and setters are not allowed to clash —
// either with each other or with an init property — and in
// strict mode, init properties are also not allowed to be repeated.

interface PropKinds {
  init: boolean
  get: boolean
  set: boolean
}

export interface PropHash {
  proto: boolean
  names: Map<string, PropKinds>
}

function checkPropClash(p: Parser, prop: Property | SpreadElement, propHash: PropHash, refDestructuringErrors: DestructuringErrors | null | undefined): void {
  if (p.options.ecmaVersion >= 9 && prop.type === "SpreadElement")
    return
  if (prop.type === "SpreadElement")
    return unreachable("spread property before ES2018")
  if (p.options.ecmaVersion >= 6 && (prop.computed || prop.method || prop.shorthand))
    return
  let {key} = prop, name
  switch (key.type) {
  case "Identifier": name = key.name; break
  case "Literal": name = String(key.value); break
  default: return
  }
  let {kind} = prop
  if (p.options.ecmaVersion >= 6) {
    if (name === "__proto__" && kind === "init") {
      if (propHash.proto) {
        if (refDestructuringErrors) {
          if (refDestructuringErrors.doubleProto < 0) {
            refDestructuringErrors.doubleProto = key.span.start
          }
        } else {
          raiseRecoverable(p, key.span.start, "Redefinition of __proto__ property")
        }
      }
      propHash.proto = true
    }
    return
  }
  let other = propHash.names.get(name)
  if (other) {
    let redefinition
    if (kind === "init") {
      redefinition = p.strict && other.init || other.get || other.set
    } else {
      redefinition = other.init || other[kind]
    }
    if (redefinition)
      raiseRecoverable(p, key.span.start, "Redefinition of property")
  } else {
    other = {
      init: false,
      get: false,
      set: false
    }
    propHash.names.set(name, other)
  }
  other[kind] = true
}

// ### Expression parsing

// These nest, from the most general expression type at the top to
// 'atomic', nondivisible expression types at the bottom. Most of
// the functions will simply let the function(s) below them parse,
// and, *if* the syntactic construct they handle is present, wrap
// the AST node that the inner parser gave them in another node.

// Parse a full expression. The optional arguments are used to
// forbid the `in` operator (in for loops initalization expressions)
// and provide reference for storing '=' operator inside shorthand
// property assignment in contexts where both object expression
// and object pattern might appear (so it's possible to raise
// delayed syntax error at correct position).

export function parseExpression(p: Parser, forInit?: ForInit, refDestructuringErrors?: DestructuringErrors | null): Expression {
  return catchStackOverflow(p, () => {
    let startPos = p.start, startLoc = p.startLoc
    let expr = parseMaybeAssign(p, forInit, refDestructuringErrors)
    if (p.type === tt.comma) {
      let node = startNodeAt(startPos, startLoc)
      let expressions = [expr]
      while (eat(p, tt.comma)) expressions.push(parseMaybeAssign(p, forInit, refDestructuringErrors))
      return {type: "SequenceExpression", span: finishSpan(p, node), expressions}
    }
    return expr
  })
}

// Parse an assignment expression. This includes applications of
// operators like `+=`.

export function parseMaybeAssign(p: Parser, forInit?: ForInit, refDestructuringErrors?: DestructuringErrors | null): Expression {
  if (isContextual(p, "yield")) {
    if (inGenerator(p)) return parseYield(p, forInit)
    // The tokenizer will assume an expression is allowed after
    // `yield`, but this isn't that kind of yield
    else p.exprAllowed = false
  }

  let ownDestructuringErrors = false, oldParenAssign = -1, oldTrailingComma = -1, oldDoubleProto = -1
  if (refDestructuringErrors) {
    oldParenAssign = refDestructuringErrors.parenthesizedAssign
    oldTrailingComma = refDestructuringErrors.trailingComma
    oldDoubleProto = refDestructuringErrors.doubleProto
    refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1
  } else {
    refDestructuringErrors = new DestructuringErrors
    ownDestructuringErrors = true
  }

  let startPos = p.start, startLoc = p.startLoc
  if (p.type === tt.parenL || p.type === tt.name) {
    p.potentialArrowAt = p.start
    p.potentialArrowInForAwait = forInit === "await"
  }
  let left: Expression = parseMaybeConditional(p, forInit, refDestructuringErrors)
  if (p.type.isAssign) {
    let node = startNodeAt(startPos, startLoc)
    let operator = tokenString(p)
    let target: Node = left
    if (p.type === tt.eq)
      target = toAssignable(p, left, false, refDestructuringErrors)
    if (!ownDestructuringErrors) {
      refDestructuringErrors.parenthesizedAssign = refDestructuringErrors.trailingComma = -1
      // reset these when detected inside this expression
      if (refDestructuringErrors.shorthandAssign >= target.span.start) refDestructuringErrors.shorthandAssign = -1
      if (refDestructuringErrors.doubleProto >= target.span.start) refDestructuringErrors.doubleProto = -1
    }
    if (p.type === tt.eq)
      checkLValPattern(p, target)
    else
      checkLValSimple(p, target)
    let assignLeft = isPattern(target) ? target : unreachable("invalid assignment target passed checks")
    next(p)
    let right = parseMaybeAssign(p, forInit)
    if (oldDoubleProto > -1) refDestructuringErrors.doubleProto = oldDoubleProto
    return {type: "AssignmentExpression", span: finishSpan(p, node), operator, left: assignLeft, right}
  } else {
    if (ownDestructuringErrors) checkExpressionErrors(p, refDestructuringErrors, true)
  }
  if (oldParenAssign > -1) refDestructuringErrors.parenthesizedAssign = oldParenAssign
  if (oldTrailingComma > -1) refDestructuringErrors.trailingComma = oldTrailingComma
  return left
}

// Parse a ternary conditional (`?:`) operator.

function parseMaybeConditional(p: Parser, forInit: ForInit | undefined, refDestructuringErrors: DestructuringErrors): Expression {
  let startPos = p.start, startLoc = p.startLoc
  let expr = parseExprOps(p, forInit, refDestructuringErrors)
  if (checkExpressionErrors(p, refDestructuringErrors)) return expr
  if (!(expr.type === "ArrowFunctionExpression" && expr.span.start === startPos) && eat(p, tt.question)) {
    let node = startNodeAt(startPos, startLoc)
    let consequent = parseMaybeAssign(p)
    expect(p, tt.colon)
    let alternate = parseMaybeAssign(p, forInit)
    return {type: "ConditionalExpression", span: finishSpan(p, node), test: expr, consequent, alternate}
  }
  return expr
}

// Start the precedence parser.

function parseExprOps(p: Parser, forInit: ForInit | undefined, refDestructuringErrors: DestructuringErrors): Expression {
  let startPos = p.start, startLoc = p.startLoc
  let expr = parseMaybeUnary(p, refDestructuringErrors, false, false, forInit)
  if (checkExpressionErrors(p, refDestructuringErrors)) return expr
  return expr.span.start === startPos && expr.type === "ArrowFunctionExpression" ? expr : parseExprOp(p, expr, startPos, startLoc, -1, forInit)
}

// Parse binary operators with the operator precedence parsing
// algorithm. `left` is the left-hand side of the operator.
// `minPrec` provides context that allows the function to stop and
// defer further parser to one of its callers when it encounters an
// operator that has a lower precedence than the set it is parsing.

function parseExprOp(p: Parser, left: Expression, leftStartPos: number, leftStartLoc: Position | undefined, minPrec: number, forInit: ForInit | undefined): Expression {
  let prec = p.type.binop
  if (prec != null && (!forInit || p.type !== tt._in)) {
    if (prec > minPrec) {
      let logical = p.type === tt.logicalOR || p.type === tt.logicalAND
      let coalesce = p.type === tt.coalesce
      if (coalesce) {
        // Handle the precedence of `tt.coalesce` as equal to the range of logical expressions.
        // In other words, `node.right` shouldn't contain logical expressions in order to check the mixed error.
        prec = tt.logicalAND.binop || unreachable("logicalAND has no precedence")
      }
      let op = tokenString(p)
      next(p)
      let startPos = p.start, startLoc = p.startLoc
      let right = parseExprOp(p, parseMaybeUnary(p, null, false, false, forInit), startPos, startLoc, prec, forInit)
      let node = buildBinary(p, leftStartPos, leftStartLoc, left, right, op, logical || coalesce)
      if ((logical && p.type === tt.coalesce) || (coalesce && (p.type === tt.logicalOR || p.type === tt.logicalAND))) {
        raiseRecoverable(p, p.start, "Logical expressions and coalesce expressions cannot be mixed. Wrap either by parentheses")
      }
      return parseExprOp(p, node, leftStartPos, leftStartLoc, minPrec, forInit)
    }
  }
  return left
}

function buildBinary(p: Parser, startPos: number, startLoc: Position | undefined, left: Expression, right: Expression, op: string, logical: boolean): Expression {
  if (right.type === "PrivateIdentifier") raise(p, right.span.start, "Private identifier can only be left side of binary expression")
  let node = startNodeAt(startPos, startLoc)
  return {type: logical ? "LogicalExpression" : "BinaryExpression", span: finishSpan(p, node), left, operator: op, right}
}

// Parse unary operators, both prefix and postfix.

export function parseMaybeUnary(p: Parser, refDestructuringErrors: DestructuringErrors | null, sawUnary: boolean, incDec: boolean, forInit: ForInit | undefined): Expression {
  let startPos = p.start, startLoc = p.startLoc, expr: Expression
  if (isContextual(p, "await") && canAwait(p)) {
    expr = parseAwait(p, forInit)
    sawUnary = true
  } else if (p.type.prefix) {
    let node = startNode(p), update = p.type === tt.incDec
    let operator = tokenString(p)
    next(p)
    let argument = parseMaybeUnary(p, null, true, update, forInit)
    checkExpressionErrors(p, refDestructuringErrors, true)
    if (update) checkLValSimple(p, argument)
    else if (p.strict && operator === "delete" && isLocalVariableAccess(argument))
      raiseRecoverable(p, node.start, "Deleting local variable in strict mode")
    else if (operator === "delete" && isPrivateFieldAccess(argument))
      raiseRecoverable(p, node.start, "Private fields can not be deleted")
    else sawUnary = true
    expr = {type: update ? "UpdateExpression" : "UnaryExpression", span: finishSpan(p, node), operator, prefix: true, argument}
  } else if (!sawUnary && p.type === tt.privateId) {
    if ((forInit || p.privateNameStack.length === 0) && p.options.checkPrivateFields) unexpected(p)
    expr = parsePrivateIdent(p)
    // only could be private fields in 'in', such as #x in obj
    if (p.type !== tt._in) unexpected(p)
  } else {
    expr = parseExprSubscripts(p, refDestructuringErrors, forInit)
    if (checkExpressionErrors(p, refDestructuringErrors)) return expr
    while (p.type.postfix && !canInsertSemicolon(p)) {
      let node = startNodeAt(startPos, startLoc)
      let operator = tokenString(p)
      checkLValSimple(p, expr)
      next(p)
      expr = {type: "UpdateExpression", span: finishSpan(p, node), operator, prefix: false, argument: expr}
    }
  }

  if (!incDec && !(expr.type === "ArrowFunctionExpression" && expr.span.start === startPos) && eat(p, tt.starstar)) {
    if (sawUnary)
      unexpected(p, p.lastTokStart)
    else
      return buildBinary(p, startPos, startLoc, expr, parseMaybeUnary(p, null, false, false, forInit), "**", false)
  } else {
    return expr
  }
}

function isLocalVariableAccess(node: Node): boolean {
  return (
    node.type === "Identifier" ||
    node.type === "ParenthesizedExpression" && isLocalVariableAccess(node.expression)
  )
}

function isPrivateFieldAccess(node: Node): boolean {
  return (
    node.type === "MemberExpression" && node.property.type === "PrivateIdentifier" ||
    node.type === "ChainExpression" && isPrivateFieldAccess(node.expression) ||
    node.type === "ParenthesizedExpression" && isPrivateFieldAccess(node.expression)
  )
}

// Parse call, dot, and `[]`-subscript expressions.

export function parseExprSubscripts(p: Parser, refDestructuringErrors: DestructuringErrors | null, forInit: ForInit | undefined): Expression {
  let startPos = p.start, startLoc = p.startLoc
  let oldDoubleProto = -1, oldShorthandAssign = -1
  if (refDestructuringErrors) {
    oldDoubleProto = refDestructuringErrors.doubleProto
    oldShorthandAssign = refDestructuringErrors.shorthandAssign
    refDestructuringErrors.doubleProto = refDestructuringErrors.shorthandAssign = -1
  }
  let expr = parseExprAtom(p, refDestructuringErrors, forInit)
  if (expr.type === "ArrowFunctionExpression" && p.input.slice(p.lastTokStart, p.lastTokEnd) !== ")")
    return expr
  let result = parseSubscripts(p, expr, startPos, startLoc, false, forInit)
  if (refDestructuringErrors) {
    if (result.span.end > expr.span.end) {
      checkExpressionErrors(p, refDestructuringErrors, true)
      if (refDestructuringErrors.parenthesizedAssign >= result.span.start) refDestructuringErrors.parenthesizedAssign = -1
      if (refDestructuringErrors.parenthesizedBind >= result.span.start) refDestructuringErrors.parenthesizedBind = -1
      if (refDestructuringErrors.trailingComma >= result.span.start) refDestructuringErrors.trailingComma = -1
    }
    if (oldDoubleProto > -1) refDestructuringErrors.doubleProto = oldDoubleProto
    if (oldShorthandAssign > -1) refDestructuringErrors.shorthandAssign = oldShorthandAssign
  }
  return result
}

function parseSubscripts(p: Parser, base: Expression, startPos: number, startLoc: Position | undefined, noCalls: boolean, forInit: ForInit | undefined): Expression {
  let maybeAsyncArrow = p.options.ecmaVersion >= 8 && base.type === "Identifier" && base.name === "async" &&
      p.lastTokEnd === base.span.end && !canInsertSemicolon(p) && base.span.end - base.span.start === 5 &&
      p.potentialArrowAt === base.span.start
  let optionalChained = false

  while (true) {
    let element = parseSubscript(p, base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit)

    if ((element.type === "MemberExpression" || element.type === "CallExpression") && element.optional) optionalChained = true
    if (element.span.end === base.span.end || element.type === "ArrowFunctionExpression") {
      if (optionalChained) {
        const chainNode = startNodeAt(startPos, startLoc)
        element = {type: "ChainExpression", span: finishSpan(p, chainNode), expression: element}
      }
      return element
    }

    base = element
    maybeAsyncArrow = false
  }
}

function shouldParseAsyncArrow(p: Parser): boolean {
  return !canInsertSemicolon(p) && eat(p, tt.arrow)
}

function parseSubscript(p: Parser, base: Expression, startPos: number, startLoc: Position | undefined, noCalls: boolean, maybeAsyncArrow: boolean, optionalChained: boolean, forInit: ForInit | undefined): Expression {
  let optionalSupported = p.options.ecmaVersion >= 11
  let optional = optionalSupported && eat(p, tt.questionDot)
  if (noCalls && optional) raise(p, p.lastTokStart, "Optional chaining cannot appear in the callee of new expressions")

  let computed = eat(p, tt.bracketL)
  if (computed || (optional && p.type !== tt.parenL && p.type !== tt.backQuote) || eat(p, tt.dot)) {
    let node = startNodeAt(startPos, startLoc)
    let property: Expression
    if (computed) {
      property = parseExpression(p)
      expect(p, tt.bracketR)
    } else if (p.type === tt.privateId && base.type !== "Super") {
      property = parsePrivateIdent(p)
    } else {
      property = parseIdent(p, p.options.allowReserved !== "never")
    }
    base = {
      type: "MemberExpression", span: finishSpan(p, node), object: base, property, computed: !!computed,
      optional: optionalSupported ? optional : undefined
    }
  } else if (!noCalls && eat(p, tt.parenL)) {
    let refDestructuringErrors = new DestructuringErrors, oldYieldPos = p.yieldPos, oldAwaitPos = p.awaitPos, oldAwaitIdentPos = p.awaitIdentPos
    p.yieldPos = 0
    p.awaitPos = 0
    p.awaitIdentPos = 0
    let exprList = noNulls(parseExprList(p, tt.parenR, p.options.ecmaVersion >= 8, false, refDestructuringErrors))
    if (maybeAsyncArrow && !optional && shouldParseAsyncArrow(p)) {
      checkPatternErrors(p, refDestructuringErrors, false)
      checkYieldAwaitInDefaultParams(p)
      if (p.awaitIdentPos > 0)
        raise(p, p.awaitIdentPos, "Cannot use 'await' as identifier inside an async function")
      p.yieldPos = oldYieldPos
      p.awaitPos = oldAwaitPos
      p.awaitIdentPos = oldAwaitIdentPos
      return parseArrowExpression(p, startNodeAt(startPos, startLoc), exprList, true, forInit)
    }
    checkExpressionErrors(p, refDestructuringErrors, true)
    p.yieldPos = oldYieldPos || p.yieldPos
    p.awaitPos = oldAwaitPos || p.awaitPos
    p.awaitIdentPos = oldAwaitIdentPos || p.awaitIdentPos
    let node = startNodeAt(startPos, startLoc)
    base = {
      type: "CallExpression", span: finishSpan(p, node), callee: base, arguments: exprList,
      optional: optionalSupported ? optional : undefined
    }
  } else if (p.type === tt.backQuote) {
    if (optional || optionalChained) {
      raise(p, p.start, "Optional chaining cannot appear in the tag of tagged template expressions")
    }
    let node = startNodeAt(startPos, startLoc)
    let quasi = parseTemplate(p, {isTagged: true})
    base = {type: "TaggedTemplateExpression", span: finishSpan(p, node), tag: base, quasi}
  }
  return base
}

// Parse an atomic expression — either a single token that is an
// expression, an expression started by a keyword like `function` or
// `new`, or an expression wrapped in punctuation like `()`, `[]`,
// or `{}`.

export function parseExprAtom(p: Parser, refDestructuringErrors?: DestructuringErrors | null, forInit?: ForInit, forNew?: boolean): Expression {
  // If a division operator appears in an expression position, the
  // tokenizer got confused, and we force it to read a regexp instead.
  if (p.type === tt.slash) readRegexp(p)

  let node, canBeArrow = p.potentialArrowAt === p.start
  switch (p.type) {
  case tt._super:
    if (!allowSuper(p))
      raise(p, p.start, "'super' keyword outside a method")
    node = startNode(p)
    next(p)
    if (p.type === tt.parenL && !allowDirectSuper(p))
      raise(p, node.start, "super() call outside constructor of a subclass")
    // The `super` keyword can appear at below:
    // SuperProperty:
    //     super [ Expression ]
    //     super . IdentifierName
    // SuperCall:
    //     super ( Arguments )
    if (p.type !== tt.dot && p.type !== tt.bracketL && p.type !== tt.parenL)
      unexpected(p)
    return {type: "Super", span: finishSpan(p, node)}

  case tt._this:
    node = startNode(p)
    next(p)
    return {type: "ThisExpression", span: finishSpan(p, node)}

  case tt.name: {
    let startPos = p.start, startLoc = p.startLoc, containsEsc = p.containsEsc
    let id = parseIdent(p, false)
    if (p.options.ecmaVersion >= 8 && !containsEsc && id.name === "async" && !canInsertSemicolon(p) && eat(p, tt._function)) {
      overrideContext(p, tokenCtxTypes.f_expr)
      return parseFunction(p, startNodeAt(startPos, startLoc), 0, false, true, forInit)
    }
    if (canBeArrow && !canInsertSemicolon(p)) {
      if (eat(p, tt.arrow))
        return parseArrowExpression(p, startNodeAt(startPos, startLoc), [id], false, forInit)
      if (p.options.ecmaVersion >= 8 && id.name === "async" && p.type === tt.name && !containsEsc &&
          (!p.potentialArrowInForAwait || p.value !== "of" || p.containsEsc)) {
        id = parseIdent(p, false)
        if (canInsertSemicolon(p) || !eat(p, tt.arrow))
          unexpected(p)
        return parseArrowExpression(p, startNodeAt(startPos, startLoc), [id], true, forInit)
      }
    }
    return id
  }

  case tt.regexp: {
    let value = tokenRegExpValue(p)
    return parseLiteral(p, value.value, {pattern: value.pattern, flags: value.flags})
  }

  case tt.num: case tt.string:
    return parseLiteral(p, tokenLiteralValue(p))

  case tt._null: case tt._true: case tt._false: {
    node = startNode(p)
    let value = p.type === tt._null ? null : p.type === tt._true
    let raw = p.type.keyword || unreachable("literal keyword without name")
    next(p)
    return {type: "Literal", span: finishSpan(p, node), value, raw, bigint: undefined, regex: undefined}
  }

  case tt.parenL: {
    let start = p.start, expr = parseParenAndDistinguishExpression(p, canBeArrow, forInit)
    if (refDestructuringErrors) {
      if (refDestructuringErrors.parenthesizedAssign < 0 && !isSimpleAssignTarget(expr))
        refDestructuringErrors.parenthesizedAssign = start
      if (refDestructuringErrors.parenthesizedBind < 0)
        refDestructuringErrors.parenthesizedBind = start
    }
    return expr
  }

  case tt.bracketL: {
    node = startNode(p)
    next(p)
    let elements = parseExprList(p, tt.bracketR, true, true, refDestructuringErrors)
    return {type: "ArrayExpression", span: finishSpan(p, node), elements}
  }

  case tt.braceL:
    overrideContext(p, tokenCtxTypes.b_expr)
    return parseObjExpression(p, refDestructuringErrors)

  case tt._function:
    node = startNode(p)
    next(p)
    return parseFunction(p, node, 0)

  case tt._class:
    return parseClass(p, startNode(p), false)

  case tt._new:
    return parseNew(p)

  case tt.backQuote:
    return parseTemplate(p)

  case tt._import:
    if (p.options.ecmaVersion >= 11) {
      return parseExprImport(p, forNew)
    } else {
      return unexpected(p)
    }

  default:
    return unexpected(p)
  }
}

function parseExprImport(p: Parser, forNew: boolean | undefined): ImportExpression | MetaProperty {
  const node = startNode(p)

  // Consume `import` as an identifier for `import.meta`.
  // Because `parseIdent(p, true)` doesn't check escape sequences, it needs the check of `p.containsEsc`.
  if (p.containsEsc) raiseRecoverable(p, p.start, "Escape sequence in keyword import")
  next(p)

  if (p.type === tt.parenL && !forNew) {
    return parseDynamicImport(p, node)
  } else if (p.type === tt.dot) {
    let metaStart = startNodeAt(node.start, node.loc)
    let meta: Identifier = {type: "Identifier", span: finishSpan(p, metaStart), name: "import"}
    return parseImportMeta(p, node, meta)
  } else {
    return unexpected(p)
  }
}

function parseDynamicImport(p: Parser, node: NodeStart): ImportExpression {
  next(p) // skip `(`

  // Parse node.source.
  let source = parseMaybeAssign(p)
  let options: Expression | null | undefined = undefined

  if (p.options.ecmaVersion >= 16) {
    if (!eat(p, tt.parenR)) {
      expect(p, tt.comma)
      if (!afterTrailingComma(p, tt.parenR)) {
        options = parseMaybeAssign(p)
        if (!eat(p, tt.parenR)) {
          expect(p, tt.comma)
          if (!afterTrailingComma(p, tt.parenR)) {
            unexpected(p)
          }
        }
      } else {
        options = null
      }
    } else {
      options = null
    }
  } else {
    // Verify ending.
    if (!eat(p, tt.parenR)) {
      const errorPos = p.start
      if (eat(p, tt.comma) && eat(p, tt.parenR)) {
        raiseRecoverable(p, errorPos, "Trailing comma is not allowed in import()")
      } else {
        unexpected(p, errorPos)
      }
    }
  }

  return {type: "ImportExpression", span: finishSpan(p, node), source, options}
}

function parseImportMeta(p: Parser, node: NodeStart, meta: Identifier): MetaProperty {
  next(p) // skip `.`

  const containsEsc = p.containsEsc
  let property = parseIdent(p, true)

  if (property.name !== "meta")
    raiseRecoverable(p, property.span.start, "The only valid meta property for import is 'import.meta'")
  if (containsEsc)
    raiseRecoverable(p, node.start, "'import.meta' must not contain escaped characters")
  if (p.options.sourceType !== "module" && !p.options.allowImportExportEverywhere)
    raiseRecoverable(p, node.start, "Cannot use 'import.meta' outside a module")

  return {type: "MetaProperty", span: finishSpan(p, node), meta, property}
}

export function parseLiteral(p: Parser, value: LiteralValue, regex?: {pattern: string, flags: string}): Literal {
  let node = startNode(p)
  let raw = p.input.slice(p.start, p.end)
  let bigint: string | undefined = undefined
  if (raw.charCodeAt(raw.length - 1) === 110)
    bigint = value != null ? String(value) : raw.slice(0, -1).replace(/_/g, "")
  next(p)
  return {type: "Literal", span: finishSpan(p, node), value, raw, bigint, regex}
}

export function parseParenExpression(p: Parser): Expression {
  expect(p, tt.parenL)
  let val = parseExpression(p)
  expect(p, tt.parenR)
  return val
}

function parseParenAndDistinguishExpression(p: Parser, canBeArrow: boolean, forInit: ForInit | undefined): Expression {
  let startPos = p.start, startLoc = p.startLoc, val: Expression, allowTrailingComma = p.options.ecmaVersion >= 8
  if (p.options.ecmaVersion >= 6) {
    next(p)

    let innerStartPos = p.start, innerStartLoc = p.startLoc
    let exprList: Array<Expression | RestElement> = [], first = true, lastIsComma = false
    let refDestructuringErrors = new DestructuringErrors, oldYieldPos = p.yieldPos, oldAwaitPos = p.awaitPos, spreadStart
    p.yieldPos = 0
    p.awaitPos = 0
    // Do not save awaitIdentPos to allow checking awaits nested in parameters
    while (p.type !== tt.parenR) {
      first ? first = false : expect(p, tt.comma)
      if (allowTrailingComma && afterTrailingComma(p, tt.parenR, true)) {
        lastIsComma = true
        break
      } else if (p.type === tt.ellipsis) {
        spreadStart = p.start
        exprList.push(parseRestBinding(p))
        if (p.type === tt.comma) {
          raiseRecoverable(p,
            p.start,
            "Comma is not permitted after the rest element"
          )
        }
        break
      } else {
        exprList.push(parseMaybeAssign(p, false, refDestructuringErrors))
      }
    }
    let innerEndPos = p.lastTokEnd, innerEndLoc = p.lastTokEndLoc
    expect(p, tt.parenR)

    if (canBeArrow && !canInsertSemicolon(p) && eat(p, tt.arrow)) {
      checkPatternErrors(p, refDestructuringErrors, false)
      checkYieldAwaitInDefaultParams(p)
      p.yieldPos = oldYieldPos
      p.awaitPos = oldAwaitPos
      return parseArrowExpression(p, startNodeAt(startPos, startLoc), exprList, false, forInit)
    }

    if (!exprList.length || lastIsComma) unexpected(p, p.lastTokStart)
    if (spreadStart) unexpected(p, spreadStart)
    checkExpressionErrors(p, refDestructuringErrors, true)
    p.yieldPos = oldYieldPos || p.yieldPos
    p.awaitPos = oldAwaitPos || p.awaitPos

    // Without a spread element, the list holds only expressions.
    let expressions = exprList.map(expr => expr.type === "RestElement" ? unreachable("rest element in parenthesized expression") : expr)
    if (expressions.length > 1) {
      let seq = startNodeAt(innerStartPos, innerStartLoc)
      val = {type: "SequenceExpression", span: finishSpanAt(seq, innerEndPos, innerEndLoc), expressions}
    } else {
      val = expressions[0]
    }
  } else {
    val = parseParenExpression(p)
  }

  if (p.options.preserveParens) {
    let par = startNodeAt(startPos, startLoc)
    return {type: "ParenthesizedExpression", span: finishSpan(p, par), expression: val}
  } else {
    return val
  }
}

// New's precedence is slightly tricky. It must allow its argument to
// be a `[]` or dot subscript expression, but not a call — at least,
// not without wrapping it in parentheses. Thus, it uses the noCalls
// argument to parseSubscripts to prevent it from consuming the
// argument list.

function parseNew(p: Parser): Expression {
  if (p.containsEsc) raiseRecoverable(p, p.start, "Escape sequence in keyword new")
  let node = startNode(p)
  next(p)
  if (p.options.ecmaVersion >= 6 && p.type === tt.dot) {
    let metaStart = startNodeAt(node.start, node.loc)
    let meta: Identifier = {type: "Identifier", span: finishSpan(p, metaStart), name: "new"}
    next(p)
    let containsEsc = p.containsEsc
    let property = parseIdent(p, true)
    if (property.name !== "target")
      raiseRecoverable(p, property.span.start, "The only valid meta property for new is 'new.target'")
    if (containsEsc)
      raiseRecoverable(p, node.start, "'new.target' must not contain escaped characters")
    if (!allowNewDotTarget(p))
      raiseRecoverable(p, node.start, "'new.target' can only be used in functions and class static block")
    return {type: "MetaProperty", span: finishSpan(p, node), meta, property}
  }
  let startPos = p.start, startLoc = p.startLoc
  let callee = parseSubscripts(p, parseExprAtom(p, null, false, true), startPos, startLoc, true, false)
  if (callee.type === "Super")
    raiseRecoverable(p, startPos, "Invalid use of 'super'")
  let args: Array<Expression | SpreadElement>
  if (eat(p, tt.parenL)) args = noNulls(parseExprList(p, tt.parenR, p.options.ecmaVersion >= 8, false))
  else args = []
  return {type: "NewExpression", span: finishSpan(p, node), callee, arguments: args}
}

// Parse template expression.

function parseTemplateElement(p: Parser, {isTagged}: {isTagged: boolean}): TemplateElement {
  let elem = startNode(p)
  let value: {raw: string, cooked: string | null}
  if (p.type === tt.invalidTemplate) {
    if (!isTagged) {
      raiseRecoverable(p, p.start, "Bad escape sequence in untagged template literal")
    }
    value = {
      raw: tokenString(p).replace(/\r\n?/g, "\n"),
      cooked: null
    }
  } else {
    value = {
      raw: p.input.slice(p.start, p.end).replace(/\r\n?/g, "\n"),
      cooked: tokenString(p)
    }
  }
  next(p)
  let tail = p.type === tt.backQuote
  return {type: "TemplateElement", span: finishSpan(p, elem), value, tail}
}

function parseTemplate(p: Parser, {isTagged = false}: {isTagged?: boolean} = {}): TemplateLiteral {
  let node = startNode(p)
  next(p)
  let expressions: Expression[] = []
  let curElt = parseTemplateElement(p, {isTagged})
  let quasis = [curElt]
  while (!curElt.tail) {
    if (p.type === tt.eof) raise(p, p.pos, "Unterminated template literal")
    expect(p, tt.dollarBraceL)
    expressions.push(parseExpression(p))
    expect(p, tt.braceR)
    quasis.push(curElt = parseTemplateElement(p, {isTagged}))
  }
  next(p)
  return {type: "TemplateLiteral", span: finishSpan(p, node), expressions, quasis}
}

function isAsyncProp(p: Parser, computed: boolean | undefined, key: Expression): boolean {
  return !computed && key.type === "Identifier" && key.name === "async" &&
    (p.type === tt.name || p.type === tt.num || p.type === tt.string || p.type === tt.bracketL || !!p.type.keyword || (p.options.ecmaVersion >= 9 && p.type === tt.star)) &&
    !lineBreak.test(p.input.slice(p.lastTokEnd, p.start))
}

// Parse an object literal or binding pattern.

function parseObjProperties(p: Parser, isPattern: boolean, refDestructuringErrors: DestructuringErrors | null | undefined): Array<Property | SpreadElement | RestElement> {
  let first = true, propHash: PropHash = {proto: false, names: new Map()}
  let properties: Array<Property | SpreadElement | RestElement> = []
  next(p)
  while (!eat(p, tt.braceR)) {
    if (!first) {
      expect(p, tt.comma)
      if (p.options.ecmaVersion >= 5 && afterTrailingComma(p, tt.braceR)) break
    } else first = false

    const prop = parseProperty(p, isPattern, refDestructuringErrors)
    if (!isPattern) {
      if (prop.type === "RestElement") unreachable("rest element in object expression")
      checkPropClash(p, prop, propHash, refDestructuringErrors)
    }
    properties.push(prop)
  }
  return properties
}

export function parseObjPattern(p: Parser): ObjectPattern {
  let node = startNode(p)
  let properties = parseObjProperties(p, true, null).map(prop =>
    prop.type === "SpreadElement" ? unreachable("spread element in object pattern") : prop)
  return {type: "ObjectPattern", span: finishSpan(p, node), properties}
}

function parseObjExpression(p: Parser, refDestructuringErrors: DestructuringErrors | null | undefined): ObjectExpression {
  let node = startNode(p)
  let properties = parseObjProperties(p, false, refDestructuringErrors).map(prop =>
    prop.type === "RestElement" ? unreachable("rest element in object expression") : prop)
  return {type: "ObjectExpression", span: finishSpan(p, node), properties}
}

function parseProperty(p: Parser, isPattern: boolean, refDestructuringErrors: DestructuringErrors | null | undefined): Property | SpreadElement | RestElement {
  let prop = startNode(p), isGenerator = false, isAsync, startPos: number | undefined, startLoc: Position | undefined
  if (p.options.ecmaVersion >= 9 && eat(p, tt.ellipsis)) {
    if (isPattern) {
      let argument = parseIdent(p, false)
      if (p.type === tt.comma) {
        raiseRecoverable(p, p.start, "Comma is not permitted after the rest element")
      }
      return {type: "RestElement", span: finishSpan(p, prop), argument}
    }
    // Parse argument.
    let argument = parseMaybeAssign(p, false, refDestructuringErrors)
    // To disallow trailing comma via `toAssignable()`.
    if (p.type === tt.comma && refDestructuringErrors && refDestructuringErrors.trailingComma < 0) {
      refDestructuringErrors.trailingComma = p.start
    }
    // Finish
    return {type: "SpreadElement", span: finishSpan(p, prop), argument}
  }
  let draft: PropertyDraft = {method: undefined, shorthand: undefined, computed: undefined, key: null, value: null, kind: "init"}
  if (p.options.ecmaVersion >= 6) {
    draft.method = false
    draft.shorthand = false
    if (isPattern || refDestructuringErrors) {
      startPos = p.start
      startLoc = p.startLoc
    }
    if (!isPattern)
      isGenerator = eat(p, tt.star)
  }
  let containsEsc = p.containsEsc
  let name = parsePropertyName(p)
  draft.computed = name.computed
  draft.key = name.key
  if (!isPattern && !containsEsc && p.options.ecmaVersion >= 8 && !isGenerator && isAsyncProp(p, draft.computed, name.key)) {
    isAsync = true
    isGenerator = p.options.ecmaVersion >= 9 && eat(p, tt.star)
    name = parsePropertyName(p)
    draft.computed = name.computed
    draft.key = name.key
  } else {
    isAsync = false
  }
  parsePropertyValue(p, draft, name.key, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc)
  let value = draft.value || unreachable("property without value")
  return {
    type: "Property", span: finishSpan(p, prop), method: draft.method, shorthand: draft.shorthand,
    computed: draft.computed, key: draft.key, value, kind: draft.kind
  }
}

// A property whose parts are still being parsed.
interface PropertyDraft {
  method: boolean | undefined
  shorthand: boolean | undefined
  computed: boolean | undefined
  key: Expression | null
  value: Expression | Pattern | null
  kind: "init" | "get" | "set"
}

function parseGetterSetter(p: Parser, prop: PropertyDraft, kind: "get" | "set"): void {
  let name = parsePropertyName(p)
  prop.computed = name.computed
  prop.key = name.key
  let value = parseMethod(p, false)
  prop.value = value
  prop.kind = kind
  let paramCount = kind === "get" ? 0 : 1
  if (value.params.length !== paramCount) {
    let start = value.span.start
    if (kind === "get")
      raiseRecoverable(p, start, "getter should have no params")
    else
      raiseRecoverable(p, start, "setter should have exactly one param")
  } else {
    if (kind === "set" && value.params[0].type === "RestElement")
      raiseRecoverable(p, value.params[0].span.start, "Setter cannot use rest params")
  }
}

function parsePropertyValue(p: Parser, prop: PropertyDraft, key: Expression, isPattern: boolean, isGenerator: boolean, isAsync: boolean, startPos: number | undefined, startLoc: Position | undefined, refDestructuringErrors: DestructuringErrors | null | undefined, containsEsc: boolean): void {
  if ((isGenerator || isAsync) && p.type === tt.colon)
    unexpected(p)

  if (eat(p, tt.colon)) {
    prop.value = isPattern ? parseMaybeDefault(p, p.start, p.startLoc) : parseMaybeAssign(p, false, refDestructuringErrors)
    prop.kind = "init"
  } else if (p.options.ecmaVersion >= 6 && p.type === tt.parenL) {
    if (isPattern) unexpected(p)
    prop.method = true
    prop.value = parseMethod(p, isGenerator, isAsync)
    prop.kind = "init"
  } else if (!isPattern && !containsEsc &&
             p.options.ecmaVersion >= 5 && !prop.computed && key.type === "Identifier" &&
             (key.name === "get" || key.name === "set") &&
             (p.type !== tt.comma && p.type !== tt.braceR && p.type !== tt.eq)) {
    if (isGenerator || isAsync) unexpected(p)
    parseGetterSetter(p, prop, key.name)
  } else if (p.options.ecmaVersion >= 6 && !prop.computed && key.type === "Identifier") {
    if (isGenerator || isAsync) unexpected(p)
    checkUnreserved(p, key)
    if (key.name === "await" && !p.awaitIdentPos)
      p.awaitIdentPos = startPos || 0
    if (isPattern) {
      prop.value = parseMaybeDefault(p, startPos || 0, startLoc, {...key})
    } else if (p.type === tt.eq && refDestructuringErrors) {
      if (refDestructuringErrors.shorthandAssign < 0)
        refDestructuringErrors.shorthandAssign = p.start
      prop.value = parseMaybeDefault(p, startPos || 0, startLoc, {...key})
    } else {
      prop.value = {...key}
    }
    prop.kind = "init"
    prop.shorthand = true
  } else unexpected(p)
}

export function parsePropertyName(p: Parser): {computed: boolean | undefined, key: Expression} {
  let computed: boolean | undefined = undefined
  if (p.options.ecmaVersion >= 6) {
    if (eat(p, tt.bracketL)) {
      let key = parseMaybeAssign(p)
      expect(p, tt.bracketR)
      return {computed: true, key}
    } else {
      computed = false
    }
  }
  let key = p.type === tt.num || p.type === tt.string ? parseExprAtom(p) : parseIdent(p, p.options.allowReserved !== "never")
  return {computed, key}
}

// Parse object or class method.

export function parseMethod(p: Parser, isGenerator: boolean, isAsync?: boolean, allowDirectSuper?: boolean): FunctionNode {
  let node = startNode(p), oldYieldPos = p.yieldPos, oldAwaitPos = p.awaitPos, oldAwaitIdentPos = p.awaitIdentPos

  let generator = p.options.ecmaVersion >= 6 ? isGenerator : undefined
  let async = p.options.ecmaVersion >= 8 ? !!isAsync : undefined

  p.yieldPos = 0
  p.awaitPos = 0
  p.awaitIdentPos = 0
  enterScope(p, functionFlags(!!isAsync, !!generator) | SCOPE_SUPER | (allowDirectSuper ? SCOPE_DIRECT_SUPER : 0))

  expect(p, tt.parenL)
  let params = noNulls(parseBindingList(p, tt.parenR, false, p.options.ecmaVersion >= 8))
  checkYieldAwaitInDefaultParams(p)
  let {body, expression} = parseFunctionBody(p, node, null, params, false, true, false)

  p.yieldPos = oldYieldPos
  p.awaitPos = oldAwaitPos
  p.awaitIdentPos = oldAwaitIdentPos
  return {
    type: "FunctionExpression", span: finishSpan(p, node), id: null, expression, generator, async, params, body
  }
}

// Parse arrow function expression with given parameters.

function parseArrowExpression(p: Parser, node: NodeStart, exprList: ReadonlyArray<Node>, isAsync: boolean, forInit: ForInit | undefined): FunctionNode {
  let oldYieldPos = p.yieldPos, oldAwaitPos = p.awaitPos, oldAwaitIdentPos = p.awaitIdentPos

  enterScope(p, functionFlags(isAsync, false) | SCOPE_ARROW)
  let generator = p.options.ecmaVersion >= 6 ? false : undefined
  let async = p.options.ecmaVersion >= 8 ? !!isAsync : undefined

  p.yieldPos = 0
  p.awaitPos = 0
  p.awaitIdentPos = 0

  let params = noNulls(toAssignableList(p, exprList, true))
  let {body, expression} = parseFunctionBody(p, node, null, params, true, false, forInit)

  p.yieldPos = oldYieldPos
  p.awaitPos = oldAwaitPos
  p.awaitIdentPos = oldAwaitIdentPos
  return {
    type: "ArrowFunctionExpression", span: finishSpan(p, node), id: null, expression, generator, async, params, body
  }
}

// Parse function body and check parameters.

export function parseFunctionBody(p: Parser, node: NodeStart, id: Identifier | null, params: Pattern[], isArrowFunction: boolean, isMethod: boolean, forInit: ForInit | undefined): {body: BlockStatement | Expression, expression: boolean} {
  let isExpression = isArrowFunction && p.type !== tt.braceL
  let oldStrict = p.strict, useStrict = false
  let result: {body: BlockStatement | Expression, expression: boolean}

  if (isExpression) {
    let body = parseMaybeAssign(p, forInit)
    result = {body, expression: true}
    checkParams(p, params, false)
  } else {
    let nonSimple = p.options.ecmaVersion >= 7 && !isSimpleParamList(params)
    if (!oldStrict || nonSimple) {
      useStrict = strictDirective(p, p.end)
      // If this is a strict mode function, verify that argument names
      // are not repeated, and it does not try to bind the words `eval`
      // or `arguments`.
      if (useStrict && nonSimple)
        raiseRecoverable(p, node.start, "Illegal 'use strict' directive in function with non-simple parameter list")
    }
    // Start a new scope with regard to labels and the `inFunction`
    // flag (restore them to their old value afterwards).
    let oldLabels = p.labels
    p.labels = []
    if (useStrict) p.strict = true

    // Add the params to varDeclaredNames to ensure that an error is thrown
    // if a let/const declaration in the function clashes with one of the params.
    checkParams(p, params, !oldStrict && !useStrict && !isArrowFunction && !isMethod && isSimpleParamList(params))
    // Ensure the function name isn't a forbidden identifier in strict mode, e.g. 'eval'
    if (p.strict && id) checkLValSimple(p, id, BIND_OUTSIDE)
    let body = parseBlock(p, false, undefined, useStrict && !oldStrict)
    result = {body, expression: false}
    adaptDirectivePrologue(p, body.body)
    p.labels = oldLabels
  }
  exitScope(p)
  return result
}

function isSimpleParamList(params: ReadonlyArray<Pattern>): boolean {
  for (let param of params)
    if (param.type !== "Identifier") return false
  return true
}

// Checks function params for various disallowed patterns such as using "eval"
// or "arguments" and duplicate parameters.

function checkParams(p: Parser, params: ReadonlyArray<Pattern>, allowDuplicates: boolean): void {
  let nameHash = new Set<string>()
  for (let param of params)
    checkLValInnerPattern(p, param, BIND_VAR, allowDuplicates ? null : nameHash)
}

// Parses a comma-separated list of expressions, and returns them as
// an array. `close` is the token type that ends the list, and
// `allowEmpty` can be turned on to allow subsequent commas with
// nothing in between them to be parsed as `null` (which is needed
// for array literals).

function parseExprList(p: Parser, close: TokenType, allowTrailingComma: boolean, allowEmpty: boolean, refDestructuringErrors?: DestructuringErrors | null): Array<Expression | SpreadElement | null> {
  let elts: Array<Expression | SpreadElement | null> = [], first = true
  while (!eat(p, close)) {
    if (!first) {
      expect(p, tt.comma)
      if (allowTrailingComma && afterTrailingComma(p, close)) break
    } else first = false

    let elt
    if (allowEmpty && p.type === tt.comma)
      elt = null
    else if (p.type === tt.ellipsis) {
      elt = parseSpread(p, refDestructuringErrors)
      if (refDestructuringErrors && p.type === tt.comma && refDestructuringErrors.trailingComma < 0)
        refDestructuringErrors.trailingComma = p.start
    } else {
      elt = parseMaybeAssign(p, false, refDestructuringErrors)
    }
    elts.push(elt)
  }
  return elts
}

export function checkUnreserved(p: Parser, {span: {start, end}, name}: Identifier): void {
  if (inGenerator(p) && name === "yield")
    raiseRecoverable(p, start, "Cannot use 'yield' as identifier inside a generator")
  if (inAsync(p) && name === "await")
    raiseRecoverable(p, start, "Cannot use 'await' as identifier inside an async function")
  if (!(currentThisScope(p).flags & SCOPE_VAR) && name === "arguments")
    raiseRecoverable(p, start, "Cannot use 'arguments' in class field initializer")
  if (inClassStaticBlock(p) && (name === "arguments" || name === "await"))
    raise(p, start, `Cannot use ${name} in class static initialization block`)
  if (p.keywords.test(name))
    raise(p, start, `Unexpected keyword '${name}'`)
  if (p.options.ecmaVersion < 6 &&
    p.input.slice(start, end).indexOf("\\") !== -1) return
  const re = p.strict ? p.reservedWordsStrict : p.reservedWords
  if (re.test(name)) {
    if (!inAsync(p) && name === "await")
      raiseRecoverable(p, start, "Cannot use keyword 'await' outside an async function")
    raiseRecoverable(p, start, `The keyword '${name}' is reserved`)
  }
}

// Parse the next token as an identifier. If `liberal` is true (used
// when parsing properties), it will also convert keywords into
// identifiers.

export function parseIdent(p: Parser, liberal?: boolean): Identifier {
  let {node, name} = parseIdentNode(p)
  next(p, !!liberal)
  let id: Identifier = {type: "Identifier", span: finishSpan(p, node), name}
  if (!liberal) {
    checkUnreserved(p, id)
    if (name === "await" && !p.awaitIdentPos)
      p.awaitIdentPos = node.start
  }
  return id
}

function parseIdentNode(p: Parser): {node: NodeStart, name: string} {
  let node = startNode(p), name
  if (p.type === tt.name) {
    name = tokenString(p)
  } else if (p.type.keyword) {
    name = p.type.keyword

    // To fix https://github.com/acornjs/acorn/issues/575
    // `class` and `function` keywords push new context into p.context.
    // But there is no chance to pop the context if the keyword is consumed as an identifier such as a property name.
    // If the previous token is a dot, this does not apply because the context-managing code already ignored the keyword
    if ((name === "class" || name === "function") &&
      (p.lastTokEnd !== p.lastTokStart + 1 || p.input.charCodeAt(p.lastTokStart) !== 46)) {
      p.context.pop()
    }
    p.type = tt.name
  } else {
    return unexpected(p)
  }
  return {node, name}
}

export function parsePrivateIdent(p: Parser): PrivateIdentifier {
  const node = startNode(p)
  let name
  if (p.type === tt.privateId) {
    name = tokenString(p)
  } else {
    return unexpected(p)
  }
  next(p)
  let id: PrivateIdentifier = {type: "PrivateIdentifier", span: finishSpan(p, node), name}

  // For validating existence
  if (p.options.checkPrivateFields) {
    if (p.privateNameStack.length === 0) {
      raise(p, node.start, `Private field '#${name}' must be declared in an enclosing class`)
    } else {
      p.privateNameStack[p.privateNameStack.length - 1].used.push(id)
    }
  }

  return id
}

// Parses yield expression inside generator.

function parseYield(p: Parser, forInit: ForInit | undefined): Expression {
  if (!p.yieldPos) p.yieldPos = p.start

  let node = startNode(p)
  next(p)
  let delegate, argument
  if (p.type === tt.semi || canInsertSemicolon(p) || (p.type !== tt.star && !p.type.startsExpr)) {
    delegate = false
    argument = null
  } else {
    delegate = eat(p, tt.star)
    argument = parseMaybeAssign(p, forInit)
  }
  return {type: "YieldExpression", span: finishSpan(p, node), delegate, argument}
}

function parseAwait(p: Parser, forInit: ForInit | undefined): Expression {
  if (!p.awaitPos) p.awaitPos = p.start

  let node = startNode(p)
  next(p)
  let argument = parseMaybeUnary(p, null, true, false, forInit)
  return {type: "AwaitExpression", span: finishSpan(p, node), argument}
}
