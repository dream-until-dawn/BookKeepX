/** 分类接口（docs/api.md "分类"） */
import { createCategoryRequestSchema, updateCategoryRequestSchema } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import { isUuid } from '../../plugins/ledger-scope.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import { createCategory, deleteCategory, listCategories, updateCategory } from './service.ts';

const BASE = '/api/ledgers/:ledgerId/categories';

/** 取路径中的分类 id；不是合法 uuid 时按"不存在"处理 */
function categoryIdParam(params: unknown): string {
  const { id } = params as { id?: unknown };
  if (!isUuid(id)) throw new AppError(404, 'CATEGORY_NOT_FOUND', '分类不存在');
  return id;
}

export function categoryRoutes(app: FastifyInstance, db: Db) {
  app.get(BASE, { preHandler: app.requireLedger('viewer') }, async (req) => listCategories(db, req.ledgerScope!));

  app.post(BASE, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    const body = parseOrThrow(createCategoryRequestSchema, req.body);
    return reply.code(201).send(await createCategory(db, req.ledgerScope!, body));
  });

  app.patch(`${BASE}/:id`, { preHandler: app.requireLedger('editor') }, async (req) => {
    const id = categoryIdParam(req.params);
    return updateCategory(db, req.ledgerScope!, id, parseOrThrow(updateCategoryRequestSchema, req.body));
  });

  app.delete(`${BASE}/:id`, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    await deleteCategory(db, req.ledgerScope!, categoryIdParam(req.params));
    return reply.code(204).send();
  });
}
