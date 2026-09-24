/** 首页：本月收支概览 + 记账入口（统计图表在 P1-9 加入） */
import { formatCents, toZonedDisplay } from '@bookkeepx/core';
import { Link } from 'react-router';
import { useCurrentUser } from '../auth/api.ts';
import { HealthStatus } from '../health/HealthStatus.tsx';
import { useLedger } from '../ledger/api.ts';
import { useLedgerId } from '../ledger/useLedgerId.ts';
import { useTransactions } from '../transactions/api.ts';

export function HomePage() {
  const { data: user } = useCurrentUser();
  const ledgerId = useLedgerId();
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">你好，{user?.displayName}</h1>
      {ledgerId && <MonthOverview ledgerId={ledgerId} />}
      <div className="mt-8">
        <HealthStatus />
      </div>
    </main>
  );
}

function MonthOverview({ ledgerId }: { ledgerId: string }) {
  const ledger = useLedger(ledgerId);
  const month = ledger.data ? toZonedDisplay(new Date(), ledger.data.timezone).date.slice(0, 7) : undefined;
  // 只需要合计，取 1 条即可
  const list = useTransactions(ledgerId, { month, pageSize: 1 }, { enabled: month !== undefined });
  const s = list.data?.summary;
  return (
    <section className="rounded-lg bg-white p-4 ring-1 ring-gray-200" data-testid="month-overview">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-medium">本月（{month ?? '…'}）</h2>
        <Link to="/transactions" className="rounded-md bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700">
          去记账
        </Link>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <Stat label="收入" value={s && formatCents(s.incomeCents)} />
        <Stat label="支出" value={s && formatCents(s.expenseCents)} />
        <Stat label="结余" value={s && formatCents(s.incomeCents - s.expenseCents)} />
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-medium tabular-nums">{value ?? '—'}</div>
    </div>
  );
}
