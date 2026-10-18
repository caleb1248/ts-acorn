import type {Parser} from "./state.ts"
import {Position, getLineInfo} from "./locutil.ts"

// This function is used to raise exceptions on parse errors. It
// takes an offset integer (into the current `input`) to indicate
// the location of the error, attaches the position to the end
// of the error message, and then raises a `SyntaxError` with that
// message.

export function raise(p: Parser, pos: number, message: string): never {
  let loc = getLineInfo(p.input, pos)
  message += " (" + loc.line + ":" + loc.column + ")"
  if (p.sourceFile) {
    message += " in " + p.sourceFile
  }
  throw Object.assign(new SyntaxError(message), {pos, loc, raisedAt: p.pos})
}

// Errors that a more lenient parser could recover from. In this
// parser they are raised just like any other error.
export function raiseRecoverable(p: Parser, pos: number, message: string): void {
  raise(p, pos, message)
}

export function curPosition(p: Parser): Position | undefined {
  if (p.options.locations) {
    return new Position(p.curLine, p.pos - p.lineStart)
  }
  return undefined
}
