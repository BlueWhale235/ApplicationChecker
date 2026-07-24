import { describe, expect, it } from "vitest";
import { assertPublicUrl } from "./security.js";

describe("public URL validation", () => {
  it("rejects localhost and credential URLs", async () => {
    await expect(assertPublicUrl("http://localhost:8080")).rejects.toThrow();
    await expect(assertPublicUrl("https://user:pass@example.com")).rejects.toThrow();
  });

  it("rejects private and proxy fake IP addresses by default", async () => {
    await expect(assertPublicUrl("http://127.0.0.1")).rejects.toThrow("受限地址");
    await expect(assertPublicUrl("https://private.example", {
      resolveHostname: async () => ["192.168.1.10"],
    })).rejects.toThrow("受限地址");
    await expect(assertPublicUrl("https://proxied.example", {
      resolveHostname: async () => ["198.18.10.20"],
    })).rejects.toThrow("受限地址");
  });

  it("accepts proxy fake IP DNS results only when explicitly enabled", async () => {
    await expect(assertPublicUrl("https://proxied.example", {
      allowProxyFakeIp: true,
      resolveHostname: async () => ["198.19.10.20"],
    })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("https://private.example", {
      allowProxyFakeIp: true,
      resolveHostname: async () => ["10.0.0.8"],
    })).rejects.toThrow("受限地址");
  });

  it("reports DNS lookup failures separately", async () => {
    await expect(assertPublicUrl("https://missing.example", {
      resolveHostname: async () => [],
    })).rejects.toThrow("无法解析目标域名");
  });
});
