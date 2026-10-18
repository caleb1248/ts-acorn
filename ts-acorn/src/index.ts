// Acorn is a tiny, fast JavaScript parser written in JavaScript.
//
// Acorn was written by Marijn Haverbeke, Ingvar Stepanyan, and
// various contributors and released under an MIT license.
//
// Git repositories for Acorn are available at
//
//     http://marijnhaverbeke.nl/git/acorn
//     https://github.com/acornjs/acorn.git
//
// Please use the [github bug tracker][ghbt] to report issues.
//
// [ghbt]: https://github.com/acornjs/acorn/issues

import {Parser as ParserState} from "./state.ts"
import {defaultOptions, type Options, type NormalizedOptions} from "./options.ts"
import {Position, SourceLocation, getLineInfo} from "./locutil.ts"
import {TokenType, types as tokTypes, keywords as keywordTypes} from "./tokentype.ts"
import {TokContext, types as tokContexts} from "./tokencontext.ts"
import {isIdentifierChar, isIdentifierStart} from "./identifier.ts"
import {Token, nextToken, getToken} from "./tokenize.ts"
import {isNewLine, lineBreak, lineBreakG, nonASCIIwhitespace} from "./whitespace.ts"
import {catchStackOverflow} from "./parseutil.ts"
import {parseTopLevel} from "./statement.ts"
import {parseExpression} from "./expression.ts"
import {startNode} from "./node.ts"
import {
  Converter, programBody, adaptDirectivePrologue, finishProgram, type ESTreeObject
} from "./estree-convert.ts"

export const version = "8.19.0"

// The public parser interface. The parser state and logic are
// internal; this wraps them and converts their output to ESTree
// objects.
//
// Unlike the JavaScript version, this parser can't be extended with
// plugins.

// The internal state of each public parser, kept out of reach of
// users of the public interface.
const parserStates = new WeakMap<Parser, ParserState>()

function stateOf(parser: Parser): ParserState {
  let state = parserStates.get(parser)
  if (!state) throw new TypeError("Not an acorn Parser instance")
  return state
}

export class Parser {
  constructor(options: Options | null | undefined, input: string, startPos?: number) {
    parserStates.set(this, new ParserState(options, input, startPos))
  }

  get options(): NormalizedOptions { return stateOf(this).options }

  get input(): string { return stateOf(this).input }

  parse(): ESTreeObject {
    let p = stateOf(this), program = p.options.program
    let node = startNode(p)
    nextToken(p)
    let converter = new Converter(p.options)
    if (!program) return converter.node(catchStackOverflow(p, () => parseTopLevel(p, node, null)))

    // Append the statements to the given program.
    let existing = program, body = programBody(existing)
    let result = catchStackOverflow(p, () => parseTopLevel(p, node, stmt => { body.push(converter.node(stmt)) }))
    adaptDirectivePrologue(p.options, p.input, body)
    existing.sourceType = result.sourceType
    finishProgram(p.options, existing, result.span.end, result.span.endLoc)
    return existing
  }

  getToken(): Token {
    return getToken(stateOf(this))
  }

  [Symbol.iterator](): Iterator<Token> {
    return {
      next: () => {
        let token = this.getToken()
        return {
          done: token.type === tokTypes.eof,
          value: token
        }
      }
    }
  }

  static parse(input: string, options: Options): ESTreeObject {
    return new this(options, input).parse()
  }

  static parseExpressionAt(input: string, pos: number, options: Options): ESTreeObject {
    let p = stateOf(new this(options, input, pos))
    nextToken(p)
    return new Converter(p.options).node(parseExpression(p))
  }

  static tokenizer(input: string, options: Options): Parser {
    return new this(options, input)
  }
}

export {
  defaultOptions,
  Position,
  SourceLocation,
  getLineInfo,
  TokenType,
  tokTypes,
  keywordTypes,
  TokContext,
  tokContexts,
  isIdentifierChar,
  isIdentifierStart,
  Token,
  isNewLine,
  lineBreak,
  lineBreakG,
  nonASCIIwhitespace
}

export type {Options, Comment} from "./options.ts"
export type {ESTreeObject, ESTreeValue} from "./estree-convert.ts"

// The main exported interface (under `self.acorn` when in the
// browser) is a `parse` function that takes a code string and returns
// an abstract syntax tree as specified by the [ESTree spec][estree].
//
// [estree]: https://github.com/estree/estree

export function parse(input: string, options: Options): ESTreeObject {
  return Parser.parse(input, options)
}

// This function tries to parse a single expression at a given
// offset in a string. Useful for parsing mixed-language formats
// that embed JavaScript expressions.

export function parseExpressionAt(input: string, pos: number, options: Options): ESTreeObject {
  return Parser.parseExpressionAt(input, pos, options)
}

// Acorn is organized as a tokenizer and a recursive-descent parser.
// The `tokenizer` export provides an interface to the tokenizer.

export function tokenizer(input: string, options: Options): Parser {
  return Parser.tokenizer(input, options)
}
