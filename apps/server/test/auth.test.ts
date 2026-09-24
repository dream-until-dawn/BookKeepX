/**
 * P1-3 鉴权：注册 / 登录 / 退出 / 当前用户 / 会话过期与续期 / 限流 / CSRF
 * 连接真实 PostgreSQL；时钟可控，用来验证过期、续期和限流窗口。
 */
import { CLIENT_HEADER, CLIENT_HEADER_VALUE, currentUserSchema } from '@bookkeepx/contracts';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { sessions, users } from '../src/db/schema/index.ts';
import { hashToken, RENEW_THRESHOLD_MS, SESSION_COOKIE, SESSION_TTL_MS } from '../src/modules/auth/sessions.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';

const database = useMigratedDatabase();
const DAY = 24 * 60 * 60 * 1000;

let now: Date;
let app: ReturnType<typeof buildApp>;

beforeEach(async () => {
  await truncateAll(database);
  now = new Date('2026-09-24T00:00:00Z');
  // 每个测试一个新应用：限流器等内存状态互不影响
  app = buildApp({ database, clock: () => now });
});

interface CallOptions {
  body?: unknown;
  cookie?: string | undefined;
  /** 是否带 CSRF 请求头，默认带 */
  csrf?: boolean;
  ip?: string;
}

function call(method: 'GET' | 'POST', url: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false) headers[CLIENT_HEADER] = CLIENT_HEADER_VALUE;
  return app.inject({
    method,
    url,
    headers,
    remoteAddress: opts.ip ?? '10.0.0.1',
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
    ...(opts.cookie ? { cookies: { [SESSION_COOKIE]: opts.cookie } } : {}),
  });
}

/** 取响应里下发的会话 Cookie */
const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name === SESSION_COOKIE);

const register = (email = 'alice@example.com', password = 'correct horse', displayName = '小明', ip?: string) =>
  call('POST', '/api/auth/register', { body: { email, password, displayName }, ...(ip ? { ip } : {}) });

const login = (email: string, password: string, ip?: string) =>
  call('POST', '/api/auth/login', { body: { email, password }, ...(ip ? { ip } : {}) });

describe('注册', () => {
  it('正向：201，返回当前用户（含默认账本），下发安全属性齐全的会话 Cookie', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    const user = currentUserSchema.parse(res.json());
    expect(user).toMatchObject({ email: 'alice@example.com', displayName: '小明' });
    expect(user.defaultLedgerId).toBeTruthy();
    const c = sessionCookie(res)!;
    expect(c).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('正向：数据库里存的是令牌哈希与密码哈希，而不是原文', async () => {
    const res = await register();
    const token = sessionCookie(res)!.value;
    const [s] = await database.db.select().from(sessions);
    expect(s!.tokenHash).toBe(hashToken(token));
    expect(s!.tokenHash).not.toContain(token);
    const [u] = await database.db.select().from(users);
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('反向：响应中不包含密码哈希', async () => {
    const res = await register();
    expect(res.body).not.toContain('argon2');
    expect(res.body).not.toContain('passwordHash');
  });

  it('反向：邮箱已注册（大小写不同也算）→ 409 EMAIL_TAKEN', async () => {
    await register('bob@example.com');
    const res = await register('BOB@Example.com');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('反向：参数不合法 → 400，返回中文原因', async () => {
    const res = await register('bad-email', 'correct horse');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED', error: '邮箱格式不正确' });
    expect((await register('c@d.com', 'short')).json().error).toBe('密码至少 8 个字符');
  });

  it('反向：同一 IP 1 小时内注册超过 10 次 → 429；1 小时后恢复', async () => {
    for (let i = 0; i < 10; i++)
      expect((await register(`u${i}@x.com`, 'correct horse', 'u', '10.9.9.9')).statusCode).toBe(201);
    expect((await register('u10@x.com', 'correct horse', 'u', '10.9.9.9')).statusCode).toBe(429);
    // 其他 IP 不受影响
    expect((await register('other@x.com', 'correct horse', 'u', '10.9.9.8')).statusCode).toBe(201);
    now = new Date(now.getTime() + 60 * 60 * 1000 + 1);
    expect((await register('u11@x.com', 'correct horse', 'u', '10.9.9.9')).statusCode).toBe(201);
  });
});

describe('登录', () => {
  beforeEach(async () => {
    await register('alice@example.com', 'correct horse');
  });

  it('正向：密码正确 → 200 返回用户并下发新会话；邮箱大小写不敏感', async () => {
    const res = await login('  ALICE@example.com ', 'correct horse');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'alice@example.com' });
    expect(sessionCookie(res)?.value).toBeTruthy();
  });

  it('反向：密码错误与邮箱不存在返回完全相同的 401（不透露邮箱是否注册）', async () => {
    const wrongPwd = await login('alice@example.com', 'wrong password');
    const noUser = await login('nobody@example.com', 'wrong password');
    expect(wrongPwd.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPwd.json()).toEqual(noUser.json());
    expect(wrongPwd.json()).toEqual({ error: '邮箱或密码错误', code: 'INVALID_CREDENTIALS' });
    expect(sessionCookie(wrongPwd)).toBeUndefined();
  });

  it('反向：邮箱不存在时的耗时与密码错误接近（防止通过耗时探测邮箱是否注册）', async () => {
    // 预热一次（首次会生成占位哈希）
    await login('warmup@example.com', 'wrong password');
    const time = async (email: string) => {
      const t0 = performance.now();
      for (let i = 0; i < 3; i++) await login(email, 'wrong password', `10.7.0.${i}`);
      return performance.now() - t0;
    };
    const wrongPassword = await time('alice@example.com');
    const unknownEmail = await time('nobody@example.com');
    // 若不对不存在的邮箱做哈希校验，耗时约为密码错误的 1/10；阈值取 1/3，留足波动余量
    expect(unknownEmail).toBeGreaterThan(wrongPassword / 3);
  });

  it('反向：同一邮箱 15 分钟内失败 5 次 → 之后即使密码正确也 429；窗口过后恢复', async () => {
    for (let i = 0; i < 5; i++) expect((await login('alice@example.com', 'wrong password')).statusCode).toBe(401);
    const blocked = await login('alice@example.com', 'correct horse');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    now = new Date(now.getTime() + 15 * 60 * 1000 + 1);
    expect((await login('alice@example.com', 'correct horse')).statusCode).toBe(200);
  });

  it('正向：登录成功会清零该邮箱的失败计数', async () => {
    for (let i = 0; i < 4; i++) await login('alice@example.com', 'wrong password');
    expect((await login('alice@example.com', 'correct horse')).statusCode).toBe(200);
    // 若计数未清零，这里第 5 次失败后就会被锁
    for (let i = 0; i < 4; i++) expect((await login('alice@example.com', 'wrong password')).statusCode).toBe(401);
    expect((await login('alice@example.com', 'correct horse')).statusCode).toBe(200);
  });

  it('反向：同一 IP 对不同邮箱失败 20 次（撞库）→ 该 IP 被限流', async () => {
    for (let i = 0; i < 20; i++) await login(`x${i}@example.com`, 'wrong password', '10.6.6.6');
    expect((await login('alice@example.com', 'correct horse', '10.6.6.6')).statusCode).toBe(429);
    expect((await login('alice@example.com', 'correct horse', '10.6.6.7')).statusCode).toBe(200);
  });
});

describe('当前用户与会话', () => {
  const registerAndGetToken = async () => sessionCookie(await register())!.value;

  it('正向：带会话 Cookie 访问 /me → 当前用户', async () => {
    const token = await registerAndGetToken();
    const res = await call('GET', '/api/auth/me', { cookie: token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: 'alice@example.com' });
  });

  it('反向：没有 Cookie / 格式错误的令牌 / 伪造的令牌 → 401', async () => {
    await registerAndGetToken();
    for (const cookie of [undefined, 'short', 'A'.repeat(43)]) {
      const res = await call('GET', '/api/auth/me', { cookie });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('反向：会话过期 → 401，并且过期会话从数据库删除、Cookie 被清除', async () => {
    const token = await registerAndGetToken();
    now = new Date(now.getTime() + SESSION_TTL_MS + 1);
    const res = await call('GET', '/api/auth/me', { cookie: token });
    expect(res.statusCode).toBe(401);
    expect(await database.db.select().from(sessions)).toHaveLength(0);
    expect(sessionCookie(res)?.value).toBe('');
  });

  it('正向：剩余有效期不足 15 天时访问 → 自动续期到 30 天并重新下发 Cookie', async () => {
    const token = await registerAndGetToken();
    now = new Date(now.getTime() + SESSION_TTL_MS - RENEW_THRESHOLD_MS + DAY); // 剩余 14 天
    const res = await call('GET', '/api/auth/me', { cookie: token });
    expect(res.statusCode).toBe(200);
    const [s] = await database.db
      .select()
      .from(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(s!.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
    expect(sessionCookie(res)?.value).toBe(token);
  });

  it('边界：剩余有效期还多时不续期、不重发 Cookie', async () => {
    const token = await registerAndGetToken();
    now = new Date(now.getTime() + DAY);
    const res = await call('GET', '/api/auth/me', { cookie: token });
    expect(res.statusCode).toBe(200);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('反向：用户被删除后，其会话随之失效（数据库级联删除）→ 401', async () => {
    const token = await registerAndGetToken();
    await database.db.delete(users);
    expect(await database.db.select().from(sessions)).toHaveLength(0);
    expect((await call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(401);
  });
});

describe('退出', () => {
  it('正向：退出后会话从数据库删除、Cookie 清除，再访问 /me → 401', async () => {
    const token = sessionCookie(await register())!.value;
    const res = await call('POST', '/api/auth/logout', { cookie: token });
    expect(res.statusCode).toBe(204);
    expect(sessionCookie(res)?.value).toBe('');
    expect(await database.db.select().from(sessions)).toHaveLength(0);
    expect((await call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(401);
  });

  it('正向：只退出当前设备，其他设备的会话不受影响', async () => {
    await register();
    const tokenA = sessionCookie(await login('alice@example.com', 'correct horse'))!.value;
    const tokenB = sessionCookie(await login('alice@example.com', 'correct horse'))!.value;
    await call('POST', '/api/auth/logout', { cookie: tokenA });
    expect((await call('GET', '/api/auth/me', { cookie: tokenB })).statusCode).toBe(200);
  });

  it('边界：未登录时退出也返回 204（幂等）', async () => {
    expect((await call('POST', '/api/auth/logout')).statusCode).toBe(204);
  });
});

describe('CSRF 防护', () => {
  it('反向：修改请求缺少客户端标识头 → 403 CSRF_REJECTED，且不产生任何副作用', async () => {
    const res = await call('POST', '/api/auth/register', {
      body: { email: 'csrf@example.com', password: 'correct horse', displayName: 'x' },
      csrf: false,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    expect(await database.db.select().from(users)).toHaveLength(0);
  });

  it('反向：退出请求缺少标识头也被拒绝（防止被其他网站强制退出）', async () => {
    const token = sessionCookie(await register())!.value;
    expect((await call('POST', '/api/auth/logout', { cookie: token, csrf: false })).statusCode).toBe(403);
    expect((await call('GET', '/api/auth/me', { cookie: token })).statusCode).toBe(200);
  });

  it('正向：只读请求（GET）不需要标识头', async () => {
    expect((await call('GET', '/api/health', { csrf: false })).statusCode).not.toBe(403);
  });
});
