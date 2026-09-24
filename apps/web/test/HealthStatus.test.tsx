/**
 * 服务状态组件：正常 / 数据库不可用 / 服务不可达 / 响应不符合契约
 * 前端单元测试只模拟 fetch；真实前后端联调在 E2E（P1-12）中覆盖。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthStatus } from '../src/features/health/HealthStatus.tsx';

/** 让 fetch 返回指定状态码和 body */
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

function renderStatus() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HealthStatus />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HealthStatus', () => {
  it('正向：服务正常 → 显示版本号', async () => {
    mockFetch(200, { status: 'ok', database: 'up', version: '0.1.0' });
    renderStatus();
    expect(await screen.findByText('服务正常 · v0.1.0')).toBeTruthy();
  });

  it('正向：503 且 body 合法 → 显示数据库不可用，而不是当成请求失败', async () => {
    mockFetch(503, { status: 'degraded', database: 'down', version: '0.1.0' });
    renderStatus();
    expect(await screen.findByText('数据库暂不可用 · v0.1.0')).toBeTruthy();
  });

  it('反向：网络不通 → 提示无法连接', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderStatus();
    expect(await screen.findByText('服务不可用：无法连接服务器，请检查网络')).toBeTruthy();
  });

  it('反向：响应结构不符合契约 → 报错，不把错误数据显示出来', async () => {
    mockFetch(200, { status: 'ok', version: 123 });
    renderStatus();
    expect(await screen.findByText('服务不可用：服务器返回的数据格式不符合约定')).toBeTruthy();
  });

  it('反向：500 → 显示服务端给出的错误信息', async () => {
    mockFetch(500, { error: '服务器内部错误' });
    renderStatus();
    expect(await screen.findByText('服务不可用：服务器内部错误')).toBeTruthy();
  });
});
