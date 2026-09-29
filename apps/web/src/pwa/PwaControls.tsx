/** 安装、离线与更新提示，不读取或持久化任何账单数据。 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../shared/ui/index.tsx';
import { startPwa } from './register.ts';

/** Chromium 提供的安装事件；未支持该事件时保留手动安装说明。 */
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
function standalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
/** 全局状态条放在路由外，登录页也能安装和看到离线状态。 */
export function PwaControls() {
  const [installed, setInstalled] = useState(standalone);
  const [installEvent, setInstallEvent] = useState<InstallEvent | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [updateReady, setUpdateReady] = useState(false);
  const [postponed, setPostponed] = useState(false);
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const update = useRef<(reload?: boolean) => Promise<void>>(async () => {});
  const started = useRef(false);
  useEffect(() => {
    const install = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as InstallEvent);
    };
    const installed = () => {
      setInstalled(true);
      setInstallEvent(null);
    };
    const network = () => setOffline(!navigator.onLine);
    window.addEventListener('beforeinstallprompt', install);
    window.addEventListener('appinstalled', installed);
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    // StrictMode 会重复挂载 effect；同一组件生命周期只注册一次。
    if (!started.current) {
      started.current = true;
      update.current = startPwa({
        onNeedRefresh: () => {
          setUpdateReady(true);
          setPostponed(false);
        },
        onError: () => setError('应用安装准备失败，可继续在线使用。'),
      });
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', install);
      window.removeEventListener('appinstalled', installed);
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
    };
  }, []);
  const install = async () => {
    if (!installEvent) return;
    setBusy(true);
    setError('');
    try {
      await installEvent.prompt();
      await installEvent.userChoice;
    } catch {
      setError('未能打开安装窗口，请使用浏览器菜单安装。');
    } finally {
      setInstallEvent(null);
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    setError('');
    try {
      await update.current(true);
    } catch {
      setError('更新失败，请联网后重试。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside
      aria-label="应用状态"
      hidden={installed && !offline && !error && !updateReady}
      className="border-b border-gray-200 bg-white px-4 py-2 text-sm"
    >
      <div className="mx-auto max-w-5xl space-y-2">
        {offline && (
          <p role="status" className="text-amber-800">
            当前离线，记账、导入和统计需要联网；未提交的操作不会自动保存或补交。
          </p>
        )}
        {error && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!installed &&
            (installEvent ? (
              <Button disabled={busy || offline} onClick={install}>
                安装 BookKeepX
              </Button>
            ) : (
              <Button onClick={() => setHelp((v) => !v)} aria-expanded={help}>
                如何安装到桌面
              </Button>
            ))}
          {updateReady &&
            (postponed ? (
              <Button onClick={() => setPostponed(false)}>有新版本</Button>
            ) : (
              <>
                <span>新版本已准备好，请先保存正在编辑的内容，再刷新更新。</span>
                <Button disabled={busy || offline} onClick={refresh}>
                  刷新更新
                </Button>
                <Button disabled={busy} onClick={() => setPostponed(true)}>
                  稍后
                </Button>
              </>
            ))}
        </div>
        {help && !installed && (
          <p>
            支持的浏览器可在菜单中选择“安装应用”或“添加到主屏幕”。iPhone / iPad 请在 Safari
            的分享菜单中选择“添加到主屏幕”。安装后仍需联网使用。
          </p>
        )}
      </div>
    </aside>
  );
}
