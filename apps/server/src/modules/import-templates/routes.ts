/** 自定义解析模板接口（docs/import.md §9.6） */
import { createUserTemplateRequestSchema, updateUserTemplateRequestSchema } from '@bookkeepx/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import { isUuid } from '../../plugins/ledger-scope.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import { MAX_FILE_BYTES } from '../imports/service.ts';
import { createTemplate, deleteTemplate, inspect, listTemplates, testTemplate, updateTemplate } from './service.ts';

const BASE = '/api/import-templates';

function idParam(params: unknown): string {
  const { id } = params as { id?: unknown };
  if (!isUuid(id)) throw new AppError(404, 'TEMPLATE_NOT_FOUND', '模板不存在');
  return id;
}

/** 读取 multipart 中的文件与文件之前的普通字段（服务端按流读取，文件之后的字段读不到） */
async function readUpload(req: FastifyRequest) {
  if (!req.isMultipart()) throw new AppError(400, 'IMPORT_NO_FILE', '请以 multipart/form-data 上传文件');
  const part = await req.file();
  if (!part) throw new AppError(400, 'IMPORT_NO_FILE', '请选择账单文件');
  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch {
    throw new AppError(413, 'IMPORT_FILE_TOO_LARGE', `文件不能超过 ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
  const field = (name: string) => {
    const f = part.fields[name] as { type?: string; value?: unknown } | undefined;
    return f?.type === 'field' && typeof f.value === 'string' && f.value !== '' ? f.value : undefined;
  };
  return { bytes, fileName: part.filename || 'unknown', field };
}

export function importTemplateRoutes(app: FastifyInstance, db: Db, clock: () => Date) {
  const auth = { preHandler: app.authenticate };

  app.get(BASE, auth, async (req) => listTemplates(db, req.userId!));

  app.post(BASE, auth, async (req, reply) => {
    const body = parseOrThrow(createUserTemplateRequestSchema, req.body);
    return reply.code(201).send(await createTemplate(db, req.userId!, body));
  });

  app.patch(`${BASE}/:id`, auth, async (req) => {
    const body = parseOrThrow(updateUserTemplateRequestSchema, req.body);
    return updateTemplate(db, req.userId!, idParam(req.params), body, clock());
  });

  app.delete(`${BASE}/:id`, auth, async (req, reply) => {
    await deleteTemplate(db, req.userId!, idParam(req.params));
    return reply.code(204).send();
  });

  app.post(`${BASE}/inspect`, auth, async (req) => inspect((await readUpload(req)).bytes));

  app.post(`${BASE}/test`, auth, async (req) => {
    const { bytes, fileName, field } = await readUpload(req);
    const templateId = field('templateId');
    if (templateId !== undefined && !isUuid(templateId)) throw new AppError(404, 'TEMPLATE_NOT_FOUND', '模板不存在');
    return testTemplate(db, req.userId!, { bytes, fileName, specJson: field('spec'), templateId });
  });
}
