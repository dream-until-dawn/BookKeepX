/**
 * 应用根组件：全局 Provider + 路由（路由表见 routes.tsx）
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { routes } from './routes.tsx';

export function App() {
  // 只创建一次，避免重新渲染时丢失缓存和路由状态
  const [queryClient] = useState(() => new QueryClient());
  const [router] = useState(() => createBrowserRouter(routes));
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
