import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from '../src/index.ts';

describe('healthResponseSchema', () => {
  it('正向：合法响应通过', () => {
    expect(healthResponseSchema.parse({ status: 'ok', database: 'up', version: '0.1.0' })).toEqual({
      status: 'ok',
      database: 'up',
      version: '0.1.0',
    });
  });

  it('反向：未知状态值被拒绝', () => {
    expect(healthResponseSchema.safeParse({ status: 'fine', database: 'up', version: '1' }).success).toBe(false);
  });

  it('反向：多出未约定字段被拒绝（严格模式，防止接口悄悄变化）', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', database: 'up', version: '1', extra: 1 }).success).toBe(
      false,
    );
  });

  it('反向：缺少字段被拒绝', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', database: 'up' }).success).toBe(false);
  });
});
