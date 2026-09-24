# 接口约定

- 所有请求与响应的结构定义在 `packages/contracts`（zod），前后端共用
- 金额一律为整数"分"（ADR-0002）；时间为 ISO 8601 字符串
- 错误响应：`{ error: 中文说明, code?: 错误码 }`
- 修改类请求须带 `X-BookKeepX-Client: web`（CSRF，见 [鉴权设计](./auth.md)）

## 账本内接口的统一规则

路径形如 `/api/ledgers/:ledgerId/...`。每个请求先登录校验，再经 `requireLedgerAccess` 校验成员与角色（[ADR-0006](./adr/0006-ledgers.md)）：

| 情况 | 响应 |
|---|---|
| 未登录 | 401 `UNAUTHENTICATED` |
| 不是账本成员 / 账本不存在 | 404 `LEDGER_NOT_FOUND`（不透露账本是否存在） |
| 只读成员执行修改 | 403 `LEDGER_FORBIDDEN` |
| 路径中的分类 / 账户 id 不属于该账本 | 404（与"不存在"相同） |

查询需要 `viewer` 及以上，修改需要 `editor` 及以上。

## 账本（P1-5）

| 接口 | 说明 |
|---|---|
| `GET /api/ledgers/:ledgerId` | 账本信息：`{ id, name, currency, timezone, role }`。前端据 `timezone` 显示时间、换算表单时间，据 `role` 决定是否显示编辑按钮 |

## 分类（P1-4）

| 接口 | 说明 |
|---|---|
| `GET /api/ledgers/:ledgerId/categories` | 全部分类（平铺，含 `parentId`、`hidden`、`presetKey`、`transactionCount`） |
| `POST /api/ledgers/:ledgerId/categories` | 新增：`{ group, parentId?, name, icon? }` |
| `PATCH /api/ledgers/:ledgerId/categories/:id` | 修改：`{ name?, icon?, hidden?, sort? }` |
| `DELETE /api/ledgers/:ledgerId/categories/:id` | 删除 |

业务规则：

| 规则 | 违反时 |
|---|---|
| 最多两级：父分类必须是一级分类 | 400 `CATEGORY_TOO_DEEP` |
| 子分类与父分类同组（支出 / 收入 / 中性） | 400 `CATEGORY_GROUP_MISMATCH`（数据库也有约束兜底） |
| 同一父分类下名称不重复（一级分类之间也不重复） | 409 `CATEGORY_NAME_TAKEN` |
| 名称 1~20 个字符 | 400 |
| **预置分类不能删除，只能隐藏**：系统规则和来源映射按预置键找分类，删掉会让自动分类失效 | 409 `CATEGORY_PRESET` |
| 有子分类的不能删除 | 409 `CATEGORY_HAS_CHILDREN` |
| 被流水引用的不能删除（包括已软删除的流水） | 409 `CATEGORY_IN_USE`，提示改为隐藏 |
| 隐藏：不出现在记账时的选择列表中；隐藏一级分类时，其子分类在选择列表中也一并不出现；历史流水不受影响 | — |

## 资金账户（P1-4）

| 接口 | 说明 |
|---|---|
| `GET /api/ledgers/:ledgerId/accounts` | 全部账户（含已停用，带 `archived`、`transactionCount`） |
| `POST /api/ledgers/:ledgerId/accounts` | 新增：`{ name, kind, institution?, cardLast4? }` |
| `PATCH /api/ledgers/:ledgerId/accounts/:id` | 修改：`{ name?, kind?, institution?, cardLast4?, archived?, sort? }` |
| `DELETE /api/ledgers/:ledgerId/accounts/:id` | 删除 |

业务规则：

| 规则 | 违反时 |
|---|---|
| 同一账本内名称不重复 | 409 `ACCOUNT_NAME_TAKEN` |
| 名称 1~30 个字符；卡号后四位必须是 4 位数字 | 400 |
| 被流水或导入批次引用的不能删除 | 409 `ACCOUNT_IN_USE`，提示改为停用 |
| 停用：不出现在记账时的选择列表中，历史流水保留；可以恢复 | — |

## 流水（P1-5）

| 接口 | 说明 |
|---|---|
| `GET /api/ledgers/:ledgerId/transactions` | 列表（分页）+ 当前筛选条件下的收支合计 |
| `GET /api/ledgers/:ledgerId/transactions/:id` | 单条 |
| `POST /api/ledgers/:ledgerId/transactions` | 记一笔：`{ direction, amount, occurredAt, categoryId?, accountId?, counterparty?, note? }` |
| `PATCH /api/ledgers/:ledgerId/transactions/:id` | 修改 |
| `DELETE /api/ledgers/:ledgerId/transactions/:id` | 删除（软删除，可恢复） |
| `POST /api/ledgers/:ledgerId/transactions/:id/restore` | 恢复已删除的流水 |

**列表查询参数**：`month=YYYY-MM` 或 `from` / `to`（`YYYY-MM-DD`，含首尾两天）；`direction`；`categoryId`（选一级分类时**包含其子分类**）；`accountId`；`q`（在对方、说明、备注中搜索）；`deleted=true`（回收站）；`page`（从 1 开始）、`pageSize`（默认 50，最大 100）。排序：发生时间倒序。

**合计口径**与统计一致（架构 §7、ADR-0004）：收入不含退款；支出 = 支出 − 退款；中性不计；跨来源重复（`duplicate_of_id` 非空）不计。

**金额与时间**
- 表单提交的 `amount` 是"元"字符串，服务端用 `parseYuanToCents` 转成分，必须大于 0；响应里一律是 `amountCents`（分）
- `occurredAt` 必须是**带时区的** ISO 8601 时间（如 `2026-09-24T12:30:00+08:00`），不接受不带时区的写法，避免"按服务器时区解释"的歧义
- 日期筛选（`month` / `from` / `to`）按**账本时区**（默认 Asia/Shanghai）切分，与 P0-2 验证的统计口径一致；前端显示时间也按账本时区

**业务规则**

| 规则 | 违反时 |
|---|---|
| 分类的组必须与收支方向一致（支出只能选支出分类） | 400 `CATEGORY_DIRECTION_MISMATCH` |
| 新选择的分类不能是已隐藏的（原本就在用的隐藏分类可以保留） | 400 `CATEGORY_HIDDEN` |
| 新选择的账户不能是已停用的（原本就在用的可以保留） | 400 `ACCOUNT_ARCHIVED` |
| 分类 / 账户必须属于本账本 | 404 |
| **导入的流水**只能修改分类、账户、备注；金额、时间、方向、对方以账单为准，不能改（否则去重和自校验会失效） | 400 `IMPORTED_FIELD_READONLY` |
| 手动修改分类后 `category_source` 记为 `manual`，以后任何自动规则都不会覆盖它 | — |
| 恢复时，如果同一平台单号已经被重新导入，则不能恢复 | 409 `TRANSACTION_DUPLICATE` |
| 修改、删除已删除的流水 | 404（需先恢复） |
