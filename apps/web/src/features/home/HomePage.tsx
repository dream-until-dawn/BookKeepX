/** 首页（骨架阶段只显示服务状态；P1 后续步骤替换为记账概览） */
import { HealthStatus } from '../health/HealthStatus.tsx';

export function HomePage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-2 text-2xl font-semibold">BookKeepX 记账</h1>
      <p className="mb-6 text-gray-600">手动记账、导入账单、查看统计 —— 开发中</p>
      <HealthStatus />
    </main>
  );
}
