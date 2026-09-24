/**
 * 为某个账本组装分类器配置：账本分类 + 用户规则 + 系统规则 + 来源映射（ADR-0004）
 */
import { type ClassifierConfig, type RuleCondition, SOURCE_HINTS, SYSTEM_RULES, type UserRule } from '@bookkeepx/core';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.ts';
import { categories, categoryRules, users } from '../../db/schema/index.ts';
import type { LedgerScope } from '../ledgers/access.ts';

export async function loadClassifierConfig(db: Db, scope: LedgerScope): Promise<ClassifierConfig> {
  const cats = await db
    .select({ id: categories.id, group: categories.group, presetKey: categories.presetKey, hidden: categories.hidden })
    .from(categories)
    .where(eq(categories.ledgerId, scope.ledgerId));

  const rules = await db
    .select()
    .from(categoryRules)
    .where(and(eq(categoryRules.ledgerId, scope.ledgerId), eq(categoryRules.enabled, true)));
  // 规则内容由 P1-8 的接口按 zod 校验后写入；这里只做最基本的形状检查，异常规则直接忽略，不影响导入
  const userRules: UserRule[] = rules.flatMap((r) => {
    const action = r.action as { categoryId?: unknown; setDirection?: unknown };
    if (!Array.isArray(r.conditions) || typeof action.categoryId !== 'string') return [];
    return [
      {
        id: r.id,
        name: r.name,
        priority: r.priority,
        match: r.match,
        conditions: r.conditions as RuleCondition[],
        action: {
          categoryId: action.categoryId,
          ...(action.setDirection === 'neutral' ? { setDirection: 'neutral' as const } : {}),
        },
      },
    ];
  });

  return { categories: cats, userRules, systemRules: SYSTEM_RULES, sourceHints: SOURCE_HINTS };
}

/** 当前用户在设置里填写的本人姓名（识别"转给自己"） */
export async function loadSelfNames(db: Db, scope: LedgerScope): Promise<string[]> {
  const [u] = await db.select({ selfNames: users.selfNames }).from(users).where(eq(users.id, scope.userId));
  return u?.selfNames ?? [];
}
