import { describe, expect, it } from 'vitest';
import { currentUserSchema, loginRequestSchema, registerRequestSchema } from '../src/index.ts';

describe('registerRequestSchema', () => {
  it('正向：邮箱去空白并转小写，昵称去空白', () => {
    expect(
      registerRequestSchema.parse({ email: '  Alice@Example.COM ', password: 'correct horse', displayName: ' 小明 ' }),
    ).toEqual({
      email: 'alice@example.com',
      password: 'correct horse',
      displayName: '小明',
    });
  });

  it.each([
    [{ email: 'not-an-email', password: 'abcdefgh', displayName: 'a' }, '邮箱格式不正确'],
    [{ email: 'a@b.com', password: 'short', displayName: 'a' }, '密码至少 8 个字符'],
    [{ email: 'a@b.com', password: '          ', displayName: 'a' }, '密码不能全是空白'],
    [{ email: 'a@b.com', password: 'x'.repeat(129), displayName: 'a' }, '密码最多 128 个字符'],
    [{ email: 'a@b.com', password: 'abcdefgh', displayName: '   ' }, '请填写昵称'],
    [{ email: 'a@b.com', password: 'abcdefgh', displayName: '字'.repeat(31) }, '昵称最多 30 个字符'],
  ])('反向：%j → %s', (input, message) => {
    const r = registerRequestSchema.safeParse(input);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(message);
  });

  it('反向：多余字段（如试图指定 role）被拒绝', () => {
    expect(
      registerRequestSchema.safeParse({ email: 'a@b.com', password: 'abcdefgh', displayName: 'a', role: 'admin' })
        .success,
    ).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('正向：登录不套用注册的密码规则（旧的短密码仍能提交）', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(true);
  });

  it('反向：空密码被拒绝', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.com', password: '' }).success).toBe(false);
  });
});

describe('currentUserSchema', () => {
  const user = {
    id: '0b3f5a1e-6c2d-4f7a-9b8e-1c2d3e4f5a6b',
    email: 'a@b.com',
    displayName: 'a',
    defaultLedgerId: null,
  };

  it('正向：合法用户对象通过', () => {
    expect(currentUserSchema.parse(user)).toEqual(user);
  });

  it('反向：带出密码哈希等额外字段 → 拒绝（防止接口泄露内部字段）', () => {
    expect(currentUserSchema.safeParse({ ...user, passwordHash: '$argon2id$...' }).success).toBe(false);
  });
});
