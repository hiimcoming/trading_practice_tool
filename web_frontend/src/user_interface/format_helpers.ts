// 显示格式：百分比、金额、价格、R、相对时间、星期和时刻。金额和百分比显示 2 位小数（规格书 15.2 节）。
// 价格（D58）：报价类（卖价、买价、开仓价、现价、K 线价格轴）按品种的位数显示（黄金 3 位，与 Exness 一致）；
//   其余价格（止盈止损价、强平价）一律 2 位小数；都带千分位。

export const pct = (x: number | null | undefined, digits = 2) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
export const signedPct = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(2)}%`);
export const num = (x: number | null | undefined, digits = 2) => (x === null || x === undefined ? '—' : x.toFixed(digits));
/** 金额：千分位 + 2 位小数（例 1,024.50） */
export const money = (x: number | null | undefined) =>
  x === null || x === undefined ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** 报价类价格：按品种的位数，带千分位（例 1,798.065） */
export const quote = (x: number | null | undefined, precision: number) =>
  x === null || x === undefined ? '—' : x.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });
/** 其余价格（止盈止损价、强平价）：2 位小数，带千分位（例 1,367.47） */
export const price2 = (x: number | null | undefined) => money(x);
/** 带正负号的金额（例 +24.06、−13.34） */
export const signedMoney = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${money(Math.abs(x))}`);
/** 平台的货币写法（D72）：币安 → USDT，其余（Exness）→ $ */
export const currencyOf = (platform: string | undefined): '$' | 'USDT' => (platform === 'binance' ? 'USDT' : '$');
/** 带货币的金额（简报、统计页用，D72）：美元写成 $1,234.56（符号紧贴数字），USDT 写成 1,234.56 USDT（空一格放后面） */
export const cash = (x: number | null | undefined, cur: '$' | 'USDT') =>
  x === null || x === undefined ? '—' : cur === '$' ? `$${money(x)}` : `${money(x)} USDT`;
/** 带正负号和货币的金额（例 +$24.06、−$13.34、−13.34 USDT） */
export const signedCash = (x: number | null | undefined, cur: '$' | 'USDT') =>
  x === null || x === undefined ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${cash(Math.abs(x), cur)}`;
/** 手数 / 数量：按步长的小数位显示，去掉浮点尾巴（0.1 − 0.04 = 0.060000000000000005 → 0.06） */
export function qtyText(q: number, step: number): string {
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return String(Number(q.toFixed(decimals)));
}
export const signedR = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}R`);

/** 「3 小时前」这类说法；输入为服务器的 UTC 时间文字 YYYY-MM-DD HH:MM:SS */
export function ago(utcText: string | null, now = Date.now()): string {
  if (!utcText) return '—';
  const t = Date.parse(utcText.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return '—';
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} 天前`;
  return utcText.slice(0, 10);
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 盲练时顶栏显示的「星期 + 时刻」（不含年月日） */
export function weekdayTime(ms: number, utcOffsetHours: number): string {
  const d = new Date(ms + utcOffsetHours * 3600_000);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.toISOString().slice(11, 16)} ${utcOffsetHours ? 'UTC+8' : 'UTC'}`;
}

export const END_REASON_TEXT: Record<string, string> = {
  normal: '正常结束',
  liquidation: '强平结束',
  latest_data: '播到最新数据',
  auto_after_days: '5 天后自动结束',
};

/** 平仓原因（持仓面板「已平仓」和单轮简报共用） */
export const CLOSE_REASON_TEXT: Record<string, string> = {
  manual: '手动平仓', stop: '止损', gap_stop: '跳空止损', tp: '止盈', gap_tp: '跳空止盈', liquidation: '强平', end_of_round: '结束本轮',
};

export const PICK_MODE_TEXT: Record<string, string> = {
  random: '随机',
  fallback_recent: '重复练习模式',
  fallback_min_overlap: '重复练习模式（重叠最少）',
  replay: '复练',
};
