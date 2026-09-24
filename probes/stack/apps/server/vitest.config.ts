import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 多个测试文件共用同一个真实数据库，串行执行避免互相清表
    fileParallelism: false,
    // 固定进程时区为 UTC，确保"按北京时间切月"的正确性来自 SQL，而不是碰巧跟本机时区一致
    env: { TZ: 'UTC' },
  },
});
