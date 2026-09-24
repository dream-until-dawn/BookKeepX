/**
 * 流水：展示用的纯函数 + 流水页交互（时区分组、记一笔、编辑导入流水、删除撤销、只读成员）
 */
import type { Category, Transaction } from '@bookkeepx/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import {
  amountClass,
  amountText,
  categoryLabel,
  categoryOptions,
  diffForUpdate,
} from '../src/features/transactions/format.ts';

const LEDGER = '11111111-1111-4111-8111-111111111111';
const TZ = 'Asia/Shanghai';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const cat = (n: number, over: Partial<Category>): Category => ({
  id: id(n),
  parentId: null,
  group: 'expense',
  name: `分类${n}`,
  presetKey: null,
  icon: null,
  sort: n,
  hidden: false,
  transactionCount: 0,
  ...over,
});

const CATS: Category[] = [
  cat(1, { name: '餐饮' }),
  cat(2, { name: '正餐', parentId: id(1) }),
  cat(3, { name: '旧分类', hidden: true }),
  cat(4, { name: '隐藏父', hidden: true }),
  cat(5, { name: '隐藏父的子', parentId: id(4) }),
  cat(6, { name: '工资', group: 'income' }),
];

const tx = (n: number, over: Partial<Transaction>): Transaction => ({
  id: id(100 + n),
  direction: 'expense',
  amountCents: 3250,
  occurredAt: '2026-09-10T04:00:00.000Z',
  timePrecision: 'second',
  categoryId: id(2),
  accountId: null,
  counterparty: '麦当劳',
  description: '',
  note: '',
  source: 'manual',
  categorySource: 'manual',
  isRefund: false,
  refundOfId: null,
  duplicateOfId: null,
  createdBy: null,
  deletedAt: null,
  createdAt: '2026-09-10T04:00:00.000Z',
  ...over,
});

describe('展示函数', () => {
  it.each([
    [{ direction: 'income', isRefund: false }, '+32.50', 'text-green-600'],
    [{ direction: 'expense', isRefund: false }, '-32.50', 'text-gray-900'],
    [{ direction: 'neutral', isRefund: false }, '32.50', 'text-gray-400'],
    // 退款冲减支出：显示为 +，绿色（即使原始方向是"不计收支"）
    [{ direction: 'neutral', isRefund: true }, '+32.50', 'text-green-600'],
  ] as const)('%j → %s %s', (over, text, cls) => {
    expect(amountText({ amountCents: 3250, ...over })).toBe(text);
    expect(amountClass(over)).toBe(cls);
  });

  it('categoryLabel：子分类显示"父 / 子"；空与未知分别提示', () => {
    expect(categoryLabel(id(2), CATS)).toBe('餐饮 / 正餐');
    expect(categoryLabel(null, CATS)).toBe('未分类');
    expect(categoryLabel(id(99), CATS)).toBe('未知分类');
  });

  it('categoryOptions：隐藏分类、以及父分类被隐藏的子分类都不可选；只列出对应方向', () => {
    const labels = categoryOptions(CATS, 'expense').map((o) => o.label);
    expect(labels).toEqual(['餐饮', '　└ 正餐']);
  });

  it('categoryOptions：正在编辑的流水原本用的隐藏分类仍保留，并标注"已隐藏"', () => {
    expect(categoryOptions(CATS, 'expense', id(3)).map((o) => o.label)).toContain('旧分类（已隐藏）');
    expect(categoryOptions(CATS, 'expense', id(5)).map((o) => o.label)).toContain('　└ 隐藏父的子（已隐藏）');
  });
});

describe('diffForUpdate（编辑时只提交改动）', () => {
  const values = (t: Transaction, over = {}) => ({
    direction: t.direction,
    amount: '32.50',
    // 表单里的时间只精确到分钟
    occurredAt: '2026-09-10T11:07:00+08:00',
    categoryId: t.categoryId,
    accountId: t.accountId,
    counterparty: t.counterparty,
    note: t.note,
    ...over,
  });

  it('正向：什么都没改 → 空；导入流水的时间带秒（11:07:04）也不算改动', () => {
    const imported = tx(1, { source: 'import', occurredAt: '2026-09-10T03:07:04.000Z' });
    expect(diffForUpdate(imported, values(imported), TZ)).toEqual({});
  });

  it('正向：只改备注和分类 → 只提交这两项', () => {
    const t = tx(1, { occurredAt: '2026-09-10T03:07:00.000Z' });
    expect(diffForUpdate(t, values(t, { note: '加了备注', categoryId: null }), TZ)).toEqual({
      note: '加了备注',
      categoryId: null,
    });
  });

  it('正向：金额写法不同但数值相同（32.5 与 32.50）不算改动；数值变了才提交', () => {
    const t = tx(1, { occurredAt: '2026-09-10T03:07:00.000Z' });
    expect(diffForUpdate(t, values(t, { amount: '32.5' }), TZ)).toEqual({});
    expect(diffForUpdate(t, values(t, { amount: '40' }), TZ)).toEqual({ amount: '40' });
  });

  it('反向：金额不合法 → 照样提交，由服务端返回错误信息', () => {
    const t = tx(1, { occurredAt: '2026-09-10T03:07:00.000Z' });
    expect(diffForUpdate(t, values(t, { amount: 'abc' }), TZ)).toEqual({ amount: 'abc' });
  });
});

// ───────────────────────── 页面 ─────────────────────────
interface Call {
  method: string;
  url: string;
  body: unknown;
}

function mockServer(opts: {
  role?: string;
  items: Transaction[];
  onWrite?: (c: Call) => { status: number; body?: unknown };
}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const call = { method, url, body };
      calls.push(call);
      const path = url.split('?')[0] ?? url;
      let r: { status: number; body?: unknown } = { status: 404 };
      if (method !== 'GET') r = opts.onWrite?.(call) ?? { status: 200 };
      else if (path === '/api/auth/me')
        r = { status: 200, body: { id: id(900), email: 'a@b.com', displayName: '小明', defaultLedgerId: LEDGER } };
      else if (path === `/api/ledgers/${LEDGER}`)
        r = {
          status: 200,
          body: { id: LEDGER, name: '我的账本', currency: 'CNY', timezone: TZ, role: opts.role ?? 'owner' },
        };
      else if (path.endsWith('/categories')) r = { status: 200, body: CATS };
      else if (path.endsWith('/accounts')) r = { status: 200, body: [] };
      else if (path.endsWith('/transactions'))
        r = {
          status: 200,
          body: {
            items: opts.items,
            total: opts.items.length,
            page: 1,
            pageSize: 50,
            summary: { incomeCents: 100000, expenseCents: 3250 },
          },
        };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('流水页', () => {
  it('正向：按账本时区分组——UTC 9 月 30 日 16:30 显示在 10 月 1 日下；显示合计', async () => {
    mockServer({ items: [tx(1, { occurredAt: '2026-09-30T16:30:00.000Z', counterparty: '国庆夜宵' })] });
    renderAt('/transactions?month=2026-10');
    expect(await screen.findByText('国庆夜宵')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '2026-10-01' })).toBeTruthy();
    expect(within(screen.getByTestId('summary')).getByText('1,000.00')).toBeTruthy();
    expect(screen.getByTestId('month').textContent).toBe('2026 年 10 月');
  });

  it('正向：记一笔 → 请求体中的时间是按北京时间换算的带偏移 ISO 时间', async () => {
    const calls = mockServer({ items: [], onWrite: () => ({ status: 201, body: tx(9, {}) }) });
    renderAt('/transactions?month=2026-09');
    fireEvent.click(await screen.findByRole('button', { name: '记一笔' }));
    const form = screen.getByRole('region', { name: '记一笔' });
    fireEvent.change(within(form).getByLabelText('金额（元）'), { target: { value: '32.5' } });
    fireEvent.change(within(form).getByLabelText('时间'), { target: { value: '2026-09-24T12:30' } });
    fireEvent.change(within(form).getByLabelText('分类'), { target: { value: id(2) } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toMatchObject({
      direction: 'expense',
      amount: '32.5',
      occurredAt: '2026-09-24T12:30:00+08:00',
      categoryId: id(2),
    });
  });

  it('反向：金额不合法 → 表单提示错误，不发送请求', async () => {
    const calls = mockServer({ items: [] });
    renderAt('/transactions?month=2026-09');
    fireEvent.click(await screen.findByRole('button', { name: '记一笔' }));
    const form = screen.getByRole('region', { name: '记一笔' });
    fireEvent.change(within(form).getByLabelText('金额（元）'), { target: { value: '0' } });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('金额必须大于 0');
    expect(writes(calls)).toHaveLength(0);
  });

  it('正向：编辑导入的流水 → 金额等字段锁定；只改备注时请求体只有 note', async () => {
    const imported = tx(1, { source: 'import', occurredAt: '2026-09-10T03:07:04.000Z', counterparty: '淘宝闪购' });
    const calls = mockServer({
      items: [imported],
      onWrite: () => ({ status: 200, body: { ...imported, note: '外卖' } }),
    });
    renderAt('/transactions?month=2026-09');
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    expect((screen.getByLabelText('金额（元）') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('时间') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('备注'), { target: { value: '外卖' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ method: 'PATCH', body: { note: '外卖' } });
    expect(Object.keys(writes(calls)[0]!.body as object)).toEqual(['note']);
  });

  it('正向：删除 → 出现"撤销"，点击后发送恢复请求', async () => {
    const t = tx(1, {});
    const calls = mockServer({
      items: [t],
      onWrite: (c) => (c.method === 'DELETE' ? { status: 204 } : { status: 200, body: t }),
    });
    renderAt('/transactions?month=2026-09');
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(await screen.findByRole('button', { name: '撤销' }));
    await waitFor(() =>
      expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual([
        `DELETE /api/ledgers/${LEDGER}/transactions/${t.id}`,
        `POST /api/ledgers/${LEDGER}/transactions/${t.id}/restore`,
      ]),
    );
  });

  it('正向：点"上个月" → 按新月份请求', async () => {
    const calls = mockServer({ items: [] });
    renderAt('/transactions?month=2026-01');
    fireEvent.click(await screen.findByRole('button', { name: '上个月' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('month=2025-12'))).toBe(true));
  });

  it('反向：只读成员看不到"记一笔"和"编辑"', async () => {
    mockServer({ role: 'viewer', items: [tx(1, {})] });
    renderAt('/transactions?month=2026-09');
    expect(await screen.findByText('麦当劳')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '记一笔' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
  });
});
