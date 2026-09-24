/** 流水接口（docs/api.md "流水"） */
import {
  createTransactionRequestSchema,
  transactionQuerySchema,
  updateTransactionRequestSchema,
} from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import { isUuid } from '../../plugins/ledger-scope.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  restoreTransaction,
  updateTransaction,
} from './service.ts';

const BASE = '/api/ledgers/:ledgerId/transactions';

function idParam(params: unknown): string {
  const { id } = params as { id?: unknown };
  if (!isUuid(id)) throw new AppError(404, 'TRANSACTION_NOT_FOUND', '流水不存在');
  return id;
}

export function transactionRoutes(app: FastifyInstance, db: Db) {
  app.get(BASE, { preHandler: app.requireLedger('viewer') }, async (req) =>
    listTransactions(db, req.ledgerScope!, parseOrThrow(transactionQuerySchema, req.query)),
  );

  app.get(`${BASE}/:id`, { preHandler: app.requireLedger('viewer') }, async (req) =>
    getTransaction(db, req.ledgerScope!, idParam(req.params)),
  );

  app.post(BASE, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    const body = parseOrThrow(createTransactionRequestSchema, req.body);
    return reply.code(201).send(await createTransaction(db, req.ledgerScope!, body));
  });

  app.patch(`${BASE}/:id`, { preHandler: app.requireLedger('editor') }, async (req) => {
    const id = idParam(req.params);
    return updateTransaction(db, req.ledgerScope!, id, parseOrThrow(updateTransactionRequestSchema, req.body));
  });

  app.delete(`${BASE}/:id`, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    await deleteTransaction(db, req.ledgerScope!, idParam(req.params));
    return reply.code(204).send();
  });

  app.post(`${BASE}/:id/restore`, { preHandler: app.requireLedger('editor') }, async (req) =>
    restoreTransaction(db, req.ledgerScope!, idParam(req.params)),
  );
}
