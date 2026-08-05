import type { ScriptRuleLogEntry } from "@application-checker/contracts";

export const SCRIPT_LOG_MAX_ENTRIES = 100;
export const SCRIPT_LOG_MAX_ENTRY_BYTES = 2 * 1024;
export const SCRIPT_LOG_MAX_TOTAL_BYTES = 32 * 1024;

export interface ScriptRuleLogPayload extends ScriptRuleLogEntry {
  index: number;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const suffix = "…";
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  return `${encoded.subarray(0, available).toString("utf8").replace(/\uFFFD$/u, "")}${suffix}`;
}

export function formatScriptLogValues(values: unknown[]): string {
  const seen = new WeakSet<object>();
  const format = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value === null) return "null";
    if (["number", "boolean", "bigint", "undefined", "symbol", "function"].includes(typeof value)) return String(value);
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof Element !== "undefined" && value instanceof Element) {
      const id = value.id ? `#${value.id}` : "";
      const classes = [...value.classList].slice(0, 3).map((name) => `.${name}`).join("");
      return `<${value.tagName.toLowerCase()}${id}${classes}>`;
    }
    try {
      const serialized = JSON.stringify(value, (_key, child: unknown) => {
        if (typeof child === "bigint") return `${child}n`;
        if (typeof child === "object" && child !== null) {
          if (seen.has(child)) return "[Circular]";
          seen.add(child);
        }
        return child;
      });
      return serialized ?? String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  };
  return values.map(format).join(" ");
}

export class ScriptRuleLogCollector {
  private readonly entries: ScriptRuleLogEntry[] = [];
  private readonly indexes = new Set<number>();
  private totalBytes = 0;
  private wasTruncated = false;

  add(input: unknown): void {
    if (!input || typeof input !== "object") return;
    const value = input as Partial<ScriptRuleLogPayload> & { truncated?: unknown };
    if (value.truncated === true) {
      this.wasTruncated = true;
      return;
    }
    if (!Number.isInteger(value.index) || typeof value.message !== "string" || typeof value.atMs !== "number") return;
    const index = value.index as number;
    if (this.indexes.has(index)) return;
    if (this.entries.length >= SCRIPT_LOG_MAX_ENTRIES) {
      this.wasTruncated = true;
      return;
    }
    const message = truncateUtf8(value.message, SCRIPT_LOG_MAX_ENTRY_BYTES);
    const bytes = Buffer.byteLength(message, "utf8");
    if (this.totalBytes + bytes > SCRIPT_LOG_MAX_TOTAL_BYTES) {
      this.wasTruncated = true;
      return;
    }
    this.indexes.add(index);
    this.totalBytes += bytes;
    this.entries.push({ atMs: Math.max(0, Math.trunc(value.atMs)), message });
    if (message !== value.message) this.wasTruncated = true;
  }

  merge(entries: ScriptRuleLogPayload[], truncated: boolean): void {
    for (const entry of entries) this.add(entry);
    if (truncated) this.wasTruncated = true;
  }

  snapshot(): { logs: ScriptRuleLogEntry[]; logsTruncated: boolean } {
    return { logs: [...this.entries], logsTruncated: this.wasTruncated };
  }
}
