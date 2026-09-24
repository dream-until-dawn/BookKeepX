# ADR-0005 代码检查与格式化：Biome

- 状态：已采纳（负责人 2026-09-24 同意开始 P1，工具层面的选择由开发者决定）
- 日期：2026-09-24

## 背景

ADR-0001 与开发约定中写的是 ESLint + Prettier。开始 P1 前核实版本时发现：

- P0 探针使用并验证的是 TypeScript 7.0（原生编译器）；
- `typescript-eslint` 8.70 的对等依赖要求 `typescript >=4.8.4 <6.1.0`（2026-09-24 用 `npm view` 核实），与 TypeScript 7 不兼容。

## 决策

使用 **Biome 2** 同时负责代码检查（lint）和格式化（format），类型检查仍由 TypeScript 7 的 `tsc` 负责。

## 理由

- Biome 不依赖 TypeScript 的编译器 API，不受 TypeScript 版本限制；
- 一个工具、一份配置替代 ESLint + Prettier + 若干插件，维护成本低、速度快；
- 覆盖常用规则（未使用变量、禁止 any、import 排序等），满足开发约定的要求。

## 被否决的备选

- **把 TypeScript 降到 6.0 以使用 typescript-eslint**：为了代码检查工具降级编译器，得不偿失；P0 的全部验证基于 TypeScript 7。
- **等待 typescript-eslint 支持 TypeScript 7**：时间不确定，不能阻塞 P1。

## 后果

- 开发约定中"ESLint + Prettier"改为"Biome"；
- 部分需要类型信息的 ESLint 规则（如 no-floating-promises）Biome 暂不完全覆盖，依靠 `tsc` 严格模式和测试弥补；若日后 typescript-eslint 支持 TypeScript 7，可重新评估。
