/**
 * 流水页：按月查看、筛选、记一笔、编辑、删除（可撤销）、回收站
 *
 * 筛选条件放在地址栏参数里（month、direction、categoryId、accountId、q、deleted、page），
 * 刷新页面或前进后退时保持不变，也方便分享。
 */
import { type Account, type Category, DIRECTION_LABELS, type Direction, type Transaction } from '@bookkeepx/contracts';
import { formatCents, shiftMonth, toZonedDisplay } from '@bookkeepx/core';
import { type ReactNode, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ApiError } from '../../shared/api/client.ts';
import { Badge, Button, ErrorBanner, inputClass, PageTitle } from '../../shared/ui/index.tsx';
import { useAccounts } from '../accounts/api.ts';
import { useCategories } from '../categories/api.ts';
import { useLedger } from '../ledger/api.ts';
import { useLedgerId } from '../ledger/useLedgerId.ts';
import { useTransactionMutations, useTransactions } from './api.ts';
import { amountClass, amountText, categoryLabel, categoryOptions, diffForUpdate } from './format.ts';
import { TransactionForm, type TransactionFormValues } from './TransactionForm.tsx';

const PAGE_SIZE = 50;

export function TransactionsPage() {
  const ledgerId = useLedgerId();
  if (!ledgerId) return null;
  return <TransactionsView ledgerId={ledgerId} />;
}

function TransactionsView({ ledgerId }: { ledgerId: string }) {
  const ledger = useLedger(ledgerId);
  const categories = useCategories(ledgerId);
  const accounts = useAccounts(ledgerId);
  const loadError = ledger.error ?? categories.error ?? accounts.error;
  if (loadError) return <ErrorBanner message={`加载失败：${loadError.message}`} />;
  if (!ledger.data || !categories.data || !accounts.data) return <p className="p-6 text-gray-500">正在加载…</p>;
  return (
    <TransactionsBody
      ledgerId={ledgerId}
      timezone={ledger.data.timezone}
      canEdit={ledger.data.role !== 'viewer'}
      categories={categories.data}
      accounts={accounts.data}
    />
  );
}

interface BodyProps {
  ledgerId: string;
  timezone: string;
  canEdit: boolean;
  categories: Category[];
  accounts: Account[];
}

function TransactionsBody({ ledgerId, timezone, canEdit, categories, accounts }: BodyProps) {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? toZonedDisplay(new Date(), timezone).date.slice(0, 7);
  const trash = params.get('deleted') === 'true';
  const page = Number(params.get('page') ?? 1);
  const filters = {
    direction: params.get('direction') ?? undefined,
    categoryId: params.get('categoryId') ?? undefined,
    accountId: params.get('accountId') ?? undefined,
    q: params.get('q') ?? undefined,
  };

  const list = useTransactions(ledgerId, {
    month,
    ...filters,
    deleted: trash ? 'true' : undefined,
    page,
    pageSize: PAGE_SIZE,
  });
  const m = useTransactionMutations(ledgerId);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 刚删除的流水：显示"撤销"提示 */
  const [lastDeleted, setLastDeleted] = useState<string | null>(null);

  /** 修改地址栏参数；除翻页外，改任何条件都回到第 1 页 */
  const setParam = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in updates)) next.delete('page');
    setParams(next);
  };

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '操作失败，请重试');
      return false;
    }
  };

  const create = async (v: TransactionFormValues) => {
    if (await run(() => m.create.mutateAsync(v))) setAdding(false);
  };
  const update = async (t: Transaction, v: TransactionFormValues) => {
    const patch = diffForUpdate(t, v, timezone);
    if (Object.keys(patch).length === 0) return setEditingId(null);
    if (await run(() => m.update.mutateAsync({ id: t.id, patch }))) setEditingId(null);
  };
  const remove = async (t: Transaction) => {
    if (await run(() => m.remove.mutateAsync(t.id))) {
      setEditingId(null);
      setLastDeleted(t.id);
    }
  };
  const restore = async (id: string) => {
    if (await run(() => m.restore.mutateAsync(id))) setLastDeleted(null);
  };

  const data = list.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PageTitle>{trash ? '回收站' : '流水'}</PageTitle>
        <div className="flex gap-2">
          <Button onClick={() => setParam({ deleted: trash ? null : 'true' })}>{trash ? '返回流水' : '回收站'}</Button>
          {canEdit && !trash && (
            <Button variant="primary" onClick={() => setAdding((v) => !v)}>
              记一笔
            </Button>
          )}
        </div>
      </div>

      <ErrorBanner message={error} onClose={() => setError(null)} />
      {lastDeleted && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between rounded-lg bg-gray-800 px-3 py-2 text-sm text-white"
        >
          已删除一笔流水
          <button type="button" className="font-medium text-blue-300" onClick={() => restore(lastDeleted)}>
            撤销
          </button>
        </div>
      )}

      {adding && (
        <section className="mb-6 rounded-lg bg-white p-4 ring-1 ring-gray-200" aria-label="记一笔">
          <TransactionForm
            categories={categories}
            accounts={accounts}
            timezone={timezone}
            submitLabel="保存"
            pending={m.create.isPending}
            onSubmit={create}
            onCancel={() => setAdding(false)}
          />
        </section>
      )}

      {/* 月份切换与筛选 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button aria-label="上个月" onClick={() => setParam({ month: shiftMonth(month, -1) })}>
          ‹
        </Button>
        <span className="min-w-24 text-center font-medium" data-testid="month">
          {month.replace('-', ' 年 ')} 月
        </span>
        <Button aria-label="下个月" onClick={() => setParam({ month: shiftMonth(month, 1) })}>
          ›
        </Button>
        <select
          aria-label="收支类型筛选"
          className={inputClass}
          value={filters.direction ?? ''}
          onChange={(e) => setParam({ direction: e.target.value, categoryId: null })}
        >
          <option value="">全部类型</option>
          {(Object.keys(DIRECTION_LABELS) as Direction[]).map((d) => (
            <option key={d} value={d}>
              {DIRECTION_LABELS[d]}
            </option>
          ))}
        </select>
        <select
          aria-label="分类筛选"
          className={inputClass}
          value={filters.categoryId ?? ''}
          onChange={(e) => setParam({ categoryId: e.target.value })}
        >
          <option value="">全部分类</option>
          {(['expense', 'income', 'neutral'] as Direction[])
            .filter((d) => !filters.direction || filters.direction === d)
            .flatMap((d) => categoryOptions(categories, d))
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </select>
        <select
          aria-label="账户筛选"
          className={inputClass}
          value={filters.accountId ?? ''}
          onChange={(e) => setParam({ accountId: e.target.value })}
        >
          <option value="">全部账户</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam({ q: String(new FormData(e.currentTarget).get('q') ?? '').trim() });
          }}
        >
          <input
            name="q"
            aria-label="搜索"
            placeholder="搜索对方、说明、备注"
            defaultValue={filters.q}
            className={inputClass}
          />
        </form>
      </div>

      {/* 合计 */}
      {data && !trash && (
        <div
          className="mb-4 grid grid-cols-3 gap-2 rounded-lg bg-white p-3 text-center ring-1 ring-gray-200"
          data-testid="summary"
        >
          <div>
            <div className="text-xs text-gray-500">收入</div>
            <div className="font-medium text-green-600">{formatCents(data.summary.incomeCents)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">支出</div>
            <div className="font-medium">{formatCents(data.summary.expenseCents)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">结余</div>
            <div className="font-medium">{formatCents(data.summary.incomeCents - data.summary.expenseCents)}</div>
          </div>
        </div>
      )}

      {list.error && <ErrorBanner message={`加载流水失败：${list.error.message}`} />}
      {data && data.items.length === 0 && (
        <p className="rounded-lg bg-white p-6 text-center text-sm text-gray-500 ring-1 ring-gray-200">
          {trash ? '回收站是空的' : '这个月还没有记录'}
        </p>
      )}

      {data && data.items.length > 0 && (
        <DayGroups
          items={data.items}
          timezone={timezone}
          render={(t) =>
            editingId === t.id ? (
              <div className="p-3">
                <TransactionForm
                  categories={categories}
                  accounts={accounts}
                  timezone={timezone}
                  initial={t}
                  submitLabel="保存修改"
                  pending={m.update.isPending}
                  onSubmit={(v) => update(t, v)}
                  onCancel={() => setEditingId(null)}
                  onDelete={() => remove(t)}
                />
              </div>
            ) : (
              <TransactionRow
                t={t}
                timezone={timezone}
                categories={categories}
                accountName={accounts.find((a) => a.id === t.accountId)?.name}
                action={
                  trash ? (
                    canEdit && <Button onClick={() => restore(t.id)}>恢复</Button>
                  ) : canEdit ? (
                    <Button variant="ghost" onClick={() => setEditingId(t.id)}>
                      编辑
                    </Button>
                  ) : null
                }
              />
            )
          }
        />
      )}

      {data && totalPages > 1 && (
        <nav className="mt-4 flex items-center justify-center gap-3 text-sm" aria-label="分页">
          <Button disabled={page <= 1} onClick={() => setParam({ page: String(page - 1) })}>
            上一页
          </Button>
          <span>
            第 {page} / {totalPages} 页，共 {data.total} 笔
          </span>
          <Button disabled={page >= totalPages} onClick={() => setParam({ page: String(page + 1) })}>
            下一页
          </Button>
        </nav>
      )}
    </main>
  );
}

/** 按日期（账本时区）分组展示 */
function DayGroups({
  items,
  timezone,
  render,
}: {
  items: Transaction[];
  timezone: string;
  render: (t: Transaction) => ReactNode;
}) {
  const groups = new Map<string, Transaction[]>();
  for (const t of items) {
    const day = toZonedDisplay(t.occurredAt, timezone).date;
    groups.set(day, [...(groups.get(day) ?? []), t]);
  }
  return (
    <div className="space-y-4">
      {[...groups].map(([day, list]) => (
        <section key={day}>
          <h3 className="mb-1 text-sm text-gray-500">{day}</h3>
          <ul className="divide-y divide-gray-100 rounded-lg bg-white ring-1 ring-gray-200">
            {list.map((t) => (
              <li key={t.id}>{render(t)}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TransactionRow({
  t,
  timezone,
  categories,
  accountName,
  action,
}: {
  t: Transaction;
  timezone: string;
  categories: Category[];
  accountName: string | undefined;
  action: ReactNode;
}) {
  const time = t.timePrecision === 'day' ? '' : toZonedDisplay(t.occurredAt, timezone).time;
  const title = t.counterparty || t.note || t.description || categoryLabel(t.categoryId, categories);
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2" data-testid="transaction-row">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{title}</span>
          <Badge>{categoryLabel(t.categoryId, categories)}</Badge>
          {t.source === 'import' && <Badge tone="blue">导入</Badge>}
          {t.isRefund && <Badge tone="amber">退款</Badge>}
          {t.direction === 'neutral' && <Badge>中性</Badge>}
        </div>
        <div className="text-xs text-gray-500">
          {[time, accountName, t.note && t.note !== title ? t.note : null].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`tabular-nums ${amountClass(t)}`}>{amountText(t)}</span>
        {action}
      </div>
    </div>
  );
}
