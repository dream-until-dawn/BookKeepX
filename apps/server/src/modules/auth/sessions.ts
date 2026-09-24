/**
 * 会话（docs/auth.md §3）
 *
 * - 令牌：32 字节随机数（base64url，43 个字符），只交给浏览器的 HttpOnly Cookie
 * - 数据库只存令牌的 SHA-256，数据库泄露也无法冒充登录
 * - 滑动过期：有效期 30 天，剩余不足 15 天时自动续到 30 天
 */
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { sessions } from '../../db/schema/index.ts';

export const SESSION_COOKIE = 'bkx_session';
const DAY = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY;
/** 剩余有效期低于该值时续期 */
export const RENEW_THRESHOLD_MS = 15 * DAY;
/** last_seen_at 最多每 5 分钟更新一次，避免每个请求都写库 */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionMeta {
  userAgent?: string | undefined;
  ip?: string | undefined;
}

/** 创建会话，返回令牌原文（只此一次，之后服务端只保存哈希） */
export async function createSession(db: DbOrTx, userId: string, meta: SessionMeta, now: Date) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    lastSeenAt: now,
    userAgent: meta.userAgent?.slice(0, 512),
    ip: meta.ip,
  });
  return { token, expiresAt };
}

export interface ResolvedSession {
  userId: string;
  /** 若本次发生了续期，返回新的过期时间（调用方需重新下发 Cookie） */
  renewedExpiresAt: Date | null;
}

/**
 * 根据令牌找到会话
 * @returns 令牌无效、会话不存在或已过期时返回 null；已过期的会话顺带删除
 */
export async function resolveSession(
  db: DbOrTx,
  token: string | undefined,
  now: Date,
): Promise<ResolvedSession | null> {
  // 格式不对的令牌不查库，直接视为未登录
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const tokenHash = hashToken(token);
  const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).limit(1);
  if (!s) return null;
  if (s.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, s.id));
    return null;
  }

  const needRenew = s.expiresAt.getTime() - now.getTime() < RENEW_THRESHOLD_MS;
  const needTouch = now.getTime() - s.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS;
  if (!needRenew && !needTouch) return { userId: s.userId, renewedExpiresAt: null };

  const renewedExpiresAt = needRenew ? new Date(now.getTime() + SESSION_TTL_MS) : null;
  await db
    .update(sessions)
    .set({ lastSeenAt: now, ...(renewedExpiresAt ? { expiresAt: renewedExpiresAt } : {}) })
    .where(eq(sessions.id, s.id));
  return { userId: s.userId, renewedExpiresAt };
}

/** 删除会话（退出登录）；令牌无效时什么也不做 */
export async function deleteSession(db: DbOrTx, token: string | undefined): Promise<void> {
  if (!token || !TOKEN_PATTERN.test(token)) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}
