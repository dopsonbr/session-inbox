/**
 * File operations that never leave a half-written file where a reader looks (H-021).
 * Claude runs `inbox-hook` constantly, so the binary must exist at its path at every
 * instant: write beside it, then rename over it (rename is atomic within a volume, and a
 * running process keeps the old inode).
 */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"

const tmpBeside = (path: string, tag: string) =>
  join(
    dirname(path),
    `.${basename(path)}.${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  )

export const atomicWriteFile = (path: string, data: string, mode = 0o644): void => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = tmpBeside(path, "tmp")
  try {
    writeFileSync(tmp, data, { mode })
    chmodSync(tmp, mode) // writeFileSync's mode is masked by the umask
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * Replace a user's file (`~/.claude/settings.json`) atomically: a temp file beside it, then a
 * rename, keeping its mode. A symlink (dotfile setups) is written through to its target, so
 * the link survives. A new file gets 0644.
 */
export const replaceUserFile = (path: string, data: string): void => {
  let target = path
  let mode = 0o644
  if (existsSync(path)) {
    target = realpathSync(path)
    mode = statSync(target).mode & 0o7777
  }
  atomicWriteFile(target, data, mode)
}

export const atomicCopyFile = (src: string, dest: string, mode = 0o755): void => {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = tmpBeside(dest, "tmp")
  try {
    copyFileSync(src, tmp)
    chmodSync(tmp, mode)
    renameSync(tmp, dest)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

/**
 * Replace a directory tree: copy to a sibling, swap with two renames, delete the old one.
 * The gap between the renames is microseconds instead of a whole copy.
 */
export const replaceDir = (src: string, dest: string): void => {
  mkdirSync(dirname(dest), { recursive: true })
  const fresh = tmpBeside(dest, "new")
  const old = tmpBeside(dest, "old")
  cpSync(src, fresh, { recursive: true, verbatimSymlinks: true })
  if (existsSync(dest)) renameSync(dest, old)
  renameSync(fresh, dest)
  rmSync(old, { recursive: true, force: true })
}

/** Lowercase hex SHA-256 of a file, streamed. */
export const sha256File = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256")
  const reader = Bun.file(path).stream().getReader()
  for (let r = await reader.read(); !r.done; r = await reader.read()) hasher.update(r.value)
  return hasher.digest("hex")
}

/** The digest in a `.sha256` sidecar: the first token, which must be 64 hex characters. */
export const parseSidecar = (text: string): string => {
  const digest = text.trim().split(/\s+/)[0]?.toLowerCase() ?? ""
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("checksum file has no SHA-256 digest")
  return digest
}

export const verifySha256 = async (file: string, sidecarText: string): Promise<void> => {
  const expected = parseSidecar(sidecarText)
  const actual = await sha256File(file)
  if (actual !== expected)
    throw new Error(`checksum mismatch for ${basename(file)}: expected ${expected}, got ${actual}`)
}
