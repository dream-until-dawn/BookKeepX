import { describe, expect, it } from 'vitest';
import {
  createAccountRequestSchema,
  createCategoryRequestSchema,
  updateAccountRequestSchema,
  updateCategoryRequestSchema,
} from '../src/index.ts';

describe('分类请求', () => {
  it('正向：名称去首尾空白', () => {
    expect(createCategoryRequestSchema.parse({ group: 'expense', name: ' 宠物 ' })).toEqual({
      group: 'expense',
      name: '宠物',
    });
  });

  it.each([
    [{ group: 'expense', name: '  ' }, '请填写分类名称'],
    [{ group: 'expense', name: '字'.repeat(21) }, '分类名称最多 20 个字符'],
  ])('反向：%j → %s', (input, msg) => {
    expect(createCategoryRequestSchema.safeParse(input).error?.issues[0]?.message).toBe(msg);
  });

  it('反向：非法组、非法父 id、多余字段（如 ledgerId）被拒绝', () => {
    expect(createCategoryRequestSchema.safeParse({ group: 'transfer', name: 'a' }).success).toBe(false);
    expect(createCategoryRequestSchema.safeParse({ group: 'expense', name: 'a', parentId: 'x' }).success).toBe(false);
    expect(createCategoryRequestSchema.safeParse({ group: 'expense', name: 'a', ledgerId: 'x' }).success).toBe(false);
  });

  it('反向：修改请求不能为空，也不能修改组和父分类', () => {
    expect(updateCategoryRequestSchema.safeParse({}).success).toBe(false);
    expect(updateCategoryRequestSchema.safeParse({ group: 'income' }).success).toBe(false);
    expect(updateCategoryRequestSchema.safeParse({ parentId: null }).success).toBe(false);
  });
});

describe('账户请求', () => {
  it('正向：卡号后四位为空字符串时视为不填', () => {
    expect(createAccountRequestSchema.parse({ name: '招行', kind: 'bank_debit', cardLast4: '' })).toMatchObject({
      cardLast4: null,
    });
  });

  it('正向：合法卡号后四位保留', () => {
    expect(createAccountRequestSchema.parse({ name: '招行', kind: 'bank_debit', cardLast4: ' 1032 ' }).cardLast4).toBe(
      '1032',
    );
  });

  it.each(['103', '10321', 'abcd', '10 2'])('反向：卡号后四位 %j 被拒绝', (v) => {
    const r = createAccountRequestSchema.safeParse({ name: '招行', kind: 'bank_debit', cardLast4: v });
    expect(r.error?.issues[0]?.message).toBe('卡号后四位必须是 4 位数字');
  });

  it('反向：非法账户类型、空修改被拒绝', () => {
    expect(createAccountRequestSchema.safeParse({ name: 'a', kind: 'paypal' }).success).toBe(false);
    expect(updateAccountRequestSchema.safeParse({}).success).toBe(false);
  });
});
