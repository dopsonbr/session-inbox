// bun ctx.ts <file> <needle> [before=200] [after=400] [max=5] : print context windows around a literal needle
import { readFileSync } from "node:fs"

const [file, needle, b = "200", a = "400", m = "5"] = process.argv.slice(2)
const text = readFileSync(file as string, "latin1")
let i = 0
let n = 0
while (n < Number(m)) {
  i = text.indexOf(needle as string, i)
  if (i < 0) break
  console.log(`--- @${i}`)
  console.log(text.slice(Math.max(0, i - Number(b)), i + (needle as string).length + Number(a)))
  i += (needle as string).length
  n++
}
if (n === 0) console.log("(no match)")
