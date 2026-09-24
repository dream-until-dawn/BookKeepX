# BookKeepX

预期实现 AI 记账 agent 的应用。首个可用版：手动记账 / 上传账单表格导入 + 统计展示。

> 当前阶段：**P0 设计与可行性验证**

## 文档

- [架构设计](docs/architecture.md)
- [分期路线图](docs/roadmap.md)
- [开发约定](docs/conventions.md)
- 架构决策记录（ADR）
  - [ADR-0001 技术选型](docs/adr/0001-tech-stack.md)
  - [ADR-0002 金额以整数分存储](docs/adr/0002-money-as-integer-cents.md)
  - [ADR-0003 导入解析模板体系](docs/adr/0003-import-templates.md)
  - [ADR-0004 统一分类与自动分类规则](docs/adr/0004-categories-and-rules.md)
- 探针结论
  - [P0-1 账单解析](docs/probes/p0-1-import-parsing.md)
  - [P0-1b/1c 解析模板体系与统一分类](docs/probes/p0-1bc-templates-and-categories.md)

## 技术栈（提议中）

TypeScript 单仓 · React + Vite · Fastify · PostgreSQL + Drizzle · Docker 自托管
