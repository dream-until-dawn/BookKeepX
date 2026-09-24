/**
 * P0-5 图表性能探针页面
 *
 * 用法：打开 /?n=3000&years=1（默认值），页面显示各阶段耗时；
 * 结果同时挂在 window.__probe 上，便于自动读取。
 * 金额展示使用共享包 @bookkeepx/core 的 formatCents（P0-4 前端侧验证）。
 */
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { echarts, type EChartsOption } from './echarts.ts';
import { formatCents } from '@bookkeepx/core';
import { aggregate, generate, type Aggregated } from './data.ts';

interface Timing {
  n: number;
  years: number;
  generateMs: number;
  aggregateMs: number;
  charts: Record<string, number>;
  totalMs: number;
}

declare global {
  interface Window {
    __probe?: Timing;
  }
}

/** 渲染一张图，返回从 init 到 ECharts 'finished' 事件的耗时 */
function renderChart(el: HTMLDivElement, option: EChartsOption): Promise<number> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chart.on('finished', () => resolve(performance.now() - t0));
    // 关闭动画：测量的是渲染本身，而不是动画时长
    chart.setOption({ animation: false, ...option });
  });
}

const yuan = (c: number) => Number(formatCents(c).replace(/,/g, ''));

function options(a: Aggregated): Record<string, EChartsOption> {
  return {
    月度收支: {
      tooltip: { trigger: 'axis' },
      legend: {},
      xAxis: { type: 'category', data: a.months },
      yAxis: { type: 'value' },
      series: [
        { name: '收入', type: 'bar', data: a.monthIncome.map(yuan) },
        { name: '支出', type: 'bar', data: a.monthExpense.map(yuan) },
      ],
    },
    分类占比: {
      tooltip: { trigger: 'item', valueFormatter: (v) => formatCents(Math.round(Number(v) * 100)) },
      series: [{ type: 'pie', radius: ['40%', '70%'], data: a.categories.map((c) => ({ name: c.name, value: yuan(c.value) })) }],
    },
    每日支出: {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: a.days },
      yAxis: { type: 'value' },
      dataZoom: [{ type: 'inside' }, { type: 'slider' }],
      series: [{ type: 'line', showSymbol: false, data: a.dayExpense.map(yuan) }],
    },
  };
}

function App() {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get('n') ?? 3000);
  const years = Number(params.get('years') ?? 1);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const [timing, setTiming] = useState<Timing | null>(null);
  const [agg, setAgg] = useState<Aggregated | null>(null);

  useEffect(() => {
    const t0 = performance.now();
    const txs = generate(n, years);
    const t1 = performance.now();
    const a = aggregate(txs);
    const t2 = performance.now();
    setAgg(a);
    // 等 DOM 挂载后依次渲染三张图
    requestAnimationFrame(async () => {
      const charts: Record<string, number> = {};
      for (const [name, opt] of Object.entries(options(a))) charts[name] = await renderChart(refs.current[name]!, opt);
      const result: Timing = { n, years, generateMs: t1 - t0, aggregateMs: t2 - t1, charts, totalMs: performance.now() - t0 };
      window.__probe = result;
      setTiming(result);
    });
  }, [n, years]);

  const total = agg ? agg.monthExpense.reduce((s, v) => s + v, 0) : 0;
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: 960, margin: '0 auto' }}>
      <h1 style={{ fontSize: 20 }}>P0-5 图表性能探针</h1>
      <p>
        数据量：{n} 笔 / {years} 年；总支出（core.formatCents）：<b>{formatCents(total)}</b> 元
      </p>
      {timing && (
        <table data-testid="timing" style={{ borderCollapse: 'collapse', marginBottom: 16 }}>
          <tbody>
            {[
              ['生成数据', timing.generateMs],
              ['前端聚合', timing.aggregateMs],
              ...Object.entries(timing.charts).map(([k, v]) => [`渲染：${k}`, v] as const),
              ['合计', timing.totalMs],
            ].map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: '2px 12px 2px 0' }}>{k}</td>
                <td style={{ textAlign: 'right' }}>{(v as number).toFixed(1)} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {['月度收支', '分类占比', '每日支出'].map((name) => (
        <section key={name}>
          <h2 style={{ fontSize: 16 }}>{name}</h2>
          <div ref={(el) => void (refs.current[name] = el)} style={{ width: '100%', height: 280 }} />
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
