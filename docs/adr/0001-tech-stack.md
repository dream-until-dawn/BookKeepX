# ADR-0001 技术选型

- 状态：提议中（待确认）
- 日期：2026-09-24

## 背景

项目从零开始。已确认的前提：首版带服务端、多用户注册登录、PostgreSQL、Docker 自托管、React、PWA 先行（后续 Capacitor 打包成 App）。最终目标是记账 agent。

## 决策

| 领域 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（前后端统一） | 领域逻辑（金额、导入解析、统计口径）只写一份，前后端共享；维护者只需掌握一门语言 |
| 仓库 | pnpm workspace 单仓（monorepo） | 模块边界清晰，共享包无需发布 |
| 前端 | React + Vite + React Router + TanStack Query | 主流、生态大；TanStack Query 负责服务端数据缓存 |
| UI | Tailwind CSS + shadcn/ui | 组件源码在仓库内，可控可改 |
| 图表 | ECharts | 中文生态好，饼图 / 折线 / 日历热力图齐全 |
| 后端 | Fastify | 性能好、插件体系清晰、原生支持 JSON Schema / zod 校验 |
| ORM / 迁移 | Drizzle ORM + drizzle-kit | 类型安全、SQL 透明、迁移文件可审阅 |
| 数据库 | PostgreSQL 16+ | 用户指定；聚合统计能力强 |
| 校验 / 契约 | zod（放在 packages/contracts） | 一份定义同时用于运行时校验与类型推导 |
| 账单解析 | exceljs（xlsx）+ PapaParse（csv）+ iconv-lite（GBK）+ pdfjs-dist（PDF 文字层） | ✅ P0-1 已验证；不用 SheetJS：npm 版本停在有已知漏洞的 0.18.5 |
| 密码 | argon2id（@node-rs/argon2，预编译无需本地编译） | 需 P0 验证 Windows / Docker 下可安装 |
| 测试 | Vitest（单元 / 集成）+ Testcontainers 或 compose 测试库 + Playwright（E2E，P1 后段） | 集成测试打真实 PostgreSQL，不用 mock 库 |
| 部署 | Docker 多阶段构建 + docker compose（server + postgres），前端静态资源由 server 托管 | 自托管一条命令启动 |

## 被否决的备选

- **Python + FastAPI**：agent 生态更好，但领域逻辑需前后端两份实现；P3 若确需 Python 能力，可以独立 worker 形式引入，不影响主干。
- **Go**：部署轻，但无法与前端共享代码，且用户对后端不熟，多一门语言增加维护负担。
- **Next.js 全栈**：前后端耦合在一个框架内，后续 Capacitor / 独立 API 给 App 用时边界不如分离清晰。
- **Prisma**：生成客户端较重、复杂聚合 SQL 需绕行；Drizzle 更贴近 SQL，统计查询友好。

## 后果

- 需要 P0 探针验证：pnpm workspace + Vitest、Drizzle 迁移与 bigint 往返、argon2 安装、~~表格解析~~（P0-1 已完成）。
- 若探针失败，更新本 ADR 再继续。
