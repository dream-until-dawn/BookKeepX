/** 生产环境注册入口；开发和不支持 SW 的浏览器不创建缓存。 */
import { registerSW } from 'virtual:pwa-register';
export interface UpdateCallbacks {
  onNeedRefresh: () => void;
  onError: () => void;
}
/** 返回显式更新动作，不自动刷新表单页面。 */
export function startPwa(callbacks: UpdateCallbacks): (reloadPage?: boolean) => Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return async () => {};
  let approved = false;
  let activatedElsewhere = false;
  let controlled = navigator.serviceWorker.controller !== null;
  // 原生事件也覆盖由其他标签页安装的更新；首次接管不算版本更新。
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    if (approved) window.location.reload();
    else {
      activatedElsewhere = true;
      callbacks.onNeedRefresh();
    }
  });
  const update = registerSW({
    immediate: true,
    onNeedRefresh: callbacks.onNeedRefresh,
    onRegisterError: callbacks.onError,
    // 其他标签页选择更新时，不能刷新本页未保存的表单。
    onNeedReload: () => {},
  });
  return async () => {
    approved = true;
    if (activatedElsewhere) {
      window.location.reload();
      return;
    }
    try {
      await update(true);
    } catch (error) {
      approved = false;
      throw error;
    }
  };
}
