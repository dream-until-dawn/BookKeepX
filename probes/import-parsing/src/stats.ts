/**
 * 统计口径（探针版）：收入、支出、按分类的净支出
 *
 * 口径（负责人决定）：
 *   - 中性不计入收支
 *   - 退款冲减支出（方案 B）：记在退款自己的发生时间，冲减**原消费所在分类**；
 *     找不到原消费的退款冲减"其他支出"，并在导入预览中提示用户确认
 *   - 退款不计入收入（微信把退款记成收入，这里纠正）
 */
import type { ClassifyResult } from './categorize/index.ts';
import type { LinkedRecord } from './engine/refund.ts';

export interface StatItem {
  rec: LinkedRecord;
  cls: ClassifyResult;
}

export interface Stats {
  incomeCents: number;
  /** 净支出 = 支出 − 退款 */
  expenseCents: number;
  refundCents: number;
  /** 一级分类 → 净支出（分） */
  byTopCategory: Map<string, number>;
  /** 没能关联到原消费、需要用户确认的退款笔数 */
  unlinkedRefunds: number;
}

/** 分类键取一级：expense.food.delivery → expense.food */
const top = (key: string | null) => (key ? key.split('.').slice(0, 2).join('.') : 'expense.uncategorized');

export function computeStats(items: StatItem[]): Stats {
  const byId = new Map(items.filter((i) => i.rec.externalId && !i.rec.refund).map((i) => [i.rec.externalId!, i]));
  const s: Stats = { incomeCents: 0, expenseCents: 0, refundCents: 0, byTopCategory: new Map(), unlinkedRefunds: 0 };
  const add = (cat: string, cents: number) => s.byTopCategory.set(cat, (s.byTopCategory.get(cat) ?? 0) + cents);

  for (const { rec, cls } of items) {
    if (rec.refund) {
      const original = rec.refund.linkedTo ? byId.get(rec.refund.linkedTo) : undefined;
      if (!original) s.unlinkedRefunds++;
      const cat = original ? top(original.cls.categoryKey) : 'expense.other';
      s.expenseCents -= rec.amountCents;
      s.refundCents += rec.amountCents;
      add(cat, -rec.amountCents);
      continue;
    }
    if (cls.direction === 'income') s.incomeCents += rec.amountCents;
    else if (cls.direction === 'expense') {
      s.expenseCents += rec.amountCents;
      add(top(cls.categoryKey), rec.amountCents);
    }
  }
  return s;
}
