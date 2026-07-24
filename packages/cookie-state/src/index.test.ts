import { describe, expect, it } from "vitest";
import { decryptBrowserState, encryptBrowserState } from "./index.js";

describe("browser state encryption", () => {
  it("round trips an envelope", () => {
    const key = Buffer.alloc(32, 7);
    const state = { version: 1 as const, cookies: [], origins: [{ origin: "https://example.com", localStorage: { token: "ok" } }] };
    expect(decryptBrowserState(encryptBrowserState(state, key), key)).toEqual(state);
  });
});
