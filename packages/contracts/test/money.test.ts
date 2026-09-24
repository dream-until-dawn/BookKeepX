import { describe, expect, it } from 'vitest';
import { centsSchema, positiveCentsSchema, yuanInputSchema } from '../src/index.ts';

describe('centsSchema / positiveCentsSchema', () => {
  it('正向：整数分通过', () => {
    expect(centsSchema.parse(-500)).toBe(-500);
    expect(positiveCentsSchema.parse(1)).toBe(1);
  });

  it('反向：误传的"元"（小数）被拒绝', () => {
    expect(centsSchema.safeParse(12.5).success).toBe(false);
  });

  it('反向：超出安全整数被拒绝', () => {
    expect(centsSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it('反向：流水金额为 0 或负数被拒绝', () => {
    expect(positiveCentsSchema.safeParse(0).success).toBe(false);
    expect(positiveCentsSchema.safeParse(-1).success).toBe(false);
  });
});

describe('yuanInputSchema', () => {
  it('正向：表单输入的元字符串转换为分', () => {
    expect(yuanInputSchema.parse('¥1,234.5')).toBe(123450);
  });

  it('反向：非法输入给出 core 的中文错误信息', () => {
    const r = yuanInputSchema.safeParse('1.234');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/最多两位小数/);
  });

  it('反向：非字符串被拒绝', () => {
    expect(yuanInputSchema.safeParse(12).success).toBe(false);
  });
});
