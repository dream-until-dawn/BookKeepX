/**
 * 健康检查：GET /api/health
 *
 * 数据库可用 → 200 { status: 'ok' }；不可用 → 503 { status: 'degraded' }。
 * 响应经契约 schema 校验后再返回，保证与前端约定一致。
 */
import { type HealthResponse, healthResponseSchema } from '@bookkeepx/contracts';
import type { FastifyInstance } from 'fastify';
import pkg from '../../../package.json' with { type: 'json' };
import { type Database, pingDatabase } from '../../db/client.ts';

export function healthRoutes(app: FastifyInstance, deps: { database: Database }) {
  app.get('/api/health', async (_req, reply) => {
    const up = await pingDatabase(deps.database);
    const body: HealthResponse = healthResponseSchema.parse({
      status: up ? 'ok' : 'degraded',
      database: up ? 'up' : 'down',
      version: pkg.version,
    });
    return reply.code(up ? 200 : 503).send(body);
  });
}
