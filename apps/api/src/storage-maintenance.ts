import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface DirectoryCleanupResult {
  beforeBytes: number;
  afterBytes: number;
  freedBytes: number;
  failed: number;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function directorySize(folder: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(target);
    } else if (entry.isFile()) {
      total += (await lstat(target)).size;
    }
  }
  return total;
}

export async function clearDirectoryContents(folder: string): Promise<DirectoryCleanupResult> {
  const beforeBytes = await directorySize(folder);
  await mkdir(folder, { recursive: true });
  const entries = await readdir(folder);
  let failed = 0;
  for (const entry of entries) {
    try {
      await rm(path.join(folder, entry), { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      failed += 1;
    }
  }
  const afterBytes = await directorySize(folder);
  return {
    beforeBytes,
    afterBytes,
    freedBytes: Math.max(0, beforeBytes - afterBytes),
    failed,
  };
}
