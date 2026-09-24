/** 首页（P1 后续步骤替换为记账概览） */
import { useCurrentUser } from '../auth/api.ts';
import { HealthStatus } from '../health/HealthStatus.tsx';

export function HomePage() {
  const { data: user } = useCurrentUser();
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-semibold">你好，{user?.displayName}</h1>
      <p className="mb-6 text-gray-600">手动记账、导入账单、查看统计 —— 开发中</p>
      <HealthStatus />
    </main>
  );
}
