/** 反向代理信任边界：只信任受控的最近一跳，不接受任意客户端地址链。 */
import { afterAll, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { testDatabase } from './helpers.ts';

const database = testDatabase();
afterAll(() => database.close());
it('默认忽略伪造的转发头', async () => {
  const app = buildApp({ database });
  app.get('/test-ip', (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({
      url: '/test-ip',
      remoteAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '203.0.113.99' },
    });
    expect(response.json().ip).toBe('10.0.0.10');
  } finally {
    await app.close();
  }
});
it('一跳代理只使用最近地址，忽略伪造的更远一跳', async () => {
  const app = buildApp({ database, trustProxyHops: 1 });
  app.get('/test-ip', (request) => ({ ip: request.ip }));
  try {
    const response = await app.inject({
      url: '/test-ip',
      remoteAddress: '10.0.0.10',
      headers: { 'x-forwarded-for': '203.0.113.99, 192.0.2.20' },
    });
    expect(response.json().ip).toBe('192.0.2.20');
  } finally {
    await app.close();
  }
});
