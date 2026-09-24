/**
 * 需要登录的页面外壳：未登录时跳转到 /login?next=当前地址
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useCurrentUser } from './api.ts';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isPending, error } = useCurrentUser();
  const location = useLocation();

  if (isPending) return <p className="p-6 text-gray-500">正在加载…</p>;
  if (error) {
    return (
      <p role="alert" className="p-6 text-red-600">
        无法获取登录状态：{error.message}
      </p>
    );
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
