/**
 * 用户服务：创建用户（含默认账本）
 *
 * 密码哈希、注册接口、会话在 P1-3 实现；这里只负责数据层面的"用户 + 默认账本"一次性创建。
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { users } from '../../db/schema/index.ts';
import { createLedger } from '../ledgers/service.ts';

export interface CreateUserInput {
  email: string;
  /** 已经哈希过的密码（argon2id） */
  passwordHash: string;
  displayName: string;
  timezone?: string;
}

export interface CreatedUser {
  id: string;
  email: string;
  defaultLedgerId: string;
}

/** 邮箱规范化：去首尾空白、转小写（数据库也有"必须小写"的约束兜底） */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 创建用户，并在同一事务中创建默认账本（写入预置分类）
 * @throws 邮箱已存在时数据库唯一约束报错（由 P1-3 的注册接口转成友好提示）
 */
export async function createUserWithDefaultLedger(db: Db, input: CreateUserInput): Promise<CreatedUser> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        displayName: input.displayName,
        timezone: input.timezone ?? 'Asia/Shanghai',
      })
      .returning({ id: users.id, email: users.email });
    const scope = await createLedger(tx, { ownerId: user!.id, name: '我的账本', timezone: input.timezone });
    await tx.update(users).set({ defaultLedgerId: scope.ledgerId }).where(eq(users.id, user!.id));
    return { id: user!.id, email: user!.email, defaultLedgerId: scope.ledgerId };
  });
}
