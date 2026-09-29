/** 安装和更新必须由用户操作，离线接口不能伪装为成功页面。 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PwaControls } from '../src/pwa/PwaControls.tsx';
import { canShowOfflinePage, isApiRequest } from '../src/pwa/policy.ts';

const mock = vi.hoisted(() => ({
  update: vi.fn(),
  start: vi.fn(),
  callbacks: {} as { onNeedRefresh: () => void; onError: () => void },
}));
vi.mock('../src/pwa/register.ts', () => ({ startPwa: mock.start }));
beforeEach(() => {
  mock.update.mockReset().mockResolvedValue(undefined);
  mock.start.mockReset().mockImplementation((callbacks) => {
    mock.callbacks = callbacks;
    return mock.update;
  });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: false });
});
afterEach(cleanup);
describe('PWA 缓存边界', () => {
  it.each(['/api', '/api/auth/me?x=1'])('同源接口 %s 必须绕过缓存', (path) => {
    expect(isApiRequest(new URL(path, 'https://example.test'), 'https://example.test')).toBe(true);
    expect(canShowOfflinePage({ mode: 'navigate', url: `https://example.test${path}` })).toBe(false);
  });
  it('只允许普通页面导航回退离线页', () => {
    expect(isApiRequest(new URL('https://other.test/api'), 'https://example.test')).toBe(false);
    expect(isApiRequest(new URL('https://example.test/apiary'), 'https://example.test')).toBe(false);
    expect(canShowOfflinePage({ mode: 'navigate', url: 'https://example.test/stats' })).toBe(true);
    expect(canShowOfflinePage({ mode: 'cors', url: 'https://example.test/assets/missing.js' })).toBe(false);
  });
});
describe('PWA 用户操作', () => {
  it('StrictMode 只注册一次；新版本和稍后操作均不得触发更新', async () => {
    render(
      <StrictMode>
        <PwaControls />
      </StrictMode>,
    );
    expect(mock.start).toHaveBeenCalledTimes(1);
    act(() => mock.callbacks.onNeedRefresh());
    expect(mock.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('稍后'));
    expect(mock.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('有新版本'));
    fireEvent.click(screen.getByText('刷新更新'));
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith(true));
  });
  it('更新失败明确提示，允许重试', async () => {
    mock.update.mockRejectedValueOnce(new Error('offline'));
    render(<PwaControls />);
    act(() => mock.callbacks.onNeedRefresh());
    fireEvent.click(screen.getByText('刷新更新'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '更新失败，请联网后重试。');
  });
  it.each(['accepted', 'dismissed'])('安装结果 %s 不会被误当成已安装事件', async (outcome) => {
    render(<PwaControls />);
    const prompt = vi.fn().mockResolvedValue(undefined);
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome }),
    });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('安装 BookKeepX'));
    await waitFor(() => expect(screen.queryByText('安装 BookKeepX')).toBeNull());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(screen.getByText('如何安装到桌面')).toBeTruthy();
    act(() => window.dispatchEvent(new Event('appinstalled')));
    expect(screen.queryByText('如何安装到桌面')).toBeNull();
  });
  it('安装窗口失败不会宣称成功', async () => {
    render(<PwaControls />);
    act(() =>
      window.dispatchEvent(
        Object.assign(new Event('beforeinstallprompt'), {
          prompt: vi.fn().mockRejectedValue(new Error('denied')),
          userChoice: Promise.resolve({ outcome: 'dismissed' }),
        }),
      ),
    );
    fireEvent.click(screen.getByText('安装 BookKeepX'));
    expect((await screen.findByRole('alert')).textContent).toContain('未能打开安装窗口');
  });
  it('独立运行隐藏安装入口，断网/恢复状态准确', () => {
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    render(<PwaControls />);
    expect(screen.queryByText('如何安装到桌面')).toBeNull();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));
    expect(screen.getByRole('status').textContent).toContain('不会自动保存或补交');
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    act(() => window.dispatchEvent(new Event('online')));
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('卸载移除事件监听，注册失败可继续在线使用', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = render(<PwaControls />);
    act(() => mock.callbacks.onError());
    expect(screen.getByRole('alert').textContent).toContain('可继续在线使用');
    view.unmount();
    for (const name of ['beforeinstallprompt', 'appinstalled', 'online', 'offline'])
      expect(remove).toHaveBeenCalledWith(name, expect.any(Function));
    remove.mockRestore();
  });
});
