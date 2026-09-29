/** 统计仓储：时间边界和聚合都在 PostgreSQL 完成，仅返回分组后的数据。 */
import { eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { ledgers } from '../../db/schema/index.ts';
import type { LedgerScope } from '../ledgers/access.ts';

/** SQL SUM 返回字符串，交给 service 做安全整数校验。 */
export interface AggregateRow extends Record<string, unknown> {
  key: string;
  income: string;
  gross: string;
  refund: string;
  count: string;
  category_id?: string | null;
  name?: string;
  direction?: 'income' | 'expense';
}
/** 读取服务端保存的账本时区，不接受客户端覆盖。 */
export async function timezoneOf(db: DbOrTx, scope: LedgerScope) {
  const [row] = await db.select({ timezone: ledgers.timezone }).from(ledgers).where(eq(ledgers.id, scope.ledgerId));
  return row!.timezone;
}
/** 一致的基础口径：时间为半开区间，退款独立于原始方向。 */
function normalized(scope: LedgerScope, timezone: string, from: string, until: string) {
  return sql`SELECT t.id, t.occurred_at AT TIME ZONE ${timezone} AS local_time,
    CASE WHEN t.is_refund THEN 'expense' ELSE t.direction::text END AS direction,
    CASE WHEN t.direction = 'income' AND NOT t.is_refund THEN t.amount_cents ELSE 0 END AS income,
    CASE WHEN t.direction = 'expense' AND NOT t.is_refund THEN t.amount_cents ELSE 0 END AS gross,
    CASE WHEN t.is_refund THEN t.amount_cents ELSE 0 END AS refund,
    CASE WHEN t.is_refund THEN COALESCE(o.category_id, fallback.id) ELSE t.category_id END AS category_id
    FROM transactions t
    LEFT JOIN transactions o ON o.id = t.refund_of_id AND o.ledger_id = t.ledger_id
    LEFT JOIN categories fallback ON fallback.ledger_id = t.ledger_id AND fallback.preset_key = 'expense.other'
    WHERE t.ledger_id = ${scope.ledgerId} AND t.deleted_at IS NULL AND t.duplicate_of_id IS NULL
    AND (t.direction <> 'neutral' OR t.is_refund)
    AND t.occurred_at >= (${from}::date::timestamp AT TIME ZONE ${timezone})
    AND t.occurred_at < (${until}::date::timestamp AT TIME ZONE ${timezone})`;
}
const sums = sql`SUM(n.income)::text AS income, SUM(n.gross)::text AS gross, SUM(n.refund)::text AS refund, count(*)::text AS count`;
/** 按本地日或月聚合，原始时间过滤仍使用 occurred_at 范围索引。 */
export function periodTotals(
  db: DbOrTx,
  scope: LedgerScope,
  timezone: string,
  from: string,
  until: string,
  unit: 'day' | 'month',
) {
  const pattern = unit === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM';
  return db.execute<AggregateRow>(sql`WITH normalized AS (${normalized(scope, timezone, from, until)})
    SELECT to_char(n.local_time, ${pattern}) AS key, ${sums} FROM normalized n GROUP BY 1 ORDER BY 1`);
}
/** 分类汇总到一级，隐藏分类不排除，未分类仍有独立分组。 */
export function categoryTotals(db: DbOrTx, scope: LedgerScope, timezone: string, from: string, until: string) {
  return db.execute<AggregateRow>(sql`WITH normalized AS (${normalized(scope, timezone, from, until)})
    SELECT '' AS key, n.direction, COALESCE(parent.id, c.id) AS category_id,
    COALESCE(parent.name, c.name, '未分类') AS name, ${sums}
    FROM normalized n LEFT JOIN categories c ON c.id = n.category_id AND c.ledger_id = ${scope.ledgerId}
    LEFT JOIN categories parent ON parent.id = c.parent_id AND parent.ledger_id = ${scope.ledgerId}
    GROUP BY n.direction, COALESCE(parent.id, c.id), COALESCE(parent.name, c.name, '未分类')
    ORDER BY n.direction, category_id NULLS LAST`);
}
