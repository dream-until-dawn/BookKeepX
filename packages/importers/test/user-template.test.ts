/**
 * 用户自定义模板（import.md §9）：编译、宽松时间格式、余额链正倒序、识别打分、读取样本、试解析、真实旧版样本
 */
import { readFileSync } from 'node:fs';
import { guessTimeFormat, type UserTemplateSpecInput } from '@bookkeepx/contracts';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TEMPLATES,
  compileUserTemplate,
  inspectFile,
  parseBill,
  suggestHeaderRow,
  trialParse,
} from '../src/index.ts';
import {
  alipayCsv,
  BANK_SPEC,
  bankCsv,
  hasSamples,
  LEGACY_ALIPAY_SPEC,
  LEGACY_WECHAT_SPEC,
  legacySamples,
} from './helpers.ts';

const UID = '0e5c1f7a-6b0e-4c8e-9d7e-1a2b3c4d5e6f';
const meta = { id: UID, name: '某银行活期', version: 1 };
const spec = (over: Partial<UserTemplateSpecInput> = {}): UserTemplateSpecInput =>
  ({ ...BANK_SPEC, ...over }) as UserTemplateSpecInput;

const BANK_ROWS: Parameters<typeof bankCsv>[0] = [
  ['2026-09-01', '工资', '某公司', '8000.00', ''],
  ['2026-09-02', '消费', '某超市', '', '56.30'],
  ['2026-09-02', '消费', '某超市', '', '56.30'],
  ['2026-09-05', '转账', '张三', '', '1000.00'],
];
const FILE = '某银行明细.csv';

describe('compileUserTemplate', () => {
  it('正向：银行模板 → 来源标识按模板独立、账户类型为储蓄卡、开启余额链、0 元跳过', () => {
    const t = compileUserTemplate(spec(), meta);
    expect(t).toMatchObject({
      id: UID,
      source: `u-${UID}`,
      account: { kind: 'bank_debit' },
      header: { required: BANK_SPEC.header },
      amount: { mode: 'split' },
      columns: { income: ['收入金额'], expense: ['支出金额'], balance: ['账户余额'] },
      zeroAmount: 'skip',
      verify: { balanceChain: true },
    });
    expect(t.refund).toBeUndefined();
  });

  it('正向：微信 / 支付宝来源沿用内置的来源标识与退款规则（与内置模板共用单号去重）', () => {
    const w = compileUserTemplate(LEGACY_WECHAT_SPEC, meta);
    expect(w.source).toBe('wechat');
    expect(w.refund).toEqual({ detect: { statuses: [], hintSuffix: '-退款' }, link: { mode: 'counterparty' } });
    expect(w.status).toEqual({ column: ['当前状态'], skip: [] });
    const a = compileUserTemplate(LEGACY_ALIPAY_SPEC, meta);
    expect(a.source).toBe('alipay');
    expect(a.refund?.link).toEqual({ mode: 'externalIdPrefix', separators: ['_', '*'] });
  });

  it('正向："其他"来源不设账户类型', () => {
    expect(compileUserTemplate(spec({ sourceKind: 'other', balanceCheck: false }), meta).account).toBeUndefined();
  });

  it.each([
    ['列不在表头中', { columns: { ...BANK_SPEC.columns, counterparty: '不存在的列' } }, '不在表头中'],
    ['同一列对应两个字段', { columns: { ...BANK_SPEC.columns, description: '对方户名' } }, '同一列不能对应多个字段'],
    ['缺时间列', { columns: { income: '收入金额', expense: '支出金额' }, balanceCheck: false }, '必须指定交易时间列'],
    [
      '分两列却缺支出列',
      { columns: { occurredAt: '交易日期', income: '收入金额' }, balanceCheck: false },
      '支出金额列',
    ],
    [
      '收支列模式缺取值映射',
      {
        amountMode: 'directionColumn',
        columns: { occurredAt: '交易日期', amount: '收入金额', direction: '摘要' },
        balanceCheck: false,
      },
      '收/支列各取值',
    ],
    [
      '余额校验却没有余额列',
      { columns: { occurredAt: '交易日期', income: '收入金额', expense: '支出金额' } },
      '余额列',
    ],
    ['跳过状态却没有状态列', { skipStatuses: ['失败'] }, '状态列'],
    ['表头列名重复', { header: ['交易日期', '交易日期', '摘要'] }, '重复'],
  ] as const)('反向：%s → 拒绝', (_, over, message) => {
    expect(() => compileUserTemplate(spec(over as Partial<UserTemplateSpecInput>), meta)).toThrow(message);
  });

  it('反向：spec 中夹带模板的其他能力（如自定义汇总规则）→ 严格模式拒绝', () => {
    expect(() => compileUserTemplate({ ...spec(), verify: { summary: {} } }, meta)).toThrow();
  });
});

describe('宽松时间格式与推断', () => {
  it('guessTimeFormat：严格格式优先；不补零 / 无秒 → 宽松格式；有一个值不符 → 换下一种；都不符 → null', () => {
    expect(guessTimeFormat(['2026-09-01 12:00:00', '2026-09-02 08:05:09'])).toBe('yyyy-MM-dd HH:mm:ss');
    expect(guessTimeFormat(['2021/12/31 8:54', '2021/1/5 18:04'])).toBe('yyyy/M/d H:mm');
    expect(guessTimeFormat(['2026-09-01', '2026-9-2 8:00'])).toBeNull();
    expect(guessTimeFormat(['2026-09-01 12:00:00', '2026-9-2 8:00'])).toBe('yyyy-M-d H:mm');
    expect(guessTimeFormat(['09/01/2026'])).toBeNull();
    expect(guessTimeFormat(['', ' '])).toBeNull();
  });

  it('正向：宽松格式补零、省略的秒按 00；反向：严格格式不接受一位数的月份', async () => {
    const csv = (time: string) =>
      Buffer.from(`交易日期,摘要,对方户名,收入金额,支出金额,账户余额\r\n${time},消费,某店,,1.00,99.00\r\n`);
    const lenient = compileUserTemplate(spec({ timeFormat: 'yyyy/M/d H:mm', balanceCheck: false }), meta);
    const r = await parseBill(csv('2021/1/5 8:04'), FILE, { templates: [lenient], templateId: UID });
    if (r.status !== 'parsed') throw new Error('解析失败');
    expect(r.file.records[0]!.occurredAt).toBe('2021-01-05T08:04:00+08:00');

    const strict = compileUserTemplate(spec({ timeFormat: 'yyyy/MM/dd HH:mm:ss', balanceCheck: false }), meta);
    const s = await parseBill(csv('2021/1/5 8:04:00'), FILE, { templates: [strict], templateId: UID });
    if (s.status !== 'parsed') throw new Error('解析失败');
    expect(s.file.errors[0]?.message).toContain('不符合格式');
  });
});

describe('余额链：正序、倒序都能校验', () => {
  const tpl = compileUserTemplate(spec(), meta);
  const parse = async (bytes: Buffer) => {
    const r = await parseBill(bytes, FILE, { templates: [tpl], templateId: UID });
    if (r.status !== 'parsed') throw new Error('解析失败');
    return r.file;
  };

  it('正向：倒序（新 → 旧）与正序文件都通过', async () => {
    expect((await parse(bankCsv(BANK_ROWS, { order: 'desc' }))).issues).toEqual([]);
    expect((await parse(bankCsv(BANK_ROWS, { order: 'asc' }))).issues).toEqual([]);
  });

  it('反向：某一行余额写错 → 两个方向都对不上，报告问题', async () => {
    for (const order of ['asc', 'desc'] as const) {
      const f = await parse(bankCsv(BANK_ROWS, { order, breakBalanceAt: 1 }));
      expect(f.issues.length).toBeGreaterThan(0);
      expect(f.issues[0]!.check).toBe('余额链');
    }
  });

  it('反向：内置招行模板也适用——漏掉一行仍会被发现', async () => {
    const rows = BANK_ROWS.filter((_, i) => i !== 1);
    const full = bankCsv(BANK_ROWS).toString('utf-8').split('\r\n');
    // 删掉中间一行数据（模拟漏记），余额链断开
    const missing = Buffer.from([...full.slice(0, 5), ...full.slice(6)].join('\r\n'));
    expect(rows).toHaveLength(3);
    expect((await parse(missing)).issues.length).toBeGreaterThan(0);
  });
});

describe('识别打分（import.md §9.4）', () => {
  const bank = compileUserTemplate(spec(), meta);

  it('正向：没有关键词的用户模板，文件完全匹配时得 1 分并被自动选用', async () => {
    const r = await parseBill(bankCsv(BANK_ROWS), FILE, { templates: [...BUILTIN_TEMPLATES, bank] });
    expect(r.status).toBe('parsed');
    if (r.status === 'parsed') {
      expect(r.template.id).toBe(UID);
      expect(r.score).toBe(1);
    }
  });

  it('反向：内置模板的文件不会被用户模板抢走（即使用户模板的表头是它的子集）', async () => {
    const generic = compileUserTemplate(
      {
        fileType: 'csv',
        sourceKind: 'other',
        header: ['交易时间', '金额'],
        columns: { occurredAt: '交易时间', amount: '金额' },
        amountMode: 'signed',
        timeFormat: 'yyyy-MM-dd HH:mm:ss',
      },
      { ...meta, id: 'a0000000-0000-4000-8000-000000000001' },
    );
    const file = alipayCsv([['2026-09-01 12:00:00', '餐饮美食', '支出', '10.00', '交易成功', 'A1']]);
    const r = await parseBill(file, '支付宝交易明细.csv', { templates: [...BUILTIN_TEMPLATES, generic] });
    // 用户模板表头能找到，但"金额"列都是正数 → 全被当成收入，方向无法校验；关键是不能被自动选中
    expect(r.status === 'parsed' ? r.template.id : r.status).toBe('alipay-csv');
  });

  it('反向：部分行解析失败的文件不会被自动选用', async () => {
    const bad = Buffer.from(bankCsv(BANK_ROWS).toString('utf-8').replace('2026-09-02,消费', '9月2日,消费'));
    const r = await parseBill(bad, FILE, { templates: [...BUILTIN_TEMPLATES, bank] });
    expect(r.status).toBe('choose_template');
  });
});

describe('读取样本', () => {
  it('suggestHeaderRow：跳过说明文字，选中列最多、且下一行也是多列的那一行', () => {
    expect(
      suggestHeaderRow([
        ['某某银行活期账户交易明细'],
        ['账号：6222'],
        [],
        ['交易日期', '摘要', '对方户名', '收入金额'],
        ['2026-09-01', '工资', '某公司', '8000.00'],
      ]),
    ).toBe(3);
  });

  it('反向：没有像表头的行 → null', () => {
    expect(suggestHeaderRow([['说明'], ['a', 'b'], ['c']])).toBeNull();
    // 列最多的是最后一行，没有下一行 → 不认为是表头
    expect(suggestHeaderRow([['说明'], ['a', 'b', 'c', 'd']])).toBeNull();
  });

  it('inspectFile：返回文字单元格、去掉行尾空列、给出推荐表头；GBK 文件正确解码', async () => {
    const r = await inspectFile(bankCsv(BANK_ROWS));
    expect(r.fileType).toBe('csv');
    expect(r.suggestedHeaderRow).toBe(3);
    expect(r.rows[3]).toEqual(BANK_SPEC.header);
    expect(r.rows[2]).toEqual([]);
    const gbk = await inspectFile(alipayCsv([['2026-09-01 12:00:00', '餐饮美食', '支出', '10.00', '交易成功', 'A1']]));
    const header = gbk.rows[gbk.suggestedHeaderRow!]!;
    expect(header.slice(0, 3)).toEqual(['交易时间', '交易分类', '交易对方']);
    // 行尾多余的逗号不产生空列
    expect(header.at(-1)).toBe('备注');
  });
});

describe('trialParse', () => {
  it('正向：返回前若干条结果与"保存后能自动识别"', async () => {
    const r = await trialParse(bankCsv(BANK_ROWS), FILE, compileUserTemplate(spec(), meta), BUILTIN_TEMPLATES);
    expect(r).toMatchObject({ headerFound: true, total: 4, errorCount: 0, issues: [] });
    expect(r.detect).toEqual({ score: 1, autoSelected: true, reason: null });
    // 倒序文件：第一条是最新的一笔
    expect(r.records[0]).toMatchObject({ direction: 'expense', amountCents: 100000, counterparty: '张三' });
  });

  it('反向：列映射错误（把收入、支出列对调）→ 余额链报问题；时间格式选错 → 错误行与"匹配度不足"', async () => {
    const swapped = compileUserTemplate(
      spec({ columns: { ...BANK_SPEC.columns, income: '支出金额', expense: '收入金额' } }),
      meta,
    );
    expect((await trialParse(bankCsv(BANK_ROWS), FILE, swapped, [])).issues.length).toBeGreaterThan(0);

    const wrongTime = compileUserTemplate(spec({ timeFormat: 'yyyy/MM/dd' }), meta);
    const r = await trialParse(bankCsv(BANK_ROWS), FILE, wrongTime, []);
    expect(r.errorCount).toBe(4);
    expect(r.detect.autoSelected).toBe(false);
    expect(r.detect.reason).toContain('匹配度不足');
  });

  it('反向：表头对不上 → headerFound=false', async () => {
    const other = compileUserTemplate(
      spec({
        header: [...BANK_SPEC.header.slice(0, 5), '余额'],
        balanceCheck: false,
        columns: { occurredAt: '交易日期', income: '收入金额', expense: '支出金额' },
      }),
      meta,
    );
    const r = await trialParse(bankCsv(BANK_ROWS), FILE, other, []);
    expect(r).toMatchObject({ headerFound: false, total: 0 });
    expect(r.detect.reason).toBe('找不到表头');
  });

  it('反向：与已有模板表头相同、难以区分 → 给出原因', async () => {
    const twin = compileUserTemplate(spec(), { ...meta, id: 'b0000000-0000-4000-8000-000000000002', name: '另一个' });
    const r = await trialParse(bankCsv(BANK_ROWS), FILE, compileUserTemplate(spec(), meta), [twin]);
    expect(r.detect.autoSelected).toBe(false);
    expect(r.detect.reason).toContain('另一个');
  });
});

describe.skipIf(!hasSamples)('真实旧版样本（import.md §9.1）', () => {
  const wechat = compileUserTemplate(LEGACY_WECHAT_SPEC, { ...meta, name: '旧版微信 csv' });
  const alipay = compileUserTemplate(LEGACY_ALIPAY_SPEC, {
    ...meta,
    id: 'c0000000-0000-4000-8000-000000000003',
    name: '旧版支付宝 csv',
  });
  const templates = [...BUILTIN_TEMPLATES, wechat, alipay];

  for (const s of hasSamples ? legacySamples() : []) {
    it(`${s.name.replace(/^\d{4}_/, '****_')} → 自动选中用户模板、0 错误`, async () => {
      const r = await parseBill(readFileSync(s.path), s.name, { templates });
      if (r.status !== 'parsed') throw new Error(`未自动识别：${JSON.stringify(r)}`);
      expect(r.template.id).toBe(s.name.includes('微信') ? wechat.id : alipay.id);
      expect(r.file.errors).toEqual([]);
      expect(r.file.records.length).toBeGreaterThan(0);
    });
  }
});
