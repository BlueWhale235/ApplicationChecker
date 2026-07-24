import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "./security.js";

describe("public URL validation", () => {
  it("rejects localhost and credential URLs", async () => {
    await expect(assertPublicUrl("http://localhost:8080")).rejects.toThrow();
    await expect(assertPublicUrl("https://user:pass@example.com")).rejects.toThrow();
  });
});
