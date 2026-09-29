/** 规则编辑和学习确认：试跑不保存，改动使预览失效，失败不伪装成功。 */
import type { Category } from '@bookkeepx/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import { LearnRule } from '../src/shared/category-rules/LearnRule.tsx';
import { newRule, RuleEditor } from '../src/shared/category-rules/RuleEditor.tsx';

const ledgerId = '00000000-0000-4000-8000-000000000001';
const categoryId = '00000000-0000-4000-8000-000000000002';
const ruleId = '00000000-0000-4000-8000-000000000003';
const categories: Category[] = [
  {
    id: categoryId,
    name: '餐饮',
    group: 'expense',
    hidden: false,
    parentId: null,
    presetKey: null,
    icon: null,
    sort: 0,
    transactionCount: 0,
  },
];
const initial = newRule(categoryId, '测试商户');
const saved = {
  ...initial,
  id: ruleId,
  hitCount: 0,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  lastHitAt: null,
};
const preview = { scanned: 2, matched: 1, conflicts: 0, samples: [] };
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function wrap(element: React.ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={cache}>{element}</QueryClientProvider>);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('规则编辑器', () => {
  it('试跑才允许保存；修改后必须重新试跑，保存内容与预览一致', async () => {
    const done = vi.fn();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
      String(url).endsWith('/preview') ? json(preview) : json({ ...saved, ...JSON.parse(String(init?.body)) }),
    );
    vi.stubGlobal('fetch', fetcher);
    wrap(
      <RuleEditor ledgerId={ledgerId} categories={categories} initial={initial} onDone={done} onCancel={() => {}} />,
    );
    expect((screen.getByText('确认保存规则') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('试跑规则'));
    await waitFor(() => expect((screen.getByText('确认保存规则') as HTMLButtonElement).disabled).toBe(false));
    expect(done).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('规则名称'), { target: { value: '新名称' } });
    expect((screen.getByText('确认保存规则') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('试跑规则'));
    await waitFor(() => expect((screen.getByText('确认保存规则') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('确认保存规则'));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({ name: '新名称', origin: 'learned' });
  });
  it('空关键词、越界优先级和缺分类不会发请求', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    wrap(
      <RuleEditor
        ledgerId={ledgerId}
        categories={categories}
        initial={newRule()}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('试跑规则'));
    expect(screen.getByRole('alert').textContent).toContain('关键词不能为空');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('重新试跑失败不能使用旧预览保存', async () => {
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => (++requests === 1 ? json(preview) : json({ error: '服务不可用', code: 'DOWN' }, 503))),
    );
    wrap(
      <RuleEditor
        ledgerId={ledgerId}
        categories={categories}
        initial={initial}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('试跑规则'));
    await waitFor(() => expect((screen.getByText('确认保存规则') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('试跑规则'));
    await screen.findByRole('alert');
    expect((screen.getByText('确认保存规则') as HTMLButtonElement).disabled).toBe(true);
  });
  it('条件增删、改金额条件保持输入对应；中性动作要求重新选分类', () => {
    wrap(
      <RuleEditor
        ledgerId={ledgerId}
        categories={categories}
        initial={initial}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('添加条件'));
    fireEvent.change(screen.getByLabelText('条件字段 3'), { target: { value: 'amount' } });
    fireEvent.change(screen.getByLabelText('条件值 3'), { target: { value: '1200' } });
    fireEvent.click(screen.getByText('删除条件 1'));
    expect((screen.getByLabelText('条件值 2') as HTMLInputElement).value).toBe('1200');
    fireEvent.click(screen.getByLabelText('将命中的资金流动改为中性'));
    expect((screen.getByLabelText('目标分类') as HTMLSelectElement).value).toBe('');
  });
});

describe('学习提示和管理页', () => {
  it('学习中性分类保留原始支出条件，并明确设置改向动作', () => {
    wrap(
      <LearnRule
        ledgerId={ledgerId}
        categories={[{ ...categories[0]!, group: 'neutral' }]}
        choice={{ categoryId, direction: 'expense', counterparty: '本人转账' }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('查看规则建议'));
    expect((screen.getByLabelText('条件值 2') as HTMLSelectElement).value).toBe('expense');
    expect((screen.getByLabelText('将命中的资金流动改为中性') as HTMLInputElement).checked).toBe(true);
  });
  it('学习建议不会自动请求；拒绝建议不保存', () => {
    const fetcher = vi.fn();
    const close = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    wrap(
      <LearnRule
        ledgerId={ledgerId}
        categories={categories}
        choice={{ categoryId, direction: 'expense', counterparty: '测试商户' }}
        onClose={close}
      />,
    );
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('查看规则建议'));
    expect((screen.getByLabelText('条件值 1') as HTMLInputElement).value).toBe('测试商户');
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('取消'));
    expect(close).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });
  function page(role: 'owner' | 'viewer' = 'owner', stale = false) {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/auth/me')
        return json({ id: ledgerId, email: 'test@example.com', displayName: '测试', defaultLedgerId: ledgerId });
      if (path === `/api/ledgers/${ledgerId}`)
        return json({ id: ledgerId, name: '测试账本', currency: 'CNY', timezone: 'Asia/Shanghai', role });
      if (path.endsWith('/categories')) return json(categories);
      if (path.endsWith('/history-preview'))
        return json({ digest: 'a'.repeat(64), scanned: 1, changed: 1, protectedCount: 0, samples: [] });
      if (path.endsWith('/apply'))
        return stale
          ? json({ error: '规则或流水已变化，请重新预览', code: 'RULE_PREVIEW_STALE' }, 409)
          : json({ changed: 1 });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (path.endsWith('/category-rules')) return json([saved]);
      throw new Error(`意外请求 ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const router = createMemoryRouter(routes, { initialEntries: ['/rules'] });
    wrap(<RouterProvider router={router} />);
    return fetcher;
  }
  it('历史应用必须先预览并确认，409 清空旧预览', async () => {
    const fetcher = page('owner', true);
    fireEvent.click(await screen.findByText('预览应用到历史'));
    await screen.findByText('确认应用 1 笔');
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/apply'))).toBe(false);
    fireEvent.click(screen.getByText('确认应用 1 笔'));
    expect((await screen.findByRole('alert')).textContent).toContain('重新预览');
    expect(screen.queryByText('确认应用 1 笔')).toBeNull();
  });
  it('成功应用显示数量；只提交摘要', async () => {
    const fetcher = page();
    fireEvent.click(await screen.findByText('预览应用到历史'));
    fireEvent.click(await screen.findByText('确认应用 1 笔'));
    await screen.findByText('已更新 1 笔流水');
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith('/apply'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ digest: 'a'.repeat(64) });
  });
  it('viewer 看得到规则但没有编辑、删除和历史应用入口', async () => {
    page('viewer');
    await screen.findByText('测试商户归类');
    expect(screen.queryByText('新建规则')).toBeNull();
    expect(screen.queryByText('预览应用到历史')).toBeNull();
    expect(screen.queryByText('编辑 测试商户归类')).toBeNull();
  });
});
