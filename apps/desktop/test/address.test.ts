import { describe, expect, test } from "bun:test"
import { addressWithoutToken } from "../src/client/http.ts"

describe("addressWithoutToken (D-095)", () => {
  test("drops k, keeps the other params and the hash", () => {
    expect(addressWithoutToken("http://127.0.0.1:9/?view=compact&k=abc&client=http#/item/7")).toBe(
      "/?view=compact&client=http#/item/7",
    )
    expect(addressWithoutToken("http://127.0.0.1:9/?k=abc#/settings")).toBe("/#/settings")
    expect(addressWithoutToken("http://127.0.0.1:9/inbox?k=abc")).toBe("/inbox")
  })
  test("null when there is no k", () => {
    expect(addressWithoutToken("http://127.0.0.1:9/?view=compact#/item/7")).toBeNull()
  })
})
