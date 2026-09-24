/**
 * 路由表：/login、/register 公开，其余页面需要登录
 * 新增页面：页面组件放在 features/<功能>/ 下，然后在这里登记。
 */
import type { RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RegisterPage } from '../features/auth/RegisterPage.tsx';
import { RequireAuth } from '../features/auth/RequireAuth.tsx';
import { HomePage } from '../features/home/HomePage.tsx';
import { AppLayout } from './AppLayout.tsx';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [{ path: '/', element: <HomePage /> }],
  },
];
