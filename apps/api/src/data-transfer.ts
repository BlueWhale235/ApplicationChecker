import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt as scryptCallback } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BrowserStateEnvelope } from "@application-checker/contracts";
import { decryptBrowserState, encryptBrowserState, type EncryptedPayload } from "@application-checker/cookie-state";
import type { Config } from "./config.js";
import type { DbContext } from "./db.js";
import { decryptSecret, encryptSecret, syncRuntimeSettingsFile } from "./runtime-settings.js";
import { appSettings } from "./service.js";

const MAGIC = Buffer.from("ACBACK01", "ascii");
const FORMAT_VERSION = 1;
const HEADER_SIZE = MAGIC.length + 1 + 16 + 12 + 16;
const TABLES = [
  "check_groups", "applications", "runs", "run_application_results", "status_events",
  "notifications", "browser_profiles", "login_sessions", "app_settings", "parser_rules",
] as const;
const INSERT_ORDER = [...TABLES];
const DELETE_ORDER = [...TABLES].reverse();
const ACTIVE_LOGIN_STATUSES = ["queued", "starting", "ready", "active", "saving"];
const MAX_JSON_BYTES = 256 * 1024 * 1024;

type TableName = typeof TABLES[number];
type JsonRow = Record<string, unknown>;
type ExportTables = Record<TableName, JsonRow[]>;

export interface MaintenanceState { active: boolean }

export interface TransferSummary {
  formatVersion: number;
  appVersion: string;
  exportedAt: string;
  sourceKeyId: string;
  targetKeyId: string;
  keyChanged: boolean;
  counts: Record<TableName, number>;
  targetCounts: Record<TableName, number>;
  screenshotCount: number;
  screenshotBytes: number;
  sensitiveData: string[];
  targetHasData: boolean;
}

interface Manifest {
  formatVersion: 1;
  appVersion: string;
  exportedAt: string;
  sourceKeyId: string;
  counts: Record<TableName, number>;
  screenshotCount: number;
  screenshotBytes: number;
  sensitiveData: string[];
}

interface ImportSession {
  id: string;
  root: string;
  tables: ExportTables;
  manifest: Manifest;
  summary: TransferSummary;
  expiresAt: number;
}

interface EntryHeader { name: string; size: number; sha256: string }

function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (password.length < 8) throw Object.assign(new Error("迁移密码至少需要 8 个字符"), { statusCode: 400 });
  if (password.length > 1024) throw Object.assign(new Error("迁移密码长度不能超过 1024 个字符"), { statusCode: 400 });
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) reject(error); else resolve(Buffer.from(derived));
    });
  });
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function writeChunk(output: Writable, value: Buffer): Promise<void> {
  if (output.write(value)) return;
  await once(output, "drain");
}

async function writeEntry(output: Writable, header: EntryHeader, source: Buffer | string): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(encoded.length);
  await writeChunk(output, prefix);
  await writeChunk(output, encoded);
  if (Buffer.isBuffer(source)) {
    await writeChunk(output, source);
    return;
  }
  for await (const chunk of createReadStream(source)) await writeChunk(output, chunk as Buffer);
}

class ByteReader {
  private readonly iterator: AsyncIterator<unknown>;
  private buffer = Buffer.alloc(0);
  constructor(stream: Readable) { this.iterator = stream[Symbol.asyncIterator](); }
  async readExactly(size: number): Promise<Buffer | null> {
    while (this.buffer.length < size) {
      const next = await this.iterator.next();
      if (next.done) return this.buffer.length ? (() => { throw new Error("备份包内容不完整"); })() : null;
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value as Uint8Array)]);
    }
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }
}

function safeEntryPath(root: string, entryName: string): string {
  if (!entryName || path.isAbsolute(entryName) || entryName.includes("\\") || entryName.split("/").includes("..")) {
    throw new Error("备份包包含不安全的文件路径");
  }
  const resolved = path.resolve(root, ...entryName.split("/"));
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("备份包包含不安全的文件路径");
  return resolved;
}

async function readArchive(input: Readable, outputRoot: string): Promise<ParsedArchive> {
  const reader = new ByteReader(input);
  let manifest: Manifest | null = null;
  let tables: ExportTables | null = null;
  let entries = 0;
  let screenshotCount = 0;
  let screenshotBytes = 0;
  const names = new Set<string>();
  while (true) {
    const prefix = await reader.readExactly(4);
    if (!prefix) break;
    const headerLength = prefix.readUInt32BE(0);
    if (headerLength === 0) break;
    if (headerLength > 16 * 1024) throw new Error("备份包条目头无效");
    const headerBytes = await reader.readExactly(headerLength);
    if (!headerBytes) throw new Error("备份包条目头不完整");
    const header = JSON.parse(headerBytes.toString("utf8")) as EntryHeader;
    if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size > 4 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(header.sha256)) {
      throw new Error("备份包条目元数据无效");
    }
    if (names.has(header.name)) throw new Error(`备份包包含重复条目：${header.name}`);
    names.add(header.name);
    if (header.name !== "manifest.json" && header.name !== "data.json" && !header.name.startsWith("screenshots/")) {
      throw new Error(`备份包包含未知条目：${header.name}`);
    }
    const target = safeEntryPath(outputRoot, header.name);
    await mkdir(path.dirname(target), { recursive: true });
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let remaining = header.size;
    while (remaining > 0) {
      const chunk = await reader.readExactly(Math.min(remaining, 1024 * 1024));
      if (!chunk) throw new Error("备份包条目内容不完整");
      hash.update(chunk);
      if (header.name === "manifest.json" || header.name === "data.json") {
        if (header.size > MAX_JSON_BYTES) throw new Error("备份包数据清单过大");
        chunks.push(chunk);
      } else {
        await writeFile(target, chunk, { flag: remaining === header.size ? "w" : "a" });
      }
      remaining -= chunk.length;
    }
    if (hash.digest("hex") !== header.sha256) throw new Error(`备份条目校验失败：${header.name}`);
    if (header.name === "manifest.json") manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Manifest;
    if (header.name === "data.json") tables = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tables: ExportTables }).tables;
    if (header.name.startsWith("screenshots/")) { screenshotCount += 1; screenshotBytes += header.size; }
    entries += 1;
    if (entries > 100_000) throw new Error("备份包文件数量超出限制");
  }
  if (!manifest || !tables) throw new Error("备份包缺少数据清单");
  return { manifest, tables, screenshotCount, screenshotBytes };
}

interface ParsedArchive { manifest: Manifest; tables: ExportTables; screenshotCount: number; screenshotBytes: number }

function tableCounts(raw: DbContext["raw"]): Record<TableName, number> {
  return Object.fromEntries(TABLES.map((table) => [table, Number((raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)])) as Record<TableName, number>;
}

function validateTables(tables: ExportTables, raw: DbContext["raw"]): void {
  if (!tables || typeof tables !== "object") throw new Error("备份数据格式无效");
  for (const table of TABLES) {
    if (!Array.isArray(tables[table])) throw new Error(`备份缺少数据表：${table}`);
    const columns = new Set((raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name));
    for (const row of tables[table]) {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`数据表 ${table} 包含无效记录`);
      for (const column of Object.keys(row)) if (!columns.has(column) && !["browser_state", "ai_api_key"].includes(column)) {
        throw new Error(`数据表 ${table} 包含未知字段：${column}`);
      }
    }
  }
}

async function collectExportTables(context: DbContext, config: Config): Promise<ExportTables> {
  const tables = Object.fromEntries(TABLES.map((table) => [table, context.raw.prepare(`SELECT * FROM ${table}`).all() as JsonRow[]])) as ExportTables;
  tables.browser_profiles = tables.browser_profiles.map((row) => {
    try {
      const browserState = decryptBrowserState(JSON.parse(String(row.payload_json)) as EncryptedPayload, config.stateKey);
      const { payload_json: _payload, ...rest } = row;
      return { ...rest, browser_state: browserState };
    } catch {
      throw new Error(`无法解密浏览器登录状态：${String(row.site)}`);
    }
  });
  tables.app_settings = tables.app_settings.map((row) => {
    let aiApiKey: string | null = null;
    try { aiApiKey = decryptSecret(row.ai_api_key_encrypted as string | null, config.stateKey); }
    catch { throw new Error("无法解密 AI API Key，请确认当前 STATE_ENCRYPTION_KEY 未被修改"); }
    const { ai_api_key_encrypted: _secret, state_key_fingerprint: _fingerprint, ...rest } = row;
    return { ...rest, ai_api_key: aiApiKey };
  });
  return tables;
}

async function screenshotEntries(tables: ExportTables, config: Config): Promise<Array<{ name: string; filename: string; size: number; sha256: string }>> {
  const entries: Array<{ name: string; filename: string; size: number; sha256: string }> = [];
  for (const run of tables.runs) {
    const filename = typeof run.screenshot_path === "string" ? run.screenshot_path : null;
    if (!filename) continue;
    const relative = path.relative(path.resolve(config.screenshotsPath), path.resolve(filename));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`截图路径不在数据目录中：${run.id}`);
    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("not a file");
      const name = `screenshots/${relative.replaceAll("\\", "/")}`;
      run.screenshot_path = name;
      entries.push({ name, filename, size: info.size, sha256: await hashFile(filename) });
    } catch {
      throw new Error(`截图文件缺失或无法读取：${run.id}`);
    }
  }
  return entries;
}

async function createEncryptedBackup(context: DbContext, config: Config, password: string, destination: string): Promise<Manifest> {
  const tables = await collectExportTables(context, config);
  const screenshots = await screenshotEntries(tables, config);
  const counts = Object.fromEntries(TABLES.map((table) => [table, tables[table].length])) as Record<TableName, number>;
  const sensitiveData = [
    ...(tables.browser_profiles.length ? ["浏览器登录状态"] : []),
    ...(tables.app_settings.some((row) => row.ai_api_key) ? ["AI API Key"] : []),
  ];
  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION,
    appVersion: "0.1.0",
    exportedAt: new Date().toISOString(),
    sourceKeyId: keyId(config.stateKey),
    counts,
    screenshotCount: screenshots.length,
    screenshotBytes: screenshots.reduce((total, item) => total + item.size, 0),
    sensitiveData,
  };
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8");
  const dataBuffer = Buffer.from(JSON.stringify({ tables }), "utf8");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt);
  const ciphertextPath = `${destination}.cipher`;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const gzip = createGzip({ level: 6 });
  const encryptedOutput = createWriteStream(ciphertextPath, { mode: 0o600 });
  gzip.pipe(cipher).pipe(encryptedOutput);
  const encryptedDone = new Promise<void>((resolve, reject) => {
    encryptedOutput.once("finish", resolve);
    encryptedOutput.once("error", reject);
    gzip.once("error", reject);
    cipher.once("error", reject);
  });
  try {
    await writeEntry(gzip, { name: "manifest.json", size: manifestBuffer.length, sha256: hashBuffer(manifestBuffer) }, manifestBuffer);
    await writeEntry(gzip, { name: "data.json", size: dataBuffer.length, sha256: hashBuffer(dataBuffer) }, dataBuffer);
    for (const item of screenshots) {
      await writeEntry(gzip, { name: item.name, size: item.size, sha256: item.sha256 }, item.filename);
    }
    await writeChunk(gzip, Buffer.alloc(4));
    gzip.end();
    await encryptedDone;
    const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv, cipher.getAuthTag()]);
    await writeFile(destination, header, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const input = createReadStream(ciphertextPath);
      const output = createWriteStream(destination, { flags: "a" });
      input.pipe(output).once("finish", resolve).once("error", reject);
      input.once("error", reject);
    });
    return manifest;
  } finally {
    key.fill(0);
    await rm(ciphertextPath, { force: true });
  }
}

async function decryptBackup(filename: string, password: string, outputRoot: string): Promise<ParsedArchive> {
  const info = await stat(filename);
  if (info.size <= HEADER_SIZE) throw new Error("备份文件过小或已损坏");
  const handle = await import("node:fs/promises").then(({ open }) => open(filename, "r"));
  const header = Buffer.alloc(HEADER_SIZE);
  try { await handle.read(header, 0, HEADER_SIZE, 0); } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("不是有效的 Application Checker 备份文件");
  if (header[MAGIC.length] !== FORMAT_VERSION) throw new Error(`不支持的备份格式版本：${header[MAGIC.length]}`);
  const salt = header.subarray(9, 25);
  const iv = header.subarray(25, 37);
  const tag = header.subarray(37, 53);
  const key = await deriveKey(password, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decoded = new PassThrough();
  const pumping = pipeline(createReadStream(filename, { start: HEADER_SIZE }), decipher, createGunzip(), decoded);
  try {
    const parsed = await readArchive(decoded, outputRoot);
    await pumping;
    return parsed;
  }
  catch (error) {
    decoded.destroy();
    await pumping.catch(() => {});
    if (error instanceof Error && /authenticate data|incorrect header check|invalid distance/i.test(error.message)) {
      throw new Error("迁移密码错误，或备份文件已损坏");
    }
    throw error;
  } finally { key.fill(0); }
}

function sqlInsert(raw: DbContext["raw"], table: TableName, rows: JsonRow[]): void {
  if (!rows.length) return;
  const allowed = new Set((raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name));
  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => allowed.has(column));
    const statement = raw.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    statement.run(...columns.map((column) => row[column] as never));
  }
}

function prepareImportedTables(session: ImportSession, config: Config): ExportTables {
  const now = new Date().toISOString();
  const tables = structuredClone(session.tables);
  tables.browser_profiles = tables.browser_profiles.map((row) => {
    const state = row.browser_state as BrowserStateEnvelope;
    if (!state || state.version !== 1 || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new Error("浏览器登录状态格式无效");
    const { browser_state: _state, ...rest } = row;
    return { ...rest, payload_json: JSON.stringify(encryptBrowserState(state, config.stateKey)) };
  });
  tables.app_settings = tables.app_settings.map((row) => {
    const secret = row.ai_api_key;
    if (secret !== null && secret !== undefined && typeof secret !== "string") throw new Error("AI API Key 格式无效");
    const { ai_api_key: _secret, ...rest } = row;
    return {
      ...rest,
      ai_api_key_encrypted: typeof secret === "string" && secret ? encryptSecret(secret, config.stateKey) : null,
      state_key_fingerprint: keyId(config.stateKey),
    };
  });
  tables.runs = tables.runs.map((row) => ({
    ...row,
    ...(row.status === "running" ? {
      status: "queued", started_at: null, completed_at: null,
      error_code: "RECOVERED_AFTER_IMPORT", error_message: "数据迁移后任务已自动重新排队",
      recognition_status: "pending",
    } : {}),
    screenshot_path: typeof row.screenshot_path === "string"
      ? path.join(config.screenshotsPath, String(row.screenshot_path).replace(/^screenshots\//, ""))
      : null,
  }));
  tables.applications = tables.applications.map((row) => ({
    ...row,
    ...(row.last_run_status === "running" ? { last_run_status: "queued", updated_at: now } : {}),
  }));
  tables.login_sessions = tables.login_sessions.map((row) => ACTIVE_LOGIN_STATUSES.includes(String(row.status)) ? {
    ...row, status: "failed", error_message: "数据迁移后原登录窗口已关闭，请重新打开登录", updated_at: now, completed_at: now,
  } : row);
  return tables;
}

export async function verifyStateEncryptionKey(context: DbContext, config: Config): Promise<void> {
  const row = context.raw.prepare("SELECT state_key_fingerprint FROM app_settings WHERE id = 1").get() as { state_key_fingerprint: string | null } | undefined;
  if (!row) return;
  const current = keyId(config.stateKey);
  if (row.state_key_fingerprint && row.state_key_fingerprint !== current) {
    const encrypted = Number((context.raw.prepare("SELECT (SELECT COUNT(*) FROM browser_profiles) + CASE WHEN ai_api_key_encrypted IS NULL THEN 0 ELSE 1 END AS count FROM app_settings WHERE id = 1").get() as { count: number }).count);
    if (encrypted) throw new Error("STATE_ENCRYPTION_KEY 与当前数据目录不匹配。请恢复原 Key 后再启动，或使用加密备份迁移数据。");
    context.raw.prepare("UPDATE app_settings SET state_key_fingerprint = ? WHERE id = 1").run(current);
  }
  if (!row.state_key_fingerprint) {
    await collectExportTables(context, config);
    context.raw.prepare("UPDATE app_settings SET state_key_fingerprint = ? WHERE id = 1").run(current);
  }
}

export class DataTransferService {
  private readonly sessions = new Map<string, ImportSession>();
  constructor(private readonly context: DbContext, private readonly config: Config, readonly maintenance: MaintenanceState) {}

  async export(password: string): Promise<{ filename: string; downloadName: string }> {
    if (this.maintenance.active) throw Object.assign(new Error("另一项数据迁移正在进行"), { statusCode: 409 });
    const activeRun = this.context.raw.prepare("SELECT id FROM runs WHERE status = 'running' LIMIT 1").get();
    const activeLogin = this.context.raw.prepare("SELECT id FROM login_sessions WHERE status IN ('starting','ready','active','saving') LIMIT 1").get();
    if (activeRun || activeLogin) throw Object.assign(new Error("仍有正在执行的检查或登录窗口，请结束后再导出"), { statusCode: 409 });
    this.maintenance.active = true;
    const root = path.join(this.config.tempPath, "data-transfer", randomUUID());
    const filename = path.join(root, "backup.acbackup");
    try {
      await mkdir(root, { recursive: true });
      await createEncryptedBackup(this.context, this.config, password, filename);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return { filename, downloadName: `application-checker-${stamp}.acbackup` };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    } finally {
      this.maintenance.active = false;
    }
  }

  async inspect(uploadPath: string, password: string): Promise<{ id: string; summary: TransferSummary; expiresAt: string }> {
    const id = randomUUID();
    const root = path.join(this.config.tempPath, "data-transfer", id);
    await mkdir(root, { recursive: true });
    const stored = path.join(root, "upload.acbackup");
    await rename(uploadPath, stored);
    try {
      const parsed = await decryptBackup(stored, password, path.join(root, "extracted"));
      if (parsed.manifest.formatVersion !== FORMAT_VERSION) throw new Error("备份格式版本不受支持");
      if (!/^[a-f0-9]{16}$/.test(parsed.manifest.sourceKeyId)
          || typeof parsed.manifest.exportedAt !== "string"
          || !Array.isArray(parsed.manifest.sensitiveData)) throw new Error("备份清单格式无效");
      validateTables(parsed.tables, this.context.raw);
      for (const table of TABLES) if (parsed.manifest.counts?.[table] !== parsed.tables[table].length) {
        throw new Error(`备份清单数量不一致：${table}`);
      }
      if (parsed.manifest.screenshotCount !== parsed.screenshotCount || parsed.manifest.screenshotBytes !== parsed.screenshotBytes) {
        throw new Error("备份截图清单与实际内容不一致");
      }
      if (parsed.tables.app_settings.length !== 1 || Number(parsed.tables.app_settings[0]?.id) !== 1) {
        throw new Error("备份中的应用设置记录无效");
      }
      const referencedScreenshots = new Set(parsed.tables.runs.flatMap((row) => {
        if (row.screenshot_path === null || row.screenshot_path === undefined) return [];
        const name = String(row.screenshot_path);
        if (!name.startsWith("screenshots/")) throw new Error("备份包含无效的截图路径");
        return [name];
      }));
      if (referencedScreenshots.size !== parsed.screenshotCount) throw new Error("备份截图与运行记录不一致");
      for (const name of referencedScreenshots) await access(safeEntryPath(path.join(root, "extracted"), name));
      const targetCounts = tableCounts(this.context.raw);
      const summary: TransferSummary = {
        ...parsed.manifest,
        targetKeyId: keyId(this.config.stateKey),
        keyChanged: parsed.manifest.sourceKeyId !== keyId(this.config.stateKey),
        targetCounts,
        targetHasData: TABLES.some((table) => table !== "app_settings" && targetCounts[table] > 0),
      };
      const session: ImportSession = { id, root, tables: parsed.tables, manifest: parsed.manifest, summary, expiresAt: Date.now() + 30 * 60_000 };
      this.sessions.set(id, session);
      return { id, summary, expiresAt: new Date(session.expiresAt).toISOString() };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async apply(id: string, confirmed: boolean): Promise<{ ok: true; summary: TransferSummary; resumedQueued: number }> {
    if (!confirmed) throw Object.assign(new Error("必须确认覆盖目标端全部数据"), { statusCode: 400 });
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) throw Object.assign(new Error("导入会话不存在或已过期"), { statusCode: 404 });
    if (this.maintenance.active) throw Object.assign(new Error("另一项数据迁移正在进行"), { statusCode: 409 });
    const activeRun = this.context.raw.prepare("SELECT id FROM runs WHERE status = 'running' LIMIT 1").get();
    const activeLogin = this.context.raw.prepare("SELECT id FROM login_sessions WHERE status IN ('starting','ready','active','saving') LIMIT 1").get();
    if (activeRun || activeLogin) throw Object.assign(new Error("仍有正在执行的检查或登录窗口，请结束后再导入"), { statusCode: 409 });
    this.maintenance.active = true;
    const rollback = path.join(session.root, "rollback-screenshots");
    const importedScreenshots = path.join(session.root, "extracted", "screenshots");
    let oldMoved = false;
    let importedMoved = false;
    let databaseCommitted = false;
    try {
      await mkdir(path.dirname(this.config.screenshotsPath), { recursive: true });
      const oldExists = await access(this.config.screenshotsPath).then(() => true, () => false);
      if (oldExists) { await rename(this.config.screenshotsPath, rollback); oldMoved = true; }
      const importedExists = await access(importedScreenshots).then(() => true, () => false);
      if (importedExists) await rename(importedScreenshots, this.config.screenshotsPath);
      else await mkdir(this.config.screenshotsPath, { recursive: true });
      importedMoved = true;
      const tables = prepareImportedTables(session, this.config);
      const replace = this.context.raw.transaction(() => {
        this.context.raw.pragma("defer_foreign_keys = ON");
        for (const table of DELETE_ORDER) this.context.raw.prepare(`DELETE FROM ${table}`).run();
        for (const table of INSERT_ORDER) sqlInsert(this.context.raw, table, tables[table]);
      });
      replace();
      databaseCommitted = true;
      await syncRuntimeSettingsFile(await appSettings(this.context), this.config).catch(() => {});
      const resumedQueued = Number((this.context.raw.prepare("SELECT COUNT(*) AS count FROM runs WHERE status = 'queued'").get() as { count: number }).count);
      if (oldMoved) await rm(rollback, { recursive: true, force: true }).catch(() => {});
      this.sessions.delete(id);
      await rm(session.root, { recursive: true, force: true }).catch(() => {});
      return { ok: true, summary: session.summary, resumedQueued };
    } catch (error) {
      if (!databaseCommitted) {
        if (importedMoved) await rm(this.config.screenshotsPath, { recursive: true, force: true }).catch(() => {});
        if (oldMoved) await rename(rollback, this.config.screenshotsPath).catch(() => {});
      }
      throw error;
    } finally {
      this.maintenance.active = false;
    }
  }

  async release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await rm(session.root, { recursive: true, force: true });
  }

  async cleanupExpired(): Promise<void> {
    for (const session of this.sessions.values()) if (session.expiresAt <= Date.now()) await this.release(session.id);
  }
}
