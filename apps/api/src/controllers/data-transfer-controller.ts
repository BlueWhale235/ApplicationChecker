import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { RouteDeps } from "./shared.js";
import { createReadStream, httpError, randomUUID } from "./shared.js";

export async function registerDataTransferController(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const service = deps.dataTransfer;
  if (!service) return;

  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  }

  app.post("/data-transfer/export", async (request, reply) => {
    const body = request.body as { password?: string; passwordConfirmation?: string };
    if (!body.password || body.password !== body.passwordConfirmation) throw httpError(400, "两次输入的迁移密码不一致");
    const result = await service.export(body.password);
    reply.header("content-type", "application/vnd.application-checker.backup");
    reply.header("content-disposition", `attachment; filename="${result.downloadName}"`);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void rm(path.dirname(result.filename), { recursive: true, force: true });
    };
    reply.raw.once("finish", cleanup);
    reply.raw.once("close", cleanup);
    return reply.send(createReadStream(result.filename));
  });

  app.post("/data-transfer/imports", async (request) => {
    const uploadRoot = path.join(deps.config.tempPath, "data-transfer", `upload-${randomUUID()}`);
    const uploadPath = path.join(uploadRoot, "incoming.acbackup");
    await mkdir(uploadRoot, { recursive: true });
    let password = "";
    let receivedFile = false;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (receivedFile) throw httpError(400, "一次只能导入一个备份文件");
          receivedFile = true;
          await pipeline(part.file, createWriteStream(uploadPath, { mode: 0o600 }));
          if (part.file.truncated) throw httpError(413, "备份文件超过上传大小限制");
        } else if (part.fieldname === "password") {
          password = String(part.value ?? "");
        }
      }
      if (!receivedFile) throw httpError(400, "请选择 .acbackup 备份文件");
      if (!password) throw httpError(400, "请输入迁移密码");
      const result = await service.inspect(uploadPath, password);
      await rm(uploadRoot, { recursive: true, force: true });
      return result;
    } catch (error) {
      await rm(uploadRoot, { recursive: true, force: true });
      if (error instanceof Error && !("statusCode" in error)) Object.assign(error, { statusCode: 400 });
      throw error;
    }
  });

  app.post("/data-transfer/imports/preflight", async (request) => {
    const body = request.body as { filename?: string; size?: number; headerBase64?: string };
    if (!body || typeof body.filename !== "string" || body.filename.length > 512) throw httpError(400, "备份文件名无效");
    if (typeof body.headerBase64 !== "string" || body.headerBase64.length > 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.headerBase64)) {
      throw httpError(400, "备份文件头无效");
    }
    return service.startUpload({
      filename: body.filename,
      size: Number(body.size),
      header: Buffer.from(body.headerBase64, "base64"),
    });
  });

  app.put("/data-transfer/imports/:id/chunks/:index", async (request) => {
    const params = request.params as { id: string; index: string };
    const query = request.query as { offset?: string };
    const index = Number(params.index);
    const offset = Number(query.offset);
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset < 0) {
      throw httpError(400, "备份分片参数无效");
    }
    return service.appendUploadChunk(params.id, index, offset, request.body as Readable);
  });

  app.post("/data-transfer/imports/:id/complete", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { password?: string };
    return service.completeUpload(id, String(body?.password ?? ""));
  });

  app.post("/data-transfer/imports/:id/apply", async (request) => {
    const id = (request.params as { id: string }).id;
    const body = request.body as { confirmReplace?: boolean };
    return service.apply(id, body.confirmReplace === true);
  });

  app.delete("/data-transfer/imports/:id", async (request, reply) => {
    await service.release((request.params as { id: string }).id);
    return reply.code(204).send();
  });
}
