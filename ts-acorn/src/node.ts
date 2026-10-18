import type {Parser} from "./state.ts"
import type {Position} from "./locutil.ts"
import type {NodeStart, Span} from "./ast.ts"

// Start an AST node, recording its start offset.

export function startNode(p: Parser): NodeStart {
  return {start: p.start, loc: p.startLoc}
}

export function startNodeAt(pos: number, loc: Position | undefined): NodeStart {
  return {start: pos, loc}
}

// Finish an AST node, computing its span from its start and the end
// of the last token.

export function finishSpan(p: Parser, node: NodeStart): Span {
  return {start: node.start, end: p.lastTokEnd, startLoc: node.loc, endLoc: p.lastTokEndLoc}
}

// Finish node at given position

export function finishSpanAt(node: NodeStart, pos: number, loc: Position | undefined): Span {
  return {start: node.start, end: pos, startLoc: node.loc, endLoc: loc}
}

// The start of an already finished node.

export function nodeStart(span: Span): NodeStart {
  return {start: span.start, loc: span.startLoc}
}
