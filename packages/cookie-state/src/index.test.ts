import { describe, expect, it } from "vitest";
import { decryptBrowserState, encryptBrowserState } from "./index.js";

describe("browser state encryption", () => {
  it("round trips an envelope", () => {
    const key = Buffer.alloc(32, 7);
    const state = {
      version: 1 as const,
      cookies: [],
      origins: [{
        origin: "https://example.com",
        localStorage: { token: "ok" },
        indexedDB: [{
          name: "auth",
          version: 2,
          stores: [{
            name: "tokens",
            keyPath: "id",
            autoIncrement: false,
            indexes: [],
            records: [{
              key: { type: "string", value: "primary" },
              value: { type: "object", value: [["id", { type: "string", value: "primary" }]] },
            }],
            truncated: false,
          }],
        }],
      }],
    };
    expect(decryptBrowserState(encryptBrowserState(state, key), key)).toEqual(state);
  });
});
