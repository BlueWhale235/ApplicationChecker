import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { BrowserStateEnvelope } from "@application-checker/contracts";

export interface EncryptedPayload {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function emptyBrowserState(): BrowserStateEnvelope {
  return { version: 1, cookies: [], origins: [] };
}

export function encryptBrowserState(state: BrowserStateEnvelope, key: Buffer): EncryptedPayload {
  if (key.length !== 32) throw new Error("State encryption key must contain exactly 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(state), "utf8")),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptBrowserState(payload: EncryptedPayload, key: Buffer): BrowserStateEnvelope {
  if (payload.version !== 1) throw new Error("Unsupported browser state version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  const parsed = JSON.parse(clear.toString("utf8")) as BrowserStateEnvelope;
  if (parsed.version !== 1 || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
    throw new Error("Invalid browser state");
  }
  return parsed;
}
