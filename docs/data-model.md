# 数据模型设计（P1-2，待确认）

- 状态：**草案，待负责人确认后实现**
- 依据：[架构设计](./architecture.md)、ADR-0002（金额）、ADR-0003（解析模板）、ADR-0004（分类与规则、已决事项 Q1~Q4）、P0 探针结论
- 通用约定：
  - 主键一律 `uuid`（随机生成，不暴露记录数量、便于将来多端同步）
  - 时间一律 `timestamptz`（带时区，存 UTC）；`created_at` / `updated_at` 每张业务表都有，下文不再重复列出
  - 所有业务数据带 `user_id`，仓储层强制按当前用户过滤（多用户隔离的唯一入口）
  - 金额一律 `bigint`，单位"分"，数据库约束 `0 < x ≤ 2^53−1`
  - 系统级数据（内置解析模板、预置分类定义、系统规则、来源分类映射）放在**代码仓库**里随版本发布，不建表

## 总览

| # | 表 | 一句话用途 | 必要性 |
|---|---|---|---|
| 1 | `users` | 用户账号 | 多用户注册登录（已决） |
| 2 | `sessions` | 登录会话 | Cookie 会话方案（架构 §6） |
| 3 | `accounts` | 资金账户（微信、支付宝、某张银行卡、现金） | 流水"从哪付的"；导入时判断文件属于哪个账户；跨来源去重 |
| 4 | `categories` | 用户自己的分类树 | 统一分类体系（ADR-0004） |
| 5 | `transactions` | 流水（核心表） | 一切统计的来源 |
| 6 | `import_batches` | 一次导入 | 预览、提交、整批撤销、追溯 |
| 7 | `import_templates` | 用户自定义解析模板 | 识别失败时的自定义流程（ADR-0003） |
| 8 | `category_rules` | 用户分类规则 | "含地铁归交通"、从修改中学习（ADR-0004） |
| 9 | `source_hint_mappings` | 用户覆盖"来源原生分类 → 我们的分类"的映射 | 例如用户想把支付宝"商业服务"归到"居住" |

---

## 1. `users` 用户

**为什么需要**：多用户注册登录，数据按用户隔离。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| email | text，唯一（不区分大小写） | 登录名；存入前统一转小写 |
| password_hash | text | argon2id 哈希（P0-3 验证），不存明文 |
| display_name | text | 界面显示的昵称 |
| timezone | text，默认 `Asia/Shanghai` | 统计时按用户时区切分"日""月"（P0-2 验证过时区切月） |
| self_names | text[]，默认空 | **本人的姓名 / 常用名**。用于识别"转给自己"（中性）：招行 PDF 能从文件里读出户主姓名，但微信、手动记账没有，需要用户自己填（见待确认问题 Q3） |

## 2. `sessions` 会话

**为什么需要**：登录状态。浏览器 Cookie 只保存一个随机令牌，服务端据此找到用户；可以主动让某个会话失效（退出登录、修改密码后踢掉其他设备）。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK → users，级联删除 | |
| token_hash | text，唯一 | 令牌的 SHA-256。**数据库里不存令牌原文**，数据库泄露也无法冒充登录 |
| expires_at | timestamptz | 过期时间（建议 30 天，活跃时自动续期） |
| last_seen_at | timestamptz | 最近一次使用，用于续期和"登录设备"列表 |
| user_agent | text | 设备信息，显示在"登录设备"列表 |
| ip | inet | 登录 IP |

索引：`user_id`、`expires_at`（定期清理过期会话）。

## 3. `accounts` 资金账户

**为什么需要**：
- 记录"钱从哪付的 / 进了哪"；
- 导入时要知道这份文件属于哪个账户（微信文件 → 微信账户；招行 PDF 里有卡号后四位 → 对应那张卡）；
- 跨来源去重要用：支付宝里"招商银行储蓄卡(1032)"付款的消费，要能找到尾号 1032 的招行账户里的那一笔（ADR-0004 Q2-B）。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| name | text | 显示名，如"招行储蓄卡 1032"；同一用户下唯一 |
| kind | 枚举：wechat / alipay / bank_debit / credit_card / cash / other | 账户类型 |
| institution | text，可空 | 机构，如"招商银行" |
| card_last4 | text，可空 | 卡号后四位，用于匹配账单中的"储蓄卡(1032)""6214\*\*\*\*1032" |
| currency | text，默认 `CNY` | 预留多币种 |
| sort | int | 排序 |
| archived_at | timestamptz，可空 | 停用（注销的卡）；停用后不再出现在选择列表，历史流水保留 |

MVP **不记余额**（见待确认问题 Q2）。

## 4. `categories` 分类

**为什么需要**：我们自己维护的统一分类（ADR-0004）。注册时把系统预置分类树复制一份给用户，用户可以改名、新增、隐藏。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| parent_id | uuid FK → categories，可空 | 空 = 一级分类；最多两级 |
| group | 枚举：expense / income / neutral | 支出 / 收入 / 中性；子分类必须与父分类同组 |
| name | text | 同一父分类下唯一 |
| preset_key | text，可空 | 来自系统预置时的稳定键（如 `expense.transport.public`）；系统规则、来源映射通过它找到用户的分类，用户改名不影响 |
| icon | text，可空 | 图标名（前端展示） |
| sort | int | 排序 |
| hidden | bool | 隐藏：不在选择列表中出现，历史流水仍保留该分类 |

约束：`(user_id, preset_key)` 唯一。分类不物理删除：有流水引用时只能隐藏，或先把流水迁移到其他分类。

## 5. `transactions` 流水（核心表）

**为什么需要**：所有记账数据；统计的唯一来源。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| account_id | uuid FK → accounts，可空 | 资金账户；手动记账可以不填 |
| category_id | uuid FK → categories，可空 | 空 = 未分类 |
| direction | 枚举：income / expense / neutral | 收入 / 支出 / 中性（不计收支） |
| amount_cents | bigint | 金额（分），恒为正 |
| currency | text，默认 `CNY` | 预留 |
| occurred_at | timestamptz | 发生时间 |
| time_precision | 枚举：second / day | 银行流水只有日期（P0-1），界面据此只显示日期 |
| counterparty | text | 交易对方 |
| description | text | 商品说明 / 交易摘要（来自账单） |
| note | text | 用户自己写的备注 |
| source | 枚举：manual / import | 手动记账还是导入 |
| import_batch_id | uuid FK → import_batches，可空 | 导入批次，用于整批撤销 |
| external_source | text，可空 | 单号所属平台，如 `wechat` / `alipay` |
| external_id | text，可空 | 平台交易单号；与 `external_source` 组合唯一，防止重复导入 |
| dedupe_key | text，可空 | 没有单号的银行流水用的去重键：hash(账户 + 日期 + 金额 + 交易后余额) |
| balance_after_cents | bigint，可空 | 银行流水的交易后余额：去重、余额链校验 |
| payment_method | text，可空 | 账单原文的支付方式（如"招商银行储蓄卡(1032)&红包"），跨来源去重用 |
| source_category | text，可空 | 账单原生分类（支付宝"交易分类"、招行"交易摘要"），分类规则可以用 |
| raw | jsonb，可空 | 导入时的原始行（全部列），用于排错和日后重新解析 |
| category_source | 枚举：manual / user_rule / system_rule / source_hint / none | 分类是怎么来的；手动指定的永不被自动规则覆盖 |
| category_rule_id | uuid FK → category_rules，可空 | 命中的用户规则，界面上显示"由规则 xx 归类" |
| is_refund | bool | 是否退款（ADR-0004 Q4：冲减支出、不计收入） |
| refund_of_id | uuid FK → transactions，可空 | 退款对应的原消费；找不到时为空（冲减"其他支出"，待确认） |
| duplicate_of_id | uuid FK → transactions，可空 | 跨来源重复时指向计入统计的那条；非空即不计入统计（Q2-B） |
| deleted_at | timestamptz，可空 | 软删除，支持误删恢复 |

约束（P0-2 已验证过其中大部分）：金额范围；只有退款才能有 `refund_of_id`；不能指向自己；`(user_id, external_source, external_id)` 在未删除记录中唯一。
索引：`(user_id, occurred_at)` 统计与列表主路径；`(user_id, category_id)`；`(user_id, import_batch_id)`；`(user_id, dedupe_key)`。

## 6. `import_batches` 导入批次

**为什么需要**：一次上传就是一个批次。
- 上传后先**预览**，用户确认再提交；预览期间的解析结果要暂存；
- 导错了可以**整批撤销**；
- 记录用的是哪个模板、自校验结果，便于日后排查。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| account_id | uuid FK → accounts，可空 | 这份文件属于哪个账户 |
| status | 枚举：previewing / committed / reverted / expired | 预览中 / 已提交 / 已撤销 / 预览过期 |
| file_name | text | 原始文件名 |
| file_sha256 | text | 文件指纹：同一文件重复上传时提示 |
| file_size | int | 字节数 |
| template_id | text | 使用的解析模板（内置模板 id 或用户模板 uuid） |
| template_version | int | 模板版本 |
| detect_score | real | 自动识别得分（0~1） |
| holder_name | text，可空 | 从文件中读出的户主姓名 |
| period_start / period_end | date，可空 | 账单覆盖的时间范围（来自文件说明） |
| verify_result | jsonb | 自校验结果（汇总比对、余额链） |
| preview | jsonb，可空 | 预览阶段暂存的解析结果；提交或过期后清空 |
| total_rows / imported_rows / skipped_rows / duplicate_rows | int | 统计 |
| committed_at / reverted_at | timestamptz，可空 | |

**不保存原始文件**（见待确认问题 Q1）。

## 7. `import_templates` 用户自定义解析模板

**为什么需要**：识别失败时，用户在页面上配置列映射，保存后下次同类文件能自动识别（ADR-0003）。内置模板在代码里，不在此表。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| name | text | 如"某银行活期明细" |
| file_type | 枚举：csv / xlsx / pdf | |
| version | int | 修改后递增；导入批次记录所用版本 |
| definition | jsonb | 模板内容（与内置模板同一结构，保存前经 zod 严格校验） |
| last_used_at | timestamptz，可空 | |

## 8. `category_rules` 用户分类规则

**为什么需要**：用户自定义"含地铁归交通"这类规则；用户改分类时"从修改中学习"生成的规则也存在这里（ADR-0004）。系统规则在代码里。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| name | text | 规则名 |
| enabled | bool | 启用 / 停用 |
| priority | int | 数字小的先匹配 |
| match | 枚举：all / any | 条件全部满足 / 任一满足 |
| conditions | jsonb | 条件列表（字段 + 操作符 + 关键词；不支持正则） |
| action | jsonb | 设置分类（存分类 id）、可选把方向改为中性 |
| origin | 枚举：manual / learned / agent | 手动创建 / 从修改中学习 / 将来 agent 建议 |
| hit_count | int | 命中次数，便于用户清理没用的规则 |
| last_hit_at | timestamptz，可空 | |

## 9. `source_hint_mappings` 来源分类映射（用户覆盖）

**为什么需要**：系统内置了"支付宝 餐饮美食 → 餐饮"这类映射（在代码里）。用户若不同意某条映射，可以覆盖成自己的分类。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| source | text | 来源，如 `alipay` |
| hint | text | 原生分类，如"商业服务" |
| category_id | uuid FK → categories | 用户指定的分类 |

约束：`(user_id, source, hint)` 唯一。

---

## 不建表的部分

| 内容 | 放在哪里 | 理由 |
|---|---|---|
| 内置解析模板 | `packages/core` 中的 JSON | 随代码版本发布、有测试保护 |
| 预置分类树定义 | 同上 | 注册时复制到用户的 `categories` |
| 系统分类规则、来源分类映射 | 同上 | 同上 |
| 登录限流计数 | 服务端内存 | 单实例自托管足够；多实例时再换 Redis |

## 待确认问题

| # | 问题 | 建议 | 影响 |
|---|---|---|---|
| Q1 | 是否保存用户上传的**原始账单文件**？ | **不保存**，只存文件哈希 + 每行原始数据（`raw`）。账单含姓名、卡号等隐私，存文件增加泄露面；`raw` 已足够排错和重新解析 | 存文件需要加文件存储与清理策略 |
| Q2 | 资金账户要不要**记余额**（资产视图）？ | MVP **不记**。导入的数据不一定完整（只导了部分月份），算出的余额容易错；P2 再做"手动校准余额" | 以后加字段即可，不影响现有表 |
| Q3 | "转给自己"的识别需要知道本人姓名：是否让用户在设置里填写 `self_names`？ | **需要**。招行文件里有户主姓名，但微信转账、支付宝转账要靠它 | 仅一个字段 |
| Q4 | 是否需要**多账本**（例如个人账本和家庭账本分开、和家人共同记账）？ | 这是唯一**以后再加代价很大**的决定：要在几乎每张表加 `ledger_id` 并改权限模型。**如果预期会有家庭共享记账，建议现在就加上 `ledgers` 表**（MVP 每人默认一个账本，界面上先不暴露）；如果确定只是个人使用，就不加 | 决定数据隔离的单位是"用户"还是"账本" |
| Q5 | 是否需要**标签**（一笔流水可打多个标签，如"出差""装修"）？ | MVP 不做，P2 加一张关联表即可，不影响现有结构 | 无 |
