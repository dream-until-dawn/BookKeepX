/**
 * 统计查询（P0-2：验证按北京时间切月、退款冲减、中性与重复排除都能在 SQL 里一次算完）
 *
 * 口径（architecture.md 第 7 节 + ADR-0004）：
 *   - 收入：direction=income 且不是退款
 *   - 支出：direction=expense 的金额 − 退款金额（退款冲减支出，不计收入）
 *   - 中性不计；duplicate_of_id 非空（跨来源重复）不计；软删除不计
 *   - 按用户时区切分月份：先把 timestamptz 转成当地时间再 date_trunc
 */
import { sql } from 'drizzle-orm';
import { toSafeInt, type Db } from './db/client.ts';

export interface MonthRow {
  month: string; // YYYY-MM
  incomeCents: number;
  expenseCents: number;
}

export async function monthlyStats(db: Db, userId: string, timezone = 'Asia/Shanghai'): Promise<MonthRow[]> {
  const rows = await db.execute<{ month: string; income: string; expense: string }>(sql`
    SELECT to_char(date_trunc('month', occurred_at AT TIME ZONE ${timezone}), 'YYYY-MM') AS month,
           COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'income' AND NOT is_refund), 0)  AS income,
           COALESCE(SUM(amount_cents) FILTER (WHERE direction = 'expense' AND NOT is_refund), 0)
             - COALESCE(SUM(amount_cents) FILTER (WHERE is_refund), 0)                             AS expense
      FROM transactions
     WHERE user_id = ${userId}
       AND deleted_at IS NULL
       AND duplicate_of_id IS NULL
     GROUP BY 1
     ORDER BY 1`);
  return rows.map((r) => ({ month: r.month, incomeCents: toSafeInt(r.income), expenseCents: toSafeInt(r.expense) }));
}

/** 按分类的净支出：退款冲减到原消费的分类；找不到原消费的冲减"其他支出" */
export async function expenseByCategory(db: Db, userId: string): Promise<Record<string, number>> {
  const rows = await db.execute<{ category: string; cents: string }>(sql`
    SELECT CASE WHEN t.is_refund THEN COALESCE(o.category_key, 'expense.other')
                ELSE COALESCE(t.category_key, 'expense.uncategorized') END AS category,
           SUM(CASE WHEN t.is_refund THEN -t.amount_cents ELSE t.amount_cents END) AS cents
      FROM transactions t
      LEFT JOIN transactions o ON o.id = t.refund_of_id
     WHERE t.user_id = ${userId}
       AND t.deleted_at IS NULL
       AND t.duplicate_of_id IS NULL
       AND (t.direction = 'expense' OR t.is_refund)
     GROUP BY 1`);
  return Object.fromEntries(rows.map((r) => [r.category, toSafeInt(r.cents)]));
}
