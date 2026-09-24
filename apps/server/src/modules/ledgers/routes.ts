/** 账本信息：GET /api/ledgers/:ledgerId */
import { ledgerSchema } from '@bookkeepx/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { ledgers } from '../../db/schema/index.ts';

export function ledgerRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/ledgers/:ledgerId', { preHandler: app.requireLedger('viewer') }, async (req) => {
    const scope = req.ledgerScope!;
    const [l] = await db
      .select({ id: ledgers.id, name: ledgers.name, currency: ledgers.currency, timezone: ledgers.timezone })
      .from(ledgers)
      .where(eq(ledgers.id, scope.ledgerId));
    return ledgerSchema.parse({ ...l, role: scope.role });
  });
}
