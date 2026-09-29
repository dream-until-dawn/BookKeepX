/** ECharts 按需注册，使用 SVG，尺寸观察和卸载清理独立管理。 */
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { type EChartsCoreOption, init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'react';

use([BarChart, LineChart, PieChart, AriaComponent, GridComponent, LegendComponent, TooltipComponent, SVGRenderer]);
/** 聚合图表；同页提供可读表格作为无障碍和精确金额替代。 */
export function StatsChart({
  option,
  label,
  height = 300,
}: {
  option: EChartsCoreOption;
  label: string;
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const chart = init(host.current, undefined, { renderer: 'svg' });
    chart.setOption(option);
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div ref={host} role="img" aria-label={label} style={{ height }} className="w-full min-w-0" />;
}
