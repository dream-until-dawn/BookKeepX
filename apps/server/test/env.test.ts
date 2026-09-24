/** 环境变量校验 */
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

describe('loadEnv', () => {
  it('正向：只给 DATABASE_URL 时其余取默认值', () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' })).toEqual({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      PORT: 3000,
      HOST: '0.0.0.0',
      NODE_ENV: 'development',
    });
  });

  it('正向：PORT 字符串被转换为数字', () => {
    expect(loadEnv({ DATABASE_URL: 'postgres://h/db', PORT: '8080' }).PORT).toBe(8080);
  });

  it('反向：缺少 DATABASE_URL → 报错并指出字段', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('反向：端口越界、NODE_ENV 非法 → 一次列出全部问题', () => {
    const run = () => loadEnv({ DATABASE_URL: 'postgres://h/db', PORT: '70000', NODE_ENV: 'staging' });
    expect(run).toThrow(/PORT/);
    expect(run).toThrow(/NODE_ENV/);
  });
});
