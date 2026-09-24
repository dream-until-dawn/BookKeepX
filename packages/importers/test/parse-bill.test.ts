/**
 * @bookkeepx/importers：模板校验、识别、解析、自校验、退款关联
 *   - 合成数据：CI 上运行，覆盖正反向与边界
 *   - 真实样本：本机 samples/ 下存在时运行（P0 探针结论的回归）
 */
import { readFileSync } from 'node:fs';
import iconv from 'iconv-lite';
import { describe, expect, it } from 'vitest';
import { BUILTIN_TEMPLATES, loadTemplate, parseBill } from '../src/index.ts';
import { alipayCsv, currentFormatSamples, hasSamples, legacySamples } from './helpers.ts';

const byId = (id: string) => BUILTIN_TEMPLATES.find((t) => t.id === id)!;

/** 解析并断言成功 */
async function parsed(bytes: Buffer, name = '支付宝交易明细(test).csv', templateId?: string) {
  const r = await parseBill(bytes, name, { templateId });
  if (r.status !== 'parsed') throw new Error(`期望解析成功，实际 ${r.status}`);
  return r;
}

describe('内置模板', () => {
  it('正向：三份内置模板加载并通过严格校验', () => {
    expect(BUILTIN_TEMPLATES.map((t) => `${t.id}@${t.version}:${t.source}`)).toEqual([
      'wechat-xlsx@1:wechat',
      'alipay-csv@1:alipay',
      'cmb-pdf@1:cmb',
    ]);
  });

  it('反向：字段名拼错 / split 缺支出列 / 汇总不含占位符 → 拒绝', () => {
    const base = byId('alipay-csv');
    expect(() => loadTemplate({ ...base, fileNamePatern: 'x' })).toThrow(/模板不合法/);
    expect(() => loadTemplate({ ...base, amount: { mode: 'split' } })).toThrow(/split/);
    expect(() => loadTemplate({ ...base, verify: { summary: { total: '共(\\d+)笔' } } })).toThrow(/\{n\}/);
  });
});

describe('支付宝（合成数据）', () => {
  const ok = (id: string, amount = '32.50', desc = '午饭'): Parameters<typeof alipayCsv>[0][number] => [
    '2026-09-01 12:00:00',
    '餐饮美食',
    '支出',
    amount,
    '交易成功',
    id,
    desc,
  ];

  it('正向：GBK 编码、混合换行能正确解析；单号尾部制表符去掉；时间带北京时区偏移', async () => {
    const r = await parsed(alipayCsv([ok('A001')]));
    expect(r.template.id).toBe('alipay-csv');
    expect(r.file.issues).toEqual([]);
    expect(r.file.records[0]).toMatchObject({
      amountCents: 3250,
      direction: 'expense',
      externalId: 'A001',
      occurredAt: '2026-09-01T12:00:00+08:00',
      categoryHint: '餐饮美食',
      skipReason: null,
    });
    expect(r.file.records[0]!.raw).toMatchObject({ 交易订单号: 'A001', 金额: '32.50' });
  });

  it('正向：提取户主姓名', async () => {
    expect((await parsed(alipayCsv([ok('A001')], { holder: '李四' }))).file.meta.holderName).toBe('李四');
  });

  it('正向：部分退款按单号前缀关联；全额退款后的"交易关闭"原消费恢复入账', async () => {
    const r = await parsed(
      alipayCsv([
        ok('P001', '50.00'),
        ['2026-09-02 12:00:00', '退款', '不计收支', '8.00', '退款成功', 'P001_R1', '退款-午饭'],
        ['2026-09-01 13:00:00', '数码电器', '支出', '179.00', '交易关闭', 'C001'],
        ['2026-09-03 12:00:00', '退款', '不计收支', '179.00', '退款成功', 'C001*X', '退款-主板'],
        ['2026-09-04 12:00:00', '餐饮美食', '支出', '0.09', '交易关闭', 'N001'],
      ]),
    );
    expect(r.file.issues).toEqual([]);
    const [buy, partial, closed, full, lonelyClosed] = r.file.records;
    expect(partial!.refund).toEqual({ ofIndex: buy!.index, ofExternalId: 'P001' });
    expect(full!.refund).toEqual({ ofIndex: closed!.index, ofExternalId: 'C001' });
    expect(closed!.skipReason).toBeNull();
    // 没有对应退款的交易关闭仍然跳过
    expect(lonelyClosed!.skipReason).toBe('状态为「交易关闭」');
  });

  it('正向：原消费不在本文件 → 退款仍给出原订单号，供服务端到历史数据中查找', async () => {
    const r = await parsed(
      alipayCsv([['2026-09-02 12:00:00', '退款', '不计收支', '8.00', '退款成功', 'OLD1_R1', '退款']]),
    );
    expect(r.file.records[0]!.refund).toEqual({ ofIndex: null, ofExternalId: 'OLD1' });
  });

  it('正向：0 元交易跳过并注明原因，仍计入笔数', async () => {
    const r = await parsed(
      alipayCsv([ok('A001'), ['2026-09-01 12:00:00', '医疗健康', '支出', '0.00', '支付成功', 'Z001', '医保支付']]),
    );
    expect(r.file.issues).toEqual([]);
    expect(r.file.records[1]!.skipReason).toBe('金额为 0');
  });

  it('反向：汇总金额对不上 → 自校验报错（不能导入）', async () => {
    const r = await parsed(
      alipayCsv([ok('A001')], { summary: ['收入：0笔 0.00元', '支出：1笔 99.99元', '不计收支：0笔 0.00元'] }),
    );
    expect(r.file.issues).toEqual([expect.objectContaining({ check: '支出金额' })]);
  });

  it('反向：未知收支类型、金额超过两位小数 → 行解析错误', async () => {
    const bytes = alipayCsv(
      [
        ['2026-09-01 12:00:00', '其他', '奇怪', '1.00', '交易成功', 'E1'],
        ['2026-09-01 12:00:00', '其他', '支出', '1.234', '交易成功', 'E2'],
      ],
      { summary: ['收入：0笔 0.00元', '支出：0笔 0.00元', '不计收支：0笔 0.00元'] },
    );
    // 行全部解析失败时"试解析成功率"为 0，不会被自动选用，而是交给用户选择模板
    expect((await parseBill(bytes, '支付宝交易明细(test).csv')).status).toBe('choose_template');
    // 用户选定模板后，看到逐行的错误原因
    const r = await parsed(bytes, '支付宝交易明细(test).csv', 'alipay-csv');
    expect(r.file.errors.map((e) => e.message)).toEqual([
      '未知收支类型 "奇怪"',
      expect.stringContaining('最多两位小数'),
    ]);
    expect(r.file.issues.some((i) => i.check === '行解析')).toBe(true);
  });
});

describe('识别', () => {
  it('反向：无关 csv → 不支持', async () => {
    expect((await parseBill(Buffer.from('姓名,年龄\n张三,18\n'), 'x.csv')).status).toBe('unsupported');
  });

  it('反向：表头像支付宝但缺少标题指纹 → 让用户选择模板，而不是自动导入', async () => {
    const csv = `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n2026-09-01 12:00:00,餐饮美食,某店,/,午饭,支出,32.50,余额宝,交易成功,1,2,,\n`;
    const r = await parseBill(Buffer.from(csv), 'export.csv');
    expect(r).toMatchObject({
      status: 'choose_template',
      candidates: [expect.objectContaining({ templateId: 'alipay-csv' })],
    });
  });

  it('正向：用户选定模板后即可解析（此时汇总缺失会被自校验报出）', async () => {
    const csv = `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,\n2026-09-01 12:00:00,餐饮美食,某店,/,午饭,支出,32.50,余额宝,交易成功,1,2,,\n`;
    const r = await parsed(Buffer.from(csv), 'export.csv', 'alipay-csv');
    expect(r.file.records).toHaveLength(1);
    expect(r.file.issues.map((i) => i.check)).toContain('汇总缺失');
  });

  it('反向：指定的模板与文件类型不匹配 → 报错', async () => {
    await expect(parseBill(alipayCsv([]), 'a.csv', { templateId: 'cmb-pdf' })).rejects.toThrow(/不匹配/);
  });

  it('反向：二进制垃圾 / 损坏的 xlsx / 损坏的 pdf → 明确报错', async () => {
    await expect(parseBill(Buffer.from([0, 1, 2, 3, 0, 0, 0, 5, 6, 7, 0, 0]), 'x.csv')).rejects.toThrow(/无法识别/);
    await expect(parseBill(Buffer.from('PK\u0003\u0004 broken'), 'x.xlsx')).rejects.toThrow(/xlsx/);
    await expect(parseBill(Buffer.from('%PDF-1.4 broken'), 'x.pdf')).rejects.toThrow(/PDF/);
  });

  it('正向：UTF-8 带 BOM 的 csv 也能解码', async () => {
    const gbk = alipayCsv([['2026-09-01 12:00:00', '餐饮美食', '支出', '1.00', '交易成功', 'U1']]);
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(iconv.decode(gbk, 'gbk'), 'utf-8')]);
    expect((await parsed(utf8)).file.records[0]!.externalId).toBe('U1');
  });
});

describe.skipIf(!hasSamples)('真实样本（本机）', () => {
  for (const s of hasSamples ? currentFormatSamples() : []) {
    it(`${s.name} → 自动选中 ${s.expected}，自校验通过，退款全部在文件内或可按单号关联`, async () => {
      const r = await parseBill(readFileSync(s.path), s.name);
      expect(r.status).toBe('parsed');
      if (r.status !== 'parsed') return;
      expect(r.template.id).toBe(s.expected);
      expect(r.file.issues).toEqual([]);
      for (const rec of r.file.records.filter((x) => x.refund)) {
        expect(rec.refund!.ofIndex !== null || rec.refund!.ofExternalId !== null).toBe(true);
      }
    });
  }

  it('招行 PDF：提取户主姓名与账号尾号', async () => {
    const s = currentFormatSamples().find((x) => x.expected === 'cmb-pdf')!;
    const r = await parseBill(readFileSync(s.path), s.name);
    if (r.status !== 'parsed') throw new Error('解析失败');
    expect(r.file.meta.holderName).toBeTruthy();
    expect(r.file.meta.accountLast4).toMatch(/^\d{4}$/);
    expect(r.file.records.every((x) => x.timePrecision === 'day')).toBe(true);
  });

  for (const s of hasSamples ? legacySamples() : []) {
    it(`旧版格式 ${s.name} → 不自动导入`, async () => {
      expect((await parseBill(readFileSync(s.path), s.name)).status).not.toBe('parsed');
    });
  }
});
