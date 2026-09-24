/**
 * P0-5 补充：用 ECharts 服务端渲染（SVG）在 Node 中测量不同数据量下的聚合与渲染开销
 *
 * 为什么需要：浏览器面板被遮挡时页面不绘制（requestAnimationFrame 不触发），
 * 无法在浏览器里测压力场景。SSR 模式同样走完"配置解析 → 布局 → 生成图形"的流程，
 * 可以衡量计算开销随数据量的增长趋势（不含 Canvas 像素绘制）。
 *
 * 用法：npx tsx bench/ssr-bench.ts
 */
import * as echarts from 'echarts';
import { aggregate, generate } from '../src/data.ts';

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

function renderSvg(option: echarts.EChartsOption): number {
  const t0 = performance.now();
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 900, height: 280 });
  chart.setOption({ animation: false, ...option });
  chart.renderToSVGString();
  chart.dispose();
  return performance.now() - t0;
}

// 预热一次，排除首次加载模块、JIT 的影响
renderSvg({ xAxis: { type: 'category', data: ['a'] }, yAxis: {}, series: [{ type: 'bar', data: [1] }] });

console.log('场景 | 笔数 | 前端聚合 | 月度柱图 | 分类饼图 | 每日折线（点数） | 合计');
for (const [n, years] of [
  [3000, 1],
  [10000, 3],
  [50000, 5],
  [200000, 10],
] as const) {
  const runs = { agg: [] as number[], bar: [] as number[], pie: [] as number[], line: [] as number[] };
  let points = 0;
  for (let i = 0; i < 5; i++) {
    const txs = generate(n, years);
    const t0 = performance.now();
    const a = aggregate(txs);
    runs.agg.push(performance.now() - t0);
    points = a.days.length;
    runs.bar.push(renderSvg({ xAxis: { type: 'category', data: a.months }, yAxis: {}, series: [{ type: 'bar', data: a.monthIncome }, { type: 'bar', data: a.monthExpense }] }));
    runs.pie.push(renderSvg({ series: [{ type: 'pie', radius: ['40%', '70%'], data: a.categories }] }));
    runs.line.push(renderSvg({ xAxis: { type: 'category', data: a.days }, yAxis: {}, dataZoom: [{ type: 'slider' }], series: [{ type: 'line', showSymbol: false, data: a.dayExpense }] }));
  }
  const m = { agg: median(runs.agg), bar: median(runs.bar), pie: median(runs.pie), line: median(runs.line) };
  const f = (x: number) => `${x.toFixed(1)}ms`;
  console.log(`${years}年 | ${n} | ${f(m.agg)} | ${f(m.bar)} | ${f(m.pie)} | ${f(m.line)}（${points}） | ${f(m.agg + m.bar + m.pie + m.line)}`);
}
