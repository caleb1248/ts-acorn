import {reservedWords, keywords} from "./identifier.ts"
import {types as tt, type TokenType} from "./tokentype.ts"
import {lineBreak} from "./whitespace.ts"
import {getOptions, type NormalizedOptions, type Options} from "./options.ts"
import {wordsRegexp} from "./util.ts"
import {SCOPE_TOP, SCOPE_FUNCTION} from "./scopeflags.ts"
import type {Position} from "./locutil.ts"
import type {TokContext} from "./tokencontext.ts"
import type {Identifier, Literal, PrivateIdentifier} from "./ast.ts"
import type {RegExpValidationState} from "./regexp.ts"
import {curPosition} from "./location.ts"
import {initialContext} from "./tokencontext.ts"
import {skipLineComment} from "./tokenize.ts"
import {strictDirective} from "./parseutil.ts"
import {enterScope, type Scope} from "./scope.ts"

// The value of a regular expression token.
export interface RegExpTokenValue {
  pattern: string
  flags: string
  value: RegExp | null
}

// Tokens that carry no information beyond their type have an
// `undefined` value.
export type TokenValue = string | number | bigint | RegExpTokenValue | null | undefined

export interface Label {
  kind: "loop" | "switch" | null
  name: string | undefined
  statementStart: number | undefined
}

export interface PrivateNameScope {
  // Maps names to the kind of declaration ("true", "iget", "sset", ...)
  declared: Map<string, string>
  used: PrivateIdentifier[]
}

// The parser state. The parsing logic itself lives in free functions
// (taking the parser as first argument) spread over the other
// modules.

export class Parser {
  options: NormalizedOptions
  sourceFile: string | null | undefined
  keywords: RegExp
  reservedWords: RegExp
  reservedWordsStrict: RegExp
  reservedWordsStrictBind: RegExp
  input: string

  // Used to signal to callers of `readWord1` whether the word
  // contained any escape sequences. This is needed because words with
  // escape sequences must not be interpreted as keywords.
  containsEsc: boolean

  // The current position of the tokenizer in the input.
  pos: number
  curLine: number
  lineStart: number

  // Properties of the current token:
  // Its type
  type: TokenType
  // For tokens that include more information than their type, the value
  value: TokenValue
  // Its start and end offset
  start: number
  end: number
  // And, if locations are used, the {line, column} object
  // corresponding to those offsets
  startLoc: Position | undefined
  endLoc: Position | undefined

  // Position information for the previous token
  lastTokEndLoc: Position | undefined
  lastTokStartLoc: Position | undefined
  lastTokStart: number
  lastTokEnd: number

  // The context stack is used to superficially track syntactic
  // context to predict whether a regular expression is allowed in a
  // given position.
  context: TokContext[]
  exprAllowed: boolean

  inModule: boolean
  strict: boolean

  // Used to signify the start of a potential arrow function
  potentialArrowAt: number
  potentialArrowInForAwait: boolean

  // Positions to delayed-check that yield/await does not exist in default parameters.
  yieldPos: number
  awaitPos: number
  awaitIdentPos: number
  // Labels in scope.
  labels: Label[]
  // Thus-far undefined exports.
  undefinedExports: Map<string, Identifier | Literal>

  // Scope tracking for duplicate variable names (see scope.ts)
  scopeStack: Scope[]

  // For RegExp validation
  regexpState: RegExpValidationState | null

  // The stack of private names.
  // Each element has two properties: 'declared' and 'used'.
  // When it exited from the outermost class definition, all used private names must be declared.
  privateNameStack: PrivateNameScope[]

  // Set while reading a template token, so that invalid escapes can
  // be reported as an invalid template rather than an error.
  inTemplateElement: boolean

  constructor(opts: Options | null | undefined, input: string, startPos?: number) {
    let options = this.options = getOptions(opts)
    this.sourceFile = options.sourceFile
    this.keywords = wordsRegexp(keywords[options.ecmaVersion >= 6 ? 6 : options.sourceType === "module" ? "5module" : 5])
    let reserved = ""
    if (options.allowReserved !== true) {
      reserved = reservedWords[options.ecmaVersion >= 6 ? 6 : options.ecmaVersion === 5 ? 5 : 3]
      if (options.sourceType === "module") reserved += " await"
    }
    this.reservedWords = wordsRegexp(reserved)
    let reservedStrict = (reserved ? reserved + " " : "") + reservedWords.strict
    this.reservedWordsStrict = wordsRegexp(reservedStrict)
    this.reservedWordsStrictBind = wordsRegexp(reservedStrict + " " + reservedWords.strictBind)
    this.input = String(input)

    this.containsEsc = false

    // Set up token state

    this.pos = startPos || 0
    this.curLine = 1
    if (options.startLocation) {
      this.lineStart = this.pos - options.startLocation.column
      this.curLine = options.startLocation.line
    } else if (startPos) {
      this.lineStart = this.input.lastIndexOf("\n", startPos - 1) + 1
      if (this.options.locations)
        this.curLine = this.input.slice(0, this.lineStart).split(lineBreak).length
    } else {
      this.lineStart = 0
    }

    this.type = tt.eof
    this.value = null
    this.start = this.end = this.pos
    this.startLoc = this.endLoc = curPosition(this)

    this.lastTokEndLoc = this.lastTokStartLoc = undefined
    this.lastTokStart = this.lastTokEnd = this.pos

    this.context = initialContext()
    this.exprAllowed = true

    // Figure out if it's a module code.
    this.inModule = options.sourceType === "module"
    this.strict = false
    this.strict = this.inModule || options.strict === true || strictDirective(this, this.pos)

    this.potentialArrowAt = -1
    this.potentialArrowInForAwait = false

    this.yieldPos = this.awaitPos = this.awaitIdentPos = 0
    this.labels = []
    this.undefinedExports = new Map()
    this.inTemplateElement = false

    // If enabled, skip leading hashbang line.
    if (this.pos === 0 && options.allowHashBang && this.input.slice(0, 2) === "#!")
      skipLineComment(this, 2)

    this.scopeStack = []
    enterScope(this,
      this.options.sourceType === "commonjs"
        // In commonjs, the top-level scope behaves like a function scope
        ? SCOPE_FUNCTION
        : SCOPE_TOP
    )

    this.regexpState = null

    this.privateNameStack = []
  }
}
