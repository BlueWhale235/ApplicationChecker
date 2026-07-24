import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

export interface PublicUrlValidationOptions {
  /**
   * Windows proxy clients such as Clash/Mihomo can return an RFC 2544
   * benchmarking address as a synthetic DNS result. The browser then sends the
   * hostname through the proxy, so this range is safe to accept only in the
   * local desktop runtime.
   */
  allowProxyFakeIp?: boolean;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

function blockedIp(address: string, allowProxyFakeIp: boolean): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (!allowProxyFakeIp && a === 198 && (b === 18 || b === 19));
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.");
}

async function resolveHostname(hostname: string): Promise<string[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => []),
    resolve6(hostname).catch(() => []),
  ]);
  return [...ipv4, ...ipv6];
}

export async function assertPublicUrl(
  input: string,
  options: PublicUrlValidationOptions = {},
): Promise<URL> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("只允许不含账号密码的 HTTP/HTTPS 地址");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "metadata.google.internal"].includes(hostname)) {
    throw new Error("不允许访问本机或内部地址");
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await (options.resolveHostname ?? resolveHostname)(hostname);
  if (!addresses.length) throw new Error("无法解析目标域名，请检查网址、网络或代理 DNS 设置");
  if (addresses.some((address) => blockedIp(address, options.allowProxyFakeIp === true))) {
    throw new Error("目标地址解析到了本机、内网或其他受限地址");
  }
  return url;
}
