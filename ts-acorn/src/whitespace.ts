// Matches a whole line break (where CRLF is considered a single
// line break). Used to count lines.

export const lineBreak = /\r\n?|\n|\u2028|\u2029/
export const lineBreakG = new RegExp(lineBreak.source, "g")

export function isNewLine(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029
}

export function nextLineBreak(code: string, from: number, end: number = code.length): number {
  for (let i = from; i < end; i++) {
    let next = code.charCodeAt(i)
    if (isNewLine(next))
      return i < end - 1 && next === 13 && code.charCodeAt(i + 1) === 10 ? i + 2 : i + 1
  }
  return -1
}

export const nonASCIIwhitespace = /[\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/

const skipWhitespace = /(?:[\n\r\u2028\u2029]\s*(:?-->.*)?|\s|\/\/.*|<!--.*|\/\*[^]*?\*\/)*/g

const skipWhitespaceModule = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g

export function whitespaceRE(mod: boolean): RegExp {
  return mod ? skipWhitespaceModule : skipWhitespace
}

// Run a whitespace-skipping regexp (which always matches, possibly
// the empty string) at the given position, returning the length of
// the skipped text and the position right after it.
export function skipWhitespaceAt(re: RegExp, input: string, pos: number): string {
  re.lastIndex = pos
  let match = re.exec(input)
  return match ? match[0] : ""
}
