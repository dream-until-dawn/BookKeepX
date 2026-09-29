/** 仅针对本机部署的可重复验收；创建合成账户，结束后按 ID 清理自己的数据。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = readFileSync(new URL('.env', import.meta.url), 'utf8').match(/^WEB_PORT=(\d+)$/m)?.[1] ?? '8080';
const base = `http://127.0.0.1:${port}`;
const compose = (...args) =>
  execFileSync('docker', ['compose', '--env-file', 'docker/.env', '-f', 'docker/compose.yaml', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
const sql = (query) =>
  compose(
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'bookkeepx',
    '-d',
    'bookkeepx',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    query,
  ).trim();
let user;
let cookie = '';
async function request(path, { method = 'GET', body, csrf = true, authenticated = true } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(authenticated ? { cookie } : {}),
      ...(csrf ? { 'x-bookkeepx-client': 'web' } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
try {
  assert.equal((await request('/api/health')).status, 200);
  const anonymous = await request('/api/auth/me');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  const credentials = { email: `deploy-${randomUUID()}@example.com`, password: randomUUID() };
  assert.equal(
    (
      await request('/api/auth/register', {
        method: 'POST',
        csrf: false,
        body: { ...credentials, displayName: '部署验收' },
      })
    ).status,
    403,
  );
  const registration = await request('/api/auth/register', {
    method: 'POST',
    body: { ...credentials, displayName: '部署验收' },
  });
  assert.equal(registration.status, 201);
  user = await registration.json();
  assert.match(user.id, /^[0-9a-f-]{36}$/);
  assert.match(user.defaultLedgerId, /^[0-9a-f-]{36}$/);
  const session = registration.headers.getSetCookie()[0];
  assert.match(session, /HttpOnly/i);
  assert.match(session, /SameSite=Lax/i);
  cookie = session.split(';')[0];
  assert.equal(
    (await request('/api/auth/login', { method: 'POST', body: { ...credentials, password: 'wrong-password' } })).status,
    401,
  );
  assert.equal((await request('/api/auth/login', { method: 'POST', body: credentials })).status, 200);
  const prefix = `/api/ledgers/${user.defaultLedgerId}`;
  // 合成 CSV 验证运行镜像携带解析依赖和内置模板；不读取真实账单。
  const csv =
    '\ufeff导出信息：\r\n姓名：验收\r\n支付宝账户：test@example.com\r\n共1笔记录\r\n收入：0笔 0.00元\r\n支出：1笔 2.00元\r\n不计收支：0笔 0.00元\r\n支付宝支付科技有限公司\r\n交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n2026-09-01 12:00:00,餐饮美食,合成商户,/,商品,支出,2.00,余额宝,交易成功,DEPLOY001,,,\n';
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'alipay_record.csv');
  const uploaded = await fetch(`${base}${prefix}/imports`, {
    method: 'POST',
    headers: { cookie, 'x-bookkeepx-client': 'web' },
    body: form,
  });
  assert.equal(uploaded.status, 200);
  const preview = await uploaded.json();
  assert.equal(preview.status, 'preview');
  assert.equal(
    (await request(`${prefix}/imports/${preview.batch.id}/commit`, { method: 'POST', body: { overrides: [] } })).status,
    200,
  );
  assert.equal((await (await request(`${prefix}/stats?month=2026-09`)).json()).summary.expenseCents, 200);
  assert.equal(
    (await request(`${prefix}/imports/${preview.batch.id}/revert`, { method: 'POST', body: {} })).status,
    200,
  );
  const response = await request(`${prefix}/transactions`, {
    method: 'POST',
    body: {
      direction: 'expense',
      amount: '12.34',
      occurredAt: '2026-09-01T12:00:00+08:00',
      counterparty: '合成验收商户',
    },
  });
  assert.equal(response.status, 201);
  assert.equal((await (await request(`${prefix}/stats?month=2026-09`)).json()).summary.expenseCents, 1234);
  assert.equal((await request(`${prefix}/stats?month=2026-09`, { authenticated: false })).status, 401);
  // 伪造代理头不能成为持久化的会话 IP。
  await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'x-bookkeepx-client': 'web', 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.99' },
    body: JSON.stringify(credentials),
  });
  assert.equal(sql(`SELECT count(*) FROM sessions WHERE user_id='${user.id}' AND ip='203.0.113.99'`), '0');
  for (const path of ['/', '/stats', '/sw.js', '/manifest.webmanifest']) {
    const asset = await request(path);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'no-cache');
  }
  const html = await (await request('/')).text();
  const assetPath = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert(assetPath);
  assert.match((await request(assetPath)).headers.get('cache-control'), /immutable/);
  assert.equal((await request('/assets/nonexistent.js')).status, 404);
  assert.equal((await request('/api/nonexistent')).status, 404);
  // 重启与重复迁移后会话、金额仍然存在。
  compose('run', '--rm', 'migrate');
  compose('restart', 'api');
  compose('up', '-d', '--wait');
  assert.equal((await (await request(`${prefix}/stats?month=2026-09`)).json()).summary.expenseCents, 1234);
  const backup = execFileSync(process.execPath, ['docker/backup.mjs'], { cwd: root, encoding: 'utf8' }).trim();
  const restoreDb = `verify_${randomUUID().replaceAll('-', '')}`;
  const restoreFile = `/tmp/${restoreDb}.dump`;
  let created = false;
  try {
    compose('cp', backup, `db:${restoreFile}`);
    compose('exec', '-T', 'db', 'createdb', '-U', 'bookkeepx', restoreDb);
    created = true;
    compose(
      'exec',
      '-T',
      'db',
      'pg_restore',
      '-U',
      'bookkeepx',
      '-d',
      restoreDb,
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
      restoreFile,
    );
    const restored = compose(
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'bookkeepx',
      '-d',
      restoreDb,
      '-At',
      '-c',
      `SELECT sum(amount_cents) FROM transactions WHERE ledger_id='${user.defaultLedgerId}'`,
    ).trim();
    assert.equal(restored, '1234');
  } finally {
    // 只删除本次随机命名的演练库；不触碰在线库或其他备份。
    if (created) compose('exec', '-T', 'db', 'dropdb', '-U', 'bookkeepx', restoreDb);
    compose('exec', '-T', 'db', 'rm', '-f', restoreFile);
  }
  console.log('部署验收通过：注册登录、记账统计、鉴权/CSRF 反向、代理防伪、缓存策略、迁移幂等、重启持久性与备份恢复。');
} finally {
  if (user?.id && /^[0-9a-f-]{36}$/.test(user.id) && /^[0-9a-f-]{36}$/.test(user.defaultLedgerId)) {
    sql(
      `BEGIN; DELETE FROM transactions WHERE ledger_id='${user.defaultLedgerId}'; DELETE FROM users WHERE id='${user.id}'; DELETE FROM ledgers WHERE id='${user.defaultLedgerId}'; COMMIT;`,
    );
  }
}
