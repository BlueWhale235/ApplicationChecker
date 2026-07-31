import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearDirectoryContents, clearLogContents, directorySize } from "./storage-maintenance.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("browser storage maintenance", () => {
  it("measures nested files and clears only the directory contents", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-storage-"));
    folders.push(folder);
    await mkdir(path.join(folder, "nested"));
    await writeFile(path.join(folder, "one.js"), "1234");
    await writeFile(path.join(folder, "nested", "two.css"), "123456");

    expect(await directorySize(folder)).toBe(10);
    const result = await clearDirectoryContents(folder);

    expect(result).toEqual({ beforeBytes: 10, afterBytes: 0, freedBytes: 10, failed: 0 });
    expect(await directorySize(folder)).toBe(0);
  });

  it("treats a missing directory as empty and creates it during cleanup", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "application-checker-storage-"));
    folders.push(parent);
    const folder = path.join(parent, "missing");

    expect(await directorySize(folder)).toBe(0);
    expect(await clearDirectoryContents(folder)).toEqual({
      beforeBytes: 0,
      afterBytes: 0,
      freedBytes: 0,
      failed: 0,
    });
    await expect(readFile(path.join(folder, "not-there"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("truncates active log files and removes rotated log folders", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "application-checker-logs-"));
    folders.push(folder);
    await mkdir(path.join(folder, "archive"));
    await writeFile(path.join(folder, "api.log"), "warning");
    await writeFile(path.join(folder, "archive", "old.log"), "old");

    expect(await clearLogContents(folder)).toEqual({
      beforeBytes: 10,
      afterBytes: 0,
      freedBytes: 10,
      failed: 0,
    });
    expect(await readFile(path.join(folder, "api.log"), "utf8")).toBe("");
    await expect(readFile(path.join(folder, "archive", "old.log"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
