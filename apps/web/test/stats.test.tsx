/** 统计页交互与纯图表配置；图表渲染生命周期另行测试。 */
import type { StatsResponse } from '@bookkeepx/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import { categoryOption, categoryPresentation, trendOption } from '../src/features/stats/chart-options.ts';

vi.mock('../src/features/stats/StatsChart.tsx', () => ({
  StatsChart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}));
const ledgerId = '00000000-0000-4000-8000-000000000001';
const zero = {
  incomeCents: 0,
  grossExpenseCents: 0,
  refundCents: 0,
  expenseCents: 0,
  balanceCents: 0,
  transactionCount: 0,
};
const data: StatsResponse = {
  month: '2026-02',
  timezone: 'Asia/Shanghai',
  summary: {
    incomeCents: 10000,
    grossExpenseCents: 1000,
    refundCents: 1500,
    expenseCents: -500,
    balanceCents: 10500,
    transactionCount: 3,
  },
  categories: [
    {
      ...zero,
      group: 'expense',
      categoryId: null,
      name: '其他支出',
      refundCents: 1500,
      grossExpenseCents: 1000,
      expenseCents: -500,
      balanceCents: 500,
      transactionCount: 2,
    },
    {
      ...zero,
      group: 'income',
      categoryId: null,
      name: '未分类',
      incomeCents: 10000,
      balanceCents: 10000,
      transactionCount: 1,
    },
  ],
  daily: [{ ...zero, date: '2026-02-01', expenseCents: -500, refundCents: 500, balanceCents: 500 }],
  monthly: [
    { ...zero, month: '2026-01' },
    { ...zero, month: '2026-02', expenseCents: -500, refundCents: 500, balanceCents: 500 },
  ],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function page(options: { month?: string; empty?: boolean; error?: boolean } = {}) {
  const fetcher = vi.fn(async (url: string) => {
    const path = String(url);
    let result: unknown;
    if (path === '/api/auth/me')
      result = { id: ledgerId, email: 'test@example.com', displayName: '测试', defaultLedgerId: ledgerId };
    else if (path === `/api/ledgers/${ledgerId}`)
      result = { id: ledgerId, name: '测试', currency: 'CNY', timezone: 'Asia/Shanghai', role: 'viewer' };
    else if (path.includes('/stats?')) {
      if (options.error)
        return new Response(JSON.stringify({ error: '统计金额超出可精确显示的范围', code: 'STATS_AMOUNT_OVERFLOW' }), {
          status: 422,
        });
      result = options.empty ? { ...data, summary: zero, categories: [] } : data;
    } else throw new Error(`意外请求 ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [`/stats?month=${options.month ?? '2026-02'}`] });
  render(
    <QueryClientProvider client={cache}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { fetcher, router };
}
describe('图表语义', () => {
  it('负分类改成条形图，保留真实负数', () => {
    expect(categoryPresentation(data.categories, 'expense').mode).toBe('bar');
    expect(categoryOption(data.categories, 'expense')).toMatchObject({ series: [{ type: 'bar', data: [-500] }] });
    expect(trendOption(data.daily, 'line')).toMatchObject({
      legend: { top: 8 },
      series: [
        { name: '收入', data: [0] },
        { name: '净支出', data: [-500] },
      ],
    });
  });
  it('普通非负分类用饼图，零数据不绘饼', () => {
    expect(categoryPresentation(data.categories, 'income')).toMatchObject({ mode: 'pie', total: 10000 });
    expect(categoryOption(data.categories, 'income')).toMatchObject({
      series: [{ type: 'pie', data: [{ name: '未分类', value: 10000 }] }],
    });
    expect(categoryPresentation([], 'expense').mode).toBe('empty');
    expect(categoryPresentation([{ ...data.categories[0]!, expenseCents: 0 }], 'expense').mode).toBe('empty');
  });
  it('合计为正但其中一类负数也不能用饼图', () => {
    const cats = [...data.categories, { ...data.categories[0]!, categoryId: ledgerId, expenseCents: 1000 }];
    expect(categoryPresentation(cats, 'expense')).toMatchObject({ total: 500, mode: 'bar' });
  });
  it('使用 richText 提示，分类名称不成为 HTML', () => {
    const option = categoryOption([{ ...data.categories[1]!, name: '<img src=x onerror=alert(1)>' }], 'income');
    expect(option).toMatchObject({ tooltip: { renderMode: 'richText' } });
  });
});
describe('统计页面', () => {
  it('viewer 能看负净支出、退款明细和替代图，不展示错误占比', async () => {
    page();
    const summary = await screen.findByRole('region', { name: '月度汇总' });
    expect(within(summary).getByText('-5.00')).toBeTruthy();
    expect(within(summary).getByText('105.00')).toBeTruthy();
    expect(screen.getByText(/退款使部分分类净支出为负/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '支出分类' })).getByText('—')).toBeTruthy();
    expect(screen.getByRole('img', { name: '月度收支趋势图' })).toBeTruthy();
    expect(screen.getByText('每日明细')).toBeTruthy();
  });
  it('月份切换更新 URL 并查询新月份，包括跨年', async () => {
    const { fetcher, router } = page({ month: '2026-01' });
    await screen.findByRole('region', { name: '月度汇总' });
    fireEvent.click(screen.getByRole('button', { name: '上个月' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('month=2025-12'))).toBe(true));
    expect(router.state.location.search).toBe('?month=2025-12');
    fireEvent.change(screen.getByLabelText('统计月份'), { target: { value: '2024-02' } });
    await waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('month=2024-02'))).toBe(true));
  });
  it('无效月份显示错误且不发统计请求', async () => {
    const { fetcher } = page({ month: '2026-13' });
    expect((await screen.findByRole('alert')).textContent).toContain('有效月份');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/stats?'))).toBe(false);
  });
  it('零数据显示空态，但历史趋势仍可见', async () => {
    page({ empty: true });
    await screen.findByText(/本月暂无计入收支的记录/);
    expect(screen.queryByRole('img', { name: '支出分类图' })).toBeNull();
    expect(screen.getByRole('img', { name: '月度收支趋势图' })).toBeTruthy();
  });
  it('接口失败显示错误，不能伪装为零收入零支出', async () => {
    page({ error: true });
    expect((await screen.findByRole('alert')).textContent).toContain('超出可精确显示的范围');
    expect(screen.queryByRole('region', { name: '月度汇总' })).toBeNull();
  });
});
