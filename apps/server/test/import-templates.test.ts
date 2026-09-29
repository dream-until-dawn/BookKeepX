/**
 * P1-7 自定义解析模板：增删改查、读取样本、试解析、用模板导入（自动识别、去重、来源、用户隔离）
 */
import { readFileSync } from 'node:fs';
import {
  importBatchSchema,
  inspectResponseSchema,
  type UserTemplate,
  uploadResponseSchema,
} from '@bookkeepx/contracts';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BANK_SPEC,
  bankCsv,
  hasSamples,
  LEGACY_WECHAT_SPEC,
  legacySamples,
} from '../../../packages/importers/test/helpers.ts';
import { buildApp } from '../src/app.ts';
import { importTemplates, transactions } from '../src/db/schema/index.ts';
import { as, registerUser, type TestUser } from './api-helpers.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';
import { postFile, upload } from './import-helpers.ts';

const database = useMigratedDatabase();
let now: Date;
let app: ReturnType<typeof buildApp>;
let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await truncateAll(database);
  now = new Date('2026-09-24T10:00:00+08:00');
  app = buildApp({ database, clock: () => now });
  alice = await registerUser(app, 'alice');
  bob = await registerUser(app, 'bob');
});

const T = '/api/import-templates';
const FILE = '某银行明细.csv';
const ROWS: Parameters<typeof bankCsv>[0] = [
  ['2026-09-01', '工资', '某公司', '8000.00', ''],
  ['2026-09-02', '消费', '某超市', '', '56.30'],
  ['2026-09-05', '转账', '张三', '', '1000.00'],
];

async function create(user: TestUser, name = '某银行活期', spec: object = BANK_SPEC): Promise<UserTemplate> {
  const res = await as(app, user).post(T, { name, spec });
  if (res.statusCode !== 201) throw new Error(`创建失败：${res.statusCode} ${res.body}`);
  return res.json();
}

const base = (u: TestUser) => `/api/ledgers/${u.ledgerId}`;

describe('模板的增删改查', () => {
  it('正向：创建 → 列表中可见；改名不升版本，改配置版本 + 1，配置没变不升版本', async () => {
    const t = await create(alice);
    expect(t).toMatchObject({ name: '某银行活期', fileType: 'csv', version: 1, lastUsedAt: null });
    expect((await as(app, alice).get(T)).json()).toHaveLength(1);

    const renamed = (await as(app, alice).patch(`${T}/${t.id}`, { name: '工资卡' })).json();
    expect(renamed).toMatchObject({ name: '工资卡', version: 1 });
    const same = (await as(app, alice).patch(`${T}/${t.id}`, { spec: BANK_SPEC })).json();
    expect(same.version).toBe(1);
    const changed = (
      await as(app, alice).patch(`${T}/${t.id}`, { spec: { ...BANK_SPEC, balanceCheck: false } })
    ).json();
    expect(changed).toMatchObject({ version: 2, spec: { balanceCheck: false } });

    expect((await as(app, alice).del(`${T}/${t.id}`)).statusCode).toBe(204);
    expect((await as(app, alice).get(T)).json()).toEqual([]);
  });

  it('反向：同名 → 409；配置不合法 → 400 并说明原因；空名称 → 400', async () => {
    await create(alice);
    expect((await as(app, alice).post(T, { name: '某银行活期', spec: BANK_SPEC })).json().code).toBe(
      'TEMPLATE_NAME_TAKEN',
    );
    const bad = await as(app, alice).post(T, {
      name: '坏模板',
      spec: { ...BANK_SPEC, columns: { ...BANK_SPEC.columns, counterparty: '不存在的列' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('不在表头中');
    expect((await as(app, alice).post(T, { name: ' ', spec: BANK_SPEC })).statusCode).toBe(400);
    expect(await database.db.$count(importTemplates)).toBe(1);
  });

  it('反向：夹带配置之外的能力（汇总规则、正则）→ 400', async () => {
    const res = await as(app, alice).post(T, { name: 'x', spec: { ...BANK_SPEC, verify: { summary: {} } } });
    expect(res.statusCode).toBe(400);
  });

  it('反向：模板按用户隔离——看不到、改不了、删不掉别人的模板；未登录 401', async () => {
    const t = await create(alice);
    expect((await as(app, bob).get(T)).json()).toEqual([]);
    expect((await as(app, bob).patch(`${T}/${t.id}`, { name: 'x' })).statusCode).toBe(404);
    expect((await as(app, bob).del(`${T}/${t.id}`)).statusCode).toBe(404);
    expect((await as(app, null).get(T)).statusCode).toBe(401);
    expect((await as(app, alice).get(T)).json()[0].name).toBe('某银行活期');
  });

  it('反向：超过数量上限 → 400', async () => {
    await database.db.insert(importTemplates).values(
      Array.from({ length: 50 }, (_, i) => ({
        userId: alice.id,
        name: `模板${i}`,
        fileType: 'csv' as const,
        definition: BANK_SPEC,
      })),
    );
    expect((await as(app, alice).post(T, { name: '第 51 个', spec: BANK_SPEC })).json().code).toBe('TEMPLATE_LIMIT');
  });
});

describe('读取样本与试解析', () => {
  it('正向：inspect 返回前若干行与推荐表头；不保存任何东西', async () => {
    const res = await postFile(app, alice, `${T}/inspect`, bankCsv(ROWS), FILE);
    const body = inspectResponseSchema.parse(res.json());
    expect(body.suggestedHeaderRow).toBe(3);
    expect(body.rows[3]).toEqual(BANK_SPEC.header);
    expect(await database.db.$count(importTemplates)).toBe(0);
  });

  it('反向：PDF → 400 暂不支持；空文件 → 400', async () => {
    const pdf = await postFile(app, alice, `${T}/inspect`, Buffer.from('%PDF-1.7\n'), 'a.pdf');
    expect(pdf.json().code).toBe('TEMPLATE_PDF_UNSUPPORTED');
    expect((await postFile(app, alice, `${T}/inspect`, Buffer.alloc(0), 'a.csv')).json().code).toBe(
      'IMPORT_EMPTY_FILE',
    );
  });

  it('正向：test 返回解析结果与"保存后能自动识别"', async () => {
    const res = await postFile(app, alice, `${T}/test`, bankCsv(ROWS), FILE, { spec: JSON.stringify(BANK_SPEC) });
    expect(res.json()).toMatchObject({ headerFound: true, total: 3, errorCount: 0, detect: { autoSelected: true } });
  });

  it('反向：已有一个表头相同的模板 → 提示难以区分；修改该模板自身时不与自己比较', async () => {
    const t = await create(alice);
    const draft = await postFile(app, alice, `${T}/test`, bankCsv(ROWS), FILE, { spec: JSON.stringify(BANK_SPEC) });
    expect(draft.json().detect).toMatchObject({ autoSelected: false });
    expect(draft.json().detect.reason).toContain('某银行活期');
    const self = await postFile(app, alice, `${T}/test`, bankCsv(ROWS), FILE, {
      spec: JSON.stringify(BANK_SPEC),
      templateId: t.id,
    });
    expect(self.json().detect.autoSelected).toBe(true);
  });

  it('反向：配置不是 JSON / 缺字段 → 400', async () => {
    const notJson = await postFile(app, alice, `${T}/test`, bankCsv(ROWS), FILE, { spec: '{' });
    expect(notJson.json().code).toBe('VALIDATION_FAILED');
    const missing = await postFile(app, alice, `${T}/test`, bankCsv(ROWS), FILE, {
      spec: JSON.stringify({ ...BANK_SPEC, timeFormat: undefined }),
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe('用自定义模板导入', () => {
  async function previewOf(res: Awaited<ReturnType<typeof upload>>) {
    const body = uploadResponseSchema.parse(res.json());
    if (body.status !== 'preview') throw new Error(`期望预览，实际 ${body.status}`);
    return body.batch;
  }

  it('正向：没有模板时不支持；建好模板后自动识别、记录模板名与版本、更新最近使用时间', async () => {
    expect((await upload(app, alice, bankCsv(ROWS), FILE)).json().code).toBe('IMPORT_UNSUPPORTED');
    const t = await create(alice);
    const batch = await previewOf(await upload(app, alice, bankCsv(ROWS), FILE));
    expect(batch).toMatchObject({ templateId: t.id, templateName: '某银行活期', templateVersion: 1, totalRows: 3 });
    const [row] = await database.db.select().from(importTemplates).where(eq(importTemplates.id, t.id));
    expect(row!.lastUsedAt?.toISOString()).toBe(now.toISOString());
  });

  it('反向：别人的模板不参与我的识别，也不能被我指定', async () => {
    const t = await create(bob);
    expect((await upload(app, alice, bankCsv(ROWS), FILE)).json().code).toBe('IMPORT_UNSUPPORTED');
    expect((await upload(app, alice, bankCsv(ROWS), FILE, { templateId: t.id })).json().code).toBe(
      'IMPORT_TEMPLATE_NOT_FOUND',
    );
  });

  it('正向：银行模板 → 自动对应卡号尾号的账户之外，再次上传全部识别为重复（按余额去重）', async () => {
    await create(alice);
    const b = await previewOf(await upload(app, alice, bankCsv(ROWS), FILE));
    await as(app, alice).post(`${base(alice)}/imports/${b.id}/commit`, { overrides: [] });
    const again = await previewOf(await upload(app, alice, bankCsv(ROWS), FILE));
    expect(again.rows!.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate']);
  });

  it('正向：既没有单号也没有余额 → 同一文件中两笔完全相同的交易都导入；再次上传两笔都识别为重复', async () => {
    const spec = {
      ...BANK_SPEC,
      sourceKind: 'other',
      header: ['交易日期', '摘要', '对方户名', '收入金额', '支出金额', '账户余额'],
      columns: { occurredAt: '交易日期', counterparty: '对方户名', income: '收入金额', expense: '支出金额' },
      balanceCheck: false,
    };
    await create(alice, '无余额', spec);
    const twin: Parameters<typeof bankCsv>[0] = [
      ['2026-09-03', '地铁', '地铁公司', '', '2.00'],
      ['2026-09-03', '地铁', '地铁公司', '', '2.00'],
    ];
    const b = await previewOf(await upload(app, alice, bankCsv(twin), FILE));
    expect(b.rows!.map((r) => r.status)).toEqual(['new', 'new']);
    await as(app, alice).post(`${base(alice)}/imports/${b.id}/commit`, { overrides: [] });
    expect(await database.db.$count(transactions)).toBe(2);

    const again = await previewOf(await upload(app, alice, bankCsv(twin), FILE));
    expect(again.rows!.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    // 新文件多了第三笔相同的交易 → 只有第三笔是新的
    const three = await previewOf(await upload(app, alice, bankCsv([...twin, twin[0]!]), FILE));
    expect(three.rows!.filter((r) => r.status === 'new')).toHaveLength(1);
  });

  it('正向：预览期间模板被删除 → 仍能提交；导入历史显示"已删除的自定义模板"', async () => {
    const t = await create(alice);
    const b = await previewOf(await upload(app, alice, bankCsv(ROWS), FILE));
    await as(app, alice).del(`${T}/${t.id}`);
    const res = await as(app, alice).post(`${base(alice)}/imports/${b.id}/commit`, { overrides: [] });
    expect(res.statusCode).toBe(200);
    expect(importBatchSchema.parse(res.json()).templateName).toBe('已删除的自定义模板');
    const txs = await database.db.select().from(transactions);
    expect(txs).toHaveLength(3);
    // 银行来源没有单号：不写来源标识，靠去重键
    expect(txs.every((x) => x.externalSource === null && x.dedupeKey)).toBe(true);
  });
});

describe.skipIf(!hasSamples)('真实旧版微信样本（import.md §9.1）', () => {
  it('建模板后旧版微信 csv 自动识别、来源为 wechat、再次上传全部重复', { timeout: 120_000 }, async () => {
    const t = await create(alice, '旧版微信 csv', LEGACY_WECHAT_SPEC);
    const [s1, s2] = legacySamples().filter((s) => s.name.includes('微信'));
    for (const s of [s1!, s2!]) {
      const body = uploadResponseSchema.parse((await upload(app, alice, readFileSync(s.path), s.name)).json());
      if (body.status !== 'preview') throw new Error('未自动识别');
      expect(body.batch.templateId).toBe(t.id);
      const res = await as(app, alice).post(`${base(alice)}/imports/${body.batch.id}/commit`, { overrides: [] });
      expect(res.statusCode).toBe(200);
    }
    const txs = await database.db.select().from(transactions);
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.every((x) => x.externalSource === 'wechat')).toBe(true);

    const again = uploadResponseSchema.parse((await upload(app, alice, readFileSync(s1!.path), s1!.name)).json());
    if (again.status !== 'preview') throw new Error('未自动识别');
    expect(again.batch.rows!.every((r) => r.status !== 'new')).toBe(true);
  });
});
