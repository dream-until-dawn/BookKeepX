/** drizzle-kit 配置：根据 schema 生成可审阅的 SQL 迁移文件（pnpm --filter @bookkeepx/server db:generate） */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
