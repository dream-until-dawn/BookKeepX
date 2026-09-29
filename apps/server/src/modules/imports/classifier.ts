/**
 * 为某个账本组装分类器配置：账本分类 + 用户规则 + 系统规则 + 来源映射（ADR-0004）
 */
import { ruleDraftSchema } from '@bookkeepx/contracts';
import { type ClassifierConfig, SOURCE_HINTS, SYSTEM_RULES, type UserRule } from '@bookkeepx/core';
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { categories, categoryRules, users } from '../../db/schema/index.ts';
import type { LedgerScope } from '../ledgers/access.ts';

export async function loadClassifierConfig(db: DbOrTx, scope: LedgerScope): Promise<ClassifierConfig> {
  const cats = await db
    .select({ id: categories.id, group: categories.group, presetKey: categories.presetKey, hidden: categories.hidden })
    .from(categories)
    .where(eq(categories.ledgerId, scope.ledgerId))
    .orderBy(asc(categories.id));

  const rules = await db
    .select()
    .from(categoryRules)
    .where(and(eq(categoryRules.ledgerId, scope.ledgerId), eq(categoryRules.enabled, true)))
    .orderBy(asc(categoryRules.priority), asc(categoryRules.createdAt), asc(categoryRules.id));
  // 存量或数据库手工写入的异常规则也必须完整校验，不能让非法条件中断导入。
  const userRules: UserRule[] = rules.flatMap((r) => {
    const parsed = ruleDraftSchema.safeParse({
      name: r.name,
      enabled: r.enabled,
      priority: r.priority,
      match: r.match,
      conditions: r.conditions,
      action: r.action,
      origin: r.origin === 'learned' ? 'learned' : 'manual',
    });
    return parsed.success ? [{ ...parsed.data, id: r.id, createdAt: r.createdAt.toISOString() }] : [];
  });

  return { categories: cats, userRules, systemRules: SYSTEM_RULES, sourceHints: SOURCE_HINTS };
}

/** 当前用户在设置里填写的本人姓名（识别"转给自己"） */
export async function loadSelfNames(db: DbOrTx, scope: LedgerScope): Promise<string[]> {
  const [u] = await db.select({ selfNames: users.selfNames }).from(users).where(eq(users.id, scope.userId));
  return u?.selfNames ?? [];
}
