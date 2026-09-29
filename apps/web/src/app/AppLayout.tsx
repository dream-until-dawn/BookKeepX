/**
 * 登录后的页面布局：顶部栏（应用名、当前用户、退出）+ 页面内容
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { logout, ME_QUERY_KEY, useCurrentUser } from '../features/auth/api.ts';

/** 顶部导航；新增页面时在这里加一项 */
const NAV = [
  { to: '/', label: '首页' },
  { to: '/transactions', label: '流水' },
  { to: '/stats', label: '统计' },
  { to: '/imports', label: '导入' },
  { to: '/categories', label: '分类' },
  { to: '/rules', label: '规则' },
  { to: '/accounts', label: '账户' },
];

export function AppLayout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: user } = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      // 无论服务端是否成功，前端都清掉登录态并回到登录页
      queryClient.setQueryData(ME_QUERY_KEY, null);
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' });
      navigate('/login', { replace: true });
    },
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="font-semibold whitespace-nowrap">BookKeepX 记账</span>
          <button
            type="button"
            className="rounded-md border border-gray-300 px-3 py-2 md:hidden"
            aria-expanded={menuOpen}
            aria-controls="app-navigation"
            onClick={() => setMenuOpen((v) => !v)}
          >
            菜单
          </button>
          <nav
            id="app-navigation"
            aria-label="主导航"
            className={`${menuOpen ? 'flex' : 'hidden'} order-3 w-full flex-wrap items-center gap-x-4 gap-y-2 md:order-none md:flex md:w-auto`}
          >
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end
                onClick={() => setMenuOpen(false)}
                className={({ isActive }) =>
                  `inline-flex min-h-11 items-center text-sm whitespace-nowrap ${isActive ? 'font-medium text-blue-600' : 'text-gray-600 hover:text-gray-900'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex max-w-full min-w-0 items-center gap-3 text-sm whitespace-nowrap">
            <span className="max-w-40 truncate text-gray-600" data-testid="current-user">
              {user?.displayName}
            </span>
            <button
              type="button"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              className="rounded-md px-2 py-1 text-gray-600 hover:bg-gray-100"
            >
              退出
            </button>
          </div>
        </div>
      </header>
      <Outlet />
    </div>
  );
}
