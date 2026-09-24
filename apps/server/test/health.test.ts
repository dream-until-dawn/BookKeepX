/** 健康检查：数据库可用 / 不可用两种情况 */
import { healthResponseSchema } from '@bookkeepx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createDatabase } from '../src/db/client.ts';
import { testDatabase, UNREACHABLE_DATABASE_URL } from './helpers.ts';

describe('GET /api/health', () => {
  const up = testDatabase();
  const down = createDatabase(UNREACHABLE_DATABASE_URL);
  afterAll(async () => {
    await up.close();
    await down.close();
  });

  it('正向：数据库可用 → 200，status=ok，响应符合契约', async () => {
    const res = await buildApp({ database: up }).inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = healthResponseSchema.parse(res.json());
    expect(body).toMatchObject({ status: 'ok', database: 'up' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('反向：数据库不可用 → 503，status=degraded，服务本身不崩溃', async () => {
    const res = await buildApp({ database: down }).inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(healthResponseSchema.parse(res.json())).toMatchObject({ status: 'degraded', database: 'down' });
  });
});
