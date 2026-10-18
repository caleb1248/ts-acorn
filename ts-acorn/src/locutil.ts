import {nextLineBreak} from "./whitespace.ts"

// These are used when `options.locations` is on, for the
// `startLoc` and `endLoc` properties.

export class Position {
  line: number
  column: number

  constructor(line: number, col: number) {
    this.line = line
    this.column = col
  }

  offset(n: number): Position {
    return new Position(this.line, this.column + n)
  }
}

export class SourceLocation {
  start: Position
  end: Position | undefined
  declare source?: string | null | undefined

  constructor(p: {sourceFile: string | null | undefined}, start: Position, end?: Position) {
    this.start = start
    this.end = end
    if (p.sourceFile !== null) this.source = p.sourceFile
  }
}

// The `getLineInfo` function is mostly useful when the
// `locations` option is off (for performance reasons) and you
// want to find the line/column position for a given character
// offset. `input` should be the code string that the offset refers
// into.

export function getLineInfo(input: string, offset: number): Position {
  for (let line = 1, cur = 0;;) {
    let nextBreak = nextLineBreak(input, cur, offset)
    if (nextBreak < 0) return new Position(line, offset - cur)
    ++line
    cur = nextBreak
  }
}
