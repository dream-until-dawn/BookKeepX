/** 生成仅本机保存的数据库口令，已有配置绝不覆盖。 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const target = new URL('.env', import.meta.url);
try {
  writeFileSync(
    target,
    `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nWEB_PORT=8080\nBOOKKEEPX_VERSION=local\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已生成 docker/.env；口令未打印，请妥善保存。');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('docker/.env 已存在，保留现有配置。');
}
