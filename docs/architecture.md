# BookKeepX 架构设计（v0.1 草案）

> 状态：**草案，待确认**（已根据 [P0-1 探针结论](./probes/p0-1-import-parsing.md) 修订）。本文描述 MVP（P1）的目标架构，并为 P2/P3 预留扩展点。
> 关键决策的"为什么"见 [`adr/`](./adr) 目录。

## 1. 目标与边界

**MVP 要做到：**

1. 多用户注册 / 登录，数据按用户隔离；
2. 手动记账（收入 / 支出，含分类、资金账户、备注）；
3. 上传账单导入：微信支付账单（xlsx）、支付宝账单（csv）、银行流水（招行 PDF + 通用 csv/xlsx 字段映射）、BookKeepX 自定义模板；
4. 统计展示：月度收支汇总、分类占比、收支趋势；
5. Docker 自托管一键部署。

**MVP 明确不做：** agent / 大模型能力、多币种换算、预算、多账本协作、转账对冲、App 上架。

## 2. 总体结构

```
┌──────────────────────── 浏览器 / PWA（后续 Capacitor 打包成 App）────────────────────────┐
│  apps/web   React + Vite                                                               │
│    页面层 pages ─► 功能模块 features/* ─► API 客户端（基于 contracts 的类型）                │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │ HTTPS  JSON（Cookie 会话）
┌───────────────────────────────────────▼────────────────────────────────────────────────┐
│  apps/server   Fastify + TypeScript                                                    │
│    路由 routes ─► 应用服务 services ─► 仓储 repositories ─► Drizzle ORM ─► PostgreSQL     │
│                       │                                                                │
│                       └─► packages/core（导入解析、金额运算、统计口径 —— 纯函数）            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **packages/core 不依赖任何框架和 IO**：只收数据、吐数据，前后端都能用，测试成本最低。
- **packages/contracts** 用 zod 定义 API 的请求 / 响应结构，服务端用它做校验，前端用它推导类型——接口改了两端同时编译报错，杜绝"对不上"。
- 服务端内部三层：`routes`（HTTP 适配、鉴权、参数校验）→ `services`（业务规则、事务）→ `repositories`（只管读写库）。上层只依赖下层接口。

## 3. 目录规划

```
BookKeepX/
├─ apps/
│  ├─ web/                 前端（React + Vite + TanStack Query + React Router + ECharts）
│  │  └─ src/
│  │     ├─ app/           路由、全局布局、Provider
│  │     ├─ features/      按业务切分：auth / transactions / import / stats / categories
│  │     ├─ shared/        通用组件、hooks、API 客户端
│  │     └─ styles/
│  └─ server/              后端（Fastify + Drizzle + zod）
│     └─ src/
│        ├─ modules/       按业务切分，每个模块自带 routes / service / repository
│        │  ├─ auth/
│        │  ├─ transactions/
│        │  ├─ imports/
│        │  ├─ categories/
│        │  └─ stats/
│        ├─ db/            schema、迁移、连接
│        ├─ plugins/       Fastify 插件（会话、错误处理、日志）
│        └─ config/        环境变量读取与校验
├─ packages/
│  ├─ core/                领域核心（纯 TS）
│  │  └─ src/
│  │     ├─ money/         金额：分 ↔ 元、格式化、解析
│  │     ├─ importers/     导入管线 + 各来源适配器（wechat / alipay / bank / template）
│  │     └─ stats/         统计口径计算
│  └─ contracts/           API 契约（zod schema + 推导类型）
├─ probes/                 P0 可行性探针（一次性验证代码，不进生产）
├─ docker/                 Dockerfile、docker-compose
└─ docs/                   文档（本目录）
```

新增一种业务能力 = 在 `modules/` 和 `features/` 各加一个目录；新增一种账单来源 = 在 `core/importers/` 加一个适配器。**不改动已有模块**是可扩展性的检验标准。

## 4. 数据模型（初稿）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `users` | id, email(唯一), password_hash, display_name, created_at | 密码使用 argon2id 哈希 |
| `sessions` | id, user_id, expires_at, user_agent | 服务端会话，Cookie 只存会话 id |
| `accounts` | id, user_id, name, kind(wechat/alipay/bank/cash/other) | 资金账户，"钱从哪付的" |
| `categories` | id, user_id, parent_id, name, direction(income/expense), sort | 两级分类；注册时写入默认分类 |
| `transactions` | id, user_id, direction(income/expense/neutral), **amount_cents(bigint, >0)**, currency, occurred_at(timestamptz), category_id, account_id, counterparty, note, source(manual/import), import_batch_id, external_id, dedupe_key, created_at, updated_at, deleted_at | 核心流水表 |
| `import_batches` | id, user_id, source_type, file_name, file_sha256, total_rows, imported_rows, skipped_rows, status, created_at | 每次导入一条，支持整批撤销 |
| `category_rules` | id, user_id, match_field, pattern, category_id | 导入时"对方 / 商品名 → 分类"映射，用户确认后沉淀；也是 P3 agent 自动分类的数据基础 |

约束要点：
- 金额一律**正整数"分"**，方向由 `direction` 表达（见 [ADR-0002](./adr/0002-money-as-integer-cents.md)）；
- `neutral`（中性）= 充值、提现、理财申购赎回、转入零钱通等"自己的钱换个地方"，**不计入收支统计**。探针样本中此类金额达数万元，不区分会让统计严重失真；
- 所有业务表带 `user_id`，仓储层强制按当前用户过滤（多用户隔离的唯一入口）；
- 删除用软删除 `deleted_at`，便于误删恢复与导入撤销；
- 去重：`(user_id, source, external_id)` 唯一；银行流水无单号，用 `dedupe_key = hash(账户+日期+金额+交易后余额)`（余额可区分同日同额的两笔）；
- 时间：平台账单给的是北京时间墙上时间，规范化时显式按 `Asia/Shanghai` 解释后存 timestamptz，银行流水只有日期。

## 5. 导入管线

```
上传文件
  └─► ① 解码：xlsx → 工作表；csv → 识别编码（UTF-8 / UTF-8-BOM / GBK）；PDF → 带坐标的文字块
  └─► ② 识别来源：每个适配器实现 detect(sheet) 打分，取最高分；都不认识 → 走通用"字段映射"
  └─► ③ 解析：适配器把行转成 RawRecord（保留原始列，便于排错）
  └─► ④ 规范化：RawRecord → TransactionDraft（金额转分、墙上时间转 timestamptz、方向判定含 neutral、按状态过滤如"交易关闭"）
  └─► ④' 自校验（质量门槛）：与文件自带汇总比对 / 银行余额链校验；不通过则拒绝导入并指出问题
  └─► ⑤ 去重 + 分类建议：同来源按单号 / 去重键；**跨来源**（银行 ↔ 支付宝 / 微信）按同日 + 同额 + 支付方式提示疑似重复；套用 category_rules 与平台自带分类
  └─► ⑥ 预览：返回给前端，用户可改分类、剔除行
  └─► ⑦ 提交：一个数据库事务内写入 import_batches + transactions
```

- ①–④ 全部在 `packages/core`，纯函数，用脱敏样本文件做夹具测试；
- 解析在**服务端**执行（权威、可审计）；core 的同构特性保留了以后"前端离线预览"的可能；
- 适配器接口：`{ id, detect(input): number, parse(input): RawRecord[], normalize(raw): Result<TransactionDraft, ImportError>, verify(records, fileMeta): Issue[] }`。

各来源已验证的格式细节见 [P0-1 探针结论](./probes/p0-1-import-parsing.md)。

## 6. 鉴权与安全

- 邮箱 + 密码注册 / 登录；密码 argon2id；
- 会话：服务端 `sessions` 表 + `HttpOnly; Secure; SameSite=Lax` Cookie；不把令牌放在 localStorage；
- 所有写接口校验 CSRF（SameSite + 自定义请求头双保险）；
- 登录 / 注册限流；上传文件限制大小与类型；
- Capacitor 打包阶段若 Cookie 不适用，再补 Bearer 令牌方案（届时写 ADR）。

## 7. 统计口径（MVP）

- 月度：收入合计、支出合计、结余（`neutral` 不参与）；
- 分类占比：按一级分类汇总支出（饼 / 环形图）；
- 趋势：按日 / 月的收支折线；
- 时区：按用户时区（默认 Asia/Shanghai）切分"日"和"月"。

聚合由 PostgreSQL 完成（`GROUP BY` + `date_trunc`），口径定义与边界测试放在 core，保证"同一口径只有一个实现"。

## 8. 为后续阶段预留

| 阶段 | 能力 | 预留点 |
|---|---|---|
| P2 | App（Capacitor）、离线记账、预算 | contracts 类型复用；会话方案可切换 |
| P3 | 记账 agent：自然语言记一笔、自动分类、消费分析问答 | 服务端新增 `modules/agent`，通过 services 层调用现有能力（agent 只是另一种"调用方"，不直接写库）；`category_rules` 作为分类知识；API Key 只存服务端 |
