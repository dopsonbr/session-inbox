import { expect, test } from "bun:test"
import { injectToken } from "../src/server.ts"

test("injects the token into both the plain and the self-closing meta tag", () => {
  for (const tag of [
    '<meta name="session-inbox-token" content="">',
    '<meta name="session-inbox-token" content="" />',
  ]) {
    expect(injectToken(`<head>${tag}</head>`, "t0k")).toBe(
      '<head><meta name="session-inbox-token" content="t0k"></head>',
    )
  }
})
