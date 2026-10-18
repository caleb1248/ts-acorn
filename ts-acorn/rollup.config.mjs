import {readFile, writeFile} from "node:fs/promises"

// The TypeScript sources are first compiled to ./build by `tsc -p
// tsconfig.build.json`; this bundles that output.

const copy = (from, to) => ({
  async writeBundle() { await writeFile(to, await readFile(from)) }
})

export default [
  {
    input: "build/index.js",
    output: {
      file: "dist/acorn.js",
      format: "es"
    },
    plugins: [
      copy("src/acorn.d.ts", "dist/acorn.d.ts")
    ]
  },
  {
    external: ["acorn", "fs", "path"],
    input: "src/bin/acorn.js",
    output: {
      file: "dist/bin.js",
      format: "es",
      paths: {acorn: "./acorn.js"}
    }
  }
]
