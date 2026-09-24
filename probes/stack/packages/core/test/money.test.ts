import { describe, expect, it } from 'vitest';
import { formatCents, yuanToCents } from '../src/index.ts';

describe('formatCents', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [123456, '1,234.56'],
    [-9868, '-98.68'],
  ])('正向：%i → %s', (c, s) => expect(formatCents(c)).toBe(s));

  it('反向：传入浮点数必须抛错', () => {
    expect(() => formatCents(12.5)).toThrow(/安全整数/);
  });

  it('往返：元 → 分 → 元 保持一致', () => {
    for (const s of ['0.01', '1,234.56', '-98.68', '900,000,000.00']) expect(formatCents(yuanToCents(s))).toBe(s.startsWith('-') ? s : s);
  });
});

describe('yuanToCents', () => {
  it('反向：三位小数必须抛错，不静默四舍五入', () => {
    expect(() => yuanToCents('1.234')).toThrow(/格式非法/);
  });
});
