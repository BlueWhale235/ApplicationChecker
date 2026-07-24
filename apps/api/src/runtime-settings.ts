import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Selectable } from "kysely";
import { OpenAiCompatibleRecognizer } from "@application-checker/ai-status";
import type { AiSettingsUpdate } from "@application-checker/contracts";
import type { Config } from "./config.js";
import type { AppSettingsTable, DbContext } from "./db.js";
import { appSettings } from "./service.js";

interface EncryptedSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function encryptSecret(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  } satisfies EncryptedSecret);
}

function decryptSecret(value: string | null, key: Buffer): string | null {
  if (!value) return null;
  const payload = JSON.parse(value) as EncryptedSecret;
  if (payload.version !== 1) throw new Error("Unsupported encrypted settings version");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

type RuntimeSettingsRow = Selectable<AppSettingsTable>;

export async function syncRuntimeSettingsFile(settings: RuntimeSettingsRow, config: Config): Promise<void> {
  const output = {
    version: 1,
    updatedAt: settings.updated_at,
    browser: { defaultUserAgent: settings.default_user_agent },
    ai: {
      baseUrl: settings.ai_base_url,
      model: settings.ai_model,
      apiKeyEncrypted: settings.ai_api_key_encrypted,
      confidenceThreshold: settings.ai_confidence_threshold,
      configured: Boolean(settings.ai_base_url && settings.ai_model && settings.ai_api_key_encrypted),
    },
  };
  await mkdir(path.dirname(config.runtimeSettingsPath), { recursive: true });
  const temporary = `${config.runtimeSettingsPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, config.runtimeSettingsPath);
}

export async function initializeRuntimeSettings(context: DbContext, config: Config): Promise<void> {
  const current = await appSettings(context);
  const seeded = {
    ...(current.ai_base_url ? {} : config.aiBaseUrl ? { ai_base_url: config.aiBaseUrl } : {}),
    ...(current.ai_model ? {} : config.aiModel ? { ai_model: config.aiModel } : {}),
    ...(current.ai_api_key_encrypted ? {} : config.aiApiKey ? { ai_api_key_encrypted: encryptSecret(config.aiApiKey, config.stateKey) } : {}),
    ai_confidence_threshold: current.ai_confidence_threshold ?? config.aiConfidenceThreshold,
  };
  if (Object.keys(seeded).length) {
    await context.db.updateTable("app_settings").set(seeded).where("id", "=", 1).execute();
  }
  await syncRuntimeSettingsFile(await appSettings(context), config);
}

export async function updateAiSettings(
  context: DbContext,
  config: Config,
  body: AiSettingsUpdate,
): Promise<RuntimeSettingsRow> {
  const current = await appSettings(context);
  const encrypted = body.apiKey === undefined
    ? current.ai_api_key_encrypted
    : body.apiKey === null
      ? null
      : encryptSecret(body.apiKey, config.stateKey);
  await context.db.updateTable("app_settings").set({
    ai_base_url: body.baseUrl?.trim().replace(/\/$/, "") || null,
    ai_model: body.model?.trim() || null,
    ai_api_key_encrypted: encrypted,
    ai_confidence_threshold: body.confidenceThreshold,
    updated_at: new Date().toISOString(),
  }).where("id", "=", 1).execute();
  const settings = await appSettings(context);
  await syncRuntimeSettingsFile(settings, config);
  return settings;
}

export function recognizerFromSettings(settings: RuntimeSettingsRow, config: Config): OpenAiCompatibleRecognizer {
  const apiKey = decryptSecret(settings.ai_api_key_encrypted, config.stateKey);
  return new OpenAiCompatibleRecognizer({
    ...(settings.ai_base_url ? { baseUrl: settings.ai_base_url } : {}),
    ...(settings.ai_model ? { model: settings.ai_model } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
}
