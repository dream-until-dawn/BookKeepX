/**
 * P0-1b 测试：通用引擎 + 声明式模板
 *
 *   1. 模板校验：合法模板能加载；非法模板（缺字段、字段拼错、跨字段约束不满足）必须被拒
 *   2. 识别：真实样本"识别矩阵"——每份样本只被自己的模板自动选中；无关文件不被误选
 *   3. 自定义模板：用一份用户定义的 split 模式模板解析合成的银行 csv，证明"不写代码接入新银行"可行
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { detect, loadBuiltinTemplates, loadTemplate, parseWith, readDoc } from '../src/engine/index.ts';
import { AUTO_SELECT_MIN } from '../src/engine/detect.ts';

const builtins = loadBuiltinTemplates();
const byId = (id: string) => builtins.find((t) => t.id === id)!;

/** 一份合法的最小模板（用户自定义的"某银行" csv，收入 / 支出分两列） */
const customBankTemplate = {
  id: 'user-demo-bank',
  version: 1,
  name: '某银行活期明细（用户自定义）',
  fileType: 'csv',
  fingerprint: { titleKeywords: ['某银行'] },
  header: { required: ['交易日期', '收入金额', '支出金额', '余额'] },
  columns: {
    occurredAt: ['交易日期'],
    income: ['收入金额'],
    expense: ['支出金额'],
    balance: ['余额'],
    counterparty: ['对方户名'],
    description: ['摘要'],
  },
  amount: { mode: 'split' },
  time: { format: 'yyyy/MM/dd' },
  verify: { balanceChain: true },
};

const demoBankCsv = (rows: string[]) =>
  iconv.encode(['某银行活期账户交易明细', '账号：****1234', '交易日期,摘要,收入金额,支出金额,余额,对方户名', ...rows].join('\r\n'), 'gbk');

// ───────────────────────── 1. 模板校验 ─────────────────────────
describe('模板校验', () => {
  it('正向：全部内置模板合法', () => {
    expect(builtins.map((t) => t.id).sort()).toEqual(['alipay-csv', 'cmb-pdf', 'wechat-xlsx']);
  });

  it('正向：用户自定义模板合法', () => {
    expect(() => loadTemplate(customBankTemplate)).not.toThrow();
  });

  it('反向：split 模式缺少支出列 → 拒绝', () => {
    const bad = { ...customBankTemplate, columns: { ...customBankTemplate.columns, expense: undefined } };
    expect(() => loadTemplate(bad)).toThrow(/split 时必须同时配置/);
  });

  it('反向：开启余额链却没配余额列 → 拒绝', () => {
    const { balance: _, ...cols } = customBankTemplate.columns;
    expect(() => loadTemplate({ ...customBankTemplate, columns: cols })).toThrow(/balanceChain/);
  });

  it('反向：字段名拼错 → 拒绝（严格模式）', () => {
    expect(() => loadTemplate({ ...customBankTemplate, fileNamePatern: 'x' })).toThrow(/模板不合法/);
  });

  it('反向：汇总笔数不含 {n} 占位符 → 拒绝', () => {
    expect(() => loadTemplate({ ...customBankTemplate, verify: { summary: { total: '共(\\d+)笔' } } })).toThrow(/\{n\}/);
  });

  it('反向：id 含非法字符 → 拒绝', () => {
    expect(() => loadTemplate({ ...customBankTemplate, id: '../etc' })).toThrow(/id/);
  });
});

// ───────────────────────── 2. 识别 ─────────────────────────
describe('识别（合成数据）', () => {
  it('反向：无关 csv → 进入自定义流程，不误选任何模板', async () => {
    const doc = await readDoc(Buffer.from('姓名,年龄\n张三,18\n'));
    expect(detect(doc, 'x.csv', builtins).kind).toBe('custom');
  });

  it('反向：表头像支付宝、但缺少标题指纹 → 只列为候选，不自动选用', async () => {
    const csv = '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n2026-09-01 12:00:00,餐饮美食,某店,/,午饭,支出,32.50,余额宝,交易成功,1,2,,\n';
    const d = detect(await readDoc(Buffer.from(csv)), 'export.csv', builtins);
    expect(d.kind).toBe('choose');
    expect(d.candidates[0]!.templateId).toBe('alipay-csv');
    expect(d.candidates[0]!.score).toBeLessThan(AUTO_SELECT_MIN);
  });

  it('正向：加入用户自定义模板后，合成银行 csv 被自动识别', async () => {
    const doc = await readDoc(demoBankCsv(['2026/09/01,工资,5000.00,,5000.00,某公司', '2026/09/02,消费,,32.50,4967.50,某店']));
    const d = detect(doc, 'mx.csv', [...builtins, loadTemplate(customBankTemplate)]);
    expect(d).toMatchObject({ kind: 'auto', templateId: 'user-demo-bank' });
  });
});

describe('自定义模板解析（合成数据）', () => {
  const t = loadTemplate(customBankTemplate);

  it('正向：前言用 CRLF、数据用 LF 的混合换行文件（支付宝实测形态）能正确分行', async () => {
    const text = '某银行活期账户交易明细\r\n账号：****1234\r\n交易日期,摘要,收入金额,支出金额,余额,对方户名\n2026/09/01,工资,5000.00,,5000.00,某公司\n2026/09/02,消费,,32.50,4967.50,某店\n';
    const r = parseWith(await readDoc(iconv.encode(text, 'gbk')), t);
    expect(r.records).toHaveLength(2);
    expect(r.issues).toEqual([]);
  });

  it('正向：split 模式解析出收入 / 支出，余额链通过', async () => {
    const r = parseWith(await readDoc(demoBankCsv(['2026/09/01,工资,5000.00,,5000.00,某公司', '2026/09/02,消费,,32.50,4967.50,某店'])), t);
    expect(r.records.map((x) => [x.direction, x.amountCents])).toEqual([
      ['income', 500000],
      ['expense', 3250],
    ]);
    expect(r.issues).toEqual([]);
  });

  it('反向：收入、支出同时填写 → 行错误并进入自校验问题', async () => {
    const r = parseWith(await readDoc(demoBankCsv(['2026/09/01,异常,1.00,2.00,5000.00,某公司'])), t);
    expect(r.errors[0]!.message).toMatch(/恰好填写一个/);
    expect(r.issues.length).toBeGreaterThan(0);
  });

  it('反向：时间格式与模板不符 → 行错误', async () => {
    const r = parseWith(await readDoc(demoBankCsv(['2026-09-01,工资,5000.00,,5000.00,某公司'])), t);
    expect(r.errors[0]!.message).toMatch(/不符合格式/);
  });

  it('反向：余额对不上 → 余额链报错', async () => {
    const r = parseWith(await readDoc(demoBankCsv(['2026/09/01,工资,5000.00,,5000.00,某公司', '2026/09/02,消费,,32.50,4000.00,某店'])), t);
    expect(r.issues).toEqual([expect.objectContaining({ check: '余额链' })]);
  });
});

// ───────────────────────── 3. 真实样本识别矩阵 ─────────────────────────
const SAMPLES = join(import.meta.dirname, '../../../samples');
const hasSamples = existsSync(SAMPLES) && readdirSync(SAMPLES).length >= 3;
const EXPECT: Record<string, string> = { '.xlsx': 'wechat-xlsx', '.csv': 'alipay-csv', '.pdf': 'cmb-pdf' };

describe.skipIf(!hasSamples)('真实样本识别矩阵', () => {
  for (const [ext, expectedId] of Object.entries(EXPECT)) {
    it(`${ext} → 只自动选中 ${expectedId}，且解析自校验通过`, async () => {
      const name = readdirSync(SAMPLES).find((n) => n.endsWith(ext))!;
      const doc = await readDoc(readFileSync(join(SAMPLES, name)));
      const d = detect(doc, name, builtins);
      expect(d).toMatchObject({ kind: 'auto', templateId: expectedId });
      expect(parseWith(doc, byId(expectedId)).issues).toEqual([]);
    });

    it(`${ext} → 改名成无意义文件名后仍能识别（不依赖文件名）`, async () => {
      const name = readdirSync(SAMPLES).find((n) => n.endsWith(ext))!;
      const d = detect(await readDoc(readFileSync(join(SAMPLES, name))), `download${ext}`, builtins);
      expect(d).toMatchObject({ kind: 'auto', templateId: expectedId });
    });
  }

  it('反向：模板声明的汇总行在文件里找不到 → 报"汇总缺失"，而不是静默跳过比对', async () => {
    const name = readdirSync(SAMPLES).find((n) => n.endsWith('.csv'))!;
    const base = byId('alipay-csv');
    const tampered = loadTemplate({ ...base, verify: { summary: { ...base.verify.summary!, total: '合计{n}条' } } });
    const r = parseWith(await readDoc(readFileSync(join(SAMPLES, name))), tampered);
    expect(r.issues).toEqual([expect.objectContaining({ check: '汇总缺失' })]);
  });

  it('反向：模板声明的分方向汇总标签在文件里找不到 → 报"汇总缺失"', async () => {
    const name = readdirSync(SAMPLES).find((n) => n.endsWith('.csv'))!;
    const base = byId('alipay-csv');
    const tampered = loadTemplate({ ...base, verify: { summary: { ...base.verify.summary!, labels: { expense: '支出合计' } } } });
    const r = parseWith(await readDoc(readFileSync(join(SAMPLES, name))), tampered);
    expect(r.issues).toEqual([expect.objectContaining({ check: '汇总缺失' })]);
  });

  it('反向：把模板的标题指纹改掉 → 支付宝样本不再被自动选中', async () => {
    const name = readdirSync(SAMPLES).find((n) => n.endsWith('.csv'))!;
    const tampered = loadTemplate({ ...byId('alipay-csv'), fingerprint: { titleKeywords: ['不存在的关键词'], fileNameKeywords: [] } });
    const d = detect(await readDoc(readFileSync(join(SAMPLES, name))), 'x.csv', [tampered]);
    expect(d.kind).toBe('choose');
  });
});
