/** 统计服务：一致快照、金额范围校验及空时间段补零。 */
import type { StatsQuery, StatsResponse, StatsTotals } from '@bookkeepx/contracts';
import { shiftMonth } from '@bookkeepx/core';
import type { Db } from '../../db/client.ts';
import { AppError } from '../../errors.ts';
import type { LedgerScope } from '../ledgers/access.ts';
import { type AggregateRow, categoryTotals, periodTotals, timezoneOf } from './repository.ts';

function safe(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
    throw new AppError(422, 'STATS_AMOUNT_OVERFLOW', '统计金额超出可精确显示的范围');
  return Number(value);
}
function totals(row?: AggregateRow): StatsTotals {
  const income = BigInt(row?.income ?? 0),
    gross = BigInt(row?.gross ?? 0),
    refund = BigInt(row?.refund ?? 0);
  return {
    incomeCents: safe(income),
    grossExpenseCents: safe(gross),
    refundCents: safe(refund),
    expenseCents: safe(gross - refund),
    balanceCents: safe(income - gross + refund),
    transactionCount: safe(BigInt(row?.count ?? 0)),
  };
}
/** 查询某月完整统计，趋势固定为截至该月的 12 个月。 */
export async function getStats(db: Db, scope: LedgerScope, query: StatsQuery): Promise<StatsResponse> {
  return db.transaction(
    async (tx) => {
      const timezone = await timezoneOf(tx, scope);
      const from = `${query.month}-01`,
        until = `${shiftMonth(query.month, 1)}-01`;
      const months = await periodTotals(tx, scope, timezone, `${shiftMonth(query.month, -11)}-01`, until, 'month');
      const days = await periodTotals(tx, scope, timezone, from, until, 'day');
      const cats = await categoryTotals(tx, scope, timezone, from, until);
      const monthMap = new Map(months.map((r) => [r.key, r])),
        dayMap = new Map(days.map((r) => [r.key, r]));
      // 这里只计算公历每月天数；实际流水归日已在 SQL 中按账本时区完成。
      const [year, month] = query.month.split('-').map(Number);
      const dayCount = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
      return {
        month: query.month,
        timezone,
        summary: totals(monthMap.get(query.month)),
        categories: cats.map((r) => ({
          ...totals(r),
          group: r.direction!,
          categoryId: r.category_id ?? null,
          name: r.name!,
        })),
        daily: Array.from({ length: dayCount }, (_, i) => {
          const date = `${query.month}-${String(i + 1).padStart(2, '0')}`;
          return { date, ...totals(dayMap.get(date)) };
        }),
        monthly: Array.from({ length: 12 }, (_, i) => {
          const month = shiftMonth(query.month, i - 11);
          return { month, ...totals(monthMap.get(month)) };
        }),
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}
