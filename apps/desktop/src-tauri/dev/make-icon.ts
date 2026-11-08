// One-off icon generator: `bun dev/make-icon.ts` (from src-tauri). Writes app-icon.png (1024) and icons/tray.png (template, 44x44).
import { deflateSync } from "node:zlib"

const crc = (b: Uint8Array) => {
  let c = ~0
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
const chunk = (t: string, d: Uint8Array) => {
  const o = new Uint8Array(12 + d.length)
  const v = new DataView(o.buffer)
  v.setUint32(0, d.length)
  o.set(new TextEncoder().encode(t), 4)
  o.set(d, 8)
  v.setUint32(8 + d.length, crc(o.subarray(4, 8 + d.length)))
  return o
}
const png = (
  w: number,
  h: number,
  px: (x: number, y: number) => [number, number, number, number],
) => {
  const raw = new Uint8Array((w * 4 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4)
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, w)
  v.setUint32(4, h)
  ihdr.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ])
}
// Inbox-tray glyph on u,v in [-1,1]: a rounded outline with a slot.
const glyph = (u: number, v: number) => {
  const box = Math.max(Math.abs(u) - 0.8, Math.abs(v) - 0.6)
  const inner = Math.max(Math.abs(u) - 0.55, Math.abs(v) - 0.35)
  const slot = Math.abs(v - 0.05) < 0.08 && Math.abs(u) < 0.5
  return (box < 0 && inner > 0) || slot
}
await Bun.write(
  "app-icon.png",
  png(1024, 1024, (x, y) => {
    const u = (x - 512) / 512
    const v = (y - 512) / 512
    if (Math.max(Math.abs(u), Math.abs(v)) > 0.8) return [0, 0, 0, 0]
    return glyph(u * 1.1, v * 1.1) ? [255, 255, 255, 255] : [58, 90, 220, 255]
  }),
)
await Bun.write(
  "icons/tray.png",
  png(44, 44, (x, y) => (glyph((x - 21.5) / 22, (y - 21.5) / 22) ? [0, 0, 0, 255] : [0, 0, 0, 0])),
)
