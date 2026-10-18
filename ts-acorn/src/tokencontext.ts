// The algorithm used to determine whether a regexp can appear at a
// given point in the program is loosely based on sweet.js' approach.
// See https://github.com/mozilla/sweet.js/wiki/design

import type {Parser} from "./state.ts"
import {types as tt, type TokenType} from "./tokentype.ts"
import {lineBreak} from "./whitespace.ts"
import {tryReadTemplateToken} from "./tokenize.ts"

export class TokContext {
  token: string
  isExpr: boolean
  preserveSpace: boolean
  override: ((p: Parser) => void) | null | undefined
  generator: boolean

  constructor(token: string, isExpr: boolean, preserveSpace?: boolean, override?: ((p: Parser) => void) | null, generator?: boolean) {
    this.token = token
    this.isExpr = !!isExpr
    this.preserveSpace = !!preserveSpace
    this.override = override
    this.generator = !!generator
  }
}

export const types = {
  b_stat: new TokContext("{", false),
  b_expr: new TokContext("{", true),
  b_tmpl: new TokContext("${", false),
  p_stat: new TokContext("(", false),
  p_expr: new TokContext("(", true),
  q_tmpl: new TokContext("`", true, true, p => tryReadTemplateToken(p)),
  f_stat: new TokContext("function", false),
  f_expr: new TokContext("function", true),
  f_expr_gen: new TokContext("function", true, false, null, true),
  f_gen: new TokContext("function", false, false, null, true)
}

export function initialContext(): TokContext[] {
  return [types.b_stat]
}

export function curContext(p: Parser): TokContext {
  return p.context[p.context.length - 1]
}

export function braceIsBlock(p: Parser, prevType: TokenType): boolean {
  let parent = curContext(p)
  if (parent === types.f_expr || parent === types.f_stat)
    return true
  if (prevType === tt.colon && (parent === types.b_stat || parent === types.b_expr))
    return !parent.isExpr

  // The check for `tt.name && exprAllowed` detects whether we are
  // after a `yield` or `of` construct. See the `updateContext` for
  // `tt.name`.
  if (prevType === tt._return || prevType === tt.name && p.exprAllowed)
    return lineBreak.test(p.input.slice(p.lastTokEnd, p.start))
  if (prevType === tt._else || prevType === tt.semi || prevType === tt.eof || prevType === tt.parenR || prevType === tt.arrow)
    return true
  if (prevType === tt.braceL)
    return parent === types.b_stat
  if (prevType === tt._var || prevType === tt._const || prevType === tt.name)
    return false
  return !p.exprAllowed
}

export function inGeneratorContext(p: Parser): boolean {
  for (let i = p.context.length - 1; i >= 1; i--) {
    let context = p.context[i]
    if (context.token === "function")
      return context.generator
  }
  return false
}

export function updateContext(p: Parser, prevType: TokenType): void {
  let update, type = p.type
  if (type.keyword && prevType === tt.dot)
    p.exprAllowed = false
  else if (update = type.updateContext)
    update(p, prevType)
  else
    p.exprAllowed = type.beforeExpr
}

// Used to handle edge cases when token context could not be inferred correctly during tokenization phase

export function overrideContext(p: Parser, tokenCtx: TokContext): void {
  if (curContext(p) !== tokenCtx) {
    p.context[p.context.length - 1] = tokenCtx
  }
}

// Token-specific context update code

tt.parenR.updateContext = tt.braceR.updateContext = function(p) {
  if (p.context.length === 1) {
    p.exprAllowed = true
    return
  }
  let out = p.context.pop()
  if (out === types.b_stat && curContext(p).token === "function") {
    out = p.context.pop()
  }
  p.exprAllowed = !(out && out.isExpr)
}

tt.braceL.updateContext = function(p, prevType) {
  p.context.push(braceIsBlock(p, prevType) ? types.b_stat : types.b_expr)
  p.exprAllowed = true
}

tt.dollarBraceL.updateContext = function(p) {
  p.context.push(types.b_tmpl)
  p.exprAllowed = true
}

tt.parenL.updateContext = function(p, prevType) {
  let statementParens = prevType === tt._if || prevType === tt._for || prevType === tt._with || prevType === tt._while
  p.context.push(statementParens ? types.p_stat : types.p_expr)
  p.exprAllowed = true
}

tt.incDec.updateContext = function() {
  // tokExprAllowed stays unchanged
}

tt._function.updateContext = tt._class.updateContext = function(p, prevType) {
  if (prevType.beforeExpr && prevType !== tt._else &&
      !(prevType === tt.semi && curContext(p) !== types.p_stat) &&
      !(prevType === tt._return && lineBreak.test(p.input.slice(p.lastTokEnd, p.start))) &&
      !((prevType === tt.colon || prevType === tt.braceL) && curContext(p) === types.b_stat))
    p.context.push(types.f_expr)
  else
    p.context.push(types.f_stat)
  p.exprAllowed = false
}

tt.colon.updateContext = function(p) {
  if (curContext(p).token === "function") p.context.pop()
  p.exprAllowed = true
}

tt.backQuote.updateContext = function(p) {
  if (curContext(p) === types.q_tmpl)
    p.context.pop()
  else
    p.context.push(types.q_tmpl)
  p.exprAllowed = false
}

tt.star.updateContext = function(p, prevType) {
  if (prevType === tt._function) {
    let index = p.context.length - 1
    if (p.context[index] === types.f_expr)
      p.context[index] = types.f_expr_gen
    else
      p.context[index] = types.f_gen
  }
  p.exprAllowed = true
}

tt.name.updateContext = function(p, prevType) {
  let allowed = false
  if (p.options.ecmaVersion >= 6 && prevType !== tt.dot) {
    if (p.value === "of" && !p.exprAllowed ||
        p.value === "yield" && inGeneratorContext(p))
      allowed = true
  }
  p.exprAllowed = allowed
}
