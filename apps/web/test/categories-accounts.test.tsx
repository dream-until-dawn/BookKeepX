/**
 * 分类管理、资金账户页面：展示、表单校验、请求内容、服务端错误提示
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import { deleteBlockReason } from '../src/features/categories/CategoriesPage.tsx';

const LEDGER = '11111111-1111-4111-8111-111111111111';
const USER = {
  id: '0b3f5a1e-6c2d-4f7a-9b8e-1c2d3e4f5a6b',
  email: 'a@b.com',
  displayName: '小明',
  defaultLedgerId: LEDGER,
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const cat = (n: number, over: Record<string, unknown>) => ({
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

const CATEGORIES = [
  cat(1, { name: '餐饮', presetKey: 'expense.food' }),
  cat(2, { name: '正餐', presetKey: 'expense.food.meal', parentId: id(1) }),
  cat(3, { name: '宠物', transactionCount: 3 }),
  cat(4, { name: '临时' }),
  cat(5, { name: '工资', group: 'income', presetKey: 'income.salary' }),
  cat(6, { name: '理财申购赎回', group: 'neutral', presetKey: 'neutral.invest' }),
];

type Reply = { status: number; body?: unknown };
interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** 模拟服务端：/me 返回已登录用户，其余交给 handler；返回记录下来的请求 */
function mockServer(handler: (method: string, url: string, body: unknown) => Reply | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const r = url === '/api/auth/me' ? { status: 200, body: USER } : (handler(method, url, body) ?? { status: 404 });
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
    }),
  );
  return calls;
}

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('deleteBlockReason', () => {
  it.each([
    [{ presetKey: 'expense.food' }, false, '预置分类不能删除，可以隐藏'],
    [{}, true, '请先删除它的子分类（目前不支持移动分类）'],
    [{ transactionCount: 2 }, false, '已有 2 笔流水使用，不能删除，可以隐藏'],
    [{}, false, null],
  ])('%j 有子分类=%s → %s', (over, hasChildren, reason) => {
    expect(deleteBlockReason(cat(9, over) as never, hasChildren)).toBe(reason);
  });
});

describe('分类管理页', () => {
  const listHandler = (m: string, url: string) =>
    m === 'GET' && url === `/api/ledgers/${LEDGER}/categories` ? { status: 200, body: CATEGORIES } : undefined;

  it('正向：默认显示支出分类的两级树；预置、使用次数标签正确；预置分类的删除按钮不可用', async () => {
    mockServer(listHandler);
    renderAt('/categories');
    const food = await screen.findByTestId('category-餐饮');
    expect(within(food).getByText('预置')).toBeTruthy();
    expect(screen.getByTestId('category-正餐')).toBeTruthy();
    expect(within(screen.getByTestId('category-宠物')).getByText('3 笔')).toBeTruthy();
    const del = within(food).getByRole('button', { name: '删除' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toBe('预置分类不能删除，可以隐藏');
    expect(screen.queryByTestId('category-工资')).toBeNull();
  });

  it('正向：切换到中性页签，显示说明与中性分类', async () => {
    mockServer(listHandler);
    renderAt('/categories');
    fireEvent.click(await screen.findByRole('tab', { name: '中性' }));
    expect(screen.getByTestId('category-理财申购赎回')).toBeTruthy();
    expect(screen.getByText(/不计入收支统计/)).toBeTruthy();
  });

  it('正向：添加一级分类 → 发送正确的请求体', async () => {
    const calls = mockServer((m, url, body) =>
      m === 'POST' ? { status: 201, body: cat(7, body as object) } : listHandler(m, url),
    );
    renderAt('/categories');
    const input = await screen.findByLabelText('添加一级分类');
    fireEvent.change(input, { target: { value: ' 旅行 ' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toEqual({
      method: 'POST',
      url: `/api/ledgers/${LEDGER}/categories`,
      body: { group: 'expense', parentId: null, name: '旅行' },
    });
  });

  it('反向：改名时重名 → 显示服务端提示，并保持编辑状态（不丢失输入）', async () => {
    mockServer((m, url) =>
      m === 'PATCH'
        ? { status: 409, body: { error: '同一级下已有同名分类', code: 'CATEGORY_NAME_TAKEN' } }
        : listHandler(m, url),
    );
    renderAt('/categories');
    fireEvent.click(within(await screen.findByTestId('category-临时')).getByRole('button', { name: '改名' }));
    const input = screen.getByLabelText('分类名称');
    fireEvent.change(input, { target: { value: '餐饮' } });
    fireEvent.submit(input.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('同一级下已有同名分类');
    expect((screen.getByLabelText('分类名称') as HTMLInputElement).value).toBe('餐饮');
  });

  it('正向：隐藏 → 发送 PATCH { hidden: true }', async () => {
    const calls = mockServer((m, url) =>
      m === 'PATCH' ? { status: 200, body: cat(4, { hidden: true }) } : listHandler(m, url),
    );
    renderAt('/categories');
    fireEvent.click(within(await screen.findByTestId('category-临时')).getByRole('button', { name: '隐藏' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({
      method: 'PATCH',
      url: `/api/ledgers/${LEDGER}/categories/${id(4)}`,
      body: { hidden: true },
    });
  });

  it('正向：删除未使用的自建分类 → 确认后发送 DELETE；取消确认则不发送', async () => {
    const calls = mockServer((m, url) => (m === 'DELETE' ? { status: 204 } : listHandler(m, url)));
    renderAt('/categories');
    const row = await screen.findByTestId('category-临时');
    vi.stubGlobal('confirm', () => false);
    fireEvent.click(within(row).getByRole('button', { name: '删除' }));
    expect(writes(calls)).toHaveLength(0);
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(within(row).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(writes(calls)[0]).toMatchObject({ method: 'DELETE' }));
  });
});

describe('资金账户页', () => {
  const account = (n: number, over: Record<string, unknown>) => ({
    id: id(n),
    name: `账户${n}`,
    kind: 'wechat',
    institution: null,
    cardLast4: null,
    sort: n,
    archived: false,
    transactionCount: 0,
    ...over,
  });
  const listOf = (items: unknown[]) => (m: string, url: string) =>
    m === 'GET' && url === `/api/ledgers/${LEDGER}/accounts` ? { status: 200, body: items } : undefined;

  it('正向：没有账户时显示引导文字', async () => {
    mockServer(listOf([]));
    renderAt('/accounts');
    expect(await screen.findByText('还没有账户，先在下面添加一个吧。')).toBeTruthy();
  });

  it('反向：银行卡的卡号后四位不合法 → 显示错误，不发送请求', async () => {
    const calls = mockServer(listOf([]));
    renderAt('/accounts');
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '招行' } });
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'bank_debit' } });
    fireEvent.change(screen.getByLabelText('卡号后四位'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    expect((await screen.findByRole('alert')).textContent).toBe('卡号后四位必须是 4 位数字');
    expect(writes(calls)).toHaveLength(0);
  });

  it('正向：添加银行卡 → 请求体包含卡号后四位，空的机构传 null', async () => {
    const calls = mockServer((m, url, body) =>
      m === 'POST' ? { status: 201, body: account(1, body as object) } : listOf([])(m, url),
    );
    renderAt('/accounts');
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '招行储蓄卡' } });
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'bank_debit' } });
    fireEvent.change(screen.getByLabelText('卡号后四位'), { target: { value: '1032' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]!.body).toEqual({
      name: '招行储蓄卡',
      kind: 'bank_debit',
      institution: null,
      cardLast4: '1032',
    });
  });

  it('正向 + 反向：已使用的账户删除按钮不可用；可以停用', async () => {
    const calls = mockServer((m, url) =>
      m === 'PATCH'
        ? { status: 200, body: account(1, { name: '微信', archived: true, transactionCount: 5 }) }
        : listOf([account(1, { name: '微信', transactionCount: 5 })])(m, url),
    );
    renderAt('/accounts');
    const row = await screen.findByTestId('account-微信');
    const del = within(row).getByRole('button', { name: '删除' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(del.title).toContain('可以停用');
    fireEvent.click(within(row).getByRole('button', { name: '停用' }));
    await waitFor(() => expect(writes(calls)[0]).toMatchObject({ method: 'PATCH', body: { archived: true } }));
  });
});
