import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";

const MAGIC = new TextEncoder().encode("ACBACK01");
const FORMAT_VERSION = 1;
const BASE_HEADER_SIZE = 53;
export const BACKUP_HEADER_SIZE = 85;
const VERIFIER_CONTEXT = new TextEncoder().encode("application-checker-backup-password-verifier-v1");

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function checkBackupPasswordLocally(
  file: Blob,
  password: string,
  onProgress?: (progress: number) => void,
): Promise<{ headerBase64: string; formatVersion: number; passwordVerified: boolean }> {
  if (password.length < 8) throw new Error("迁移密码至少需要 8 个字符");
  if (password.length > 1024) throw new Error("迁移密码长度不能超过 1024 个字符");
  const header = new Uint8Array(await file.slice(0, BACKUP_HEADER_SIZE).arrayBuffer());
  if (header.length < BASE_HEADER_SIZE || !sameBytes(header.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error("不是有效的 Application Checker 备份文件");
  }
  const formatVersion = header[MAGIC.length]!;
  if (formatVersion !== FORMAT_VERSION) {
    throw new Error(`不支持的备份格式版本：${formatVersion}`);
  }
  if (header.length < BACKUP_HEADER_SIZE) throw new Error("备份文件头不完整");
  const derivedKey = await scryptAsync(password, header.subarray(9, 25), {
    N: 32768,
    r: 8,
    p: 1,
    dkLen: 32,
    maxmem: 64 * 1024 * 1024,
    asyncTick: 8,
    ...(onProgress ? { onProgress } : {}),
  });
  try {
    if (!sameBytes(hmac(sha256, derivedKey, VERIFIER_CONTEXT), header.subarray(BASE_HEADER_SIZE, BACKUP_HEADER_SIZE))) {
      throw new Error("迁移密码错误");
    }
  } finally { derivedKey.fill(0); }
  let binary = "";
  for (const byte of header) binary += String.fromCharCode(byte);
  return { headerBase64: btoa(binary), formatVersion, passwordVerified: true };
}
