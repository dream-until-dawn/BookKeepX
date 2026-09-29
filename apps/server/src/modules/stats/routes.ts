/** 统计接口，所有账本成员（包括 viewer）可读。 */
import { statsQuerySchema } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import { getStats } from './service.ts';
/** 注册只读统计路由。 */
export function statsRoutes(app: FastifyInstance, db: Db) {
  app.get('/api/ledgers/:ledgerId/stats', { preHandler: app.requireLedger('viewer') }, (req) =>
    getStats(db, req.ledgerScope!, parseOrThrow(statsQuerySchema, req.query)),
  );
}
