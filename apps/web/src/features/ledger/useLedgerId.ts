/**
 * 当前使用的账本 id
 *
 * MVP 阶段每个用户只有一个默认账本（ADR-0006），界面上不提供切换；
 * 以后开放多账本时，只需要改这里（例如从地址或本地设置中读取当前账本）。
 */
import { useCurrentUser } from '../auth/api.ts';

export function useLedgerId(): string | null {
  const { data: user } = useCurrentUser();
  return user?.defaultLedgerId ?? null;
}
