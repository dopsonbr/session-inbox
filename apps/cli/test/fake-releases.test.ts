/** The fake releases server the release test and `scripts/e2e-update.ts` share. */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startFakeReleases } from "../../../scripts/fake-releases.ts"
import { fetchRelease, sidecarName, tarballName } from "../src/releases.ts"

const dir = mkdtempSync("/tmp/si-fake-")
const fake = startFakeReleases()
afterAll(() => {
  fake.stop()
  rmSync(dir, { recursive: true, force: true })
})

test("serves release JSON and assets the CLI can resolve, through both URL forms", async () => {
  const tarball = join(dir, tarballName("0.0.1"))
  writeFileSync(tarball, "tar bytes")
  writeFileSync(`${tarball}.sha256`, `${"a".repeat(64)}\n`)
  expect((await fetch(`${fake.releasesUrl}/latest`)).status).toBe(404)

  fake.add({ version: "0.0.1", tarball, sidecar: `${tarball}.sha256` }, { latest: true })
  const viaJson = await fetchRelease({ SESSION_INBOX_RELEASES_URL: fake.releasesUrl }, null)
  expect(viaJson).toMatchObject({
    version: "0.0.1",
    tag: "v0.0.1",
    notesUrl: `${fake.base}/notes/v0.0.1`,
  })
  expect(viaJson.tarball.browser_download_url).toBe(
    `${fake.base}/download/v0.0.1/${tarballName("0.0.1")}`,
  )
  const viaMirror = await fetchRelease(
    { SESSION_INBOX_RELEASES_URL: fake.releasesUrl, SESSION_INBOX_ASSET_URL: fake.assetUrl },
    "0.0.1",
  )
  expect(viaMirror.sidecar.browser_download_url).toBe(
    `${fake.base}/download/v0.0.1/${sidecarName("0.0.1")}`,
  )
  expect(await (await fetch(viaMirror.tarball.browser_download_url)).text()).toBe("tar bytes")
  expect(await (await fetch(viaMirror.sidecar.browser_download_url)).text()).toBe(
    `${"a".repeat(64)}\n`,
  )

  fake.setCorrupt("0.0.1", true)
  expect(await (await fetch(viaMirror.tarball.browser_download_url)).text()).toBe("not a tarball")
  fake.setCorrupt("0.0.1", false)

  fake.addBroken("0.0.3", { latest: true })
  const broken = await fetchRelease({ SESSION_INBOX_RELEASES_URL: fake.releasesUrl }, null)
  expect(broken.version).toBe("0.0.3")
  expect(await (await fetch(broken.sidecar.browser_download_url)).text()).toMatch(/^0{64}\n$/)
  expect((await fetch(`${fake.releasesUrl}/tags/v9.9.9`)).status).toBe(404)
  expect(fake.requests).toContain("/releases/latest")
})
