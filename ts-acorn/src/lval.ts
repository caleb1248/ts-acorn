import {types as tt, type TokenType} from "./tokentype.ts"
import type {Parser} from "./state.ts"
import type {Position} from "./locutil.ts"
import {BIND_NONE, BIND_OUTSIDE, BIND_LEXICAL} from "./scopeflags.ts"
import type {Node, Pattern, Property, RestElement, SpreadElement} from "./ast.ts"
import {isPattern} from "./ast.ts"
import {raise, raiseRecoverable} from "./location.ts"
import {next} from "./tokenize.ts"
import {startNode, startNodeAt, finishSpan} from "./node.ts"
import {
  DestructuringErrors, checkPatternErrors, eat, expect, unexpected, afterTrailingComma
} from "./parseutil.ts"
import {parseMaybeAssign, parseObjPattern, parseIdent} from "./expression.ts"
import {inAsync, declareName} from "./scope.ts"
import {unreachable} from "./util.ts"

// Convert existing expression atom to assignable pattern
// if possible.
//
// Unlike the original implementation, which changed node types in
// place, this builds and returns new nodes for converted
// expressions.

export function toAssignable(p: Parser, node: Node, isBinding: boolean, refDestructuringErrors?: DestructuringErrors | null): Pattern {
  if (p.options.ecmaVersion >= 6) {
    switch (node.type) {
    case "Identifier":
      if (inAsync(p) && node.name === "await")
        raise(p, node.span.start, "Cannot use 'await' as identifier inside an async function")
      return node

    case "ObjectPattern":
    case "ArrayPattern":
    case "AssignmentPattern":
    case "RestElement":
      return node

    case "ObjectExpression": {
      if (refDestructuringErrors) checkPatternErrors(p, refDestructuringErrors, true)
      let properties: Array<Property | RestElement> = []
      for (let prop of node.properties) {
        let converted = prop.type === "Property" ? toAssignableProperty(p, prop, isBinding) : toAssignableSpread(p, prop, isBinding)
        // Early error:
        //   AssignmentRestProperty[Yield, Await] :
        //     `...` DestructuringAssignmentTarget[Yield, Await]
        //
        //   It is a Syntax Error if |DestructuringAssignmentTarget| is an |ArrayLiteral| or an |ObjectLiteral|.
        if (
          converted.type === "RestElement" &&
          (converted.argument.type === "ArrayPattern" || converted.argument.type === "ObjectPattern")
        ) {
          raise(p, converted.argument.span.start, "Unexpected token")
        }
        properties.push(converted)
      }
      return {type: "ObjectPattern", span: node.span, properties}
    }

    case "ArrayExpression":
      if (refDestructuringErrors) checkPatternErrors(p, refDestructuringErrors, true)
      return {type: "ArrayPattern", span: node.span, elements: toAssignableList(p, node.elements, isBinding)}

    case "SpreadElement":
      return toAssignableSpread(p, node, isBinding)

    case "AssignmentExpression":
      if (node.operator !== "=") raise(p, node.left.span.end, "Only '=' operator can be used for specifying default value.")
      return {type: "AssignmentPattern", span: node.span, left: toAssignable(p, node.left, isBinding), right: node.right}

    case "ParenthesizedExpression":
      return {type: "ParenthesizedExpression", span: node.span, expression: toAssignable(p, node.expression, isBinding, refDestructuringErrors)}

    case "ChainExpression":
      raiseRecoverable(p, node.span.start, "Optional chaining cannot appear in left-hand side")
      return unreachable("recovered from optional chain in pattern")

    case "MemberExpression":
      if (!isBinding) return node
      return raise(p, node.span.start, "Assigning to rvalue")

    default:
      return raise(p, node.span.start, "Assigning to rvalue")
    }
  }
  if (refDestructuringErrors) checkPatternErrors(p, refDestructuringErrors, true)
  if (isPattern(node)) return node
  // Before ES6 there are no patterns to convert to. Every caller
  // immediately checks the result with checkLValPattern, which
  // rejects anything that isn't already assignable, so do that here.
  checkLValPattern(p, node)
  return unreachable("non-pattern accepted as assignment target")
}

// AssignmentProperty has type === "Property"
function toAssignableProperty(p: Parser, prop: Property, isBinding: boolean): Property {
  if (prop.kind !== "init") raise(p, prop.key.span.start, "Object pattern can't contain getter or setter")
  return {...prop, value: toAssignable(p, prop.value, isBinding)}
}

function toAssignableSpread(p: Parser, node: SpreadElement, isBinding: boolean): RestElement {
  let argument = toAssignable(p, node.argument, isBinding)
  if (argument.type === "AssignmentPattern")
    raise(p, argument.span.start, "Rest elements cannot have a default value")
  return {type: "RestElement", span: node.span, argument}
}

// Convert list of expression atoms to binding list.

export function toAssignableList(p: Parser, exprList: ReadonlyArray<Node | null>, isBinding: boolean): Array<Pattern | null> {
  let end = exprList.length
  let result: Array<Pattern | null> = []
  for (let i = 0; i < end; i++) {
    let elt = exprList[i]
    result.push(elt ? toAssignable(p, elt, isBinding) : null)
  }
  if (end) {
    let last = result[end - 1]
    if (p.options.ecmaVersion === 6 && isBinding && last && last.type === "RestElement" && last.argument.type !== "Identifier")
      unexpected(p, last.argument.span.start)
  }
  return result
}

// Parses spread element.

export function parseSpread(p: Parser, refDestructuringErrors?: DestructuringErrors | null): SpreadElement {
  let node = startNode(p)
  next(p)
  let argument = parseMaybeAssign(p, false, refDestructuringErrors)
  return {type: "SpreadElement", span: finishSpan(p, node), argument}
}

export function parseRestBinding(p: Parser): RestElement {
  let node = startNode(p)
  next(p)

  // RestElement inside of a function parameter must be an identifier
  if (p.options.ecmaVersion === 6 && p.type !== tt.name)
    unexpected(p)

  let argument = parseBindingAtom(p)

  return {type: "RestElement", span: finishSpan(p, node), argument}
}

// Parses lvalue (assignable) atom.

export function parseBindingAtom(p: Parser): Pattern {
  if (p.options.ecmaVersion >= 6) {
    switch (p.type) {
    case tt.bracketL: {
      let node = startNode(p)
      next(p)
      let elements = parseBindingList(p, tt.bracketR, true, true)
      return {type: "ArrayPattern", span: finishSpan(p, node), elements}
    }

    case tt.braceL:
      return parseObjPattern(p)
    }
  }
  return parseIdent(p)
}

export function parseBindingList(p: Parser, close: TokenType, allowEmpty: boolean, allowTrailingComma: boolean): Array<Pattern | null> {
  let elts: Array<Pattern | null> = [], first = true
  while (!eat(p, close)) {
    if (first) first = false
    else expect(p, tt.comma)
    if (allowEmpty && p.type === tt.comma) {
      elts.push(null)
    } else if (allowTrailingComma && afterTrailingComma(p, close)) {
      break
    } else if (p.type === tt.ellipsis) {
      let rest = parseRestBinding(p)
      elts.push(rest)
      if (p.type === tt.comma) raiseRecoverable(p, p.start, "Comma is not permitted after the rest element")
      expect(p, close)
      break
    } else {
      elts.push(parseMaybeDefault(p, p.start, p.startLoc))
    }
  }
  return elts
}

// Parses assignment pattern around given atom if possible.

export function parseMaybeDefault(p: Parser, startPos: number, startLoc: Position | undefined, left?: Pattern): Pattern {
  left = left || parseBindingAtom(p)
  if (p.options.ecmaVersion < 6 || !eat(p, tt.eq)) return left
  let node = startNodeAt(startPos, startLoc)
  let right = parseMaybeAssign(p)
  return {type: "AssignmentPattern", span: finishSpan(p, node), left, right}
}

// The following three functions all verify that a node is an lvalue —
// something that can be bound, or assigned to. In order to do so, they perform
// a variety of checks:
//
// - Check that none of the bound/assigned-to identifiers are reserved words.
// - Record name declarations for bindings in the appropriate scope.
// - Check duplicate argument names, if checkClashes is set.
//
// If a complex binding pattern is encountered (e.g., object and array
// destructuring), the entire pattern is recursively checked.
//
// There are three versions of checkLVal*() appropriate for different
// circumstances:
//
// - checkLValSimple() shall be used if the syntactic construct supports
//   nothing other than identifiers and member expressions. Parenthesized
//   expressions are also correctly handled. This is generally appropriate for
//   constructs for which the spec says
//
//   > It is a Syntax Error if AssignmentTargetType of [the production] is not
//   > simple.
//
//   It is also appropriate for checking if an identifier is valid and not
//   defined elsewhere, like import declarations or function/class identifiers.
//
//   Examples where this is used include:
//     a += …;
//     import a from '…';
//   where a is the node to be checked.
//
// - checkLValPattern() shall be used if the syntactic construct supports
//   anything checkLValSimple() supports, as well as object and array
//   destructuring patterns. This is generally appropriate for constructs for
//   which the spec says
//
//   > It is a Syntax Error if [the production] is neither an ObjectLiteral nor
//   > an ArrayLiteral and AssignmentTargetType of [the production] is not
//   > simple.
//
//   Examples where this is used include:
//     (a = …);
//     const a = …;
//     try { … } catch (a) { … }
//   where a is the node to be checked.
//
// - checkLValInnerPattern() shall be used if the syntactic construct supports
//   anything checkLValPattern() supports, as well as default assignment
//   patterns, rest elements, and other constructs that may appear within an
//   object or array destructuring pattern.
//
//   As a special case, function parameters also use checkLValInnerPattern(),
//   as they also support defaults and rest constructs.
//
// These functions deliberately support both assignment and binding constructs,
// as the logic for both is exceedingly similar. If the node is the target of
// an assignment, then bindingType should be set to BIND_NONE. Otherwise, it
// should be set to the appropriate BIND_* constant, like BIND_VAR or
// BIND_LEXICAL.
//
// If the function is called with a non-BIND_NONE bindingType, then
// additionally a checkClashes set may be specified to allow checking for
// duplicate argument names. checkClashes is ignored if the provided construct
// is an assignment (i.e., bindingType is BIND_NONE).

export type CheckClashes = Set<string> | null | false | undefined

export function checkLValSimple(p: Parser, expr: Node, bindingType: number = BIND_NONE, checkClashes?: CheckClashes): void {
  const isBind = bindingType !== BIND_NONE

  switch (expr.type) {
  case "Identifier":
    if (p.strict && p.reservedWordsStrictBind.test(expr.name))
      raiseRecoverable(p, expr.span.start, (isBind ? "Binding " : "Assigning to ") + expr.name + " in strict mode")
    if (isBind) {
      if (bindingType === BIND_LEXICAL && expr.name === "let")
        raiseRecoverable(p, expr.span.start, "let is disallowed as a lexically bound name")
      if (checkClashes) {
        if (checkClashes.has(expr.name))
          raiseRecoverable(p, expr.span.start, "Argument name clash")
        checkClashes.add(expr.name)
      }
      if (bindingType !== BIND_OUTSIDE) declareName(p, expr.name, bindingType, expr.span.start)
    }
    break

  case "ChainExpression":
    raiseRecoverable(p, expr.span.start, "Optional chaining cannot appear in left-hand side")
    break

  case "MemberExpression":
    if (isBind) raiseRecoverable(p, expr.span.start, "Binding member expression")
    break

  case "ParenthesizedExpression":
    if (isBind) raiseRecoverable(p, expr.span.start, "Binding parenthesized expression")
    return checkLValSimple(p, expr.expression, bindingType, checkClashes)

  default:
    raise(p, expr.span.start, (isBind ? "Binding" : "Assigning to") + " rvalue")
  }
}

export function checkLValPattern(p: Parser, expr: Node, bindingType: number = BIND_NONE, checkClashes?: CheckClashes): void {
  switch (expr.type) {
  case "ObjectPattern":
    for (let prop of expr.properties) {
      checkLValInnerPattern(p, prop, bindingType, checkClashes)
    }
    break

  case "ArrayPattern":
    for (let elem of expr.elements) {
      if (elem) checkLValInnerPattern(p, elem, bindingType, checkClashes)
    }
    break

  default:
    checkLValSimple(p, expr, bindingType, checkClashes)
  }
}

export function checkLValInnerPattern(p: Parser, expr: Node, bindingType: number = BIND_NONE, checkClashes?: CheckClashes): void {
  switch (expr.type) {
  case "Property":
    // AssignmentProperty has type === "Property"
    checkLValInnerPattern(p, expr.value, bindingType, checkClashes)
    break

  case "AssignmentPattern":
    checkLValPattern(p, expr.left, bindingType, checkClashes)
    break

  case "RestElement":
    checkLValPattern(p, expr.argument, bindingType, checkClashes)
    break

  default:
    checkLValPattern(p, expr, bindingType, checkClashes)
  }
}
