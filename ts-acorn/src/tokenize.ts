import {isIdentifierStart, isIdentifierChar} from "./identifier.ts"
import {types as tt, keywords as keywordTypes, type TokenType} from "./tokentype.ts"
import type {Parser, TokenValue} from "./state.ts"
import {SourceLocation} from "./locutil.ts"
import {RegExpValidationState, validateRegExpFlags, validateRegExpPattern} from "./regexp.ts"
import {lineBreak, nextLineBreak, isNewLine, nonASCIIwhitespace} from "./whitespace.ts"
import {codePointToString, unreachable} from "./util.ts"
import {raise, raiseRecoverable, curPosition} from "./location.ts"
import {curContext, updateContext} from "./tokencontext.ts"
import {unexpected} from "./parseutil.ts"

// Object type used to represent tokens. Note that normally, tokens
// simply exist as properties on the parser object. This is only
// used for the onToken callback and the external tokenizer.

export class Token {
  type: TokenType
  value: TokenValue
  start: number
  end: number
  declare loc?: SourceLocation
  declare range?: [number, number]

  constructor(p: Parser) {
    this.type = p.type
    this.value = p.value
    this.start = p.start
    this.end = p.end
    if (p.options.locations && p.startLoc)
      this.loc = new SourceLocation(p, p.startLoc, p.endLoc)
    if (p.options.ranges)
      this.range = [p.start, p.end]
  }
}

// ## Tokenizer

// Move to the next token

export function next(p: Parser, ignoreEscapeSequenceInKeyword?: boolean): void {
  if (!ignoreEscapeSequenceInKeyword && p.type.keyword && p.containsEsc)
    raiseRecoverable(p, p.start, "Escape sequence in keyword " + p.type.keyword)
  if (p.options.onToken)
    p.options.onToken(new Token(p))

  p.lastTokEnd = p.end
  p.lastTokStart = p.start
  p.lastTokEndLoc = p.endLoc
  p.lastTokStartLoc = p.startLoc
  nextToken(p)
}

export function getToken(p: Parser): Token {
  next(p)
  return new Token(p)
}

// Toggle strict mode. Re-reads the next number or string to please
// pedantic tests (`"use strict"; 010;` should fail).

// Read a single token, updating the parser object's token-related
// properties.

export function nextToken(p: Parser): void {
  let context = curContext(p)
  if (!context || !context.preserveSpace) skipSpace(p)

  p.start = p.pos
  if (p.options.locations) p.startLoc = curPosition(p)
  if (p.pos >= p.input.length) return finishToken(p, tt.eof)

  if (context.override) return context.override(p)
  else readToken(p, fullCharCodeAtPos(p))
}

export function readToken(p: Parser, code: number): void {
  // Identifier or keyword. '\uXXXX' sequences are allowed in
  // identifiers, so '\' also dispatches to that.
  if (isIdentifierStart(code, p.options.ecmaVersion >= 6) || code === 92 /* '\' */)
    return readWord(p)

  return getTokenFromCode(p, code)
}

export function fullCharCodeAt(p: Parser, pos: number): number {
  let code = p.input.charCodeAt(pos)
  if (code <= 0xd7ff || code >= 0xdc00) return code
  let next = p.input.charCodeAt(pos + 1)
  return next <= 0xdbff || next >= 0xe000 ? code : (code << 10) + next - 0x35fdc00
}

export function fullCharCodeAtPos(p: Parser): number {
  return fullCharCodeAt(p, p.pos)
}

export function skipBlockComment(p: Parser): void {
  let startLoc = p.options.onComment ? curPosition(p) : undefined
  let start = p.pos, end = p.input.indexOf("*/", p.pos += 2)
  if (end === -1) raise(p, p.pos - 2, "Unterminated comment")
  p.pos = end + 2
  if (p.options.locations) {
    for (let nextBreak, pos = start; (nextBreak = nextLineBreak(p.input, pos, p.pos)) > -1;) {
      ++p.curLine
      pos = p.lineStart = nextBreak
    }
  }
  if (p.options.onComment)
    p.options.onComment(true, p.input.slice(start + 2, end), start, p.pos,
                           startLoc, curPosition(p))
}

export function skipLineComment(p: Parser, startSkip: number): void {
  let start = p.pos
  let startLoc = p.options.onComment ? curPosition(p) : undefined
  let ch = p.input.charCodeAt(p.pos += startSkip)
  while (p.pos < p.input.length && !isNewLine(ch)) {
    ch = p.input.charCodeAt(++p.pos)
  }
  if (p.options.onComment)
    p.options.onComment(false, p.input.slice(start + startSkip, p.pos), start, p.pos,
                           startLoc, curPosition(p))
}

// Called at the start of the parse and after every token. Skips
// whitespace and comments, and.

export function skipSpace(p: Parser): void {
  loop: while (p.pos < p.input.length) {
    let ch = p.input.charCodeAt(p.pos)
    switch (ch) {
    case 32: case 160: // ' '
      ++p.pos
      break
    case 13:
      if (p.input.charCodeAt(p.pos + 1) === 10) {
        ++p.pos
      }
    case 10: case 8232: case 8233:
      ++p.pos
      if (p.options.locations) {
        ++p.curLine
        p.lineStart = p.pos
      }
      break
    case 47: // '/'
      switch (p.input.charCodeAt(p.pos + 1)) {
      case 42: // '*'
        skipBlockComment(p)
        break
      case 47:
        skipLineComment(p, 2)
        break
      default:
        break loop
      }
      break
    default:
      if (ch > 8 && ch < 14 || ch >= 5760 && nonASCIIwhitespace.test(String.fromCharCode(ch))) {
        ++p.pos
      } else {
        break loop
      }
    }
  }
}

// Called at the end of every token. Sets `end`, `val`, and
// maintains `context` and `exprAllowed`, and skips the space after
// the token, so that the next one's `start` will point at the
// right position.

export function finishToken(p: Parser, type: TokenType, val?: TokenValue): void {
  p.end = p.pos
  if (p.options.locations) p.endLoc = curPosition(p)
  let prevType = p.type
  p.type = type
  p.value = val

  updateContext(p, prevType)
}

// ### Token reading

// This is the function that is called to fetch the next token. It
// is somewhat obscure, because it works in character codes rather
// than characters, and because operator parsing has been inlined
// into it.
//
// All in the name of speed.
//
export function readToken_dot(p: Parser): void {
  let next = p.input.charCodeAt(p.pos + 1)
  if (next >= 48 && next <= 57) return readNumber(p, true)
  let next2 = p.input.charCodeAt(p.pos + 2)
  if (p.options.ecmaVersion >= 6 && next === 46 && next2 === 46) { // 46 = dot '.'
    p.pos += 3
    return finishToken(p, tt.ellipsis)
  } else {
    ++p.pos
    return finishToken(p, tt.dot)
  }
}

export function readToken_slash(p: Parser): void { // '/'
  let next = p.input.charCodeAt(p.pos + 1)
  if (p.exprAllowed) { ++p.pos; return readRegexp(p) }
  if (next === 61) return finishOp(p, tt.assign, 2)
  return finishOp(p, tt.slash, 1)
}

export function readToken_mult_modulo_exp(p: Parser, code: number): void { // '%*'
  let next = p.input.charCodeAt(p.pos + 1)
  let size = 1
  let tokentype = code === 42 ? tt.star : tt.modulo

  // exponentiation operator ** and **=
  if (p.options.ecmaVersion >= 7 && code === 42 && next === 42) {
    ++size
    tokentype = tt.starstar
    next = p.input.charCodeAt(p.pos + 2)
  }

  if (next === 61) return finishOp(p, tt.assign, size + 1)
  return finishOp(p, tokentype, size)
}

export function readToken_pipe_amp(p: Parser, code: number): void { // '|&'
  let next = p.input.charCodeAt(p.pos + 1)
  if (next === code) {
    if (p.options.ecmaVersion >= 12) {
      let next2 = p.input.charCodeAt(p.pos + 2)
      if (next2 === 61) return finishOp(p, tt.assign, 3)
    }
    return finishOp(p, code === 124 ? tt.logicalOR : tt.logicalAND, 2)
  }
  if (next === 61) return finishOp(p, tt.assign, 2)
  return finishOp(p, code === 124 ? tt.bitwiseOR : tt.bitwiseAND, 1)
}

export function readToken_caret(p: Parser): void { // '^'
  let next = p.input.charCodeAt(p.pos + 1)
  if (next === 61) return finishOp(p, tt.assign, 2)
  return finishOp(p, tt.bitwiseXOR, 1)
}

export function readToken_plus_min(p: Parser, code: number): void { // '+-'
  let next = p.input.charCodeAt(p.pos + 1)
  if (next === code) {
    if (next === 45 && !p.inModule && p.input.charCodeAt(p.pos + 2) === 62 &&
        (p.lastTokEnd === 0 || lineBreak.test(p.input.slice(p.lastTokEnd, p.pos)))) {
      // A `-->` line comment
      skipLineComment(p, 3)
      skipSpace(p)
      return nextToken(p)
    }
    return finishOp(p, tt.incDec, 2)
  }
  if (next === 61) return finishOp(p, tt.assign, 2)
  return finishOp(p, tt.plusMin, 1)
}

export function readToken_lt_gt(p: Parser, code: number): void { // '<>'
  let next = p.input.charCodeAt(p.pos + 1)
  let size = 1
  if (next === code) {
    size = code === 62 && p.input.charCodeAt(p.pos + 2) === 62 ? 3 : 2
    if (p.input.charCodeAt(p.pos + size) === 61) return finishOp(p, tt.assign, size + 1)
    return finishOp(p, tt.bitShift, size)
  }
  if (next === 33 && code === 60 && !p.inModule && p.input.charCodeAt(p.pos + 2) === 45 &&
      p.input.charCodeAt(p.pos + 3) === 45) {
    // `<!--`, an XML-style comment that should be interpreted as a line comment
    skipLineComment(p, 4)
    skipSpace(p)
    return nextToken(p)
  }
  if (next === 61) size = 2
  return finishOp(p, tt.relational, size)
}

export function readToken_eq_excl(p: Parser, code: number): void { // '=!'
  let next = p.input.charCodeAt(p.pos + 1)
  if (next === 61) return finishOp(p, tt.equality, p.input.charCodeAt(p.pos + 2) === 61 ? 3 : 2)
  if (code === 61 && next === 62 && p.options.ecmaVersion >= 6) { // '=>'
    p.pos += 2
    return finishToken(p, tt.arrow)
  }
  return finishOp(p, code === 61 ? tt.eq : tt.prefix, 1)
}

export function readToken_question(p: Parser): void { // '?'
  const ecmaVersion = p.options.ecmaVersion
  if (ecmaVersion >= 11) {
    let next = p.input.charCodeAt(p.pos + 1)
    if (next === 46) {
      let next2 = p.input.charCodeAt(p.pos + 2)
      if (next2 < 48 || next2 > 57) return finishOp(p, tt.questionDot, 2)
    }
    if (next === 63) {
      if (ecmaVersion >= 12) {
        let next2 = p.input.charCodeAt(p.pos + 2)
        if (next2 === 61) return finishOp(p, tt.assign, 3)
      }
      return finishOp(p, tt.coalesce, 2)
    }
  }
  return finishOp(p, tt.question, 1)
}

export function readToken_numberSign(p: Parser): void { // '#'
  const ecmaVersion = p.options.ecmaVersion
  let code = 35 // '#'
  if (ecmaVersion >= 13) {
    ++p.pos
    code = fullCharCodeAtPos(p)
    if (isIdentifierStart(code, true) || code === 92 /* '\' */) {
      return finishToken(p, tt.privateId, readWord1(p))
    }
  }

  raise(p, p.pos, "Unexpected character '" + codePointToString(code) + "'")
}

export function getTokenFromCode(p: Parser, code: number): void {
  switch (code) {
  // The interpretation of a dot depends on whether it is followed
  // by a digit or another two dots.
  case 46: // '.'
    return readToken_dot(p)

  // Punctuation tokens.
  case 40: ++p.pos; return finishToken(p, tt.parenL)
  case 41: ++p.pos; return finishToken(p, tt.parenR)
  case 59: ++p.pos; return finishToken(p, tt.semi)
  case 44: ++p.pos; return finishToken(p, tt.comma)
  case 91: ++p.pos; return finishToken(p, tt.bracketL)
  case 93: ++p.pos; return finishToken(p, tt.bracketR)
  case 123: ++p.pos; return finishToken(p, tt.braceL)
  case 125: ++p.pos; return finishToken(p, tt.braceR)
  case 58: ++p.pos; return finishToken(p, tt.colon)

  case 96: // '`'
    if (p.options.ecmaVersion < 6) break
    ++p.pos
    return finishToken(p, tt.backQuote)

  case 48: // '0'
    let next = p.input.charCodeAt(p.pos + 1)
    if (next === 120 || next === 88) return readRadixNumber(p, 16) // '0x', '0X' - hex number
    if (p.options.ecmaVersion >= 6) {
      if (next === 111 || next === 79) return readRadixNumber(p, 8) // '0o', '0O' - octal number
      if (next === 98 || next === 66) return readRadixNumber(p, 2) // '0b', '0B' - binary number
    }

  // Anything else beginning with a digit is an integer, octal
  // number, or float.
  case 49: case 50: case 51: case 52: case 53: case 54: case 55: case 56: case 57: // 1-9
    return readNumber(p, false)

  // Quotes produce strings.
  case 34: case 39: // '"', "'"
    return readString(p, code)

  // Operators are parsed inline in tiny state machines. '=' (61) is
  // often referred to. `finishOp` simply skips the amount of
  // characters it is given as second argument, and returns a token
  // of the type given by its first argument.
  case 47: // '/'
    return readToken_slash(p)

  case 37: case 42: // '%*'
    return readToken_mult_modulo_exp(p, code)

  case 124: case 38: // '|&'
    return readToken_pipe_amp(p, code)

  case 94: // '^'
    return readToken_caret(p)

  case 43: case 45: // '+-'
    return readToken_plus_min(p, code)

  case 60: case 62: // '<>'
    return readToken_lt_gt(p, code)

  case 61: case 33: // '=!'
    return readToken_eq_excl(p, code)

  case 63: // '?'
    return readToken_question(p)

  case 126: // '~'
    return finishOp(p, tt.prefix, 1)

  case 35: // '#'
    return readToken_numberSign(p)
  }

  raise(p, p.pos, "Unexpected character '" + codePointToString(code) + "'")
}

export function finishOp(p: Parser, type: TokenType, size: number): void {
  let str = p.input.slice(p.pos, p.pos + size)
  p.pos += size
  return finishToken(p, type, str)
}

export function readRegexp(p: Parser): void {
  let escaped, inClass, start = p.pos
  for (;;) {
    if (p.pos >= p.input.length) raise(p, start, "Unterminated regular expression")
    let ch = p.input.charAt(p.pos)
    if (lineBreak.test(ch)) raise(p, start, "Unterminated regular expression")
    if (!escaped) {
      if (ch === "[") inClass = true
      else if (ch === "]" && inClass) inClass = false
      else if (ch === "/" && !inClass) break
      escaped = ch === "\\"
    } else escaped = false
    ++p.pos
  }
  let pattern = p.input.slice(start, p.pos)
  ++p.pos
  let flagsStart = p.pos
  let flags = readWord1(p)
  if (p.containsEsc) unexpected(p, flagsStart)

  // Validate pattern
  const state = p.regexpState || (p.regexpState = new RegExpValidationState(p))
  state.reset(start, pattern, flags)
  validateRegExpFlags(p, state)
  validateRegExpPattern(p, state)

  // Create Literal#value property value.
  let value = null
  try {
    value = new RegExp(pattern, flags)
  } catch (e) {
    // ESTree requires null if it failed to instantiate RegExp object.
    // https://github.com/estree/estree/blob/a27003adf4fd7bfad44de9cef372a2eacd527b1c/es5.md#regexpliteral
  }

  return finishToken(p, tt.regexp, {pattern, flags, value})
}

// Read an integer in the given radix. Return null if zero digits
// were read, the integer value otherwise. When `len` is given, this
// will return `null` unless the integer has exactly `len` digits.

export function readInt(p: Parser, radix: number, len?: number, maybeLegacyOctalNumericLiteral?: boolean): number | null {
  // `len` is used for character escape sequences. In that case, disallow separators.
  const allowSeparators = p.options.ecmaVersion >= 12 && len === undefined

  // `maybeLegacyOctalNumericLiteral` is true if it doesn't have prefix (0x,0o,0b)
  // and isn't fraction part nor exponent part. In that case, if the first digit
  // is zero then disallow separators.
  const isLegacyOctalNumericLiteral = maybeLegacyOctalNumericLiteral && p.input.charCodeAt(p.pos) === 48

  let start = p.pos, total = 0, lastCode = 0
  for (let i = 0, e = len == null ? Infinity : len; i < e; ++i, ++p.pos) {
    let code = p.input.charCodeAt(p.pos), val

    if (allowSeparators && code === 95) {
      if (isLegacyOctalNumericLiteral) raiseRecoverable(p, p.pos, "Numeric separator is not allowed in legacy octal numeric literals")
      if (lastCode === 95) raiseRecoverable(p, p.pos, "Numeric separator must be exactly one underscore")
      if (i === 0) raiseRecoverable(p, p.pos, "Numeric separator is not allowed at the first of digits")
      lastCode = code
      continue
    }

    if (code >= 97) val = code - 97 + 10 // a
    else if (code >= 65) val = code - 65 + 10 // A
    else if (code >= 48 && code <= 57) val = code - 48 // 0-9
    else val = Infinity
    if (val >= radix) break
    lastCode = code
    total = total * radix + val
  }

  if (allowSeparators && lastCode === 95) raiseRecoverable(p, p.pos - 1, "Numeric separator is not allowed at the last of digits")
  if (p.pos === start || len != null && p.pos - start !== len) return null

  return total
}

function stringToNumber(str: string, isLegacyOctalNumericLiteral: boolean): number {
  if (isLegacyOctalNumericLiteral) {
    return parseInt(str, 8)
  }

  // `parseFloat(value)` stops parsing at the first numeric separator then returns a wrong value.
  return parseFloat(str.replace(/_/g, ""))
}

function stringToBigInt(str: string): bigint | null {
  if (typeof BigInt !== "function") {
    return null
  }

  // `BigInt(value)` throws syntax error if the string contains numeric separators.
  return BigInt(str.replace(/_/g, ""))
}

export function readRadixNumber(p: Parser, radix: number): void {
  let start = p.pos
  p.pos += 2 // 0x
  let val: number | bigint | null = readInt(p, radix)
  if (val == null) raise(p, p.start + 2, "Expected number in radix " + radix)
  if (p.options.ecmaVersion >= 11 && p.input.charCodeAt(p.pos) === 110) {
    val = stringToBigInt(p.input.slice(start, p.pos))
    ++p.pos
  } else if (isIdentifierStart(fullCharCodeAtPos(p))) raise(p, p.pos, "Identifier directly after number")
  return finishToken(p, tt.num, val)
}

// Read an integer, octal integer, or floating-point number.

export function readNumber(p: Parser, startsWithDot: boolean): void {
  let start = p.pos
  if (!startsWithDot && readInt(p, 10, undefined, true) === null) raise(p, start, "Invalid number")
  let octal = p.pos - start >= 2 && p.input.charCodeAt(start) === 48
  if (octal && p.strict) raise(p, start, "Invalid number")
  let next = p.input.charCodeAt(p.pos)
  if (!octal && !startsWithDot && p.options.ecmaVersion >= 11 && next === 110) {
    let val = stringToBigInt(p.input.slice(start, p.pos))
    ++p.pos
    if (isIdentifierStart(fullCharCodeAtPos(p))) raise(p, p.pos, "Identifier directly after number")
    return finishToken(p, tt.num, val)
  }
  if (octal && /[89]/.test(p.input.slice(start, p.pos))) octal = false
  if (next === 46 && !octal) { // '.'
    ++p.pos
    readInt(p, 10)
    next = p.input.charCodeAt(p.pos)
  }
  if ((next === 69 || next === 101) && !octal) { // 'eE'
    next = p.input.charCodeAt(++p.pos)
    if (next === 43 || next === 45) ++p.pos // '+-'
    if (readInt(p, 10) === null) raise(p, start, "Invalid number")
  }
  if (isIdentifierStart(fullCharCodeAtPos(p))) raise(p, p.pos, "Identifier directly after number")

  let val = stringToNumber(p.input.slice(start, p.pos), octal)
  return finishToken(p, tt.num, val)
}

// Read a string value, interpreting backslash-escapes.

export function readCodePoint(p: Parser): number {
  let ch = p.input.charCodeAt(p.pos), code

  if (ch === 123) { // '{'
    if (p.options.ecmaVersion < 6) unexpected(p)
    let codePos = ++p.pos
    code = readHexChar(p, p.input.indexOf("}", p.pos) - p.pos)
    ++p.pos
    if (code > 0x10FFFF) invalidStringToken(p, codePos, "Code point out of bounds")
  } else {
    code = readHexChar(p, 4)
  }
  return code
}

export function readString(p: Parser, quote: number): void {
  let out = "", chunkStart = ++p.pos
  for (;;) {
    if (p.pos >= p.input.length) raise(p, p.start, "Unterminated string constant")
    let ch = p.input.charCodeAt(p.pos)
    if (ch === quote) break
    if (ch === 92) { // '\'
      out += p.input.slice(chunkStart, p.pos)
      out += readEscapedChar(p, false)
      chunkStart = p.pos
    } else if (ch === 0x2028 || ch === 0x2029) {
      if (p.options.ecmaVersion < 10) raise(p, p.start, "Unterminated string constant")
      ++p.pos
      if (p.options.locations) {
        p.curLine++
        p.lineStart = p.pos
      }
    } else {
      if (isNewLine(ch)) raise(p, p.start, "Unterminated string constant")
      ++p.pos
    }
  }
  out += p.input.slice(chunkStart, p.pos++)
  return finishToken(p, tt.string, out)
}

// Reads template string tokens.

const INVALID_TEMPLATE_ESCAPE_ERROR = {}

export function tryReadTemplateToken(p: Parser): void {
  p.inTemplateElement = true
  try {
    readTmplToken(p)
  } catch (err) {
    if (err === INVALID_TEMPLATE_ESCAPE_ERROR) {
      readInvalidTemplateToken(p)
    } else {
      throw err
    }
  }

  p.inTemplateElement = false
}

export function invalidStringToken(p: Parser, position: number, message: string): never {
  if (p.inTemplateElement && p.options.ecmaVersion >= 9) {
    throw INVALID_TEMPLATE_ESCAPE_ERROR
  } else {
    raise(p, position, message)
  }
}

export function readTmplToken(p: Parser): void {
  let out = "", chunkStart = p.pos
  for (;;) {
    if (p.pos >= p.input.length) raise(p, p.start, "Unterminated template")
    let ch = p.input.charCodeAt(p.pos)
    if (ch === 96 || ch === 36 && p.input.charCodeAt(p.pos + 1) === 123) { // '`', '${'
      if (p.pos === p.start && (p.type === tt.template || p.type === tt.invalidTemplate)) {
        if (ch === 36) {
          p.pos += 2
          return finishToken(p, tt.dollarBraceL)
        } else {
          ++p.pos
          return finishToken(p, tt.backQuote)
        }
      }
      out += p.input.slice(chunkStart, p.pos)
      return finishToken(p, tt.template, out)
    }
    if (ch === 92) { // '\'
      out += p.input.slice(chunkStart, p.pos)
      out += readEscapedChar(p, true)
      chunkStart = p.pos
    } else if (isNewLine(ch)) {
      out += p.input.slice(chunkStart, p.pos)
      ++p.pos
      switch (ch) {
      case 13:
        if (p.input.charCodeAt(p.pos) === 10) ++p.pos
      case 10:
        out += "\n"
        break
      default:
        out += String.fromCharCode(ch)
        break
      }
      if (p.options.locations) {
        ++p.curLine
        p.lineStart = p.pos
      }
      chunkStart = p.pos
    } else {
      ++p.pos
    }
  }
}

// Reads a template token to search for the end, without validating any escape sequences
export function readInvalidTemplateToken(p: Parser): void {
  for (; p.pos < p.input.length; p.pos++) {
    switch (p.input[p.pos]) {
    case "\\":
      ++p.pos
      break

    case "$":
      if (p.input[p.pos + 1] !== "{") break
      // fall through
    case "`":
      return finishToken(p, tt.invalidTemplate, p.input.slice(p.start, p.pos))

    case "\r":
      if (p.input[p.pos + 1] === "\n") ++p.pos
      // fall through
    case "\n": case "\u2028": case "\u2029":
      ++p.curLine
      p.lineStart = p.pos + 1
      break
    }
  }
  raise(p, p.start, "Unterminated template")
}

// Used to read escaped characters

export function readEscapedChar(p: Parser, inTemplate: boolean): string {
  let ch = p.input.charCodeAt(++p.pos)
  ++p.pos
  switch (ch) {
  case 110: return "\n" // 'n' -> '\n'
  case 114: return "\r" // 'r' -> '\r'
  case 120: return String.fromCharCode(readHexChar(p, 2)) // 'x'
  case 117: return codePointToString(readCodePoint(p)) // 'u'
  case 116: return "\t" // 't' -> '\t'
  case 98: return "\b" // 'b' -> '\b'
  case 118: return "\u000b" // 'v' -> '\u000b'
  case 102: return "\f" // 'f' -> '\f'
  case 13: if (p.input.charCodeAt(p.pos) === 10) ++p.pos // '\r\n'
  case 10: // ' \n'
    if (p.options.locations) { p.lineStart = p.pos; ++p.curLine }
    return ""
  case 56:
  case 57:
    if (p.strict) {
      invalidStringToken(p, 
        p.pos - 1,
        "Invalid escape sequence"
      )
    }
    if (inTemplate) {
      const codePos = p.pos - 1

      invalidStringToken(p, 
        codePos,
        "Invalid escape sequence in template string"
      )
    }
  default:
    if (ch >= 48 && ch <= 55) {
      let octalMatch = p.input.substr(p.pos - 1, 3).match(/^[0-7]+/)
      let octalStr = octalMatch ? octalMatch[0] : unreachable("octal escape without digits")
      let octal = parseInt(octalStr, 8)
      if (octal > 255) {
        octalStr = octalStr.slice(0, -1)
        octal = parseInt(octalStr, 8)
      }
      p.pos += octalStr.length - 1
      ch = p.input.charCodeAt(p.pos)
      if ((octalStr !== "0" || ch === 56 || ch === 57) && (p.strict || inTemplate)) {
        invalidStringToken(p, 
          p.pos - 1 - octalStr.length,
          inTemplate
            ? "Octal literal in template string"
            : "Octal literal in strict mode"
        )
      }
      return String.fromCharCode(octal)
    }
    if (isNewLine(ch)) {
      // Unicode new line characters after \ get removed from output in both
      // template literals and strings
      if (p.options.locations) { p.lineStart = p.pos; ++p.curLine }
      return ""
    }
    return String.fromCharCode(ch)
  }
}

// Used to read character escape sequences ('\x', '\u', '\U').

export function readHexChar(p: Parser, len: number): number {
  let codePos = p.pos
  let n = readInt(p, 16, len)
  if (n === null) invalidStringToken(p, codePos, "Bad character escape sequence")
  return n
}

// Read an identifier, and return it as a string. Sets `p.containsEsc`
// to whether the word contained a '\u' escape.
//
// Incrementally adds only escaped chars, adding other chunks as-is
// as a micro-optimization.

export function readWord1(p: Parser): string {
  p.containsEsc = false
  let word = "", first = true, chunkStart = p.pos
  let astral = p.options.ecmaVersion >= 6
  while (p.pos < p.input.length) {
    let ch = fullCharCodeAtPos(p)
    if (isIdentifierChar(ch, astral)) {
      p.pos += ch <= 0xffff ? 1 : 2
    } else if (ch === 92) { // "\"
      p.containsEsc = true
      word += p.input.slice(chunkStart, p.pos)
      let escStart = p.pos
      if (p.input.charCodeAt(++p.pos) !== 117) // "u"
        invalidStringToken(p, p.pos, "Expecting Unicode escape sequence \\uXXXX")
      ++p.pos
      let esc = readCodePoint(p)
      if (!(first ? isIdentifierStart : isIdentifierChar)(esc, astral))
        invalidStringToken(p, escStart, "Invalid Unicode escape")
      word += codePointToString(esc)
      chunkStart = p.pos
    } else {
      break
    }
    first = false
  }
  return word + p.input.slice(chunkStart, p.pos)
}

// Read an identifier or keyword token. Will check for reserved
// words when necessary.

export function readWord(p: Parser): void {
  let word = readWord1(p)
  let type = tt.name
  if (p.keywords.test(word)) {
    type = keywordTypes[word]
  }
  return finishToken(p, type, word)
}
