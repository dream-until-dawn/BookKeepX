/**
 * 鉴权接口：注册、登录、退出、当前用户（docs/auth.md §1）
 */
import { type CurrentUser, currentUserSchema, loginRequestSchema, registerRequestSchema } from '@bookkeepx/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client.ts';
import { users } from '../../db/schema/index.ts';
import { AppError } from '../../errors.ts';
import { clearSessionCookie, setSessionCookie } from '../../plugins/auth.ts';
import { parseOrThrow } from '../../plugins/validation.ts';
import { createUserWithDefaultLedger } from '../users/service.ts';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './password.ts';
import type { AuthLimiters } from './rate-limit.ts';
import { createSession, deleteSession, SESSION_COOKIE } from './sessions.ts';

export interface AuthRouteDeps {
  db: Db;
  clock: () => Date;
  secureCookie: boolean;
  limiters: AuthLimiters;
}

/** 查询当前用户的公开信息（经契约校验，保证不会带出密码哈希等字段） */
async function loadCurrentUser(db: Db, userId: string): Promise<CurrentUser | null> {
  const [u] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      defaultLedgerId: users.defaultLedgerId,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u ? currentUserSchema.parse(u) : null;
}

/** 判断是否为"邮箱已被注册"的唯一约束冲突 */
function isEmailTaken(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === '23505' && cause.constraint_name === 'users_email_lower_uq';
}

const tooMany = () => new AppError(429, 'TOO_MANY_ATTEMPTS', '尝试次数过多，请 15 分钟后再试');

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps) {
  const { db, clock, secureCookie, limiters } = deps;
  const meta = (req: { headers: Record<string, unknown>; ip: string }) => ({
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    ip: req.ip,
  });

  app.post('/api/auth/register', async (req, reply) => {
    if (limiters.registerByIp.isBlocked(req.ip))
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', '注册过于频繁，请稍后再试');
    limiters.registerByIp.hit(req.ip);
    const body = parseOrThrow(registerRequestSchema, req.body);

    let created: Awaited<ReturnType<typeof createUserWithDefaultLedger>>;
    try {
      created = await createUserWithDefaultLedger(db, {
        email: body.email,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
      });
    } catch (err) {
      if (isEmailTaken(err)) throw new AppError(409, 'EMAIL_TAKEN', '该邮箱已注册');
      throw err;
    }

    const session = await createSession(db, created.id, meta(req), clock());
    setSessionCookie(reply, session.token, session.expiresAt, secureCookie);
    return reply.code(201).send(await loadCurrentUser(db, created.id));
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parseOrThrow(loginRequestSchema, req.body);
    if (limiters.loginFailuresByEmail.isBlocked(body.email) || limiters.loginFailuresByIp.isBlocked(req.ip))
      throw tooMany();

    const [u] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, body.email))
      .limit(1);
    // 邮箱不存在时也做一次哈希校验，让两种失败的耗时接近
    const ok = u ? await verifyPassword(u.passwordHash, body.password) : await verifyAgainstDummy(body.password);
    if (!u || !ok) {
      limiters.loginFailuresByEmail.hit(body.email);
      limiters.loginFailuresByIp.hit(req.ip);
      // 邮箱不存在与密码错误返回完全相同的错误，不透露邮箱是否注册
      throw new AppError(401, 'INVALID_CREDENTIALS', '邮箱或密码错误');
    }

    limiters.loginFailuresByEmail.reset(body.email);
    const session = await createSession(db, u.id, meta(req), clock());
    setSessionCookie(reply, session.token, session.expiresAt, secureCookie);
    return reply.send(await loadCurrentUser(db, u.id));
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    clearSessionCookie(reply, secureCookie);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => {
    const user = await loadCurrentUser(db, req.userId!);
    // 会话存在但用户已被删除：按未登录处理
    if (!user) throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    return user;
  });
}
