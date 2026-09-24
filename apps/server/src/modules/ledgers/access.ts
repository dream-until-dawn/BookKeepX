/**
 * 账本访问控制：账本内一切操作的**唯一入口**（ADR-0006）
 *
 * 用法：
 *   const scope = await requireLedgerAccess(db, userId, ledgerId, 'editor');
 *   await someRepository.list(db, scope);   // 仓储函数只接受 LedgerScope，不接受裸的 ledgerId
 *
 * LedgerScope 是"带品牌"的类型，只有本文件能创建。这样在类型层面就杜绝了
 * "忘记校验权限、直接拿前端传来的 ledgerId 去查库"的写法。
 */
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { ledgerMembers } from '../../db/schema/index.ts';
import { LedgerForbiddenError, LedgerNotFoundError } from '../../errors.ts';

export type LedgerRole = 'owner' | 'editor' | 'viewer';

/** 角色等级：数字越大权限越高 */
const ROLE_LEVEL: Record<LedgerRole, number> = { viewer: 1, editor: 2, owner: 3 };
const ROLE_NAME: Record<LedgerRole, string> = { viewer: '只读', editor: '可编辑', owner: '所有者' };

declare const scopeBrand: unique symbol;

/** 已通过权限校验的账本上下文 */
export interface LedgerScope {
  readonly ledgerId: string;
  readonly userId: string;
  readonly role: LedgerRole;
  readonly [scopeBrand]: true;
}

/** 判断角色是否满足要求 */
export function roleSatisfies(actual: LedgerRole, required: LedgerRole): boolean {
  return ROLE_LEVEL[actual] >= ROLE_LEVEL[required];
}

/**
 * 校验当前用户对账本的访问权限
 * @throws LedgerNotFoundError 账本不存在或用户不是成员（统一 404，不透露账本是否存在）
 * @throws LedgerForbiddenError 是成员但角色不够
 */
export async function requireLedgerAccess(
  db: DbOrTx,
  userId: string,
  ledgerId: string,
  required: LedgerRole,
): Promise<LedgerScope> {
  const [member] = await db
    .select({ role: ledgerMembers.role })
    .from(ledgerMembers)
    .where(and(eq(ledgerMembers.ledgerId, ledgerId), eq(ledgerMembers.userId, userId)))
    .limit(1);
  if (!member) throw new LedgerNotFoundError();
  if (!roleSatisfies(member.role, required)) throw new LedgerForbiddenError(ROLE_NAME[required]);
  return { ledgerId, userId, role: member.role } as LedgerScope;
}

/**
 * 仅供创建账本的流程内部使用：刚创建的账本，创建者必然是 owner，无需再查库。
 * 不从模块导出到其他业务模块。
 */
export function ownerScopeForNewLedger(ledgerId: string, userId: string): LedgerScope {
  return { ledgerId, userId, role: 'owner' } as LedgerScope;
}
