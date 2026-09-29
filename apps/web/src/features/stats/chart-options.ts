/** 纯图表配置；数据保持整数分，坐标轴仅做元单位展示。 */
import type { StatsResponse } from '@bookkeepx/contracts';
import { formatCents } from '@bookkeepx/core';
import type { EChartsCoreOption } from 'echarts/core';

const tooltip = {
  renderMode: 'richText',
  valueFormatter: (value: unknown) => (typeof value === 'number' ? `${formatCents(value)} 元` : String(value)),
};
const moneyAxis = { type: 'value', name: '元', axisLabel: { formatter: (value: number) => String(value / 100) } };
/** 连续日/月趋势，净支出可以为负；图表无 HTML 字符串插值。 */
export function trendOption(
  rows: (StatsResponse['daily'][number] | StatsResponse['monthly'][number])[],
  type: 'bar' | 'line',
): EChartsCoreOption {
  return {
    aria: { enabled: true },
    tooltip: { ...tooltip, trigger: 'axis' },
    legend: { top: 8, data: ['收入', '净支出'] },
    grid: { left: 70, right: 20, top: 50, bottom: 45 },
    xAxis: { type: 'category', data: rows.map((r) => ('date' in r ? r.date.slice(5) : r.month)) },
    yAxis: moneyAxis,
    series: [
      { name: '收入', type, data: rows.map((r) => r.incomeCents), itemStyle: { color: '#059669' } },
      { name: '净支出', type, data: rows.map((r) => r.expenseCents), itemStyle: { color: '#2563eb' } },
    ],
  };
}
/** 有负金额时没有有意义的饼图占比，改用带正负轴的条形图。 */
export function categoryPresentation(categories: StatsResponse['categories'], group: 'income' | 'expense') {
  const rows = categories
    .filter((c) => c.group === group)
    .map((c) => ({ ...c, value: group === 'income' ? c.incomeCents : c.expenseCents }))
    .sort((a, b) => b.value - a.value);
  const total = rows.reduce((sum, r) => sum + BigInt(r.value), 0n);
  const hasNegative = rows.some((r) => r.value < 0);
  return {
    rows,
    total: Number(total),
    mode: hasNegative ? ('bar' as const) : total > 0n ? ('pie' as const) : ('empty' as const),
  };
}
/** 分类图只传聚合名称和金额，不带原始交易信息。 */
export function categoryOption(
  categories: StatsResponse['categories'],
  group: 'income' | 'expense',
): EChartsCoreOption {
  const view = categoryPresentation(categories, group);
  if (view.mode === 'bar')
    return {
      aria: { enabled: true },
      tooltip: { ...tooltip, trigger: 'axis' },
      grid: { left: 110, right: 30, top: 25, bottom: 40 },
      xAxis: moneyAxis,
      yAxis: { type: 'category', inverse: true, data: view.rows.map((r) => r.name) },
      series: [{ type: 'bar', data: view.rows.map((r) => r.value), itemStyle: { color: '#2563eb' } }],
    };
  return {
    aria: { enabled: true },
    tooltip: { ...tooltip, trigger: 'item' },
    series: [
      {
        type: 'pie',
        radius: ['35%', '65%'],
        label: { formatter: '{b}\n{d}%' },
        data: view.rows.filter((r) => r.value > 0).map((r) => ({ name: r.name, value: r.value })),
      },
    ],
  };
}
