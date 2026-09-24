# P0-2 ~ P0-5 探针：技术栈验证

一个微型 pnpm 单仓，验证数据库链路、鉴权依赖、跨包引用、图表性能。结论见 [docs/probes/p0-2-5-stack.md](../../docs/probes/p0-2-5-stack.md)。

> 探针代码只用于验证可行性，不进入生产。

## 目录

| 路径 | 作用 |
|---|---|
| `packages/core` | 共享领域代码（金额工具），同时被 server 和 web 引用 |
| `apps/server` | Fastify + Drizzle + PostgreSQL + argon2；`drizzle/` 为生成的迁移 SQL |
| `apps/web` | Vite + React + ECharts 图表性能页；`bench/` 为 SSR 压力测试 |
| `docker/compose.yaml` | 测试用 PostgreSQL（端口 55432，数据放内存盘） |

## 运行

```bash
pnpm install
docker compose -f docker/compose.yaml up -d --wait   # 启动测试数据库
pnpm -r test                                          # 全部测试（server 测试需要数据库）
pnpm -r typecheck                                     # 跨包类型检查
pnpm --filter @bookkeepx/web build                    # 前端生产构建
pnpm --dir apps/web exec vite preview --port 5174     # 打开 /?n=3000&years=1 查看渲染耗时
pnpm --dir apps/web exec tsx bench/ssr-bench.ts       # 不同数据量下的渲染压力测试
docker compose -f docker/compose.yaml down            # 停止数据库
```
