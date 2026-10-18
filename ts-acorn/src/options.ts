import {hasOwn} from "./util.ts"
import {SourceLocation, type Position} from "./locutil.ts"
import type {Token} from "./tokenize.ts"
import type {ESTreeObject} from "./estree-convert.ts"

export type EcmaVersion = 3 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | "latest"

export type SourceType = "script" | "module" | "commonjs"

export type PositionCallback = (pos: number, loc?: Position) => void

export type CommentCallback = (
  isBlock: boolean, text: string, start: number, end: number, startLoc?: Position,
  endLoc?: Position
) => void

export interface Comment {
  type: "Line" | "Block"
  value: string
  start: number
  end: number
  loc?: SourceLocation
  range?: [number, number]
}

// The options object as passed in by the user.

export interface Options {
  /**
   * `ecmaVersion` indicates the ECMAScript version to parse. Can be a
   * number, either in year (`2022`) or plain version number (`6`) form,
   * or `"latest"` (the latest the library supports). This influences
   * support for strict mode, the set of reserved words, and support for
   * new syntax features.
   */
  ecmaVersion: EcmaVersion

  /**
   * `sourceType` indicates the mode the code should be parsed in.
   * Can be either `"script"`, `"module"` or `"commonjs"`. This influences global
   * strict mode and parsing of `import` and `export` declarations.
   */
  sourceType?: SourceType

  /**
   * When set to true, enable strict parsing mode even if `sourceType`
   * is `"script"`.
   */
  strict?: boolean

  /**
   * a callback that will be called when a semicolon is automatically inserted.
   * @param lastTokEnd the position of the comma as an offset
   * @param lastTokEndLoc location if {@link locations} is enabled
   */
  onInsertedSemicolon?: PositionCallback

  /**
   * similar to `onInsertedSemicolon`, but for trailing commas
   * @param lastTokEnd the position of the comma as an offset
   * @param lastTokEndLoc location if `locations` is enabled
   */
  onTrailingComma?: PositionCallback

  /**
   * By default, reserved words are only enforced if ecmaVersion >= 5.
   * Set `allowReserved` to a boolean value to explicitly turn this on
   * an off. When this option has the value "never", reserved words
   * and keywords can also not be used as property names.
   */
  allowReserved?: boolean | "never"

  /**
   * When enabled, a return at the top level is not considered an error.
   */
  allowReturnOutsideFunction?: boolean

  /**
   * When enabled, import/export statements are not constrained to
   * appearing at the top of the program, and an import.meta expression
   * in a script isn't considered an error.
   */
  allowImportExportEverywhere?: boolean

  /**
   * By default, `await` identifiers are allowed to appear at the top-level scope only if {@link ecmaVersion} >= 2022.
   * When enabled, await identifiers are allowed to appear at the top-level scope,
   * but they are still not allowed in non-async functions.
   */
  allowAwaitOutsideFunction?: boolean

  /**
   * When enabled, super identifiers are not constrained to
   * appearing in methods and do not raise an error when they appear elsewhere.
   */
  allowSuperOutsideMethod?: boolean

  /**
   * When enabled, hashbang directive in the beginning of file is
   * allowed and treated as a line comment. Enabled by default when
   * {@link ecmaVersion} >= 2023.
   */
  allowHashBang?: boolean

  /**
   * By default, the parser will verify that private properties are
   * only used in places where they are valid and have been declared.
   * Set this to false to turn such checks off.
   */
  checkPrivateFields?: boolean

  /**
   * When `locations` is on, `loc` properties holding objects with
   * `start` and `end` properties as {@link Position} objects will be attached to the
   * nodes.
   */
  locations?: boolean

  /**
   * Pass an optional `{line, column}` object to use for the start of
   * the parse. This is mostly useful when using `parseExpressionAt`
   * with `locations: true`, to prevent the parser from having to
   * determine the line position at the start position.
   */
  startLocation?: {line: number, column: number}

  /**
   * a callback that will cause Acorn to call that export function with object in the same
   * format as tokens returned from `tokenizer().getToken()`. Note
   * that you are not allowed to call the parser from the
   * callback—that will corrupt its internal state.
   */
  onToken?: ((token: Token) => void) | Token[]

  /**
   * This takes a export function or an array.
   *
   * When a export function is passed, Acorn will call that export function with `(block, text, start,
   * end)` parameters whenever a comment is skipped. `block` is a
   * boolean indicating whether this is a block (`/* *\/`) comment,
   * `text` is the content of the comment, and `start` and `end` are
   * character offsets that denote the start and end of the comment.
   * When the {@link locations} option is on, two more parameters are
   * passed, the full locations of {@link Position} export type of the start and
   * end of the comments.
   *
   * When a array is passed, each found comment of {@link Comment} export type is pushed to the array.
   *
   * Note that you are not allowed to call the
   * parser from the callback—that will corrupt its internal state.
   */
  onComment?: CommentCallback | Comment[]

  /**
   * Nodes have their start and end characters offsets recorded in
   * `start` and `end` properties (directly on the node, rather than
   * the `loc` object, which holds line/column data. To also add a
   * [semi-standardized][range] `range` property holding a `[start,
   * end]` array with the same numbers, set the `ranges` option to
   * `true`.
   */
  ranges?: boolean

  /**
   * It is possible to parse multiple files into a single AST by
   * passing the tree produced by parsing the first file as
   * `program` option in subsequent parses. This will add the
   * toplevel forms of the parsed file to the `Program` (top) node
   * of an existing parse tree.
   */
  program?: ESTreeObject

  /**
   * When {@link locations} is on, you can pass this to record the source
   * file in every node's `loc` object.
   */
  sourceFile?: string

  /**
   * This value, if given, is stored in every node, whether {@link locations} is on or off.
   */
  directSourceFile?: string

  /**
   * When enabled, parenthesized expressions are represented by
   * (non-standard) ParenthesizedExpression nodes
   */
  preserveParens?: boolean
}

// The options after defaults have been filled in. Values that the
// user explicitly set to `undefined` are kept as `undefined`, as in
// the original implementation.

export interface NormalizedOptions {
  ecmaVersion: number
  sourceType: SourceType | undefined
  strict: boolean | undefined
  onInsertedSemicolon: PositionCallback | null | undefined
  onTrailingComma: PositionCallback | null | undefined
  allowReserved: boolean | "never"
  allowReturnOutsideFunction: boolean | undefined
  allowImportExportEverywhere: boolean | undefined
  allowAwaitOutsideFunction: boolean | null | undefined
  allowSuperOutsideMethod: boolean | null | undefined
  allowHashBang: boolean | undefined
  checkPrivateFields: boolean | undefined
  locations: boolean | undefined
  startLocation: {line: number, column: number} | null | undefined
  onToken: ((token: Token) => void) | null | undefined
  onComment: CommentCallback | null | undefined
  ranges: boolean | undefined
  program: ESTreeObject | null | undefined
  sourceFile: string | null | undefined
  directSourceFile: string | null | undefined
  preserveParens: boolean | undefined
}

// A second argument must be given to configure the parser process.
// These options are recognized (only `ecmaVersion` is required):

export type DefaultOptions = Omit<NormalizedOptions, "ecmaVersion" | "allowReserved"> & {
  ecmaVersion: null
  allowReserved: null
}

export const defaultOptions: DefaultOptions = {
  // `ecmaVersion` indicates the ECMAScript version to parse. Must be
  // either 3, 5, 6 (or 2015), 7 (2016), 8 (2017), 9 (2018), 10
  // (2019), 11 (2020), 12 (2021), 13 (2022), 14 (2023), or `"latest"`
  // (the latest version the library supports). This influences
  // support for strict mode, the set of reserved words, and support
  // for new syntax features.
  ecmaVersion: null,
  // `sourceType` indicates the mode the code should be parsed in.
  // Can be either `"script"`, `"module"` or `"commonjs"`. This influences global
  // strict mode and parsing of `import` and `export` declarations.
  sourceType: "script",
  // When set to true, enable strict parsing mode even if `sourceType`
  // is `"script"`.
  strict: false,
  // `onInsertedSemicolon` can be a callback that will be called when
  // a semicolon is automatically inserted. It will be passed the
  // position of the inserted semicolon as an offset, and if
  // `locations` is enabled, it is given the location as a `{line,
  // column}` object as second argument.
  onInsertedSemicolon: null,
  // `onTrailingComma` is similar to `onInsertedSemicolon`, but for
  // trailing commas.
  onTrailingComma: null,
  // By default, reserved words are only enforced if ecmaVersion >= 5.
  // Set `allowReserved` to a boolean value to explicitly turn this on
  // an off. When this option has the value "never", reserved words
  // and keywords can also not be used as property names.
  allowReserved: null,
  // When enabled, a return at the top level is not considered an
  // error.
  allowReturnOutsideFunction: false,
  // When enabled, import/export statements are not constrained to
  // appearing at the top of the program, and an import.meta expression
  // in a script isn't considered an error.
  allowImportExportEverywhere: false,
  // By default, await identifiers are allowed to appear at the top-level scope only if ecmaVersion >= 2022.
  // When enabled, await identifiers are allowed to appear at the top-level scope,
  // but they are still not allowed in non-async functions.
  allowAwaitOutsideFunction: null,
  // When enabled, super identifiers are not constrained to
  // appearing in methods and do not raise an error when they appear elsewhere.
  allowSuperOutsideMethod: null,
  // When enabled, hashbang directive in the beginning of file is
  // allowed and treated as a line comment. Enabled by default when
  // `ecmaVersion` >= 2023.
  allowHashBang: false,
  // By default, the parser will verify that private properties are
  // only used in places where they are valid and have been declared.
  // Set this to false to turn such checks off.
  checkPrivateFields: true,
  // When `locations` is on, `loc` properties holding objects with
  // `start` and `end` properties in `{line, column}` form (with
  // line being 1-based and column 0-based) will be attached to the
  // nodes.
  locations: false,
  // Pass an optional `{line, column}` object to use for the start of
  // the parse. This is mostly useful when using `parseExpressionAt`
  // with `locations: true`, to prevent the parser from having to
  // determine the line position at the start position.
  startLocation: null,
  // A function can be passed as `onToken` option, which will
  // cause Acorn to call that function with object in the same
  // format as tokens returned from `tokenizer().getToken()`. Note
  // that you are not allowed to call the parser from the
  // callback—that will corrupt its internal state.
  onToken: null,
  // A function can be passed as `onComment` option, which will
  // cause Acorn to call that function with `(block, text, start,
  // end)` parameters whenever a comment is skipped. `block` is a
  // boolean indicating whether this is a block (`/* */`) comment,
  // `text` is the content of the comment, and `start` and `end` are
  // character offsets that denote the start and end of the comment.
  // When the `locations` option is on, two more parameters are
  // passed, the full `{line, column}` locations of the start and
  // end of the comments. Note that you are not allowed to call the
  // parser from the callback—that will corrupt its internal state.
  // When this option has an array as value, objects representing the
  // comments are pushed to it.
  onComment: null,
  // Nodes have their start and end characters offsets recorded in
  // `start` and `end` properties (directly on the node, rather than
  // the `loc` object, which holds line/column data. To also add a
  // [semi-standardized][range] `range` property holding a `[start,
  // end]` array with the same numbers, set the `ranges` option to
  // `true`.
  //
  // [range]: https://bugzilla.mozilla.org/show_bug.cgi?id=745678
  ranges: false,
  // It is possible to parse multiple files into a single AST by
  // passing the tree produced by parsing the first file as
  // `program` option in subsequent parses. This will add the
  // toplevel forms of the parsed file to the `Program` (top) node
  // of an existing parse tree.
  program: null,
  // When `locations` is on, you can pass this to record the source
  // file in every node's `loc` object.
  sourceFile: null,
  // This value, if given, is stored in every node, whether
  // `locations` is on or off.
  directSourceFile: null,
  // When enabled, parenthesized expressions are represented by
  // (non-standard) ParenthesizedExpression nodes
  preserveParens: false
}

// Interpret and default an options object

let warnedAboutEcmaVersion = false

// Read an option, falling back to the default only when the
// property is not present on the object at all.
function get<K extends keyof Options, D>(opts: Options | null | undefined, name: K, dflt: D): Options[K] | D {
  return opts && hasOwn(opts, name) ? opts[name] : dflt
}

function normalizeEcmaVersion(version: EcmaVersion | null | undefined): number {
  if (version === "latest") return 1e8
  if (version == null) {
    if (!warnedAboutEcmaVersion && typeof console === "object" && console.warn) {
      warnedAboutEcmaVersion = true
      console.warn("Since Acorn 8.0.0, options.ecmaVersion is required.\nDefaulting to 2020, but this will stop working in the future.")
    }
    return 11
  }
  if (version >= 2015) return version - 2009
  return version
}

export function getOptions(opts: Options | null | undefined): NormalizedOptions {
  let ecmaVersion = normalizeEcmaVersion(get(opts, "ecmaVersion", defaultOptions.ecmaVersion))
  let allowReserved = get(opts, "allowReserved", defaultOptions.allowReserved)
  let allowHashBang = get(opts, "allowHashBang", defaultOptions.allowHashBang)
  if (!opts || opts.allowHashBang == null) allowHashBang = ecmaVersion >= 14

  let onTokenOpt = get(opts, "onToken", defaultOptions.onToken)
  let onToken: ((token: Token) => void) | null | undefined
  if (Array.isArray(onTokenOpt)) {
    let tokens = onTokenOpt
    onToken = (token) => { tokens.push(token) }
  } else {
    onToken = onTokenOpt
  }

  let options: NormalizedOptions = {
    ecmaVersion,
    sourceType: get(opts, "sourceType", defaultOptions.sourceType),
    strict: get(opts, "strict", defaultOptions.strict),
    onInsertedSemicolon: get(opts, "onInsertedSemicolon", defaultOptions.onInsertedSemicolon),
    onTrailingComma: get(opts, "onTrailingComma", defaultOptions.onTrailingComma),
    allowReserved: allowReserved == null ? ecmaVersion < 5 : allowReserved,
    allowReturnOutsideFunction: get(opts, "allowReturnOutsideFunction", defaultOptions.allowReturnOutsideFunction),
    allowImportExportEverywhere: get(opts, "allowImportExportEverywhere", defaultOptions.allowImportExportEverywhere),
    allowAwaitOutsideFunction: get(opts, "allowAwaitOutsideFunction", defaultOptions.allowAwaitOutsideFunction),
    allowSuperOutsideMethod: get(opts, "allowSuperOutsideMethod", defaultOptions.allowSuperOutsideMethod),
    allowHashBang,
    checkPrivateFields: get(opts, "checkPrivateFields", defaultOptions.checkPrivateFields),
    locations: get(opts, "locations", defaultOptions.locations),
    startLocation: get(opts, "startLocation", defaultOptions.startLocation),
    onToken,
    onComment: null,
    ranges: get(opts, "ranges", defaultOptions.ranges),
    program: get(opts, "program", defaultOptions.program),
    sourceFile: get(opts, "sourceFile", defaultOptions.sourceFile),
    directSourceFile: get(opts, "directSourceFile", defaultOptions.directSourceFile),
    preserveParens: get(opts, "preserveParens", defaultOptions.preserveParens)
  }

  let onCommentOpt = get(opts, "onComment", defaultOptions.onComment)
  options.onComment = Array.isArray(onCommentOpt) ? pushComment(options, onCommentOpt) : onCommentOpt

  if (options.sourceType === "commonjs" && options.allowAwaitOutsideFunction)
    throw new Error("Cannot use allowAwaitOutsideFunction with sourceType: commonjs")

  return options
}

function pushComment(options: NormalizedOptions, array: Comment[]): CommentCallback {
  return function(block, text, start, end, startLoc, endLoc) {
    let comment: Comment = {
      type: block ? "Block" : "Line",
      value: text,
      start: start,
      end: end
    }
    if (options.locations && startLoc)
      comment.loc = new SourceLocation(options, startLoc, endLoc)
    if (options.ranges)
      comment.range = [start, end]
    array.push(comment)
  }
}
