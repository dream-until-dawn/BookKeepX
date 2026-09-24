/**
 * ECharts 按需引入（P0-5 实测：整体引入 1.34 MB / gzip 436 KB，按需引入见探针结论）
 *
 * 只注册 MVP 用到的图表与组件；新增图表类型时在这里登记。
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, CanvasRenderer]);

export { echarts };
export type { EChartsOption } from 'echarts';
