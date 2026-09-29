/** 验证图表资源管理，不把真实 ECharts 的布局交给 jsdom 假尺寸。 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StatsChart } from '../src/features/stats/StatsChart.tsx';

const chart = vi.hoisted(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() }));
const observed = vi.hoisted(() => ({ observe: vi.fn(), disconnect: vi.fn(), callback: () => {} }));
vi.mock('echarts/core', () => ({ use: vi.fn(), init: vi.fn(() => chart) }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('设置选项，容器变化时 resize，换配置/卸载断开监听并 dispose', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        observed.callback = callback;
      }
      observe = observed.observe;
      disconnect = observed.disconnect;
    },
  );
  const option = { series: [] };
  const view = render(<StatsChart option={option} label="测试统计" />);
  expect(chart.setOption).toHaveBeenCalledWith(option);
  expect(observed.observe).toHaveBeenCalledOnce();
  observed.callback();
  expect(chart.resize).toHaveBeenCalledOnce();
  view.rerender(<StatsChart option={{ series: [{ type: 'bar', data: [10] }] }} label="测试统计" />);
  expect(chart.dispose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(chart.dispose).toHaveBeenCalledTimes(2);
  expect(observed.disconnect).toHaveBeenCalledTimes(2);
});
