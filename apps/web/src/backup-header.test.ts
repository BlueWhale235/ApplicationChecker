import { hmac } from "@noble/hashes/hmac.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { BACKUP_HEADER_SIZE, checkBackupPasswordLocally } from "./backup-header";

function backupHeader(password: string): Uint8Array {
  const header = new Uint8Array(BACKUP_HEADER_SIZE);
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  header.set(new TextEncoder().encode("ACBACK01"), 0);
  header[8] = 1;
  header.set(salt, 9);
  const key = scrypt(password, salt, { N: 32768, r: 8, p: 1, dkLen: 32, maxmem: 64 * 1024 * 1024 });
  const verifier = hmac(sha256, key, new TextEncoder().encode("application-checker-backup-password-verifier-v1"));
  header.set(verifier, 53);
  key.fill(0);
  return header;
}

describe("local backup password check", () => {
  it("checks the v1 password using only the local file header", async () => {
    const header = backupHeader("correct-password");
    expect(header).toHaveLength(BACKUP_HEADER_SIZE);
    const result = await checkBackupPasswordLocally(new Blob([header.buffer as ArrayBuffer]), "correct-password");
    expect(result.formatVersion).toBe(1);
    expect(result.passwordVerified).toBe(true);
    await expect(checkBackupPasswordLocally(new Blob([header.buffer as ArrayBuffer]), "wrong-password"))
      .rejects.toThrow("迁移密码错误");
  });
});
