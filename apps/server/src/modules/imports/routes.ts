/** 账单导入接口（docs/import.md §3） */
import { commitRequestSchema } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import { isUuid } from '../../plugins/ledger-scope.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import {
  commitBatch,
  discardBatch,
  getBatch,
  listBatches,
  MAX_FILE_BYTES,
  revertBatch,
  uploadBill,
} from './service.ts';

const BASE = '/api/ledgers/:ledgerId/imports';

function batchIdParam(params: unknown): string {
  const { batchId } = params as { batchId?: unknown };
  if (!isUuid(batchId)) throw new AppError(404, 'IMPORT_NOT_FOUND', '导入记录不存在');
  return batchId;
}

/** multipart 表单中的普通字段取值 */
function fieldValue(fields: Record<string, unknown>, name: string): string | undefined {
  const f = fields[name] as { type?: string; value?: unknown } | undefined;
  return f?.type === 'field' && typeof f.value === 'string' && f.value !== '' ? f.value : undefined;
}

export function importRoutes(app: FastifyInstance, db: Db, clock: () => Date) {
  app.post(BASE, { preHandler: app.requireLedger('editor') }, async (req) => {
    if (!req.isMultipart()) throw new AppError(400, 'IMPORT_NO_FILE', '请以 multipart/form-data 上传文件');
    const part = await req.file();
    if (!part) throw new AppError(400, 'IMPORT_NO_FILE', '请选择要导入的账单文件');
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch {
      throw new AppError(413, 'IMPORT_FILE_TOO_LARGE', `文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    }
    const accountId = fieldValue(part.fields, 'accountId');
    if (accountId !== undefined && !isUuid(accountId)) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
    return uploadBill(db, req.ledgerScope!, {
      bytes,
      fileName: part.filename || 'unknown',
      now: clock(),
      templateId: fieldValue(part.fields, 'templateId'),
      accountId,
    });
  });

  app.get(BASE, { preHandler: app.requireLedger('viewer') }, async (req) => listBatches(db, req.ledgerScope!));

  app.get(`${BASE}/:batchId`, { preHandler: app.requireLedger('viewer') }, async (req) =>
    getBatch(db, req.ledgerScope!, batchIdParam(req.params)),
  );

  app.post(`${BASE}/:batchId/commit`, { preHandler: app.requireLedger('editor') }, async (req) => {
    const id = batchIdParam(req.params);
    const body = parseOrThrow(commitRequestSchema, req.body ?? {});
    return commitBatch(db, req.ledgerScope!, id, body, clock());
  });

  app.post(`${BASE}/:batchId/revert`, { preHandler: app.requireLedger('editor') }, async (req) =>
    revertBatch(db, req.ledgerScope!, batchIdParam(req.params), clock()),
  );

  app.delete(`${BASE}/:batchId`, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    await discardBatch(db, req.ledgerScope!, batchIdParam(req.params), clock());
    return reply.code(204).send();
  });
}
