import {types as tt} from "./tokentype.ts"
import type {Parser, Label} from "./state.ts"
import type {
  NodeStart, Statement, Expression, Pattern, Identifier, Literal, Node, Program, BlockStatement,
  VariableDeclaration, VariableDeclarator, VariableKind, FunctionNode, ClassNode, ClassElement,
  MethodDefinition, PropertyDefinition, StaticBlock, SwitchCase, CatchClause, ImportSpecifierNode,
  ImportAttribute, ExportSpecifier
} from "./ast.ts"
import {lineBreak, whitespaceRE, skipWhitespaceAt} from "./whitespace.ts"
import {isIdentifierStart, isIdentifierChar, keywordRelationalOperator} from "./identifier.ts"
import {loneSurrogate, unreachable, noNulls} from "./util.ts"
import {
  DestructuringErrors, eat, expect, unexpected, isContextual, eatContextual, expectContextual,
  semicolon, insertSemicolon, canInsertSemicolon, afterTrailingComma, checkExpressionErrors, checkYieldAwaitInDefaultParams
} from "./parseutil.ts"
import {
  functionFlags, SCOPE_SIMPLE_CATCH, BIND_SIMPLE_CATCH, BIND_LEXICAL, BIND_VAR, BIND_FUNCTION,
  SCOPE_CLASS_STATIC_BLOCK, SCOPE_SUPER, SCOPE_CLASS_FIELD_INIT, SCOPE_SWITCH
} from "./scopeflags.ts"
import {raise, raiseRecoverable} from "./location.ts"
import {next, fullCharCodeAt} from "./tokenize.ts"
import {startNode, startNodeAt, finishSpan} from "./node.ts"
import {
  parseExpression, parseMaybeAssign, parseExprSubscripts, parseParenExpression, parseIdent,
  parseLiteral, parsePrivateIdent, parsePropertyName, parseMethod, parseFunctionBody, checkUnreserved,
  tokenLiteralValue, type ForInit
} from "./expression.ts"
import {toAssignable, checkLValSimple, checkLValPattern, parseBindingAtom, parseBindingList} from "./lval.ts"
import {
  enterScope, exitScope, allowReturn, allowUsing, canAwait, treatFunctionsAsVar, checkLocalExport
} from "./scope.ts"

// The set of names exported so far, used to detect duplicate exports.
type Exports = Set<string>

// ### Statement parsing

// Parse a program. Initializes the parser, reads any number of
// statements, and wraps them in a Program node.
//
// When `appendStatement` is given (used to implement the `program`
// option, which appends to an existing program), each statement is
// passed to it as soon as it is parsed, and handling the directive
// prologue is left to the caller.

export function parseTopLevel(p: Parser, node: NodeStart, appendStatement: ((stmt: Statement) => void) | null): Program {
  let exports: Exports = new Set()
  let body: Statement[] = []
  while (p.type !== tt.eof) {
    let stmt = parseStatement(p, null, true, exports)
    body.push(stmt)
    if (appendStatement) appendStatement(stmt)
  }
  if (p.inModule)
    for (let [name, id] of p.undefinedExports)
      raiseRecoverable(p, id.span.start, `Export '${name}' is not defined`)
  if (!appendStatement) adaptDirectivePrologue(p, body)
  next(p)
  let sourceType = p.options.sourceType === "commonjs" ? "script" : p.options.sourceType
  return {type: "Program", span: finishSpan(p, node), body, sourceType}
}

const loopLabel: Label = {kind: "loop", name: undefined, statementStart: undefined}
const switchLabel: Label = {kind: "switch", name: undefined, statementStart: undefined}

function isLet(p: Parser, context?: string | null): boolean {
  if (p.options.ecmaVersion < 6 || !isContextual(p, "let")) return false
  let skip = skipWhitespaceAt(whitespaceRE(p.inModule), p.input, p.pos)
  let next = p.pos + skip.length, nextCh = fullCharCodeAt(p, next)
  // For ambiguous cases, determine if a LexicalDeclaration (or only a
  // Statement) is allowed here. If context is not empty then only a Statement
  // is allowed. However, `let [` is an explicit negative lookahead for
  // ExpressionStatement, so special-case it first.
  if (nextCh === 91 || nextCh === 92) return true // '[', '\'
  if (context) return false

  if (nextCh === 123) return true // '{'
  if (isIdentifierStart(nextCh)) {
    let start = next
    do { next += nextCh <= 0xffff ? 1 : 2 }
    while (isIdentifierChar(nextCh = fullCharCodeAt(p, next)))
    if (nextCh === 92) return true
    let ident = p.input.slice(start, next)
    if (!keywordRelationalOperator.test(ident)) return true
  }
  return false
}

// check 'async [no LineTerminator here] function'
// - 'async /*foo*/ function' is OK.
// - 'async /*\n*/ function' is invalid.
function isAsyncFunction(p: Parser): boolean {
  if (p.options.ecmaVersion < 8 || !isContextual(p, "async"))
    return false

  let skip = skipWhitespaceAt(whitespaceRE(p.inModule), p.input, p.pos)
  let next = p.pos + skip.length, after
  return !lineBreak.test(p.input.slice(p.pos, next)) &&
    p.input.slice(next, next + 8) === "function" &&
    (next + 8 === p.input.length ||
     !(isIdentifierChar(after = fullCharCodeAt(p, next + 8)) || after === 92 /* '\' */))
}

function isUsingKeyword(p: Parser, isAwaitUsing: boolean, isFor: boolean): boolean {
  if (p.options.ecmaVersion < 17 || !isContextual(p, isAwaitUsing ? "await" : "using"))
    return false

  let skipRE = whitespaceRE(p.inModule)
  let skip = skipWhitespaceAt(skipRE, p.input, p.pos)
  let next = p.pos + skip.length

  if (lineBreak.test(p.input.slice(p.pos, next))) return false

  if (isAwaitUsing) {
    let usingEndPos = next + 5 /* using */, after
    if (p.input.slice(next, usingEndPos) !== "using" ||
      usingEndPos === p.input.length ||
      isIdentifierChar(after = fullCharCodeAt(p, usingEndPos)) ||
      after === 92 /* '\' */
    ) return false

    let skipAfterUsing = skipWhitespaceAt(skipRE, p.input, usingEndPos)
    next = usingEndPos + skipAfterUsing.length
    if (lineBreak.test(p.input.slice(usingEndPos, next))) return false
  }

  let ch = fullCharCodeAt(p, next)
  if (!isIdentifierStart(ch) && ch !== 92 /* '\' */) return false
  let idStart = next
  do { next += ch <= 0xffff ? 1 : 2 }
  while (isIdentifierChar(ch = fullCharCodeAt(p, next)))
  if (ch === 92) return true
  let id = p.input.slice(idStart, next)
  if (keywordRelationalOperator.test(id)) return false
  if (isFor && !isAwaitUsing && id === "of") {
    // Look ahead for using declaration with initializer, i.e., `for (using of = ...)`
    const skipAfterOf = skipWhitespaceAt(skipRE, p.input, next)
    next = next + skipAfterOf.length
    if (p.input.charCodeAt(next) !== 61 /* '=' */ ||
      // Check for ==, === and => operators
      (ch = p.input.charCodeAt(next + 1)) === 61 /* '=' */ || ch === 62 /* '>' */) {
      return false
    }
  }
  return true
}

function isAwaitUsing(p: Parser, isFor: boolean): boolean {
  return isUsingKeyword(p, true, isFor)
}

function isUsing(p: Parser, isFor: boolean): boolean {
  return isUsingKeyword(p, false, isFor)
}

// Parse a single statement.
//
// If expecting a statement and finding a slash operator, parse a
// regular expression literal. This is to handle cases like
// `if (foo) /blah/.exec(foo)`, where looking at the previous token
// does not help.

export function parseStatement(p: Parser, context: string | null, topLevel?: boolean, exports?: Exports | null): Statement {
  let starttype = p.type, node = startNode(p), kind: VariableKind | undefined

  if (isLet(p, context)) {
    starttype = tt._var
    kind = "let"
  }

  // Most types of statements are recognized by the keyword they
  // start with. Many are trivial to parse, some require a bit of
  // complexity.

  switch (starttype) {
  case tt._break: case tt._continue: return parseBreakContinueStatement(p, node, starttype === tt._break)
  case tt._debugger: return parseDebuggerStatement(p, node)
  case tt._do: return parseDoStatement(p, node)
  case tt._for: return parseForStatement(p, node)
  case tt._function:
    // Function as sole body of either an if statement or a labeled statement
    // works, but not when it is part of a labeled statement that is the sole
    // body of an if statement.
    if ((context && (p.strict || context !== "if" && context !== "label")) && p.options.ecmaVersion >= 6) unexpected(p)
    return parseFunctionStatement(p, node, false, !context)
  case tt._class:
    if (context) unexpected(p)
    return parseClass(p, node, true)
  case tt._if: return parseIfStatement(p, node)
  case tt._return: return parseReturnStatement(p, node)
  case tt._switch: return parseSwitchStatement(p, node)
  case tt._throw: return parseThrowStatement(p, node)
  case tt._try: return parseTryStatement(p, node)
  case tt._const: case tt._var:
    kind = kind || (p.value === "const" ? "const" : "var")
    if (context && kind !== "var") unexpected(p)
    return parseVarStatement(p, node, kind)
  case tt._while: return parseWhileStatement(p, node)
  case tt._with: return parseWithStatement(p, node)
  case tt.braceL: return parseBlock(p, true, node)
  case tt.semi: return parseEmptyStatement(p, node)
  case tt._export:
  case tt._import:
    if (p.options.ecmaVersion > 10 && starttype === tt._import) {
      let skip = skipWhitespaceAt(whitespaceRE(p.inModule), p.input, p.pos)
      let next = p.pos + skip.length, nextCh = p.input.charCodeAt(next)
      if (nextCh === 40 || nextCh === 46) // '(' or '.'
        return parseExpressionStatement(p, node, parseExpression(p))
    }

    if (!p.options.allowImportExportEverywhere) {
      if (!topLevel)
        raise(p, p.start, "'import' and 'export' may only appear at the top level")
      if (!p.inModule)
        raise(p, p.start, "'import' and 'export' may appear only with 'sourceType: module'")
    }
    return starttype === tt._import ? parseImport(p, node) : parseExport(p, node, exports)

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
  default: {
    if (isAsyncFunction(p)) {
      if (context) unexpected(p)
      next(p)
      return parseFunctionStatement(p, node, true, !context)
    }

    let usingKind: VariableKind | null = isAwaitUsing(p, false) ? "await using" : isUsing(p, false) ? "using" : null
    if (usingKind) {
      if (!allowUsing(p)) {
        raise(p, p.start, "Using declaration cannot appear in the top level when source type is `script` or in the bare case statement")
      }
      if (context) {
        // Cases like `for (;;) using x = ...;`, `if (true) await using x = ...;`, etc. are not allowed.
        raise(p, p.start, "Using declaration is not allowed in single-statement positions")
      }
      if (usingKind === "await using") {
        if (!canAwait(p)) {
          raise(p, p.start, "Await using cannot appear outside of async function")
        }
        next(p)
      }
      next(p)
      let declarations = parseVar(p, false, usingKind)
      semicolon(p)
      return {type: "VariableDeclaration", span: finishSpan(p, node), declarations, kind: usingKind}
    }

    let maybeName = p.value, expr = parseExpression(p)
    if (starttype === tt.name && expr.type === "Identifier" && eat(p, tt.colon))
      return parseLabeledStatement(p, node, typeof maybeName === "string" ? maybeName : unreachable("name token without a name"), expr, context)
    else return parseExpressionStatement(p, node, expr)
  }
  }
}

function parseBreakContinueStatement(p: Parser, node: NodeStart, isBreak: boolean): Statement {
  let keyword = isBreak ? "break" : "continue"
  next(p)
  let label: Identifier | null
  if (eat(p, tt.semi) || insertSemicolon(p)) label = null
  else if (p.type !== tt.name) return unexpected(p)
  else {
    label = parseIdent(p)
    semicolon(p)
  }

  // Verify that there is an actual destination to break or
  // continue to.
  let i = 0
  for (; i < p.labels.length; ++i) {
    let lab = p.labels[i]
    if (label == null || lab.name === label.name) {
      if (lab.kind != null && (isBreak || lab.kind === "loop")) break
      if (label && isBreak) break
    }
  }
  if (i === p.labels.length) raise(p, node.start, "Unsyntactic " + keyword)
  return {type: isBreak ? "BreakStatement" : "ContinueStatement", span: finishSpan(p, node), label}
}

function parseDebuggerStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  semicolon(p)
  return {type: "DebuggerStatement", span: finishSpan(p, node)}
}

function parseDoStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  p.labels.push(loopLabel)
  let body = parseStatement(p, "do")
  p.labels.pop()
  expect(p, tt._while)
  let test = parseParenExpression(p)
  if (p.options.ecmaVersion >= 6)
    eat(p, tt.semi)
  else
    semicolon(p)
  return {type: "DoWhileStatement", span: finishSpan(p, node), body, test}
}

// Disambiguating between a `for` and a `for`/`in` or `for`/`of`
// loop is non-trivial. Basically, we have to parse the init `var`
// statement or expression, disallowing the `in` operator (see
// the second parameter to `parseExpression`), and then check
// whether the next token is `in` or `of`. When there is no init
// part (semicolon immediately after the opening parenthesis), it
// is a regular `for` loop.

function parseForStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  let awaitAt = (p.options.ecmaVersion >= 9 && canAwait(p) && eatContextual(p, "await")) ? p.lastTokStart : -1
  p.labels.push(loopLabel)
  enterScope(p, 0)
  expect(p, tt.parenL)
  if (p.type === tt.semi) {
    if (awaitAt > -1) unexpected(p, awaitAt)
    return parseFor(p, node, null)
  }
  let letDecl = isLet(p)
  if (p.type === tt._var || p.type === tt._const || letDecl) {
    let init = startNode(p), kind: VariableKind = letDecl ? "let" : p.value === "const" ? "const" : "var"
    next(p)
    let declarations = parseVar(p, true, kind)
    let decl: VariableDeclaration = {type: "VariableDeclaration", span: finishSpan(p, init), declarations, kind}
    return parseForAfterInit(p, node, decl, awaitAt)
  }
  let startsWithLet = isContextual(p, "let"), isForOf = false

  let usingKind: VariableKind | null = isUsing(p, true) ? "using" : isAwaitUsing(p, true) ? "await using" : null
  if (usingKind) {
    let init = startNode(p)
    next(p)
    if (usingKind === "await using") {
      if (!canAwait(p)) {
        raise(p, p.start, "Await using cannot appear outside of async function")
      }
      next(p)
    }
    let declarations = parseVar(p, true, usingKind)
    let decl: VariableDeclaration = {type: "VariableDeclaration", span: finishSpan(p, init), declarations, kind: usingKind}
    return parseForAfterInit(p, node, decl, awaitAt)
  }
  let containsEsc = p.containsEsc
  let refDestructuringErrors = new DestructuringErrors
  let initPos = p.start
  let init = awaitAt > -1
    ? parseExprSubscripts(p, refDestructuringErrors, "await")
    : parseExpression(p, true, refDestructuringErrors)
  if (p.type === tt._in || (isForOf = p.options.ecmaVersion >= 6 && isContextual(p, "of"))) {
    let isAwait: boolean | undefined = undefined
    if (awaitAt > -1) { // implies `ecmaVersion >= 9` (see declaration of awaitAt)
      if (p.type === tt._in) unexpected(p, awaitAt)
      isAwait = true
    } else if (isForOf && p.options.ecmaVersion >= 8) {
      if (init.span.start === initPos && !containsEsc && init.type === "Identifier" && init.name === "async") unexpected(p)
      else if (p.options.ecmaVersion >= 9) isAwait = false
    }
    if (startsWithLet && isForOf) raise(p, init.span.start, "The left-hand side of a for-of loop may not start with 'let'.")
    let left = toAssignable(p, init, false, refDestructuringErrors)
    checkLValPattern(p, left)
    return parseForIn(p, node, left, isAwait)
  } else {
    checkExpressionErrors(p, refDestructuringErrors, true)
  }
  if (awaitAt > -1) unexpected(p, awaitAt)
  return parseFor(p, node, init)
}

// Helper method to parse for loop after variable initialization
function parseForAfterInit(p: Parser, node: NodeStart, init: VariableDeclaration, awaitAt: number): Statement {
  if ((p.type === tt._in || (p.options.ecmaVersion >= 6 && isContextual(p, "of"))) && init.declarations.length === 1) {
    let isAwait: boolean | undefined = undefined
    if (p.type === tt._in) {
      if ((init.kind === "using" || init.kind === "await using") && !init.declarations[0].init) {
        raise(p, p.start, "Using declaration is not allowed in for-in loops")
      }
      if (p.options.ecmaVersion >= 9 && awaitAt > -1) unexpected(p, awaitAt)
    } else if (p.options.ecmaVersion >= 9) isAwait = awaitAt > -1
    return parseForIn(p, node, init, isAwait)
  }
  if (awaitAt > -1) unexpected(p, awaitAt)
  return parseFor(p, node, init)
}

function parseFunctionStatement(p: Parser, node: NodeStart, isAsync: boolean, declarationPosition: boolean): Statement {
  next(p)
  return parseFunction(p, node, FUNC_STATEMENT | (declarationPosition ? 0 : FUNC_HANGING_STATEMENT), false, isAsync)
}

function parseIfStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  let test = parseParenExpression(p)
  // allow function declarations in branches, but only in non-strict mode
  let consequent = parseStatement(p, "if")
  let alternate = eat(p, tt._else) ? parseStatement(p, "if") : null
  return {type: "IfStatement", span: finishSpan(p, node), test, consequent, alternate}
}

function parseReturnStatement(p: Parser, node: NodeStart): Statement {
  if (!allowReturn(p))
    raise(p, p.start, "'return' outside of function")
  next(p)

  // In `return` (and `break`/`continue`), the keywords with
  // optional arguments, we eagerly look for a semicolon or the
  // possibility to insert one.

  let argument: Expression | null
  if (eat(p, tt.semi) || insertSemicolon(p)) argument = null
  else { argument = parseExpression(p); semicolon(p) }
  return {type: "ReturnStatement", span: finishSpan(p, node), argument}
}

function parseSwitchStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  let discriminant = parseParenExpression(p)
  let cases: SwitchCase[] = []
  expect(p, tt.braceL)
  p.labels.push(switchLabel)
  enterScope(p, SCOPE_SWITCH)

  // Statements under must be grouped (by label) in SwitchCase
  // nodes. `cur` is used to keep the case that we are currently
  // adding statements to.

  let cur: {start: NodeStart, consequent: Statement[], test: Expression | null} | null = null
  for (let sawDefault = false; p.type !== tt.braceR;) {
    if (p.type === tt._case || p.type === tt._default) {
      let isCase = p.type === tt._case
      if (cur) cases.push({type: "SwitchCase", span: finishSpan(p, cur.start), consequent: cur.consequent, test: cur.test})
      let start = startNode(p)
      next(p)
      let test: Expression | null
      if (isCase) {
        test = parseExpression(p)
      } else {
        if (sawDefault) raiseRecoverable(p, p.lastTokStart, "Multiple default clauses")
        sawDefault = true
        test = null
      }
      cur = {start, consequent: [], test}
      expect(p, tt.colon)
    } else {
      if (!cur) unexpected(p)
      cur.consequent.push(parseStatement(p, null))
    }
  }
  exitScope(p)
  if (cur) cases.push({type: "SwitchCase", span: finishSpan(p, cur.start), consequent: cur.consequent, test: cur.test})
  next(p) // Closing brace
  p.labels.pop()
  return {type: "SwitchStatement", span: finishSpan(p, node), discriminant, cases}
}

function parseThrowStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  if (lineBreak.test(p.input.slice(p.lastTokEnd, p.start)))
    raise(p, p.lastTokEnd, "Illegal newline after throw")
  let argument = parseExpression(p)
  semicolon(p)
  return {type: "ThrowStatement", span: finishSpan(p, node), argument}
}

function parseCatchClauseParam(p: Parser): Pattern {
  const param = parseBindingAtom(p)
  let simple = param.type === "Identifier"
  enterScope(p, simple ? SCOPE_SIMPLE_CATCH : 0)
  checkLValPattern(p, param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL)
  expect(p, tt.parenR)

  return param
}

function parseTryStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  let block = parseBlock(p)
  let handler: CatchClause | null = null
  if (p.type === tt._catch) {
    let clause = startNode(p)
    next(p)
    let param: Pattern | null
    if (eat(p, tt.parenL)) {
      param = parseCatchClauseParam(p)
    } else {
      if (p.options.ecmaVersion < 10) unexpected(p)
      param = null
      enterScope(p, 0)
    }
    let body = parseBlock(p, false)
    exitScope(p)
    handler = {type: "CatchClause", span: finishSpan(p, clause), param, body}
  }
  let finalizer = eat(p, tt._finally) ? parseBlock(p) : null
  if (!handler && !finalizer)
    raise(p, node.start, "Missing catch or finally clause")
  return {type: "TryStatement", span: finishSpan(p, node), block, handler, finalizer}
}

function parseVarStatement(p: Parser, node: NodeStart, kind: VariableKind): Statement {
  next(p)
  let declarations = parseVar(p, false, kind)
  semicolon(p)
  return {type: "VariableDeclaration", span: finishSpan(p, node), declarations, kind}
}

function parseWhileStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  let test = parseParenExpression(p)
  p.labels.push(loopLabel)
  let body = parseStatement(p, "while")
  p.labels.pop()
  return {type: "WhileStatement", span: finishSpan(p, node), test, body}
}

function parseWithStatement(p: Parser, node: NodeStart): Statement {
  if (p.strict) raise(p, p.start, "'with' in strict mode")
  next(p)
  let object = parseParenExpression(p)
  let body = parseStatement(p, "with")
  return {type: "WithStatement", span: finishSpan(p, node), object, body}
}

function parseEmptyStatement(p: Parser, node: NodeStart): Statement {
  next(p)
  return {type: "EmptyStatement", span: finishSpan(p, node)}
}

function parseLabeledStatement(p: Parser, node: NodeStart, maybeName: string, expr: Identifier, context: string | null): Statement {
  for (let label of p.labels)
    if (label.name === maybeName)
      raise(p, expr.span.start, "Label '" + maybeName + "' is already declared")
  let kind: Label["kind"] = p.type.isLoop ? "loop" : p.type === tt._switch ? "switch" : null
  for (let i = p.labels.length - 1; i >= 0; i--) {
    let label = p.labels[i]
    if (label.statementStart === node.start) {
      // Update information about previous labels on this node
      label.statementStart = p.start
      label.kind = kind
    } else break
  }
  p.labels.push({name: maybeName, kind, statementStart: p.start})
  let body = parseStatement(p, context ? context.indexOf("label") === -1 ? context + "label" : context : "label")
  p.labels.pop()
  return {type: "LabeledStatement", span: finishSpan(p, node), body, label: expr}
}

function parseExpressionStatement(p: Parser, node: NodeStart, expr: Expression): Statement {
  semicolon(p)
  return {type: "ExpressionStatement", span: finishSpan(p, node), expression: expr, directive: undefined}
}

// Parse a semicolon-enclosed block of statements, handling `"use
// strict"` declarations when `allowStrict` is true (used for
// function bodies).

export function parseBlock(p: Parser, createNewLexicalScope: boolean = true, node: NodeStart = startNode(p), exitStrict?: boolean): BlockStatement {
  let body: Statement[] = []
  expect(p, tt.braceL)
  if (createNewLexicalScope) enterScope(p, 0)
  while (p.type !== tt.braceR) {
    let stmt = parseStatement(p, null)
    body.push(stmt)
  }
  if (exitStrict) p.strict = false
  next(p)
  if (createNewLexicalScope) exitScope(p)
  return {type: "BlockStatement", span: finishSpan(p, node), body}
}

// Parse a regular `for` loop. The disambiguation code in
// `parseStatement` will already have parsed the init statement or
// expression.

function parseFor(p: Parser, node: NodeStart, init: VariableDeclaration | Expression | null): Statement {
  expect(p, tt.semi)
  let test = p.type === tt.semi ? null : parseExpression(p)
  expect(p, tt.semi)
  let update = p.type === tt.parenR ? null : parseExpression(p)
  expect(p, tt.parenR)
  let body = parseStatement(p, "for")
  exitScope(p)
  p.labels.pop()
  return {type: "ForStatement", span: finishSpan(p, node), init, test, update, body}
}

// Parse a `for`/`in` and `for`/`of` loop, which are almost
// same from parser's perspective.

function parseForIn(p: Parser, node: NodeStart, init: VariableDeclaration | Pattern, isAwait: boolean | undefined): Statement {
  const isForIn = p.type === tt._in
  next(p)

  if (
    init.type === "VariableDeclaration" &&
    init.declarations[0].init != null &&
    (
      !isForIn ||
      p.options.ecmaVersion < 8 ||
      p.strict ||
      init.kind !== "var" ||
      init.declarations[0].id.type !== "Identifier"
    )
  ) {
    raise(p,
      init.span.start,
      `${
        isForIn ? "for-in" : "for-of"
      } loop variable declaration may not have an initializer`
    )
  }
  let right = isForIn ? parseExpression(p) : parseMaybeAssign(p)
  expect(p, tt.parenR)
  let body = parseStatement(p, "for")
  exitScope(p)
  p.labels.pop()
  return {type: isForIn ? "ForInStatement" : "ForOfStatement", span: finishSpan(p, node), await: isAwait, left: init, right, body}
}

// Parse a list of variable declarations.

function parseVar(p: Parser, isFor: boolean, kind: VariableKind): VariableDeclarator[] {
  let declarations: VariableDeclarator[] = []
  for (;;) {
    let decl = startNode(p)
    let id = parseVarId(p, kind)
    let init: Expression | null
    if (eat(p, tt.eq)) {
      init = parseMaybeAssign(p, isFor)
    } else if ((kind === "const" || kind === "using" || kind === "await using" || id.type !== "Identifier") &&
               !(isFor && (p.type === tt._in || (p.options.ecmaVersion >= 6 && isContextual(p, "of"))))) {
      raise(p, p.lastTokEnd, id.type !== "Identifier"
        ? "Complex binding patterns require an initialization value"
        : `Missing initializer in ${kind} declaration`)
    } else {
      init = null
    }
    declarations.push({type: "VariableDeclarator", span: finishSpan(p, decl), id, init})
    if (!eat(p, tt.comma)) break
  }
  return declarations
}

function parseVarId(p: Parser, kind: VariableKind): Pattern {
  let id = kind === "using" || kind === "await using"
    ? parseIdent(p)
    : parseBindingAtom(p)

  checkLValPattern(p, id, kind === "var" ? BIND_VAR : BIND_LEXICAL, false)
  return id
}

const FUNC_STATEMENT = 1, FUNC_HANGING_STATEMENT = 2, FUNC_NULLABLE_ID = 4

// Parse a function declaration or literal (depending on the
// `statement & FUNC_STATEMENT`).

// Remove `allowExpressionBody` for 7.0.0, as it is only called with false
export function parseFunction(p: Parser, node: NodeStart, statement: number, allowExpressionBody?: boolean, isAsync?: boolean, forInit?: ForInit): FunctionNode {
  let generator: boolean | undefined = p.options.ecmaVersion >= 6 ? false : undefined
  if (p.options.ecmaVersion >= 9 || p.options.ecmaVersion >= 6 && !isAsync) {
    if (p.type === tt.star && (statement & FUNC_HANGING_STATEMENT))
      unexpected(p)
    generator = eat(p, tt.star)
  }
  let async = p.options.ecmaVersion >= 8 ? !!isAsync : undefined

  let id: Identifier | null = null
  if (statement & FUNC_STATEMENT) {
    id = (statement & FUNC_NULLABLE_ID) && p.type !== tt.name ? null : parseIdent(p)
    if (id && !(statement & FUNC_HANGING_STATEMENT))
      // If it is a regular function declaration in sloppy mode, then it is
      // subject to Annex B semantics (BIND_FUNCTION). Otherwise, the binding
      // mode depends on properties of the current scope (see
      // treatFunctionsAsVar).
      checkLValSimple(p, id, (p.strict || generator || async) ? treatFunctionsAsVar(p) ? BIND_VAR : BIND_LEXICAL : BIND_FUNCTION)
  }

  let oldYieldPos = p.yieldPos, oldAwaitPos = p.awaitPos, oldAwaitIdentPos = p.awaitIdentPos
  p.yieldPos = 0
  p.awaitPos = 0
  p.awaitIdentPos = 0
  enterScope(p, functionFlags(!!async, !!generator))

  if (!(statement & FUNC_STATEMENT))
    id = p.type === tt.name ? parseIdent(p) : null

  let params = parseFunctionParams(p)
  let {body, expression} = parseFunctionBody(p, node, id, params, !!allowExpressionBody, false, forInit)

  p.yieldPos = oldYieldPos
  p.awaitPos = oldAwaitPos
  p.awaitIdentPos = oldAwaitIdentPos
  return {
    type: (statement & FUNC_STATEMENT) ? "FunctionDeclaration" : "FunctionExpression", span: finishSpan(p, node),
    id, expression, generator, async, params, body
  }
}

function parseFunctionParams(p: Parser): Pattern[] {
  expect(p, tt.parenL)
  let params = noNulls(parseBindingList(p, tt.parenR, false, p.options.ecmaVersion >= 8))
  checkYieldAwaitInDefaultParams(p)
  return params
}

// Parse a class declaration or literal (depending on the
// `isStatement` parameter).

export function parseClass(p: Parser, node: NodeStart, isStatement: boolean | "nullableID"): ClassNode {
  next(p)

  // ecma-262 14.6 Class Definitions
  // A class definition is always strict mode code.
  const oldStrict = p.strict
  p.strict = true

  let id = parseClassId(p, isStatement)
  let superClass = parseClassSuper(p)
  const privateNameMap = enterClassBody(p)
  const classBody = startNode(p)
  let hadConstructor = false
  let body: ClassElement[] = []
  expect(p, tt.braceL)
  while (p.type !== tt.braceR) {
    const element = parseClassElement(p, superClass !== null)
    if (element) {
      body.push(element)
      if (element.type === "MethodDefinition" && element.kind === "constructor") {
        if (hadConstructor) raiseRecoverable(p, element.span.start, "Duplicate constructor in the same class")
        hadConstructor = true
      } else if (element.type !== "StaticBlock" && element.key.type === "PrivateIdentifier" && isPrivateNameConflicted(privateNameMap, element, element.key.name)) {
        raiseRecoverable(p, element.key.span.start, `Identifier '#${element.key.name}' has already been declared`)
      }
    }
  }
  p.strict = oldStrict
  next(p)
  let classBodyNode: ClassNode["body"] = {type: "ClassBody", span: finishSpan(p, classBody), body}
  exitClassBody(p)
  return {type: isStatement ? "ClassDeclaration" : "ClassExpression", span: finishSpan(p, node), id, superClass, body: classBodyNode}
}

function parseClassElement(p: Parser, constructorAllowsSuper: boolean): ClassElement | null {
  if (eat(p, tt.semi)) return null

  const ecmaVersion = p.options.ecmaVersion
  const node = startNode(p)
  let keyName = ""
  let isGenerator = false
  let isAsync = false
  let kind: "method" | "get" | "set" = "method"
  let isStatic = false

  if (eatContextual(p, "static")) {
    // Parse static init block
    if (ecmaVersion >= 13 && eat(p, tt.braceL)) {
      return parseClassStaticBlock(p, node)
    }
    if (isClassElementNameStart(p) || p.type === tt.star) {
      isStatic = true
    } else {
      keyName = "static"
    }
  }
  if (!keyName && ecmaVersion >= 8 && eatContextual(p, "async")) {
    if ((isClassElementNameStart(p) || p.type === tt.star) && !canInsertSemicolon(p)) {
      isAsync = true
    } else {
      keyName = "async"
    }
  }
  if (!keyName && (ecmaVersion >= 9 || !isAsync) && eat(p, tt.star)) {
    isGenerator = true
  }
  if (!keyName && !isAsync && !isGenerator) {
    const lastValue = p.value
    if (eatContextual(p, "get") || eatContextual(p, "set")) {
      if (isClassElementNameStart(p)) {
        kind = lastValue === "get" ? "get" : "set"
      } else {
        keyName = tokenValueString(lastValue)
      }
    }
  }

  // Parse element name
  let computed: boolean, key: Expression
  if (keyName) {
    // 'async', 'get', 'set', or 'static' were not a keyword contextually.
    // The last token is any of those. Make it the element name.
    computed = false
    let keyStart = startNodeAt(p.lastTokStart, p.lastTokStartLoc)
    key = {type: "Identifier", span: finishSpan(p, keyStart), name: keyName}
  } else {
    ({computed, key} = parseClassElementName(p))
  }

  // Parse element value
  if (ecmaVersion < 13 || p.type === tt.parenL || kind !== "method" || isGenerator || isAsync) {
    const isConstructor = !isStatic && checkKeyName(computed, key, "constructor")
    const allowsDirectSuper = isConstructor && constructorAllowsSuper
    // Couldn't move this check into the 'parseClassMethod' method for backward compatibility.
    if (isConstructor && kind !== "method") raise(p, key.span.start, "Constructor can't have get/set modifier")
    return parseClassMethod(p, node, isStatic, computed, key, isConstructor ? "constructor" : kind, isGenerator, isAsync, allowsDirectSuper)
  } else {
    return parseClassField(p, node, isStatic, computed, key)
  }
}

function tokenValueString(value: Parser["value"]): string {
  return typeof value === "string" ? value : unreachable("expected a string token value")
}

function isClassElementNameStart(p: Parser): boolean {
  return (
    p.type === tt.name ||
    p.type === tt.privateId ||
    p.type === tt.num ||
    p.type === tt.string ||
    p.type === tt.bracketL ||
    !!p.type.keyword
  )
}

function parseClassElementName(p: Parser): {computed: boolean, key: Expression} {
  if (p.type === tt.privateId) {
    if (p.value === "constructor") {
      raise(p, p.start, "Classes can't have an element named '#constructor'")
    }
    return {computed: false, key: parsePrivateIdent(p)}
  } else {
    let {computed, key} = parsePropertyName(p)
    // Classes only exist from ES6 on, where property names always
    // record whether they are computed.
    return {computed: computed === true, key}
  }
}

function parseClassMethod(p: Parser, node: NodeStart, isStatic: boolean, computed: boolean, key: Expression, kind: MethodDefinition["kind"], isGenerator: boolean, isAsync: boolean, allowsDirectSuper: boolean): MethodDefinition {
  // Check key and flags
  if (kind === "constructor") {
    if (isGenerator) raise(p, key.span.start, "Constructor can't be a generator")
    if (isAsync) raise(p, key.span.start, "Constructor can't be an async method")
  } else if (isStatic && checkKeyName(computed, key, "prototype")) {
    raise(p, key.span.start, "Classes may not have a static property named prototype")
  }

  // Parse value
  const value = parseMethod(p, isGenerator, isAsync, allowsDirectSuper)

  // Check value
  if (kind === "get" && value.params.length !== 0)
    raiseRecoverable(p, value.span.start, "getter should have no params")
  if (kind === "set" && value.params.length !== 1)
    raiseRecoverable(p, value.span.start, "setter should have exactly one param")
  if (kind === "set" && value.params[0].type === "RestElement")
    raiseRecoverable(p, value.params[0].span.start, "Setter cannot use rest params")

  return {type: "MethodDefinition", span: finishSpan(p, node), static: isStatic, computed, key, kind, value}
}

function parseClassField(p: Parser, node: NodeStart, isStatic: boolean, computed: boolean, key: Expression): PropertyDefinition {
  if (checkKeyName(computed, key, "constructor")) {
    raise(p, key.span.start, "Classes can't have a field named 'constructor'")
  } else if (isStatic && checkKeyName(computed, key, "prototype")) {
    raise(p, key.span.start, "Classes can't have a static field named 'prototype'")
  }

  let value: Expression | null
  if (eat(p, tt.eq)) {
    // To raise SyntaxError if 'arguments' exists in the initializer.
    enterScope(p, SCOPE_CLASS_FIELD_INIT | SCOPE_SUPER)
    value = parseMaybeAssign(p)
    exitScope(p)
  } else {
    value = null
  }
  semicolon(p)

  return {type: "PropertyDefinition", span: finishSpan(p, node), static: isStatic, computed, key, value}
}

function parseClassStaticBlock(p: Parser, node: NodeStart): StaticBlock {
  let body: Statement[] = []

  let oldLabels = p.labels
  p.labels = []
  enterScope(p, SCOPE_CLASS_STATIC_BLOCK | SCOPE_SUPER)
  while (p.type !== tt.braceR) {
    let stmt = parseStatement(p, null)
    body.push(stmt)
  }
  next(p)
  exitScope(p)
  p.labels = oldLabels

  return {type: "StaticBlock", span: finishSpan(p, node), body}
}

function parseClassId(p: Parser, isStatement: boolean | "nullableID"): Identifier | null {
  if (p.type === tt.name) {
    let id = parseIdent(p)
    if (isStatement)
      checkLValSimple(p, id, BIND_LEXICAL, false)
    else if (p.strict && p.reservedWordsStrictBind.test(id.name))
      raiseRecoverable(p, id.span.start, `Binding ${id.name} in strict mode`)
    return id
  } else {
    if (isStatement === true)
      unexpected(p)
    return null
  }
}

function parseClassSuper(p: Parser): Expression | null {
  return eat(p, tt._extends) ? parseExprSubscripts(p, null, false) : null
}

function enterClassBody(p: Parser): Map<string, string> {
  const element = {declared: new Map<string, string>(), used: []}
  p.privateNameStack.push(element)
  return element.declared
}

function exitClassBody(p: Parser): void {
  const {declared, used} = p.privateNameStack.pop() || unreachable("unbalanced private name stack")
  if (!p.options.checkPrivateFields) return
  const len = p.privateNameStack.length
  const parent = len === 0 ? null : p.privateNameStack[len - 1]
  for (let i = 0; i < used.length; ++i) {
    const id = used[i]
    if (!declared.has(id.name)) {
      if (parent) {
        parent.used.push(id)
      } else {
        raiseRecoverable(p, id.span.start, `Private field '#${id.name}' must be declared in an enclosing class`)
      }
    }
  }
}

function isPrivateNameConflicted(privateNameMap: Map<string, string>, element: MethodDefinition | PropertyDefinition, name: string): boolean {
  const curr = privateNameMap.get(name)

  let next = "true"
  if (element.type === "MethodDefinition" && (element.kind === "get" || element.kind === "set")) {
    next = (element.static ? "s" : "i") + element.kind
  }

  // `class { get #a(){}; static set #a(_){} }` is also conflict.
  if (
    curr === "iget" && next === "iset" ||
    curr === "iset" && next === "iget" ||
    curr === "sget" && next === "sset" ||
    curr === "sset" && next === "sget"
  ) {
    privateNameMap.set(name, "true")
    return false
  } else if (!curr) {
    privateNameMap.set(name, next)
    return false
  } else {
    return true
  }
}

function checkKeyName(computed: boolean, key: Expression, name: string): boolean {
  return !computed && (
    key.type === "Identifier" && key.name === name ||
    key.type === "Literal" && key.value === name
  )
}

// Parses module export declaration.

function parseExportAllDeclaration(p: Parser, node: NodeStart, exports: Exports | null | undefined): Statement {
  let exported: Identifier | Literal | null | undefined = undefined
  if (p.options.ecmaVersion >= 11) {
    if (eatContextual(p, "as")) {
      exported = parseModuleExportName(p)
      checkExport(p, exports, exported, p.lastTokStart)
    } else {
      exported = null
    }
  }
  expectContextual(p, "from")
  if (p.type !== tt.string) unexpected(p)
  let source = parseStringLiteral(p)
  let attributes = p.options.ecmaVersion >= 16 ? parseWithClause(p) : undefined
  semicolon(p)
  return {type: "ExportAllDeclaration", span: finishSpan(p, node), exported, source, attributes}
}

function parseExport(p: Parser, node: NodeStart, exports: Exports | null | undefined): Statement {
  next(p)
  // export * from '...'
  if (eat(p, tt.star)) {
    return parseExportAllDeclaration(p, node, exports)
  }
  if (eat(p, tt._default)) { // export default ...
    checkExport(p, exports, "default", p.lastTokStart)
    let declaration = parseExportDefaultDeclaration(p)
    return {type: "ExportDefaultDeclaration", span: finishSpan(p, node), declaration}
  }
  let declaration: Statement | null, specifiers: ExportSpecifier[], source: Literal | null
  let attributes: ImportAttribute[] | undefined = undefined
  // export var|const|let|function|class ...
  if (shouldParseExportStatement(p)) {
    declaration = parseStatement(p, null)
    if (declaration.type === "VariableDeclaration")
      checkVariableExport(p, exports, declaration.declarations)
    else if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id)
      checkExport(p, exports, declaration.id, declaration.id.span.start)
    else
      unreachable("exported declaration without a name")
    specifiers = []
    source = null
    if (p.options.ecmaVersion >= 16)
      attributes = []
  } else { // export { x, y as z } [from '...']
    declaration = null
    specifiers = parseExportSpecifiers(p, exports)
    if (eatContextual(p, "from")) {
      if (p.type !== tt.string) unexpected(p)
      source = parseStringLiteral(p)
      if (p.options.ecmaVersion >= 16)
        attributes = parseWithClause(p)
    } else {
      for (let spec of specifiers) {
        let local = spec.local
        if (local.type === "Literal") {
          raise(p, local.span.start, "A string literal cannot be used as an exported binding without `from`.")
        }
        // check for keywords used as local names
        checkUnreserved(p, local)
        // check if export is defined
        checkLocalExport(p, local)
      }

      source = null
      if (p.options.ecmaVersion >= 16)
        attributes = []
    }
    semicolon(p)
  }
  return {type: "ExportNamedDeclaration", span: finishSpan(p, node), declaration, specifiers, source, attributes}
}

function parseExportDefaultDeclaration(p: Parser): FunctionNode | ClassNode | Expression {
  let isAsync
  if (p.type === tt._function || (isAsync = isAsyncFunction(p))) {
    let fNode = startNode(p)
    next(p)
    if (isAsync) next(p)
    return parseFunction(p, fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync)
  } else if (p.type === tt._class) {
    let cNode = startNode(p)
    return parseClass(p, cNode, "nullableID")
  } else {
    let declaration = parseMaybeAssign(p)
    semicolon(p)
    return declaration
  }
}

function checkExport(p: Parser, exports: Exports | null | undefined, name: string | Identifier | Literal, pos: number): void {
  if (!exports) return
  let exportName = typeof name === "string" ? name
    : name.type === "Identifier" ? name.name
    : typeof name.value === "string" ? name.value : unreachable("non-string module export name")
  if (exports.has(exportName))
    raiseRecoverable(p, pos, "Duplicate export '" + exportName + "'")
  exports.add(exportName)
}

function checkPatternExport(p: Parser, exports: Exports, pat: Node): void {
  if (pat.type === "Identifier")
    checkExport(p, exports, pat, pat.span.start)
  else if (pat.type === "ObjectPattern")
    for (let prop of pat.properties)
      checkPatternExport(p, exports, prop)
  else if (pat.type === "ArrayPattern")
    for (let elt of pat.elements) {
      if (elt) checkPatternExport(p, exports, elt)
    }
  else if (pat.type === "Property")
    checkPatternExport(p, exports, pat.value)
  else if (pat.type === "AssignmentPattern")
    checkPatternExport(p, exports, pat.left)
  else if (pat.type === "RestElement")
    checkPatternExport(p, exports, pat.argument)
}

function checkVariableExport(p: Parser, exports: Exports | null | undefined, decls: VariableDeclarator[]): void {
  if (!exports) return
  for (let decl of decls)
    checkPatternExport(p, exports, decl.id)
}

function shouldParseExportStatement(p: Parser): boolean {
  return p.type.keyword === "var" ||
    p.type.keyword === "const" ||
    p.type.keyword === "class" ||
    p.type.keyword === "function" ||
    isLet(p) ||
    isAsyncFunction(p)
}

// Parses a comma-separated list of module exports.

function parseExportSpecifier(p: Parser, exports: Exports | null | undefined): ExportSpecifier {
  let node = startNode(p)
  let local = parseModuleExportName(p)

  let exported = eatContextual(p, "as") ? parseModuleExportName(p) : local
  checkExport(p,
    exports,
    exported,
    exported.span.start
  )

  return {type: "ExportSpecifier", span: finishSpan(p, node), local, exported}
}

function parseExportSpecifiers(p: Parser, exports: Exports | null | undefined): ExportSpecifier[] {
  let nodes = [], first = true
  // export { x, y as z } [from '...']
  expect(p, tt.braceL)
  while (!eat(p, tt.braceR)) {
    if (!first) {
      expect(p, tt.comma)
      if (afterTrailingComma(p, tt.braceR)) break
    } else first = false

    nodes.push(parseExportSpecifier(p, exports))
  }
  return nodes
}

// Parses import declaration.

function parseImport(p: Parser, node: NodeStart): Statement {
  next(p)

  let specifiers: ImportSpecifierNode[], source: Literal
  // import '...'
  if (p.type === tt.string) {
    specifiers = []
    source = parseStringLiteral(p)
  } else {
    specifiers = parseImportSpecifiers(p)
    expectContextual(p, "from")
    source = p.type === tt.string ? parseStringLiteral(p) : unexpected(p)
  }
  let attributes = p.options.ecmaVersion >= 16 ? parseWithClause(p) : undefined
  semicolon(p)
  return {type: "ImportDeclaration", span: finishSpan(p, node), specifiers, source, attributes}
}

// Parses a comma-separated list of module imports.

function parseImportSpecifier(p: Parser): ImportSpecifierNode {
  let node = startNode(p)
  let imported = parseModuleExportName(p)

  let local: Identifier
  if (eatContextual(p, "as")) {
    local = parseIdent(p)
  } else if (imported.type === "Identifier") {
    checkUnreserved(p, imported)
    local = imported
  } else {
    // A string name can't be used as a local binding.
    return raise(p, imported.span.start, "Binding rvalue")
  }
  checkLValSimple(p, local, BIND_LEXICAL)

  return {type: "ImportSpecifier", span: finishSpan(p, node), imported, local}
}

function parseImportDefaultSpecifier(p: Parser): ImportSpecifierNode {
  // import defaultObj, { x, y as z } from '...'
  let node = startNode(p)
  let local = parseIdent(p)
  checkLValSimple(p, local, BIND_LEXICAL)
  return {type: "ImportDefaultSpecifier", span: finishSpan(p, node), local}
}

function parseImportNamespaceSpecifier(p: Parser): ImportSpecifierNode {
  let node = startNode(p)
  next(p)
  expectContextual(p, "as")
  let local = parseIdent(p)
  checkLValSimple(p, local, BIND_LEXICAL)
  return {type: "ImportNamespaceSpecifier", span: finishSpan(p, node), local}
}

function parseImportSpecifiers(p: Parser): ImportSpecifierNode[] {
  let nodes = [], first = true
  if (p.type === tt.name) {
    nodes.push(parseImportDefaultSpecifier(p))
    if (!eat(p, tt.comma)) return nodes
  }
  if (p.type === tt.star) {
    nodes.push(parseImportNamespaceSpecifier(p))
    return nodes
  }
  expect(p, tt.braceL)
  while (!eat(p, tt.braceR)) {
    if (!first) {
      expect(p, tt.comma)
      if (afterTrailingComma(p, tt.braceR)) break
    } else first = false

    nodes.push(parseImportSpecifier(p))
  }
  return nodes
}

function parseWithClause(p: Parser): ImportAttribute[] {
  let nodes: ImportAttribute[] = []
  if (!eat(p, tt._with)) {
    return nodes
  }
  expect(p, tt.braceL)
  const attributeKeys = new Set<string>()
  let first = true
  while (!eat(p, tt.braceR)) {
    if (!first) {
      expect(p, tt.comma)
      if (afterTrailingComma(p, tt.braceR)) break
    } else first = false

    const attr = parseImportAttribute(p)
    const keyName = attr.key.type === "Identifier" ? attr.key.name : String(attr.key.value)
    if (attributeKeys.has(keyName))
      raiseRecoverable(p, attr.key.span.start, "Duplicate attribute key '" + keyName + "'")
    attributeKeys.add(keyName)
    nodes.push(attr)
  }
  return nodes
}

function parseImportAttribute(p: Parser): ImportAttribute {
  const node = startNode(p)
  let key = p.type === tt.string ? parseStringLiteral(p) : parseIdent(p, p.options.allowReserved !== "never")
  expect(p, tt.colon)
  if (p.type !== tt.string) {
    unexpected(p)
  }
  let value = parseStringLiteral(p)
  return {type: "ImportAttribute", span: finishSpan(p, node), key, value}
}

function parseModuleExportName(p: Parser): Identifier | Literal {
  if (p.options.ecmaVersion >= 13 && p.type === tt.string) {
    const stringLiteral = parseStringLiteral(p)
    if (loneSurrogate.test(String(stringLiteral.value))) {
      raise(p, stringLiteral.span.start, "An export name cannot include a lone surrogate.")
    }
    return stringLiteral
  }
  return parseIdent(p, true)
}

// Parse the current string token as a literal.
function parseStringLiteral(p: Parser): Literal {
  return parseLiteral(p, tokenLiteralValue(p))
}

// Set `ExpressionStatement#directive` property for directive prologues.
export function adaptDirectivePrologue(p: Parser, statements: Statement[]): void {
  for (let i = 0; i < statements.length; ++i) {
    let statement = statements[i]
    if (
      p.options.ecmaVersion >= 5 &&
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "Literal" &&
      typeof statement.expression.value === "string" &&
      // Reject parenthesized strings.
      (p.input[statement.span.start] === "\"" || p.input[statement.span.start] === "'")
    ) {
      statement.directive = statement.expression.raw.slice(1, -1)
    } else {
      break
    }
  }
}
