/**
 * 前端鉴权流程：未登录跳转、表单校验、服务端错误提示、登录后跳回、退出
 * 只模拟 fetch；真实前后端联调在浏览器中验证，并在 E2E（P1-12）中覆盖。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../src/app/routes.tsx';
import { safeNext } from '../src/features/auth/useAuthForm.ts';

const USER = {
  id: '0b3f5a1e-6c2d-4f7a-9b8e-1c2d3e4f5a6b',
  email: 'a@b.com',
  displayName: '小明',
  defaultLedgerId: null,
};

type Handler = (method: string, url: string, body: unknown) => { status: number; body?: unknown };

/** 按"方法 + 路径"模拟服务端；返回记录下来的全部请求 */
function mockServer(handler: Handler) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, headers: (init.headers ?? {}) as Record<string, string>, body });
      const r = handler(method, url, body);
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

const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('未登录访问', () => {
  it('反向：未登录访问首页 → 跳转到登录页，并记住原地址', async () => {
    mockServer(() => ({ status: 401, body: { error: '请先登录', code: 'UNAUTHENTICATED' } }));
    const router = renderAt('/');
    expect(await screen.findByRole('heading', { name: '登录' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?next=%2F');
  });

  it('正向：已登录访问首页 → 显示问候和当前用户', async () => {
    mockServer((_method, url) =>
      url === '/api/auth/me'
        ? { status: 200, body: USER }
        : { status: 200, body: { status: 'ok', database: 'up', version: '0.1.0' } },
    );
    renderAt('/');
    expect(await screen.findByText('你好，小明')).toBeTruthy();
  });
});

describe('登录页', () => {
  it('反向：邮箱格式不对 → 显示字段错误，且不发送登录请求', async () => {
    const calls = mockServer(() => ({ status: 401 }));
    renderAt('/login');
    type(/邮箱/, 'not-an-email');
    type(/密码/, 'whatever');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('邮箱格式不正确')).toBeTruthy();
    expect(calls.filter((c) => c.url === '/api/auth/login')).toHaveLength(0);
  });

  it('反向：服务端返回 401 → 显示"邮箱或密码错误"', async () => {
    mockServer((_method, url) =>
      url === '/api/auth/login'
        ? { status: 401, body: { error: '邮箱或密码错误', code: 'INVALID_CREDENTIALS' } }
        : { status: 401 },
    );
    renderAt('/login');
    type(/邮箱/, 'a@b.com');
    type(/密码/, 'wrong password');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toBe('邮箱或密码错误');
  });

  it('正向：登录成功 → 请求带 CSRF 头与规范化后的邮箱，并跳回原地址', async () => {
    let loggedIn = false;
    const calls = mockServer((_method, url) => {
      if (url === '/api/auth/login') {
        loggedIn = true;
        return { status: 200, body: USER };
      }
      if (url === '/api/auth/me') return loggedIn ? { status: 200, body: USER } : { status: 401 };
      return { status: 200, body: { status: 'ok', database: 'up', version: '0.1.0' } };
    });
    const router = renderAt('/login?next=%2F');
    type(/邮箱/, '  A@B.com ');
    type(/密码/, 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('你好，小明')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
    const req = calls.find((c) => c.url === '/api/auth/login')!;
    expect(req.headers['x-bookkeepx-client']).toBe('web');
    expect(req.body).toEqual({ email: 'a@b.com', password: 'correct horse' });
  });
});

describe('注册页', () => {
  it('反向：邮箱已注册 → 显示服务端提示', async () => {
    mockServer((_method, url) =>
      url === '/api/auth/register'
        ? { status: 409, body: { error: '该邮箱已注册', code: 'EMAIL_TAKEN' } }
        : { status: 401 },
    );
    renderAt('/register');
    type(/昵称/, '小明');
    type(/邮箱/, 'a@b.com');
    type(/密码/, 'correct horse');
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect((await screen.findByRole('alert')).textContent).toBe('该邮箱已注册');
  });

  it('反向：密码太短、昵称为空 → 同时显示两个字段错误', async () => {
    mockServer(() => ({ status: 401 }));
    renderAt('/register');
    type(/邮箱/, 'a@b.com');
    type(/密码/, 'short');
    fireEvent.click(screen.getByRole('button', { name: '注册' }));
    expect(await screen.findByText('密码至少 8 个字符')).toBeTruthy();
    expect(screen.getByText('请填写昵称')).toBeTruthy();
  });
});

describe('退出', () => {
  it('正向：点击退出 → 发送带 CSRF 头的退出请求，回到登录页', async () => {
    let loggedIn = true;
    const calls = mockServer((_method, url) => {
      if (url === '/api/auth/logout') {
        loggedIn = false;
        return { status: 204 };
      }
      if (url === '/api/auth/me') return loggedIn ? { status: 200, body: USER } : { status: 401 };
      return { status: 200, body: { status: 'ok', database: 'up', version: '0.1.0' } };
    });
    const router = renderAt('/');
    fireEvent.click(await screen.findByRole('button', { name: '退出' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.find((c) => c.url === '/api/auth/logout')!.headers['x-bookkeepx-client']).toBe('web');
  });
});

describe('safeNext（防开放重定向）', () => {
  it.each([
    ['/', '/'],
    ['/transactions?month=2026-09', '/transactions?month=2026-09'],
    [null, '/'],
    ['https://evil.com', '/'],
    ['//evil.com/path', '/'],
    ['javascript:alert(1)', '/'],
  ])('%j → %s', (input, output) => {
    expect(safeNext(input)).toBe(output);
  });
});
