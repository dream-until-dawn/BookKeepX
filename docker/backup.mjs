/** 跨平台二进制备份；不通过 PowerShell 文本重定向，不覆盖既有备份。 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = new URL('backups/', import.meta.url);
await mkdir(directory, { recursive: true, mode: 0o700 });
const name = `bookkeepx-${new Date().toISOString().replaceAll(':', '-')}.dump`;
const target = new URL(name, directory);
const partial = new URL(`${name}.partial`, directory);
const child = spawn(
  'docker',
  [
    'compose',
    '--env-file',
    'docker/.env',
    '-f',
    'docker/compose.yaml',
    'exec',
    '-T',
    'db',
    'pg_dump',
    '-U',
    'bookkeepx',
    '-d',
    'bookkeepx',
    '-Fc',
    '--no-owner',
    '--no-acl',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
);
const exited = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump 失败，退出码 ${code}`))));
});
try {
  await Promise.all([exited, pipeline(child.stdout, createWriteStream(partial, { flags: 'wx', mode: 0o600 }))]);
  await rename(partial, target);
  console.log(fileURLToPath(target));
} catch (error) {
  child.kill();
  await rm(partial, { force: true });
  throw error;
}
