/**
 * Fastify 应用（P0-4：验证服务端能引用 @bookkeepx/core，并串起 路由 → 服务 → 数据库）
 *
 * 探针只做两个接口；鉴权、会话等在 P1 实现。
 */
import Fastify from 'fastify';
import { formatCents, yuanToCents } from '@bookkeepx/core';
import { transactions } from './db/schema.ts';
import type { Db } from './db/client.ts';
import { monthlyStats } from './stats.ts';

export function buildApp(db: Db) {
  const app = Fastify({ logger: false });

  /** 记一笔：金额以"元"字符串传入，由共享的 core 包转成分 */
  app.post<{ Body: { userId: string; direction: 'income' | 'expense' | 'neutral'; amount: string; occurredAt: string } }>('/transactions', async (req, reply) => {
    const { userId, direction, amount, occurredAt } = req.body;
    let cents: number;
    try {
      cents = yuanToCents(amount);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    if (cents <= 0) return reply.code(400).send({ error: '金额必须大于 0' });
    const [row] = await db.insert(transactions).values({ userId, direction, amountCents: cents, occurredAt: new Date(occurredAt) }).returning();
    return reply.code(201).send({ id: row!.id, amount: formatCents(row!.amountCents) });
  });

  /** 月度统计，金额用 core 的 formatCents 格式化 */
  app.get<{ Querystring: { userId: string } }>('/stats/monthly', async (req) => {
    const rows = await monthlyStats(db, req.query.userId);
    return rows.map((r) => ({ month: r.month, income: formatCents(r.incomeCents), expense: formatCents(r.expenseCents) }));
  });

  return app;
}
