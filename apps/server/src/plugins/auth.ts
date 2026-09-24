/**
 * 登录态：从 Cookie 解析会话，得到当前用户
 *
 * 用法：需要登录的路由加上 { preHandler: app.authenticate }，之后在处理函数中用 req.userId。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.ts';
import { AppError } from '../errors.ts';
import { resolveSession, SESSION_COOKIE } from '../modules/auth/sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** 当前登录用户 id；只有经过 authenticate 的路由才有值 */
    userId: string | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  db: Db;
  clock: () => Date;
  /** 是否给 Cookie 加 Secure（生产环境 HTTPS 下为 true） */
  secureCookie: boolean;
}

/** 下发会话 Cookie（登录、注册、续期时调用） */
export function setSessionCookie(reply: FastifyReply, token: string, expires: Date, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure, expires });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/', secure });
}

export function registerAuth(app: FastifyInstance, opts: AuthPluginOptions) {
  app.decorateRequest('userId', null);
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    const session = await resolveSession(opts.db, token, opts.clock());
    if (!session) {
      // 带着无效 / 过期的 Cookie 来访问时，顺手清掉，避免浏览器反复带着它
      if (token) clearSessionCookie(reply, opts.secureCookie);
      throw new AppError(401, 'UNAUTHENTICATED', '请先登录');
    }
    if (session.renewedExpiresAt) setSessionCookie(reply, token!, session.renewedExpiresAt, opts.secureCookie);
    req.userId = session.userId;
  });
}
