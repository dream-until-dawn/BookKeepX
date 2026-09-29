/** 月度统计页：金额明细与图表并列，负净支出不隐藏。 */
import { type StatsResponse, statsQuerySchema } from '@bookkeepx/contracts';
import { formatCents, shiftMonth, toZonedDisplay } from '@bookkeepx/core';
import { useSearchParams } from 'react-router';
import { Button, ErrorBanner, inputClass, PageTitle } from '../../shared/ui/index.tsx';
import { useLedger } from '../ledger/api.ts';
import { useLedgerId } from '../ledger/useLedgerId.ts';
import { useStats } from './api.ts';
import { categoryOption, categoryPresentation, trendOption } from './chart-options.ts';
import { StatsChart } from './StatsChart.tsx';

/** 登录后进入当前账本统计。 */
export function StatsPage() {
  const ledgerId = useLedgerId();
  return ledgerId ? <StatsLedger ledgerId={ledgerId} /> : null;
}
function StatsLedger({ ledgerId }: { ledgerId: string }) {
  const ledger = useLedger(ledgerId);
  if (ledger.error) return <ErrorBanner message={ledger.error.message} />;
  if (!ledger.data) return <p className="p-6">正在加载账本…</p>;
  return <StatsBody ledgerId={ledgerId} timezone={ledger.data.timezone} />;
}
function StatsBody({ ledgerId, timezone }: { ledgerId: string; timezone: string }) {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? toZonedDisplay(new Date(), timezone).date.slice(0, 7);
  const valid = statsQuerySchema.safeParse({ month }).success;
  const stats = useStats(ledgerId, month, valid);
  const setMonth = (value: string) => setParams({ month: value });
  const data = stats.data;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <PageTitle description={`按账本时区 ${timezone} 统计；退款冲减支出，中性、重复和已删除记录不计入。`}>
        统计
      </PageTitle>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!valid || month <= '1901-01'}
          aria-label="上个月"
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          ‹
        </Button>
        <input
          aria-label="统计月份"
          className={inputClass}
          type="month"
          min="1901-01"
          max="9998-12"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
        <Button
          aria-label="下个月"
          disabled={!valid || month >= '9998-12'}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          ›
        </Button>
      </div>
      {!valid && <ErrorBanner message="请选择 1901-01 至 9998-12 之间的有效月份" />}
      {stats.error && <ErrorBanner message={`统计加载失败：${stats.error.message}`} />}
      {valid && stats.isPending && <p role="status">正在加载统计…</p>}
      {data && (
        <>
          <section
            aria-label="月度汇总"
            className="grid grid-cols-2 gap-3 rounded-lg bg-white p-4 ring-1 ring-gray-200 sm:grid-cols-3"
          >
            <Amount label="收入" value={data.summary.incomeCents} />
            <Amount label="净支出" value={data.summary.expenseCents} />
            <Amount label="结余" value={data.summary.balanceCents} />
            <Amount label="支出（退款前）" value={data.summary.grossExpenseCents} />
            <Amount label="退款冲减" value={data.summary.refundCents} />
            <div>
              <p className="text-sm text-gray-500">计入统计</p>
              <p>{data.summary.transactionCount} 笔</p>
            </div>
          </section>
          {data.summary.transactionCount === 0 && <p role="status">本月暂无计入收支的记录，历史月份仍可在下方查看。</p>}
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <CategorySection data={data} group="expense" />
            <CategorySection data={data} group="income" />
          </div>
          <section className="rounded-lg bg-white p-4 ring-1 ring-gray-200">
            <h2 className="font-medium">每日收支</h2>
            <StatsChart label="每日收支趋势图" option={trendOption(data.daily, 'line')} />
            <PeriodTable rows={data.daily.map((r) => ({ ...r, period: r.date }))} label="每日明细" />
          </section>
          <section className="rounded-lg bg-white p-4 ring-1 ring-gray-200">
            <h2 className="font-medium">近 12 个月收支</h2>
            <StatsChart label="月度收支趋势图" option={trendOption(data.monthly, 'bar')} />
            <PeriodTable rows={data.monthly.map((r) => ({ ...r, period: r.month }))} label="月度明细" />
          </section>
        </>
      )}
    </main>
  );
}
function Amount({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="text-lg font-medium tabular-nums">{formatCents(value)}</p>
    </div>
  );
}
function CategorySection({ data, group }: { data: StatsResponse; group: 'income' | 'expense' }) {
  const view = categoryPresentation(data.categories, group);
  return (
    <section
      className="min-w-0 rounded-lg bg-white p-4 ring-1 ring-gray-200"
      aria-label={group === 'expense' ? '支出分类' : '收入分类'}
    >
      <h2 className="font-medium">{group === 'expense' ? '净支出分类' : '收入分类'}</h2>
      {view.mode === 'empty' ? (
        <p className="py-6 text-sm text-gray-500">暂无可展示的分类占比</p>
      ) : (
        <StatsChart
          label={group === 'expense' ? '支出分类图' : '收入分类图'}
          option={categoryOption(data.categories, group)}
          height={view.mode === 'bar' ? Math.max(300, view.rows.length * 35 + 70) : 300}
        />
      )}
      {view.mode === 'bar' && (
        <p className="text-sm text-amber-700">退款使部分分类净支出为负，改用条形图展示，不计算占比。</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>分类</th>
              <th>{group === 'expense' ? '净支出' : '收入'}</th>
              {group === 'expense' && <th>退款</th>}
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr className="border-t border-gray-100" key={r.categoryId ?? 'uncategorized'}>
                <td className="py-2">{r.name}</td>
                <td>{formatCents(r.value)}</td>
                {group === 'expense' && <td>{formatCents(r.refundCents)}</td>}
                <td>{view.mode === 'pie' ? `${((r.value / view.total) * 100).toFixed(1)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function PeriodTable({ rows, label }: { rows: (StatsResponse['summary'] & { period: string })[]; label: string }) {
  return (
    <details>
      <summary className="cursor-pointer text-sm text-blue-700">{label}</summary>
      <div className="overflow-x-auto">
        <table className="mt-2 w-full text-left text-sm">
          <thead>
            <tr>
              <th>时间</th>
              <th>收入</th>
              <th>净支出</th>
              <th>退款</th>
              <th>结余</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.period} className="border-t border-gray-100">
                <td className="py-1">{r.period}</td>
                <td>{formatCents(r.incomeCents)}</td>
                <td>{formatCents(r.expenseCents)}</td>
                <td>{formatCents(r.refundCents)}</td>
                <td>{formatCents(r.balanceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
