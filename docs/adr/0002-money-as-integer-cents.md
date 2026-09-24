# ADR-0002 金额以"整数分"存储

- 状态：提议中（待确认）
- 日期：2026-09-24

## 背景

JavaScript 的 number 是二进制浮点数，`0.1 + 0.2 !== 0.3`。记账系统里金额误差不可接受；账单里的金额又常带 `¥`、千分位逗号、正负号、"-"前缀等多种写法。

## 决策

1. 数据库列 `amount_cents BIGINT NOT NULL CHECK (amount_cents > 0)`，单位为"分"；
2. 收支方向由独立字段 `direction`（income / expense）表达，金额本身恒为正；
3. 字符串 → 分的转换**只允许**走 `packages/core/money` 的 `parseYuanToCents`，内部按字符串拆分整数与小数部分计算，**不经过浮点数**；
4. 分 → 展示字符串只允许走 `formatCents`；
5. 超过 2 位小数、非法字符、空串一律报错，不静默四舍五入。

## 后果

- 统计求和在数据库以整数完成，无精度问题；
- Drizzle 读取 bigint 需配置为 `number` 模式（安全整数范围内足够：约 900 亿亿分）或 `bigint`，由 P0 探针确认往返正确；
- 多币种（P2+）时新增 `currency` 字段已预留，换算另立 ADR。
