// Differential test on real-world files and the less common API entry points.
"use strict"
const fs = require("fs"), path = require("path")
const port = require(process.env.ACORN_DIST ? "../dist/acorn.js" : "../src/index.ts")
const original = require("../../acorn/src/index.js")

function serialize(value) {
  return JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? "bigint:" + v : v instanceof RegExp ? "regexp:" + v : v === undefined ? "<undefined>" : v)
}
function run(f) {
  try { return serialize(f()) } catch (e) { return "error: " + e.message + " " + e.pos + " " + e.raisedAt }
}
let diffs = 0, compared = 0
function compare(label, f) {
  ++compared
  const a = run(() => f(original)), b = run(() => f(port))
  if (a !== b) {
    ++diffs
    let i = 0
    while (a[i] === b[i]) i++
    console.log("DIFF", label, "\n  original:", a.slice(Math.max(0, i - 200), i + 200), "\n  port:    ", b.slice(Math.max(0, i - 200), i + 200))
  }
}

const files = process.argv.slice(2)
for (const file of files) {
  const code = fs.readFileSync(file, "utf8")
  for (const sourceType of ["script", "module"]) {
    for (const extra of [{}, {locations: true, ranges: true, preserveParens: true}]) {
      compare(file + " " + sourceType + " " + JSON.stringify(extra), acorn => {
        const comments = [], tokens = []
        const ast = acorn.parse(code, Object.assign({ecmaVersion: "latest", sourceType, onComment: comments, onToken: tokens}, extra))
        return {ast, comments, tokens}
      })
    }
  }
  compare(file + " tokenizer", acorn => [...acorn.tokenizer(code, {ecmaVersion: "latest", sourceType: "module", locations: true})])
}

const snippets = ["a + b * c", "x => y, z", "`a${b}c`", "/re/g.test(s)", "{a: 1}.a", "async function* f() {}", "class A { #x; static { this.#x } }", "0n + 1_000"]
for (const s of snippets) {
  for (const pos of [0, 1, 2]) {
    compare("parseExpressionAt " + s + " @" + pos, acorn => acorn.parseExpressionAt("  " + s, pos, {ecmaVersion: "latest", locations: true}))
  }
}

// The `program` option appends to an existing program.
for (const opts of [{}, {locations: true, ranges: true}]) {
  compare("program option " + JSON.stringify(opts), acorn => {
    const prog = acorn.parse("'use strict'; var a = 1", Object.assign({ecmaVersion: 2020}, opts))
    acorn.parse("'not a directive'; let b = a", Object.assign({ecmaVersion: 2020, program: prog}, opts))
    return prog
  })
  compare("program option partial " + JSON.stringify(opts), acorn => {
    const prog = acorn.parse("x", Object.assign({ecmaVersion: 2020}, opts))
    try { acorn.parse("y; z z", Object.assign({ecmaVersion: 2020, program: prog}, opts)) } catch (e) {}
    return prog
  })
}

// Callbacks.
compare("callbacks", acorn => {
  const log = []
  acorn.parse("a\nb\n[1,2,]\n/*c*/ //d\n", {
    ecmaVersion: 2020, locations: true,
    onInsertedSemicolon: (pos, loc) => log.push(["semi", pos, loc]),
    onTrailingComma: (pos, loc) => log.push(["comma", pos, loc]),
    onComment: (block, text, start, end, sl, el) => log.push(["comment", block, text, start, end, sl, el]),
    onToken: t => log.push(["token", t])
  })
  return log
})
console.log("corpus: " + compared + " compared, " + diffs + " differences")
process.exitCode = diffs ? 1 : 0
