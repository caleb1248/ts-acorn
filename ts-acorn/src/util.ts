const {hasOwnProperty} = Object.prototype

export function hasOwn(obj: object, propName: string): boolean {
  return hasOwnProperty.call(obj, propName)
}

const regexpCache = new Map<string, RegExp>()

export function wordsRegexp(words: string): RegExp {
  let cached = regexpCache.get(words)
  if (!cached) {
    cached = new RegExp("^(?:" + words.replace(/ /g, "|") + ")$")
    regexpCache.set(words, cached)
  }
  return cached
}

export function codePointToString(code: number): string {
  // UTF-16 Decoding
  if (code <= 0xFFFF) return String.fromCharCode(code)
  code -= 0x10000
  return String.fromCharCode((code >> 10) + 0xD800, (code & 1023) + 0xDC00)
}

export const loneSurrogate = /[\uD800-\uDFFF]/u

// Used for states that the type system can't rule out, but that the
// parser's logic guarantees never happen.
export function unreachable(what: string): never {
  throw new Error("Internal acorn error: " + what)
}

// For lists that were parsed without allowing holes.
export function noNulls<T>(list: ReadonlyArray<T | null>): T[] {
  return list.map(elt => elt === null ? unreachable("unexpected hole in list") : elt)
}
