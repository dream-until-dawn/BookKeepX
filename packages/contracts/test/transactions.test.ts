import { describe, expect, it } from 'vitest';
import {
  createTransactionRequestSchema,
  transactionQuerySchema,
  updateTransactionRequestSchema,
} from '../src/index.ts';

const base = { direction: 'expense', amount: '32.5', occurredAt: '2026-09-24T12:30:00+08:00' };

describe('createTransactionRequestSchema', () => {
  it('正向：金额元字符串转为分；对方、备注去首尾空白', () => {
    expect(createTransactionRequestSchema.parse({ ...base, counterparty: ' 麦当劳 ', note: ' 午饭 ' })).toEqual({
      ...base,
      amount: 3250,
      counterparty: '麦当劳',
      note: '午饭',
    });
  });

  it.each([
    [{ amount: '0' }, '金额必须大于 0'],
    [{ amount: '-5' }, '金额必须大于 0'],
    [{ amount: '1.234' }, '金额最多两位小数'],
    [{ occurredAt: '2026-09-24T12:30:00' }, '时间必须是带时区的 ISO 格式'],
    [{ occurredAt: '2026-09-24' }, '时间必须是带时区的 ISO 格式'],
    [{ note: 'x'.repeat(501) }, '备注最多 500 个字符'],
  ])('反向：%j → %s', (over, message) => {
    const r = createTransactionRequestSchema.safeParse({ ...base, ...over });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message).join('|')).toContain(message);
  });

  it('反向：试图指定来源、账本等服务端字段被拒绝', () => {
    expect(createTransactionRequestSchema.safeParse({ ...base, source: 'import' }).success).toBe(false);
    expect(createTransactionRequestSchema.safeParse({ ...base, ledgerId: 'x' }).success).toBe(false);
  });
});

describe('updateTransactionRequestSchema', () => {
  it('正向：可以只改备注；分类可以置空（改为未分类）', () => {
    expect(updateTransactionRequestSchema.parse({ note: '改' })).toEqual({ note: '改' });
    expect(updateTransactionRequestSchema.parse({ categoryId: null })).toEqual({ categoryId: null });
  });

  it('反向：空修改被拒绝', () => {
    expect(updateTransactionRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('transactionQuerySchema', () => {
  it('正向：默认第 1 页、每页 50；页码字符串被转为数字', () => {
    expect(transactionQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(transactionQuerySchema.parse({ month: '2026-09', page: '3' })).toMatchObject({ month: '2026-09', page: 3 });
  });

  it.each([
    [{ month: '2026-13' }],
    [{ month: '2026-9' }],
    [{ pageSize: '101' }],
    [{ page: '0' }],
    [{ month: '2026-09', from: '2026-09-01' }],
    [{ from: '2026-09-30', to: '2026-09-01' }],
    [{ unknown: '1' }],
  ])('反向：%j 被拒绝', (q) => {
    expect(transactionQuerySchema.safeParse(q).success).toBe(false);
  });
});
