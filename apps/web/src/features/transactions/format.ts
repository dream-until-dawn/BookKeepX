/**
 * 流水展示相关的纯函数（便于单独测试）
 */
import type { Account, Category, Direction, Transaction } from '@bookkeepx/contracts';
import { formatCents, parseYuanToCents, toZonedDisplay } from '@bookkeepx/core';

/** 金额文字：收入带 +，支出带 -，中性不带符号；退款显示为冲减支出（+） */
export function amountText(t: Pick<Transaction, 'direction' | 'amountCents' | 'isRefund'>): string {
  const text = formatCents(t.amountCents);
  if (t.isRefund) return `+${text}`;
  if (t.direction === 'income') return `+${text}`;
  if (t.direction === 'expense') return `-${text}`;
  return text;
}

export function amountClass(t: Pick<Transaction, 'direction' | 'isRefund'>): string {
  if (t.isRefund || t.direction === 'income') return 'text-green-600';
  if (t.direction === 'expense') return 'text-gray-900';
  return 'text-gray-400';
}

/** 分类显示名：子分类显示为"父 / 子" */
export function categoryLabel(categoryId: string | null, categories: Category[]): string {
  if (!categoryId) return '未分类';
  const c = categories.find((x) => x.id === categoryId);
  if (!c) return '未知分类';
  const parent = c.parentId ? categories.find((x) => x.id === c.parentId) : undefined;
  return parent ? `${parent.name} / ${c.name}` : c.name;
}

export interface Option {
  value: string;
  label: string;
}

/**
 * 某个方向下可选的分类（按树展开，子分类缩进）
 * - 隐藏的分类、以及父分类被隐藏的子分类不出现
 * - 例外：正在编辑的流水原本用的分类，即使已隐藏也保留（服务端同样允许保留）
 */
export function categoryOptions(categories: Category[], direction: Direction, keepId?: string | null): Option[] {
  const inGroup = categories.filter((c) => c.group === direction);
  const tops = inGroup.filter((c) => !c.parentId).sort((a, b) => a.sort - b.sort);
  const out: Option[] = [];
  for (const top of tops) {
    const topVisible = !top.hidden || top.id === keepId;
    if (topVisible) out.push({ value: top.id, label: top.hidden ? `${top.name}（已隐藏）` : top.name });
    for (const child of inGroup.filter((c) => c.parentId === top.id).sort((a, b) => a.sort - b.sort)) {
      const visible = (!child.hidden && !top.hidden) || child.id === keepId;
      if (visible) {
        out.push({ value: child.id, label: `　└ ${child.name}${child.hidden || top.hidden ? '（已隐藏）' : ''}` });
      }
    }
  }
  return out;
}

/**
 * 编辑时只提交真正改动过的字段。
 * 原因：导入的流水不允许提交金额、时间等字段（即使值没变，服务端也会拒绝），
 * 且只发送改动部分可以避免覆盖别人同时做的修改。
 *
 * 时间按"账本时区的墙上时间、精确到分钟"比较：输入框只到分钟，而导入的时间带秒（如 11:07:04），
 * 直接比较时刻会误判为"改了时间"，导致导入流水的编辑被服务端拒绝。
 */
export function diffForUpdate(
  initial: Transaction,
  values: {
    direction: Direction;
    amount: string;
    occurredAt: string;
    categoryId: string | null;
    accountId: string | null;
    counterparty: string;
    note: string;
  },
  timezone: string,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (values.direction !== initial.direction) patch.direction = values.direction;
  let cents: number | null = null;
  try {
    cents = parseYuanToCents(values.amount);
  } catch {
    // 金额不合法时交给服务端校验并返回错误
  }
  if (cents === null || cents !== initial.amountCents) patch.amount = values.amount;
  if (toZonedDisplay(values.occurredAt, timezone).wall !== toZonedDisplay(initial.occurredAt, timezone).wall) {
    patch.occurredAt = values.occurredAt;
  }
  if (values.categoryId !== initial.categoryId) patch.categoryId = values.categoryId;
  if (values.accountId !== initial.accountId) patch.accountId = values.accountId;
  if (values.counterparty.trim() !== initial.counterparty) patch.counterparty = values.counterparty;
  if (values.note.trim() !== initial.note) patch.note = values.note;
  return patch;
}

/** 可选的账户：停用的不出现，除非是正在编辑的流水原本用的 */
export function accountOptions(accounts: Account[], keepId?: string | null): Option[] {
  return accounts
    .filter((a) => !a.archived || a.id === keepId)
    .map((a) => ({ value: a.id, label: a.archived ? `${a.name}（已停用）` : a.name }));
}
