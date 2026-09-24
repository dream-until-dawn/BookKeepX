/** 命令行执行迁移：pnpm db:migrate */
import { loadEnv } from '../config/env.ts';
import { runMigrations } from './migrate.ts';

await runMigrations(loadEnv().DATABASE_URL);
console.log('迁移完成');
