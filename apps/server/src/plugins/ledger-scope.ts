/**
 * 账本内路由的统一入口：登录校验 + 账本成员与角色校验（docs/api.md "账本内接口的统一规则"）
 *
 * 用法：
 *   app.get('/api/ledgers/:ledgerId/categories', { preHandler: app.requireLedger('viewer') }, async (req) => {
 *     const scope = req.ledgerScope!;   // 已通过校验
 *   });
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { LedgerNotFoundError } from '../errors.ts';
import { type LedgerRole, type LedgerScope, requireLedgerAccess } from '../modules/ledgers/access.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** 经过 requireLedger 的路由才有值 */
    ledgerScope: LedgerScope | null;
  }
  interface FastifyInstance {
    requireLedger: (role: LedgerRole) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 路径参数中的 id 是否为合法 uuid；不合法的 id 按"不存在"处理，而不是让数据库报类型错误变成 500 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function registerLedgerScope(app: FastifyInstance, db: Db) {
  app.decorateRequest('ledgerScope', null);
  app.decorate('requireLedger', (role: LedgerRole) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    const { ledgerId } = req.params as { ledgerId?: unknown };
    if (!isUuid(ledgerId)) throw new LedgerNotFoundError();
    req.ledgerScope = await requireLedgerAccess(db, req.userId!, ledgerId, role);
  });
}
