# BookKeepX

预期实现 AI 记账 agent 的应用。首个可用版：手动记账 / 上传账单表格导入 + 统计展示。

> 当前阶段：**P1 MVP 开发**（P0 已完成，见 tag `v0.0.1`）

## 开发

环境要求：Node.js 22+、pnpm 12、Docker。

```bash
pnpm install          # 安装依赖
cp .env.example .env  # 首次：复制环境变量
pnpm db:up            # 启动开发数据库（PostgreSQL 16，端口 54320；同时创建测试库）
pnpm dev              # 同时启动服务端（3000）和前端（5173），打开 http://localhost:5173
```

提交前必须通过（CI 会同样检查）：

```bash
pnpm check        # 格式与代码检查（Biome）；pnpm check:fix 自动修复
pnpm typecheck    # 类型检查
pnpm test         # 全部测试（服务端测试需要 pnpm db:up）
```

目录：`apps/server` 服务端、`apps/web` 前端、`packages/core` 领域核心、`packages/contracts` 接口契约、`probes/` P0 探针（不参与正式构建）。

## 文档

- [架构设计](docs/architecture.md)
- [分期路线图](docs/roadmap.md)
- [开发约定](docs/conventions.md)
- [P1 实施计划](docs/p1-plan.md)
- 架构决策记录（ADR）
  - [ADR-0001 技术选型](docs/adr/0001-tech-stack.md)
  - [ADR-0002 金额以整数分存储](docs/adr/0002-money-as-integer-cents.md)
  - [ADR-0003 导入解析模板体系](docs/adr/0003-import-templates.md)
  - [ADR-0004 统一分类与自动分类规则](docs/adr/0004-categories-and-rules.md)
  - [ADR-0005 代码检查与格式化：Biome](docs/adr/0005-lint-and-format.md)
- 探针结论
  - [P0-1 账单解析](docs/probes/p0-1-import-parsing.md)
  - [P0-1b/1c 解析模板体系与统一分类](docs/probes/p0-1bc-templates-and-categories.md)
  - [P0-1d 多份历史样本验证](docs/probes/p0-1d-more-samples.md)
  - [P0-1e 退款关联与冲减支出](docs/probes/p0-1e-refunds.md)
  - [P0-2~5 数据库 / 鉴权 / 单仓 / 图表](docs/probes/p0-2-5-stack.md)

## 技术栈（提议中）

TypeScript 单仓 · React + Vite · Fastify · PostgreSQL + Drizzle · Docker 自托管
