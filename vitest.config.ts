/**
 * 全仓测试配置：每个包是一个测试项目，pnpm test 一次跑完
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'core', root: 'packages/core', include: ['test/**/*.test.ts'] } },
      { test: { name: 'importers', root: 'packages/importers', include: ['test/**/*.test.ts'] } },
      { test: { name: 'contracts', root: 'packages/contracts', include: ['test/**/*.test.ts'] } },
      {
        test: {
          name: 'server',
          root: 'apps/server',
          include: ['test/**/*.test.ts'],
          // 服务端测试共用同一个测试库，串行执行避免互相清表
          fileParallelism: false,
          // 固定 UTC：时区相关的正确性必须来自代码，而不是碰巧与本机时区一致
          env: { TZ: 'UTC' },
        },
      },
      {
        // 前端组件测试：jsdom 模拟浏览器环境
        test: { name: 'web', root: 'apps/web', include: ['test/**/*.test.{ts,tsx}'], environment: 'jsdom' },
      },
    ],
  },
});
