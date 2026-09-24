/** 资金账户接口（docs/api.md "资金账户"） */
import { createAccountRequestSchema, updateAccountRequestSchema } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import { isUuid } from '../../plugins/ledger-scope.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import { createAccount, deleteAccount, listAccounts, updateAccount } from './service.ts';

const BASE = '/api/ledgers/:ledgerId/accounts';

function accountIdParam(params: unknown): string {
  const { id } = params as { id?: unknown };
  if (!isUuid(id)) throw new AppError(404, 'ACCOUNT_NOT_FOUND', '账户不存在');
  return id;
}

export function accountRoutes(app: FastifyInstance, db: Db) {
  app.get(BASE, { preHandler: app.requireLedger('viewer') }, async (req) => listAccounts(db, req.ledgerScope!));

  app.post(BASE, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    const body = parseOrThrow(createAccountRequestSchema, req.body);
    return reply.code(201).send(await createAccount(db, req.ledgerScope!, body));
  });

  app.patch(`${BASE}/:id`, { preHandler: app.requireLedger('editor') }, async (req) => {
    const id = accountIdParam(req.params);
    return updateAccount(db, req.ledgerScope!, id, parseOrThrow(updateAccountRequestSchema, req.body));
  });

  app.delete(`${BASE}/:id`, { preHandler: app.requireLedger('editor') }, async (req, reply) => {
    await deleteAccount(db, req.ledgerScope!, accountIdParam(req.params));
    return reply.code(204).send();
  });
}
