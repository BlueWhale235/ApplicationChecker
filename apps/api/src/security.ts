import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

function blockedIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.");
}

export async function assertPublicUrl(input: string): Promise<URL> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("只允许不含账号密码的 HTTP/HTTPS 地址");
  }
  if (["localhost", "metadata.google.internal"].includes(url.hostname.toLowerCase())) throw new Error("不允许访问本机或内部地址");
  const addresses = [
    ...await resolve4(url.hostname).catch(() => []),
    ...await resolve6(url.hostname).catch(() => []),
  ];
  if (!addresses.length || addresses.some(blockedIp)) throw new Error("目标地址不是可访问的公网地址");
  return url;
}
