/**
 * 账本服务：创建账本并写入预置分类
 */
import { flattenPreset, PRESET_VERSION } from '@bookkeepx/core';
import type { DbOrTx } from '../../db/client.ts';
import { categories, ledgerMembers, ledgers } from '../../db/schema/index.ts';
import { type LedgerScope, ownerScopeForNewLedger } from './access.ts';

/**
 * 把系统预置分类树写入账本（父分类先写，子分类通过父分类的键找到父 id）
 * @returns 写入的分类数量
 */
export async function seedPresetCategories(db: DbOrTx, scope: LedgerScope): Promise<number> {
  const flat = flattenPreset();
  const idByKey = new Map<string, string>();
  // 按层级分两批插入：一级分类一次插完，再插子分类
  for (const level of [0, 1] as const) {
    const rows = flat.filter((c) => (level === 0 ? c.parentKey === null : c.parentKey !== null));
    if (rows.length === 0) continue;
    const inserted = await db
      .insert(categories)
      .values(
        rows.map((c) => ({
          ledgerId: scope.ledgerId,
          parentId: c.parentKey ? idByKey.get(c.parentKey)! : null,
          group: c.group,
          name: c.name,
          presetKey: c.key,
          sort: c.sort,
        })),
      )
      .returning({ id: categories.id, presetKey: categories.presetKey });
    for (const r of inserted) idByKey.set(r.presetKey!, r.id);
  }
  return flat.length;
}

export interface CreateLedgerInput {
  ownerId: string;
  name: string;
  timezone?: string;
}

/**
 * 创建账本：账本 + 所有者成员 + 预置分类。
 * 应在事务中调用（由调用方开启），保证三者同时成功或同时失败。
 */
export async function createLedger(tx: DbOrTx, input: CreateLedgerInput): Promise<LedgerScope> {
  const [ledger] = await tx
    .insert(ledgers)
    .values({ name: input.name, timezone: input.timezone ?? 'Asia/Shanghai', presetVersion: PRESET_VERSION })
    .returning({ id: ledgers.id });
  const ledgerId = ledger!.id;
  await tx.insert(ledgerMembers).values({ ledgerId, userId: input.ownerId, role: 'owner' });
  const scope = ownerScopeForNewLedger(ledgerId, input.ownerId);
  await seedPresetCategories(tx, scope);
  return scope;
}
