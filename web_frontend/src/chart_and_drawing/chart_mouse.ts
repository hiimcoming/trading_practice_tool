// 把浏览器鼠标位置换算成「图表主区域内的坐标」，以及价格吸附到最小价格单位。价格轴「+」和图上拖线共用。
// 来源：第 1 阶段手感原型 tm_feel_prototype/prototype_code/prototype_feel_test/chart_mouse.ts（用户实测通过，D44），2026-10-21 复制。
// 思路参考 Lightweight Charts 官方插件示例 user-price-alerts 的 mouse.ts：
// 在图表外层元素上自己监听鼠标，才能知道鼠标是否在价格轴上、离价格轴左边缘多远。

import type { IChartApi, ISeriesApi, SeriesType } from 'lightweight-charts';

export interface PanePoint {
  /** 相对图表主区域左上角的横坐标（像素） */
  x: number;
  y: number;
  /** 主区域宽度（不含右侧价格轴） */
  paneWidth: number;
  /** 主区域高度（不含底部时间轴） */
  paneHeight: number;
  /** 鼠标在主区域内（不在价格轴、时间轴上） */
  insidePane: boolean;
}

export function toPanePoint(e: MouseEvent, chart: IChartApi, series: ISeriesApi<SeriesType>): PanePoint {
  const el = chart.chartElement();
  const box = el.getBoundingClientRect();
  const paneWidth = el.clientWidth - series.priceScale().width();
  const paneHeight = el.clientHeight - chart.timeScale().height();
  const x = e.clientX - box.left;
  const y = e.clientY - box.top;
  return { x, y, paneWidth, paneHeight, insidePane: x >= 0 && x < paneWidth && y >= 0 && y < paneHeight };
}

/** 价格吸附到最小价格单位（tick）的整数倍，并去掉浮点尾数（规格书 15.2 节） */
export function snapToTick(price: number, tick: number, precision: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(precision));
}
