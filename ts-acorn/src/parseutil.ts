import {types as tt, type TokenType} from "./tokentype.ts"
import type {Parser} from "./state.ts"
import type {Node} from "./ast.ts"
import {lineBreak, whitespaceRE, skipWhitespaceAt} from "./whitespace.ts"
import {isIdentifierChar} from "./identifier.ts"
import {raise, raiseRecoverable} from "./location.ts"
import {fullCharCodeAt, next} from "./tokenize.ts"

// ## Parser utilities

const literal = /^(?:'((?:\\[^]|[^'\\])*?)'|"((?:\\[^]|[^"\\])*?)")/
export function strictDirective(p: Parser, start: number): boolean {
  if (p.options.ecmaVersion < 5) return false
  let skip = whitespaceRE(p.inModule)
  for (;;) {
    // Try to find string literal.
    start += skipWhitespaceAt(skip, p.input, start).length
    let match = literal.exec(p.input.slice(start))
    if (!match) return false
    if ((match[1] || match[2]) === "use strict") {
      skip.lastIndex = start + match[0].length
      let spaceAfter = skip.exec(p.input)
      if (!spaceAfter) return false
      let end = spaceAfter.index + spaceAfter[0].length
      let next = p.input.charAt(end)
      return next === ";" || next === "}" ||
        (lineBreak.test(spaceAfter[0]) &&
         !(/[(`.[+\-/*%<>=,?^&]/.test(next) ||
           next === "!" && p.input.charAt(end + 1) === "=" ||
           next === "i" && keywordOpAt(p, end)))
    }
    start += match[0].length

    // Skip semicolon, if any.
    start += skipWhitespaceAt(skip, p.input, start).length
    if (p.input[start] === ";")
      start++
  }
}

// Scan for `in` or `instanceof` at the given position, knowing that
// there's an `i` there.
function keywordOpAt(parser: Parser, pos: number): boolean {
  let end = pos + 1, stop = Math.min(parser.input.length, pos + 11)
  while (end < stop) {
    let ch = fullCharCodeAt(parser, end)
    if (!isIdentifierChar(ch, true)) break
    end += ch <= 0xffff ? 1 : 2
  }
  return end === pos + 2 && parser.input.slice(pos, end) === "in" ||
    end === pos + 10 && parser.input.slice(pos, end) === "instanceof"
}

// Predicate that tests whether the next token is of the given
// type, and if yes, consumes it as a side effect.

export function eat(p: Parser, type: TokenType): boolean {
  if (p.type === type) {
    next(p)
    return true
  } else {
    return false
  }
}

// Tests whether parsed token is a contextual keyword.

export function isContextual(p: Parser, name: string): boolean {
  return p.type === tt.name && p.value === name && !p.containsEsc
}

// Consumes contextual keyword if possible.

export function eatContextual(p: Parser, name: string): boolean {
  if (!isContextual(p, name)) return false
  next(p)
  return true
}

export function catchStackOverflow<T>(p: Parser, f: () => T): T {
  try {
    return f()
  } catch (e) {
    if (e instanceof Error && (/\bstack\b.*\b(exceeded|overflow)\b/i.test(e.message) || /\btoo much recursion\b/i.test(e.message)))
      raise(p, p.start, "Not enough stack space to parse input")
    else
      throw e
  }
}

// Asserts that following token is given contextual keyword.

export function expectContextual(p: Parser, name: string): void {
  if (!eatContextual(p, name)) unexpected(p)
}

// Test whether a semicolon can be inserted at the current position.

export function canInsertSemicolon(p: Parser): boolean {
  return p.type === tt.eof ||
    p.type === tt.braceR ||
    lineBreak.test(p.input.slice(p.lastTokEnd, p.start))
}

export function insertSemicolon(p: Parser): boolean {
  if (canInsertSemicolon(p)) {
    if (p.options.onInsertedSemicolon)
      p.options.onInsertedSemicolon(p.lastTokEnd, p.lastTokEndLoc)
    return true
  }
  return false
}

// Consume a semicolon, or, failing that, see if we are allowed to
// pretend that there is a semicolon at this position.

export function semicolon(p: Parser): void {
  if (!eat(p, tt.semi) && !insertSemicolon(p)) unexpected(p)
}

export function afterTrailingComma(p: Parser, tokType: TokenType, notNext?: boolean): boolean {
  if (p.type === tokType) {
    if (p.options.onTrailingComma)
      p.options.onTrailingComma(p.lastTokStart, p.lastTokStartLoc)
    if (!notNext)
      next(p)
    return true
  }
  return false
}

// Expect a token of a given type. If found, consume it, otherwise,
// raise an unexpected token error.

export function expect(p: Parser, type: TokenType): void {
  eat(p, type) || unexpected(p)
}

// Raise an unexpected token error.

export function unexpected(p: Parser, pos?: number | null): never {
  raise(p, pos != null ? pos : p.start, "Unexpected token")
}

export class DestructuringErrors {
  shorthandAssign: number
  trailingComma: number
  parenthesizedAssign: number
  parenthesizedBind: number
  doubleProto: number

  constructor() {
    this.shorthandAssign =
    this.trailingComma =
    this.parenthesizedAssign =
    this.parenthesizedBind =
    this.doubleProto =
      -1
  }
}

export function checkPatternErrors(p: Parser, refDestructuringErrors: DestructuringErrors | null | undefined, isAssign: boolean): void {
  if (!refDestructuringErrors) return
  if (refDestructuringErrors.trailingComma > -1)
    raiseRecoverable(p, refDestructuringErrors.trailingComma, "Comma is not permitted after the rest element")
  let parens = isAssign ? refDestructuringErrors.parenthesizedAssign : refDestructuringErrors.parenthesizedBind
  if (parens > -1) raiseRecoverable(p, parens, isAssign ? "Assigning to rvalue" : "Parenthesized pattern")
}

export function checkExpressionErrors(p: Parser, refDestructuringErrors: DestructuringErrors | null | undefined, andThrow?: boolean): boolean {
  if (!refDestructuringErrors) return false
  let {shorthandAssign, doubleProto} = refDestructuringErrors
  if (!andThrow) return shorthandAssign >= 0 || doubleProto >= 0
  if (shorthandAssign >= 0)
    raise(p, shorthandAssign, "Shorthand property assignments are valid only in destructuring patterns")
  if (doubleProto >= 0)
    raiseRecoverable(p, doubleProto, "Redefinition of __proto__ property")
  return false
}

export function checkYieldAwaitInDefaultParams(p: Parser): void {
  if (p.yieldPos && (!p.awaitPos || p.yieldPos < p.awaitPos))
    raise(p, p.yieldPos, "Yield expression cannot be a default value")
  if (p.awaitPos)
    raise(p, p.awaitPos, "Await expression cannot be a default value")
}

export function isSimpleAssignTarget(expr: Node): boolean {
  if (expr.type === "ParenthesizedExpression")
    return isSimpleAssignTarget(expr.expression)
  return expr.type === "Identifier" || expr.type === "MemberExpression"
}
