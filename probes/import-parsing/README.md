# P0-1 探针：账单解析

验证微信 / 支付宝 / 招商银行的原始导出账单能否被可靠解析。结论见 [docs/probes/p0-1-import-parsing.md](../../docs/probes/p0-1-import-parsing.md)。

> 探针代码只用于验证可行性，不进入生产；正式实现在 `packages/core/importers` 中重写。

## 运行

```bash
pnpm install
npx tsx src/run.ts             # P0-1：专用适配器解析 + 校验报告（不输出明细）
npx tsx src/run-engine.ts      # P0-1b：通用引擎 + 模板自动识别，并与 P0-1 逐笔比对
npx tsx src/run-categorize.ts  # P0-1c：自动分类覆盖率
npx tsx src/run-batch.ts       # P0-1d：对 samples/ 全部文件批量识别 + 校验，一行一个文件
npx tsx src/run-refund.ts      # P0-1e：退款关联率与冲减效果
npx vitest run          # 正反向测试
```

真实账单放在仓库根目录 `samples/`（已 gitignore，**切勿提交**）。缺少样本时，真实样本那组测试会被跳过并给出警告。

## 目录

| 文件 | 作用 |
|---|---|
| `src/common.ts` | 统一的记录结构、金额（元→分）与时间工具 |
| `src/adapters/wechat.ts` | 微信 xlsx 解析 |
| `src/adapters/alipay.ts` | 支付宝 csv（GBK）解析 |
| `src/adapters/cmb-pdf.ts` | 招行 PDF 按坐标还原表格 |
| `src/verify.ts` | 自校验：汇总比对、余额链、跨来源重复探测 |
| `src/inspect.ts` | 结构查看工具（输出打码） |
| `src/engine/` | P0-1b 通用解析引擎：模板 schema、文件读取、表格抽取、规范化与自校验、自动识别 |
| `src/engine/refund.ts` | P0-1e 退款关联 |
| `src/stats.ts` | 统计口径（含退款冲减） |
| `templates/*.json` | 内置解析模板 |
| `src/categorize/` | P0-1c 分类：预置分类、系统规则、来源映射、规则引擎 |
| `test/*.test.ts` | 测试（probe / engine / categorize） |
