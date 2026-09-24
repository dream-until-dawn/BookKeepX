/**
 * P1-6 账单导入：上传 → 预览 → 提交 → 撤销；去重、退款、跨来源重复、分类、权限、异常文件
 */
import { readFileSync } from 'node:fs';
import { type ImportBatch, importBatchSchema, transactionListSchema, uploadResponseSchema } from '@bookkeepx/contracts';
import { BUILTIN_TEMPLATES } from '@bookkeepx/importers';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { currentFormatSamples, hasSamples } from '../../../packages/importers/test/helpers.ts';
import { buildApp } from '../src/app.ts';
import { ledgerMembers, transactions } from '../src/db/schema/index.ts';
import { buildPreview } from '../src/modules/imports/preview.ts';
import { requireLedgerAccess } from '../src/modules/ledgers/access.ts';
import { as, registerUser, type TestUser } from './api-helpers.ts';
import { truncateAll, useMigratedDatabase } from './db-helpers.ts';
import { alipayCsv, upload } from './import-helpers.ts';

const database = useMigratedDatabase();
let now: Date;
let app: ReturnType<typeof buildApp>;
let alice: TestUser;

beforeEach(async () => {
  await truncateAll(database);
  now = new Date('2026-09-24T10:00:00+08:00');
  app = buildApp({ database, clock: () => now });
  alice = await registerUser(app, 'alice');
});

const base = (u: TestUser = alice) => `/api/ledgers/${u.ledgerId}`;
const NAME = '支付宝交易明细(20260901-20260930).csv';

/** 上传并断言得到预览 */
async function preview(
  bytes: Buffer,
  name = NAME,
  fields: Record<string, string> = {},
  user = alice,
): Promise<ImportBatch> {
  const res = await upload(app, user, bytes, name, fields);
  if (res.statusCode !== 200) throw new Error(`上传失败：${res.statusCode} ${res.body}`);
  const body = uploadResponseSchema.parse(res.json());
  if (body.status !== 'preview') throw new Error(`期望得到预览，实际 ${body.status}`);
  return body.batch;
}

async function commit(batch: ImportBatch, overrides: object[] = [], user = alice) {
  return as(app, user).post(`${base(user)}/imports/${batch.id}/commit`, { overrides });
}

async function ledgerTransactions(user = alice) {
  return transactionListSchema.parse((await as(app, user).get(`${base(user)}/transactions?pageSize=100`)).json());
}

const catId = async (key: string) =>
  ((await as(app, alice).get(`${base()}/categories`)).json() as { id: string; presetKey: string }[]).find(
    (c) => c.presetKey === key,
  )!.id;

describe('上传与预览', () => {
  it('正向：识别模板、自动分类、自动对应唯一的支付宝账户、提取户主姓名', async () => {
    const acc = (await as(app, alice).post(`${base()}/accounts`, { name: '支付宝', kind: 'alipay' })).json();
    const b = await preview(
      alipayCsv(
        [
          { id: 'A1', amount: '2.70', category: '交通出行', counterparty: '厦门地铁', desc: '厦门地铁' },
          { id: 'A2', amount: '32.50', category: '餐饮美食', counterparty: '无关键词的店' },
          { id: 'A3', amount: '9.90', category: '其他', counterparty: '甲乙丙' },
        ],
        { holder: '张三' },
      ),
    );
    expect(importBatchSchema.parse(b)).toMatchObject({
      status: 'previewing',
      // 中文文件名原样保存
      fileName: NAME,
      templateId: 'alipay-csv',
      templateName: '支付宝交易明细（csv）',
      accountId: acc.id,
      holderName: '张三',
      totalRows: 3,
      sameFileImportedBefore: false,
    });
    const [metro, food, other] = b.rows!;
    expect(metro).toMatchObject({
      status: 'new',
      categoryId: await catId('expense.transport.public'),
      categorySource: 'system_rule',
    });
    expect(food).toMatchObject({ categoryId: await catId('expense.food'), categorySource: 'source_hint' });
    expect(other).toMatchObject({ categoryId: null, categorySource: 'none' });
  });

  it('正向：有多个支付宝账户时不自动选择；用户可以在上传时指定', async () => {
    await as(app, alice).post(`${base()}/accounts`, { name: '支付宝 A', kind: 'alipay' });
    const accB = (await as(app, alice).post(`${base()}/accounts`, { name: '支付宝 B', kind: 'alipay' })).json();
    expect((await preview(alipayCsv([{ id: 'A1', amount: '1' }]))).accountId).toBeNull();
    expect((await preview(alipayCsv([{ id: 'A1', amount: '1' }]), NAME, { accountId: accB.id })).accountId).toBe(
      accB.id,
    );
  });

  it('反向：自校验不通过 → 422，附带问题列表，不产生任何批次', async () => {
    const res = await upload(
      app,
      alice,
      alipayCsv([{ id: 'A1', amount: '1' }], {
        summary: ['收入：0笔 0.00元', '支出：1笔 9.99元', '不计收支：0笔 0.00元'],
      }),
      NAME,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      code: 'IMPORT_VERIFY_FAILED',
      details: [expect.objectContaining({ check: '支出金额' })],
    });
    expect((await as(app, alice).get(`${base()}/imports`)).json()).toHaveLength(0);
  });

  it('反向：无关文件 → 400 不支持；空文件 → 400；损坏的 xlsx → 400 且给出原因', async () => {
    expect((await upload(app, alice, Buffer.from('姓名,年龄\n张三,18\n'), 'x.csv')).json().code).toBe(
      'IMPORT_UNSUPPORTED',
    );
    expect((await upload(app, alice, Buffer.alloc(0), 'x.csv')).json().code).toBe('IMPORT_EMPTY_FILE');
    const broken = await upload(app, alice, Buffer.from('PK\u0003\u0004broken'), 'x.xlsx');
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ code: 'IMPORT_UNREADABLE', error: expect.stringContaining('xlsx') });
  });

  it('正向 + 反向：识别不确定 → 返回候选；指定模板后解析，但汇总缺失仍被自校验拦下', async () => {
    const csv = Buffer.from(
      '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n2026-09-01 12:00:00,餐饮美食,某店,/,午饭,支出,32.50,余额宝,交易成功,1,2,,\n',
    );
    const first = uploadResponseSchema.parse((await upload(app, alice, csv, 'export.csv')).json());
    expect(first).toMatchObject({
      status: 'choose_template',
      candidates: [expect.objectContaining({ templateId: 'alipay-csv' })],
    });
    const second = await upload(app, alice, csv, 'export.csv', { templateId: 'alipay-csv' });
    expect(second.statusCode).toBe(422);
  });

  it('反向：文件超过 10 MB → 413', async () => {
    const res = await upload(app, alice, Buffer.alloc(10 * 1024 * 1024 + 1, 0x41), 'big.csv');
    expect(res.statusCode).toBe(413);
  });

  it('反向：指定不存在的模板 / 其他账本的账户 → 400 / 404', async () => {
    expect(
      (await upload(app, alice, alipayCsv([{ id: 'A1', amount: '1' }]), NAME, { templateId: 'nope' })).statusCode,
    ).toBe(400);
    const bob = await registerUser(app, 'bob');
    const bobAcc = (await as(app, bob).post(`${base(bob)}/accounts`, { name: '支付宝', kind: 'alipay' })).json();
    expect(
      (await upload(app, alice, alipayCsv([{ id: 'A1', amount: '1' }]), NAME, { accountId: bobAcc.id })).statusCode,
    ).toBe(404);
  });
});

describe('提交', () => {
  it('正向：写入全部新记录，保留单号、原始行、分类来源；批次变为已提交', async () => {
    const b = await preview(
      alipayCsv([
        { id: 'A1', amount: '2.70', counterparty: '厦门地铁', category: '交通出行' },
        { id: 'A2', amount: '5' },
      ]),
    );
    const res = await commit(b);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'committed', importedRows: 2 });
    const [row] = await database.db.select().from(transactions).where(eq(transactions.externalId, 'A1'));
    expect(row).toMatchObject({
      source: 'import',
      externalSource: 'alipay',
      importBatchId: b.id,
      amountCents: 270,
      categorySource: 'system_rule',
      sourceCategory: '交通出行',
    });
    expect(row!.raw).toMatchObject({ 交易订单号: 'A1' });
  });

  it('正向：预览中改分类、取消勾选某行 → 按修改写入，改过的分类记为手动', async () => {
    const b = await preview(
      alipayCsv([
        { id: 'A1', amount: '1' },
        { id: 'A2', amount: '2' },
      ]),
    );
    const other = await catId('expense.other');
    await commit(b, [
      { index: 0, categoryId: other },
      { index: 1, include: false },
    ]);
    const list = await ledgerTransactions();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ categoryId: other, categorySource: 'manual' });
  });

  it('反向：把分类改成与方向不一致的 → 400，且什么都没写入', async () => {
    const b = await preview(alipayCsv([{ id: 'A1', amount: '1' }]));
    const res = await commit(b, [{ index: 0, categoryId: await catId('income.salary') }]);
    expect(res.json().code).toBe('CATEGORY_DIRECTION_MISMATCH');
    expect((await ledgerTransactions()).total).toBe(0);
  });

  it('反向：改成已隐藏的分类 → 400，且什么都没写入', async () => {
    const b = await preview(alipayCsv([{ id: 'A1', amount: '1' }]));
    const hiddenId = await catId('expense.other');
    await as(app, alice).patch(`${base()}/categories/${hiddenId}`, { hidden: true });
    const res = await commit(b, [{ index: 0, categoryId: hiddenId }]);
    expect(res.json().code).toBe('CATEGORY_HIDDEN');
    expect((await ledgerTransactions()).total).toBe(0);
  });

  it('反向：重复提交 → 409；放弃的预览不能提交；超过 24 小时的预览 → 410', async () => {
    const b1 = await preview(alipayCsv([{ id: 'A1', amount: '1' }]));
    await commit(b1);
    expect((await commit(b1)).json().code).toBe('IMPORT_NOT_PREVIEWING');

    const b2 = await preview(alipayCsv([{ id: 'B1', amount: '1' }]));
    expect((await as(app, alice).del(`${base()}/imports/${b2.id}`)).statusCode).toBe(204);
    expect((await commit(b2)).statusCode).toBe(409);

    const b3 = await preview(alipayCsv([{ id: 'C1', amount: '1' }]));
    now = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 1000);
    expect((await commit(b3)).statusCode).toBe(410);
  });
});

describe('去重', () => {
  it('正向：同一文件再次上传 → 全部标记为"已导入过"，提示同一文件导入过；提交后不产生重复流水', async () => {
    const bytes = alipayCsv([
      { id: 'A1', amount: '1' },
      { id: 'A2', amount: '2' },
    ]);
    await commit(await preview(bytes));
    const again = await preview(bytes);
    expect(again.sameFileImportedBefore).toBe(true);
    expect(again.rows!.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(again.duplicateRows).toBe(2);
    await commit(again);
    expect((await ledgerTransactions()).total).toBe(2);
  });

  it('正向：新旧账单时间重叠 → 只导入新的记录', async () => {
    await commit(await preview(alipayCsv([{ id: 'A1', amount: '1' }])));
    const b = await preview(
      alipayCsv([
        { id: 'A1', amount: '1' },
        { id: 'A2', amount: '2' },
      ]),
    );
    expect(b.rows!.map((r) => r.status)).toEqual(['duplicate', 'new']);
  });

  it('反向：试图强行导入"已导入过"的行 → 400', async () => {
    const bytes = alipayCsv([{ id: 'A1', amount: '1' }]);
    await commit(await preview(bytes));
    const again = await preview(bytes);
    expect((await commit(again, [{ index: 0, include: true }])).json().code).toBe('IMPORT_ROW_NOT_INCLUDABLE');
  });

  it('正向：删除后的流水不算"已导入过"，可以重新导入', async () => {
    const bytes = alipayCsv([{ id: 'A1', amount: '1' }]);
    await commit(await preview(bytes));
    const t = (await ledgerTransactions()).items[0]!;
    await as(app, alice).del(`${base()}/transactions/${t.id}`);
    expect((await preview(bytes)).rows![0]!.status).toBe('new');
  });
});

describe('退款', () => {
  it('正向：全额退款后的"交易关闭"原消费与退款都导入，净支出为 0', async () => {
    const b = await preview(
      alipayCsv([
        { id: 'C001', amount: '179.00', status: '交易关闭', category: '数码电器' },
        {
          id: 'C001_R',
          amount: '179.00',
          dir: '不计收支',
          status: '退款成功',
          category: '退款',
          time: '2026-09-03 12:00:00',
        },
      ]),
    );
    expect(b.rows!.map((r) => r.status)).toEqual(['new', 'new']);
    expect(b.rows![1]!.refund).toEqual({ linked: true });
    await commit(b);
    expect((await ledgerTransactions()).summary.expenseCents).toBe(0);
  });

  it('正向：退款的原消费在以前的导入里 → 按单号关联到已有流水', async () => {
    await commit(await preview(alipayCsv([{ id: 'P001', amount: '50.00' }])));
    const b = await preview(
      alipayCsv([{ id: 'P001_R1', amount: '8.00', dir: '不计收支', status: '退款成功', category: '退款' }]),
    );
    expect(b.rows![0]!.refund).toEqual({ linked: true });
    await commit(b);
    const [original] = await database.db.select().from(transactions).where(eq(transactions.externalId, 'P001'));
    const [refund] = await database.db.select().from(transactions).where(eq(transactions.externalId, 'P001_R1'));
    expect(refund).toMatchObject({ isRefund: true, refundOfId: original!.id });
    expect((await ledgerTransactions()).summary.expenseCents).toBe(4200);
  });

  it('反向：原消费从未导入 → 退款标记为未关联（冲减"其他支出"）', async () => {
    const b = await preview(
      alipayCsv([{ id: 'X_R1', amount: '8.00', dir: '不计收支', status: '退款成功', category: '退款' }]),
    );
    expect(b.rows![0]!.refund).toEqual({ linked: false });
  });
});

describe('跨来源重复（ADR-0004 Q2-B）', () => {
  async function cardAccount() {
    return (
      await as(app, alice).post(`${base()}/accounts`, { name: '招行储蓄卡', kind: 'bank_debit', cardLast4: '1032' })
    ).json();
  }

  it('正向：先有银行记录，再导入用这张卡付款的支付宝消费 → 银行那条标记为重复（不计入统计）', async () => {
    const card = await cardAccount();
    const [bank] = await database.db
      .insert(transactions)
      .values({
        ledgerId: alice.ledgerId,
        accountId: card.id,
        direction: 'expense',
        amountCents: 377092,
        occurredAt: new Date('2026-09-01T00:00:00+08:00'),
        timePrecision: 'day',
        source: 'import',
        counterparty: '支付宝-平安保险',
      })
      .returning();
    const b = await preview(
      alipayCsv([{ id: 'INS1', amount: '3770.92', pay: '招商银行储蓄卡(1032)&支付宝随机立减', category: '保险' }]),
    );
    expect(b.rows![0]!.crossSource).toBe('platform_side');
    await commit(b);
    const [newRow] = await database.db.select().from(transactions).where(eq(transactions.externalId, 'INS1'));
    const [bankAfter] = await database.db.select().from(transactions).where(eq(transactions.id, bank!.id));
    expect(bankAfter!.duplicateOfId).toBe(newRow!.id);
    expect((await ledgerTransactions()).summary.expenseCents).toBe(377092);
  });

  it('正向：先有支付宝记录，再导入银行流水 → 银行那条写入时即标记为重复', async () => {
    const card = await cardAccount();
    const [platform] = await database.db
      .insert(transactions)
      .values({
        ledgerId: alice.ledgerId,
        direction: 'expense',
        amountCents: 377092,
        occurredAt: new Date('2026-09-01T11:05:07+08:00'),
        source: 'import',
        externalSource: 'alipay',
        externalId: 'INS1',
        paymentMethod: '招商银行储蓄卡(1032)&支付宝随机立减',
      })
      .returning();
    const scope = await requireLedgerAccess(database.db, alice.id, alice.ledgerId, 'editor');
    const cmb = BUILTIN_TEMPLATES.find((t) => t.id === 'cmb-pdf')!;
    const rows = await buildPreview(database.db, scope, {
      template: cmb,
      accountId: card.id,
      holderName: null,
      timezone: 'Asia/Shanghai',
      records: [
        {
          index: 0,
          rowLabel: '第 1 页',
          occurredAt: '2026-09-01T00:00:00+08:00',
          timePrecision: 'day',
          direction: 'expense',
          amountCents: 377092,
          counterparty: '支付宝-平安保险',
          description: '快捷支付',
          externalId: null,
          paymentMethod: null,
          status: null,
          categoryHint: '快捷支付',
          balanceCents: 100,
          raw: {},
          skipReason: null,
          refund: null,
        },
      ],
    });
    expect(rows[0]).toMatchObject({ crossSource: 'bank_side', duplicateOfTransactionId: platform!.id });
  });

  it('反向：同金额但不同日期、或付款卡尾号不同 → 不算重复', async () => {
    const card = await cardAccount();
    await database.db.insert(transactions).values({
      ledgerId: alice.ledgerId,
      accountId: card.id,
      direction: 'expense',
      amountCents: 100,
      occurredAt: new Date('2026-09-02T00:00:00+08:00'),
      source: 'import',
    });
    const b = await preview(
      alipayCsv([
        { id: 'D1', amount: '1.00', pay: '招商银行储蓄卡(1032)' },
        { id: 'D2', amount: '1.00', pay: '招商银行储蓄卡(9999)', time: '2026-09-02 10:00:00' },
      ]),
    );
    expect(b.rows!.map((r) => r.crossSource)).toEqual([null, null]);
  });

  it('反向：用这张卡买理财（被规则识别为中性，Q2-A）→ 不走跨来源重复，银行那条照常计入', async () => {
    const card = await cardAccount();
    await database.db.insert(transactions).values({
      ledgerId: alice.ledgerId,
      accountId: card.id,
      direction: 'expense',
      amountCents: 100000,
      occurredAt: new Date('2026-09-01T00:00:00+08:00'),
      source: 'import',
    });
    const b = await preview(
      alipayCsv([{ id: 'F1', amount: '1000.00', counterparty: '蚂蚁基金销售', pay: '招商银行储蓄卡(1032)' }]),
    );
    expect(b.rows![0]).toMatchObject({ direction: 'neutral', crossSource: null });
  });
});

describe('撤销', () => {
  it('正向：整批撤销删除该批次的全部流水；其他批次对它的退款引用被解除；不能重复撤销', async () => {
    const first = await preview(alipayCsv([{ id: 'P001', amount: '50.00' }]));
    await commit(first);
    await commit(
      await preview(
        alipayCsv([{ id: 'P001_R1', amount: '8.00', dir: '不计收支', status: '退款成功', category: '退款' }]),
      ),
    );

    const res = await as(app, alice).post(`${base()}/imports/${first.id}/revert`, {});
    expect(res.json()).toMatchObject({ status: 'reverted' });
    const left = await database.db.select().from(transactions).where(eq(transactions.ledgerId, alice.ledgerId));
    expect(left.map((t) => t.externalId)).toEqual(['P001_R1']);
    expect(left[0]!.refundOfId).toBeNull();
    expect((await as(app, alice).post(`${base()}/imports/${first.id}/revert`, {})).json().code).toBe(
      'IMPORT_NOT_COMMITTED',
    );
  });

  it('正向：撤销平台账单 → 被它标记为重复的银行记录恢复计入统计（不连带删除）', async () => {
    const card = (
      await as(app, alice).post(`${base()}/accounts`, { name: '招行储蓄卡', kind: 'bank_debit', cardLast4: '1032' })
    ).json();
    const [bank] = await database.db
      .insert(transactions)
      .values({
        ledgerId: alice.ledgerId,
        accountId: card.id,
        direction: 'expense',
        amountCents: 5000,
        occurredAt: new Date('2026-09-01T00:00:00+08:00'),
        timePrecision: 'day',
        source: 'import',
      })
      .returning();
    const b = await preview(alipayCsv([{ id: 'X1', amount: '50.00', pay: '招商银行储蓄卡(1032)' }]));
    await commit(b);
    expect((await ledgerTransactions()).summary.expenseCents).toBe(5000);

    expect((await as(app, alice).post(`${base()}/imports/${b.id}/revert`, {})).statusCode).toBe(200);
    const [after] = await database.db.select().from(transactions).where(eq(transactions.id, bank!.id));
    expect(after!.duplicateOfId).toBeNull();
    const list = await ledgerTransactions();
    expect(list.total).toBe(1);
    expect(list.summary.expenseCents).toBe(5000);
  });

  it('正向：撤销后同一文件可以重新导入', async () => {
    const bytes = alipayCsv([{ id: 'A1', amount: '1' }]);
    const b = await preview(bytes);
    await commit(b);
    await as(app, alice).post(`${base()}/imports/${b.id}/revert`, {});
    expect((await preview(bytes)).rows![0]!.status).toBe('new');
  });
});

describe('权限', () => {
  it('反向：只读成员可以查看导入历史，但不能上传、提交、撤销', async () => {
    const viewer = await registerUser(app, 'viewer');
    await database.db.insert(ledgerMembers).values({ ledgerId: alice.ledgerId, userId: viewer.id, role: 'viewer' });
    const b = await preview(alipayCsv([{ id: 'A1', amount: '1' }]));
    expect((await as(app, viewer).get(`${base()}/imports`)).statusCode).toBe(200);
    expect(
      (await upload(app, { ...viewer, ledgerId: alice.ledgerId }, alipayCsv([{ id: 'A2', amount: '1' }]), NAME))
        .statusCode,
    ).toBe(403);
    expect((await commit(b, [], { ...viewer, ledgerId: alice.ledgerId })).statusCode).toBe(403);
  });

  it('反向：在自己的账本路径下操作他人的导入批次 → 404', async () => {
    const bob = await registerUser(app, 'bob');
    const bobBatch = await preview(alipayCsv([{ id: 'B1', amount: '1' }]), NAME, {}, bob);
    expect((await as(app, alice).get(`${base()}/imports/${bobBatch.id}`)).statusCode).toBe(404);
    expect((await commit({ ...bobBatch }, [], alice)).statusCode).toBe(404);
  });
});

describe.skipIf(!hasSamples)('真实样本端到端（本机）', () => {
  it('全部新版样本依次导入同一账本：自校验通过、退款关联、再次导入全部识别为重复', { timeout: 120_000 }, async () => {
    await as(app, alice).post(`${base()}/accounts`, { name: '微信', kind: 'wechat' });
    await as(app, alice).post(`${base()}/accounts`, { name: '支付宝', kind: 'alipay' });
    const samples = currentFormatSamples();
    // 招行卡尾号从文件中提取，先解析一次拿到尾号再建账户
    for (const s of samples) {
      const b = await preview(readFileSync(s.path), s.name);
      if (s.expected === 'cmb-pdf' && !b.accountId) {
        await as(app, alice).del(`${base()}/imports/${b.id}`);
        const tail = (await import('@bookkeepx/importers')).parseBill;
        const parsed = await tail(readFileSync(s.path), s.name);
        if (parsed.status !== 'parsed') throw new Error('招行解析失败');
        await as(app, alice).post(`${base()}/accounts`, {
          name: '招行卡',
          kind: 'bank_debit',
          cardLast4: parsed.file.meta.accountLast4,
        });
        const again = await preview(readFileSync(s.path), s.name);
        expect(again.accountId).not.toBeNull();
        expect((await commit(again)).statusCode).toBe(200);
        continue;
      }
      expect(b.accountId, `${s.name} 应自动对应账户`).not.toBeNull();
      expect((await commit(b)).statusCode).toBe(200);
    }
    // 退款全部关联到原消费
    const refunds = await database.db
      .select()
      .from(transactions)
      .where(and(eq(transactions.ledgerId, alice.ledgerId), eq(transactions.isRefund, true)));
    expect(refunds.length).toBeGreaterThan(0);
    expect(refunds.every((r) => r.refundOfId !== null)).toBe(true);
    // 再次导入：全部是"已导入过"或"跳过"
    for (const s of samples) {
      const b = await preview(readFileSync(s.path), s.name);
      expect(
        b.rows!.every((r) => r.status !== 'new'),
        s.name,
      ).toBe(true);
      await as(app, alice).del(`${base()}/imports/${b.id}`);
    }
  });
});
