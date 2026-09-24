/**
 * 数据库迁移
 *
 * 迁移文件由 drizzle-kit 根据 src/db/schema.ts 生成在 drizzle/ 目录（P1-2 起有内容）。
 * 已执行过的迁移会自动跳过，可以重复运行。命令行入口见 migrate-cli.ts。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './client.ts';

export const MIGRATIONS_DIR = join(import.meta.dirname, '../../drizzle');

export async function runMigrations(url: string) {
  if (!existsSync(join(MIGRATIONS_DIR, 'meta/_journal.json'))) {
    console.log('尚无迁移文件，跳过');
    return;
  }
  const database = createDatabase(url);
  try {
    await migrate(database.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await database.close();
  }
}
