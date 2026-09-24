/** 统一错误处理：404、4xx 透传信息、5xx 隐藏内部细节 */
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createDatabase } from '../src/db/client.ts';
import { LedgerForbiddenError } from '../src/errors.ts';
import { UNREACHABLE_DATABASE_URL } from './helpers.ts';

describe('错误处理', () => {
  // 这些测试不访问数据库，用一个连不上的连接即可
  const database = createDatabase(UNREACHABLE_DATABASE_URL);
  afterAll(() => database.close());

  const appWithRoutes = () => {
    const app = buildApp({ database });
    app.get('/api/_test/bad-request', async () => {
      throw Object.assign(new Error('参数 x 不合法'), { statusCode: 400 });
    });
    app.get('/api/_test/forbidden', async () => {
      throw new LedgerForbiddenError('可编辑');
    });
    app.get('/api/_test/boom', async () => {
      throw new Error('数据库密码是 secret123');
    });
    return app;
  };

  it('反向：不存在的接口 → 404，中文提示含方法与路径', async () => {
    const res = await appWithRoutes().inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('接口不存在：GET /api/nope');
  });

  it('正向：4xx 错误把信息返回给前端', async () => {
    const res = await appWithRoutes().inject({ method: 'GET', url: '/api/_test/bad-request' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: '参数 x 不合法' });
  });

  it('正向：业务错误（AppError）返回对应状态码和机器可读的错误码', async () => {
    const res = await appWithRoutes().inject({ method: 'GET', url: '/api/_test/forbidden' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: '需要"可编辑"及以上权限', code: 'LEDGER_FORBIDDEN' });
  });

  it('反向：5xx 错误不泄露内部信息', async () => {
    const res = await appWithRoutes().inject({ method: 'GET', url: '/api/_test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: '服务器内部错误' });
    expect(res.body).not.toContain('secret123');
  });
});
