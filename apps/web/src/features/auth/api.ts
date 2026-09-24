/**
 * 鉴权相关的请求与查询（docs/auth.md §6）
 */
import { type CurrentUser, currentUserSchema, type LoginRequest, type RegisterRequest } from '@bookkeepx/contracts';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, apiSend } from '../../shared/api/client.ts';

/** 当前用户在 TanStack Query 中的缓存键 */
export const ME_QUERY_KEY = ['auth', 'me'] as const;

/** 获取当前用户；未登录（401）返回 null，其他错误照常抛出 */
export async function fetchMe(): Promise<CurrentUser | null> {
  try {
    return await apiGet('/api/auth/me', currentUserSchema);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

export const login = (body: LoginRequest) => apiSend('POST', '/api/auth/login', body, currentUserSchema);
export const register = (body: RegisterRequest) => apiSend('POST', '/api/auth/register', body, currentUserSchema);
export const logout = () => apiSend('POST', '/api/auth/logout', {}, null);

/** 当前用户（带缓存）；data 为 null 表示未登录 */
export function useCurrentUser() {
  return useQuery({ queryKey: ME_QUERY_KEY, queryFn: fetchMe, retry: false, staleTime: 60_000 });
}
