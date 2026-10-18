// Runs acorn's test suite (from the repository's test/ directory)
// against the TypeScript port, and additionally compares the port's
// output to the original JavaScript implementation in ../acorn.
"use strict"
const Module = require("module")
const path = require("path")

const port = require(process.env.ACORN_DIST ? "../dist/acorn.js" : "../src/index.ts")
const original = require("../../acorn/src/index.js")

const origLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request === "../acorn") return port
  if (request === "../acorn-loose") return {}
  return origLoad.call(this, request, parent, isMain)
}

const testDir = path.join(__dirname, "..", "..", "test")
const driver = require(path.join(testDir, "driver.js"))
const suites = require("fs").readFileSync(path.join(testDir, "run.js"), "utf8")
  .match(/require\("\.\/tests[^"]*"\)/g).map(s => s.slice(11, -2))
for (const file of suites) require(path.join(testDir, file))

let failed = 0, run = 0
function report(state, code, message) {
  ++run
  if (state !== "ok") { ++failed; console.log("FAIL", JSON.stringify(code), message) }
}

const modes = {
  Normal: {parse: port.parse},
  "Normal with sourceType: commonjs": {
    parse: (code, option) => port.parse(code, Object.assign({}, option, {sourceType: "commonjs"})),
    filter: test => {
      const opts = test.options || {}
      return opts.commonjs !== false && !opts.allowAwaitOutsideFunction && (!opts.sourceType || opts.sourceType === "script")
    }
  }
}
const collected = []
for (const name in modes) {
  const mode = modes[name]
  const before = failed
  driver.runTests({parse: mode.parse, filter: test => {
    if (name === "Normal") collected.push(test)
    return mode.filter ? mode.filter(test) : true
  }}, report)
  console.log(name + ": " + (failed - before) + " failures")
}
console.log("suite: " + run + " tests run, " + failed + " failures")

// Differential comparison with the original implementation.
function serialize(value) {
  return JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? "bigint:" + v : v instanceof RegExp ? "regexp:" + v : v === undefined ? "<undefined>" : v)
}
function outcome(impl, code, options) {
  const opts = Object.assign({}, options)
  const comments = [], tokens = []
  opts.onComment = comments
  opts.onToken = tokens
  try {
    const ast = impl.parse(code, opts)
    return serialize({ast, comments, tokens})
  } catch (e) {
    if (!(e instanceof SyntaxError)) return "crash: " + e.message
    // Where exactly the stack runs out depends on the engine and on
    // how much stack each parse function uses.
    if (/^Not enough stack space/.test(e.message)) return "error: stack overflow"
    return "error: " + e.message + " " + e.pos + " " + e.raisedAt + " " + serialize(e.loc)
  }
}
let diffs = 0, compared = 0
const variants = [{}, {locations: true, ranges: true}, {preserveParens: true}, {sourceType: "module"}, {ecmaVersion: 5}, {ecmaVersion: 3}, {ecmaVersion: 6}, {ecmaVersion: "latest", directSourceFile: "x.js", sourceFile: "y.js", locations: true}]
const seen = new Set()
for (const test of collected) {
  for (const variant of variants) {
    const options = Object.assign({ecmaVersion: 5}, test.options || {}, variant)
    delete options.onComment; delete options.onToken
    const key = test.code + "\0" + JSON.stringify(options)
    if (seen.has(key)) continue
    seen.add(key)
    ++compared
    const a = outcome(original, test.code, options), b = outcome(port, test.code, options)
    if (a !== b) {
      if (++diffs <= 20) console.log("DIFF", JSON.stringify(test.code.slice(0, 120)), JSON.stringify(options), "\n  original:", a.slice(0, 400), "\n  port:    ", b.slice(0, 400))
    }
  }
}
console.log("differential: " + compared + " compared, " + diffs + " differences")
process.exitCode = failed || diffs ? 1 : 0
