/**
 * 应用根组件：全局 Provider + 路由
 *
 * 新增页面时在 routes 中登记；页面本身放在 features/<功能>/ 下。
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { HomePage } from '../features/home/HomePage.tsx';

const routes = [{ path: '/', element: <HomePage /> }];

export function App({ queryClient = new QueryClient() }: { queryClient?: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createBrowserRouter(routes)} />
    </QueryClientProvider>
  );
}
