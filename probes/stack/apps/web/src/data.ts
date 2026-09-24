/**
 * 模拟数据与前端聚合（P0-5）
 *
 * 真实统计在服务端用 SQL 聚合（见 apps/server/src/stats.ts）；这里在前端也做一遍，
 * 用来测量"如果把原始流水交给前端聚合"的耗时上限，作为是否需要服务端聚合的依据。
 */

export interface Tx {
  /** 北京时间日期 YYYY-MM-DD */
  day: string;
  direction: 'income' | 'expense';
  amountCents: number;
  category: string;
}

const CATEGORIES = ['餐饮', '交通', '购物', '居住', '通讯与订阅', '医疗健康', '娱乐休闲', '人情往来', '其他支出'];

/** 可复现的伪随机数（mulberry32），保证每次测量用同一份数据 */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成 n 笔流水，均匀分布在 years 年内（从 2026-01-01 往前） */
export function generate(n: number, years: number): Tx[] {
  const rand = rng(42);
  const days = years * 365;
  const start = Date.UTC(2026, 0, 1) - days * 86400000;
  return Array.from({ length: n }, () => {
    const day = new Date(start + Math.floor(rand() * days) * 86400000).toISOString().slice(0, 10);
    const income = rand() < 0.05;
    return {
      day,
      direction: income ? 'income' : 'expense',
      amountCents: income ? 500000 + Math.floor(rand() * 1000000) : 100 + Math.floor(rand() * 30000),
      category: income ? '工资' : CATEGORIES[Math.floor(rand() * CATEGORIES.length)]!,
    } as Tx;
  });
}

export interface Aggregated {
  months: string[];
  monthIncome: number[];
  monthExpense: number[];
  categories: { name: string; value: number }[];
  days: string[];
  dayExpense: number[];
}

/** 一次遍历完成月度、分类、按日三种聚合（全部整数分运算） */
export function aggregate(txs: Tx[]): Aggregated {
  const month = new Map<string, [number, number]>();
  const cat = new Map<string, number>();
  const day = new Map<string, number>();
  for (const t of txs) {
    const m = t.day.slice(0, 7);
    const mv = month.get(m) ?? [0, 0];
    if (t.direction === 'income') mv[0] += t.amountCents;
    else {
      mv[1] += t.amountCents;
      cat.set(t.category, (cat.get(t.category) ?? 0) + t.amountCents);
      day.set(t.day, (day.get(t.day) ?? 0) + t.amountCents);
    }
    month.set(m, mv);
  }
  const months = [...month.keys()].sort();
  const days = [...day.keys()].sort();
  return {
    months,
    monthIncome: months.map((m) => month.get(m)![0]),
    monthExpense: months.map((m) => month.get(m)![1]),
    categories: [...cat].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
    days,
    dayExpense: days.map((d) => day.get(d)!),
  };
}
