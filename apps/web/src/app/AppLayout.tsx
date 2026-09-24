/**
 * 登录后的页面布局：顶部栏（应用名、当前用户、退出）+ 页面内容
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { logout, ME_QUERY_KEY, useCurrentUser } from '../features/auth/api.ts';

/** 顶部导航；新增页面时在这里加一项 */
const NAV = [
  { to: '/', label: '首页' },
  { to: '/categories', label: '分类' },
  { to: '/accounts', label: '账户' },
];

export function AppLayout() {
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
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <nav className="flex items-center gap-4">
            <span className="font-semibold">BookKeepX 记账</span>
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end
                className={({ isActive }) =>
                  `text-sm ${isActive ? 'font-medium text-blue-600' : 'text-gray-600 hover:text-gray-900'}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-gray-600" data-testid="current-user">
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
