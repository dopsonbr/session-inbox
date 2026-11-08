// bun asar.ts <app.asar> <outDir> [ext=.js] : extract only files with the given extension from an Electron asar.
// asar layout: [u32 4][u32 headerPickleSize][u32 jsonPickleSize][u32 jsonLen][json][file data...]
import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const [asar, out, ext = ".js"] = process.argv.slice(2) as [string, string, string?]
const fd = openSync(asar, "r")
const read = (pos: number, len: number) => {
  const b = Buffer.alloc(len)
  readSync(fd, b, 0, len, pos)
  return b
}
const pre = read(0, 16)
const headerSize = pre.readUInt32LE(4) // size of the header pickle (incl. its own length fields)
const jsonLen = pre.readUInt32LE(12)
const header = JSON.parse(read(16, jsonLen).toString("utf8"))
const base = 8 + headerSize // file offsets are relative to the end of the header
type Node = { files?: Record<string, Node>; offset?: string; size?: number; unpacked?: boolean }
let n = 0
const walk = (node: Node, path: string) => {
  if (node.files) {
    for (const [k, v] of Object.entries(node.files)) walk(v, join(path, k))
    return
  }
  if (!path.endsWith(ext) || node.unpacked || node.offset === undefined) return
  const dest = join(out, path)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, read(base + Number(node.offset), node.size ?? 0))
  n++
}
walk(header, "")
closeSync(fd)
console.log(`extracted ${n} ${ext} files to ${out}`)
