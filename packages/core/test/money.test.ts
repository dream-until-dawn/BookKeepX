/**
 * 金额模块测试
 *   - 正向：P0 真实账单中出现过的全部写法
 *   - 反向：每种非法输入给出正确的错误码
 *   - 边界：0、1 分、最大安全整数、-0
 *   - 往返：随机整数 分 → 字符串 → 分 必须还原
 */
import { describe, expect, it } from 'vitest';
import { centsToYuanNumber, formatCents, MoneyParseError, parseYuanToCents, sumCents } from '../src/index.ts';

/** 断言抛出指定错误码的 MoneyParseError */
function expectCode(input: string | number, code: MoneyParseError['code']) {
  try {
    parseYuanToCents(input);
  } catch (e) {
    expect(e).toBeInstanceOf(MoneyParseError);
    expect((e as MoneyParseError).code).toBe(code);
    expect((e as MoneyParseError).input).toBe(input);
    return;
  }
  throw new Error(`期望 ${JSON.stringify(input)} 抛出 ${code}，但解析成功了`);
}

describe('parseYuanToCents 正向（P0 真实账单中的写法）', () => {
  it.each([
    // 支付宝 / 微信的普通金额
    ['6', 600],
    ['21.78', 2178],
    ['0.01', 1],
    ['17.8', 1780],
    // 微信旧版 csv 与手动输入：货币符号
    ['¥11.00', 1100],
    ['￥12.90', 1290],
    [' ¥ 5 ', 500],
    // 招行 PDF：千分位与正负号
    ['1,800.00', 180000],
    ['-2,500.00', -250000],
    ['11,067.68', 1106768],
    ['1,234,567.89', 123456789],
    ['+5.5', 550],
    ['-¥3.20', -320],
    // 汇总行："元"后缀
    ['602.00元', 60200],
    // 全角输入
    ['１２．５', 1250],
    ['－１，０００', -100000],
  ])('%j → %i 分', (input, cents) => {
    expect(parseYuanToCents(input)).toBe(cents);
  });

  it.each([
    [2635.95, 263595],
    [550, 55000],
    [0.1, 10],
    [6, 600],
  ])('Excel 数字单元格 %d → %i 分', (input, cents) => {
    expect(parseYuanToCents(input)).toBe(cents);
  });
});

describe('parseYuanToCents 反向', () => {
  it.each(['', '   ', '¥', '元', '-', '+'])('空值 %j → EMPTY', (input) => expectCode(input, 'EMPTY'));

  it.each(['abc', '12a', '1.2.3', '--1', '1-', '.5', '5.', '1 000', '(12.00)', '1e5', '0x10'])(
    '非法格式 %j → FORMAT',
    (input) => expectCode(input, 'FORMAT'),
  );

  it.each(['1,23.00', '12,34', '1,2345.00', ',123'])('千分位位置不对 %j → FORMAT', (input) =>
    expectCode(input, 'FORMAT'),
  );

  it.each(['1.234', '0.001', '9.999'])('超过两位小数 %j → PRECISION（不四舍五入）', (input) =>
    expectCode(input, 'PRECISION'),
  );

  it('Excel 浮点误差 0.1+0.2 → PRECISION，而不是悄悄变成 30 分', () => expectCode(0.1 + 0.2, 'PRECISION'));

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('非有限数字 %d → FORMAT', (input) => expectCode(input, 'FORMAT'));

  it('超大数字（科学计数法）→ OVERFLOW', () => expectCode(1e21, 'OVERFLOW'));

  it('超出安全整数的字符串 → OVERFLOW', () => expectCode('90071992547409.92', 'OVERFLOW'));
});

describe('parseYuanToCents 边界', () => {
  it('最大安全整数恰好可以表示', () => {
    expect(parseYuanToCents('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('"-0" 和 "-0.00" 解析为 0，而不是 -0', () => {
    expect(Object.is(parseYuanToCents('-0'), 0)).toBe(true);
    expect(Object.is(parseYuanToCents('-0.00'), 0)).toBe(true);
  });
});

describe('formatCents', () => {
  it.each([
    [0, {}, '0.00'],
    [1, {}, '0.01'],
    [123456, {}, '1,234.56'],
    [-9868, {}, '-98.68'],
    [100000000, {}, '1,000,000.00'],
    [123456, { grouping: false }, '1234.56'],
    [123456, { symbol: true }, '¥1,234.56'],
    [-9868, { symbol: true }, '-¥98.68'],
    [5000, { sign: 'always' }, '+50.00'],
    [0, { sign: 'always' }, '0.00'],
    [-5000, { sign: 'never' }, '50.00'],
    [Number.MAX_SAFE_INTEGER, {}, '90,071,992,547,409.91'],
  ] as const)('%i %j → %s', (cents, opts, text) => {
    expect(formatCents(cents, opts)).toBe(text);
  });

  it.each([12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('反向：非法的分 %d 抛错', (v) => {
    expect(() => formatCents(v)).toThrow(/安全整数/);
  });
});

describe('往返：分 → 字符串 → 分', () => {
  it('10,000 个随机金额（含负数、千分位、符号）全部精确还原', () => {
    let seed = 20260924;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 10_000; i++) {
      // 覆盖从 1 分到约 9e13 分的各个数量级
      const magnitude = 10 ** Math.floor(rand() * 14);
      const abs = Math.floor(rand() * magnitude);
      // 0 不加负号：-0 不是有意义的金额（解析函数会把 "-0" 规范为 0，另有专门测试）
      const cents = abs !== 0 && rand() < 0.3 ? -abs : abs;
      for (const opts of [{}, { symbol: true }, { grouping: false }, { sign: 'always' as const }]) {
        expect(parseYuanToCents(formatCents(cents, opts))).toBe(cents);
      }
    }
  });
});

describe('centsToYuanNumber / sumCents', () => {
  it('正向：分转元数字（仅供图表）', () => {
    expect(centsToYuanNumber(263595)).toBe(2635.95);
  });

  it('正向：整数求和，没有浮点误差（0.1 + 0.2 元）', () => {
    expect(sumCents([10, 20])).toBe(30);
  });

  it('反向：混入浮点数（例如误传了"元"）→ 抛错', () => {
    expect(() => sumCents([100, 0.5])).toThrow(/安全整数/);
  });

  it('反向：合计溢出 → 抛错而不是丢精度', () => {
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(/超出安全整数/);
  });

  it('边界：空列表合计为 0', () => {
    expect(sumCents([])).toBe(0);
  });
});
