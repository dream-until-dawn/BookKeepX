# P0-1 探针：账单解析

验证微信 / 支付宝 / 招商银行的原始导出账单能否被可靠解析。结论见 [docs/probes/p0-1-import-parsing.md](../../docs/probes/p0-1-import-parsing.md)。

> 探针代码只用于验证可行性，不进入生产；正式实现在 `packages/core/importers` 中重写。

## 运行

```bash
pnpm install
npx tsx src/run.ts      # 解析 samples/ 下的真实账单，输出统计与校验报告（不输出明细）
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
| `test/probe.test.ts` | 测试 |
