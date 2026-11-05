/*
 * Shared geometry for the data-driven drawings (regression-trend, anchored-vwap,
 * volume-profile) plus the forecast tool's data-resolved status. Pure TS — no
 * JSX, no Solid — so BOTH the overlay renderer and the hit-test dispatch compute
 * the exact same screen geometry from a single source of truth. Each helper
 * reads coords.bars() (the live OHLCV array) and projects the computed series
 * back to screen space via coords.
 */
import type { Coords, LowerTimeframe } from "../coords";
import type { OHLC } from "../coords";
import { barDirections, buildProfile, ltfForSpan, lowerBound, profileLevels, type GridOptions, type LtfBar } from "./vbp-engine";
import type { Drawing, DrawingStyle, LevelDef, RegressionLine } from "../types";
import type { Time } from "lightweight-charts";
import { timeToSec, type Pt } from "../_shared";
import { VWAP_BAND_DEFAULTS, VWAP_BAND_LINE_DEFAULTS, volumeProfileStyle } from "../specs";

/** Bars whose time falls within [aSec, bSec] (order-insensitive). */
export function barsBetween(bars: OHLC[], aSec: number, bSec: number): OHLC[] {
  const lo = Math.min(aSec, bSec);
  const hi = Math.max(aSec, bSec);
  const out: OHLC[] = [];
  for (const b of bars) {
    const ts = timeToSec(b.time);
    if (ts != null && ts >= lo && ts <= hi) out.push(b);
  }
  return out;
}

/** Least-squares fit of the source values vs bar-index; m/b in
 *  price-per-index + price intercept, the residual standard deviation and
 *  Pearson's R of the fit (TV's regression-trend study reports it as
 *  `pearsons`). σ is the sample deviation (divided by n − 1): matches the TV
 *  study output to the cent (read live 24/09/2026, 28 bars). */
export function linregress(ys: number[]): { m: number; b: number; sd: number; r: number } | null {
  const n = ys.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const y = ys[i];
    sx += i; sy += y; sxx += i * i; sxy += i * y; syy += y * y;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null;
  const m = (n * sxy - sx * sy) / denom;
  const b = (sy - m * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (b + m * i);
    ss += r * r;
  }
  const varY = n * syy - sy * sy;
  const r = varY > 1e-12 ? (n * sxy - sx * sy) / Math.sqrt(denom * varY) : 0;
  return { m, b, sd: Math.sqrt(ss / (n - 1)), r };
}

export type RegressionLines = {
  center: [Pt, Pt];
  upper: [Pt, Pt] | null;
  lower: [Pt, Pt] | null;
  /** Pearson's R of the fit — rendered under the DOWN line's start when
   *  `showPearsons` (TV prepareLinearRegressionRenderersData). */
  pearsons: number;
  /** Anchor positions for points 0 / 1: on the base line at the first / last
   *  fitted bar (TV `_updateAnchorsPrice`: the anchors take the base line's
   *  start / end prices, swapped when point 0 is the later one). */
  anchors: [Pt, Pt];
};

/** Extend a screen segment rightward to x = `toX` (TV styles.extendLines →
 *  per-line `extendright` clipped by intersectLineWithViewport). */
function extendSegRight(seg: [Pt, Pt], toX: number): [Pt, Pt] {
  const [a, b] = seg;
  if (b.x <= a.x || toX <= b.x) return seg;
  const t = (toX - a.x) / (b.x - a.x);
  return [a, { x: toX, y: a.y + (b.y - a.y) * t }];
}

/** Projected regression base line + deviation bands over the drawing's [t0,t1]
 *  range, or null when there's no data to fit / projection fails (the caller
 *  falls back to the stored screen segment). Band offsets are the style's
 *  upper/lower deviation multipliers × the residual σ (TV factory +2 / −2);
 *  with "Use Upper / Lower Deviation" off, the largest bar high above / low
 *  below the base line, whatever the source (TV study, checked live with
 *  close and high sources). `extendRightToX` (pane width) extends all three
 *  lines right when the drawing's extend flag is on. */
export function regressionScreenLines(
  d: Drawing,
  coords: Coords | null,
  extendRightToX?: number,
): RegressionLines | null {
  const p1 = d.points[1];
  const t0 = timeToSec(d.points[0].time);
  const t1 = p1 ? timeToSec(p1.time) : null;
  if (!coords || t0 == null || t1 == null) return null;
  const bars = barsBetween(coords.bars(), t0, t1);
  const src = d.style.regressionSource ?? "close";
  const fit = linregress(bars.map((b) => sourcePrice(b, src)));
  if (!fit) return null;
  const n = bars.length;
  const yFit0 = fit.b;
  const yFit1 = fit.b + fit.m * (n - 1);
  let maxHigh = -Infinity;
  let maxLow = -Infinity;
  for (let i = 0; i < n; i++) {
    const base = fit.b + fit.m * i;
    maxHigh = Math.max(maxHigh, bars[i].high - base);
    maxLow = Math.max(maxLow, base - bars[i].low);
  }
  const upDev = d.style.useUpperDeviation === false ? maxHigh : (d.style.upperDeviation ?? 2) * fit.sd;
  const loDev = d.style.useLowerDeviation === false ? -maxLow : (d.style.lowerDeviation ?? -2) * fit.sd;
  const proj = (time: Time, price: number): Pt | null => {
    const x = coords.timeToX(time);
    const y = coords.priceToY(price);
    return x == null || y == null ? null : { x, y };
  };
  const c0 = proj(bars[0].time, yFit0);
  const c1 = proj(bars[n - 1].time, yFit1);
  if (!c0 || !c1) return null;
  const u0 = proj(bars[0].time, yFit0 + upDev);
  const u1 = proj(bars[n - 1].time, yFit1 + upDev);
  const l0 = proj(bars[0].time, yFit0 + loDev);
  const l1 = proj(bars[n - 1].time, yFit1 + loDev);
  const ext = (seg: [Pt, Pt]): [Pt, Pt] =>
    d.style.extendRight && extendRightToX != null ? extendSegRight(seg, extendRightToX) : seg;
  return {
    center: ext([c0, c1]),
    upper: u0 && u1 ? ext([u0, u1]) : null,
    lower: l0 && l1 ? ext([l0, l1]) : null,
    pearsons: fit.r,
    anchors: t0 <= t1 ? [c0, c1] : [c1, c0],
  };
}

/* ── Anchored VWAP (LineToolAnchoredVWAP — study "anchoredvwap") ─────────────
 * Plots: VWAP + UpperBand/LowerBand #1..#3 at vwap ± mult·σ where σ is the
 * cumulative volume-weighted stdev of the source price from the anchor
 * (σ² = Σv·src² / Σv − vwap²). The source select mirrors the study's price
 * sources (631031 → 202637 studyAvailablePriceSources). */

export type VwapSource = NonNullable<Drawing["style"]["vwapSource"]>;

function sourcePrice(b: OHLC, src: VwapSource): number {
  switch (src) {
    case "open": return b.open;
    case "high": return b.high;
    case "low": return b.low;
    case "close": return b.close;
    case "hl2": return (b.high + b.low) / 2;
    case "ohlc4": return (b.open + b.high + b.low + b.close) / 4;
    case "hlcc4": return (b.high + b.low + b.close + b.close) / 4;
    case "hlc3":
    default: return (b.high + b.low + b.close) / 3;
  }
}

/** A computed band (`index` = band #index + 1). */
export type VwapBand = { level: LevelDef; index: number; upper: Pt[]; lower: Pt[] };

/** Upper / lower line style of band `i` (TV UpperBand / LowerBand styles;
 *  older drawings fall back to the level's colour / width). */
export function vwapBandLine(s: DrawingStyle, i: number, side: "upper" | "lower"): RegressionLine {
  const list = side === "upper" ? s.vwapUpper : s.vwapLower;
  const lvl = (s.levels ?? VWAP_BAND_DEFAULTS)[i];
  const def = VWAP_BAND_LINE_DEFAULTS[i] ?? VWAP_BAND_LINE_DEFAULTS[0];
  return list?.[i] ?? { ...def, color: lvl?.color ?? def.color, width: lvl?.width ?? def.width };
}
export type VwapSeries = { line: Pt[]; bands: VwapBand[] };

/** Cumulative VWAP and σ per bar from the anchor bar forward, in data space.
 *  Cached per bars array (one per pane, so a drawing shown on several panes
 *  doesn't thrash) and per drawing; recomputed only when the bars (length or
 *  the forming last bar), the anchor or the source change, so a pan/zoom frame
 *  only projects the visible slice instead of rescanning every bar. Entries
 *  go with their bars array. */
type VwapData = { start: number; vwap: Float64Array; sd: Float64Array };
const vwapCache = new WeakMap<OHLC[], Map<string, { key: string; data: VwapData }>>();

function vwapData(d: Drawing, bars: OHLC[], anchorSec: number, src: VwapSource): VwapData {
  const last = bars[bars.length - 1];
  const key = `${anchorSec}|${src}|${bars.length}|${last ? `${timeToSec(last.time)}:${last.close}:${last.volume}` : ""}`;
  let perBars = vwapCache.get(bars);
  if (!perBars) {
    perBars = new Map();
    vwapCache.set(bars, perBars);
  }
  const hit = perBars.get(d.id);
  if (hit && hit.key === key) return hit.data;
  // First bar at or after the anchor (bars are time-ascending).
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ts = timeToSec(bars[mid].time);
    if (ts != null && ts < anchorSec) lo = mid + 1;
    else hi = mid;
  }
  const n = bars.length - lo;
  const vwap = new Float64Array(Math.max(0, n));
  const sd = new Float64Array(Math.max(0, n));
  let cumPV = 0;
  let cumPV2 = 0;
  let cumV = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[lo + i];
    const price = sourcePrice(b, src);
    const vol = b.volume && b.volume > 0 ? b.volume : 1;
    cumPV += price * vol;
    cumPV2 += price * price * vol;
    cumV += vol;
    const v = cumPV / cumV;
    vwap[i] = v;
    sd[i] = Math.sqrt(Math.max(0, cumPV2 / cumV - v * v));
  }
  const data = { start: lo, vwap, sd };
  perBars.set(d.id, { key, data });
  return data;
}

/** Index of the first bar with time ≥ sec (bars.length when none). */
function firstIndexAtOrAfter(bars: OHLC[], sec: number): number {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const ts = timeToSec(bars[mid].time);
    if (ts != null && ts < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The VWAP value at the last bar (TV price-scale label), null when the
 *  anchor is past the data. */
export function vwapLastValue(d: Drawing, coords: Coords | null): number | null {
  return coords ? (vwapLast(d, coords.bars())?.vwap ?? null) : null;
}

/** The VWAP and its σ at the last bar of `bars` (any bars of the symbol,
 *  not only a chart's), null when the anchor is past the data. */
export function vwapLast(d: Drawing, bars: OHLC[]): { vwap: number; sd: number } | null {
  const anchorSec = d.points[0] ? timeToSec(d.points[0].time) : null;
  if (anchorSec == null || bars.length === 0) return null;
  const data = vwapData(d, bars, anchorSec, d.style.vwapSource ?? "hlc3");
  const k = data.vwap.length - 1;
  return k >= 0 ? { vwap: data.vwap[k], sd: data.sd[k] } : null;
}

/** Projected cumulative-VWAP polyline from the anchor bar forward plus the
 *  visible ±σ bands (equal weights when volume is absent). Only the bars in
 *  view, plus one on each side so the lines run to the pane edges, are
 *  projected. */
export function vwapScreenSeries(d: Drawing, coords: Coords | null): VwapSeries {
  const anchorSec = timeToSec(d.points[0].time);
  const out: VwapSeries = { line: [], bands: [] };
  if (!coords || anchorSec == null) return out;
  const src = d.style.vwapSource ?? "hlc3";
  // TV calculate_stDev #k: only the enabled bands are computed.
  out.bands = (d.style.levels ?? VWAP_BAND_DEFAULTS).map((level, index) => ({ level, index, upper: [] as Pt[], lower: [] as Pt[] })).filter((b) => b.level.visible);
  const percent = d.style.vwapBandsMode === "percent";
  const bars = coords.bars();
  if (bars.length === 0) return out;
  const data = vwapData(d, bars, anchorSec, src);
  let first = data.start;
  let end = bars.length; // exclusive
  const vis = coords.visibleTimeRange();
  if (vis) {
    first = Math.max(first, firstIndexAtOrAfter(bars, vis.from) - 1);
    end = Math.min(end, firstIndexAtOrAfter(bars, vis.to) + 2);
  }
  for (let i = first; i < end; i++) {
    const k = i - data.start;
    const b = bars[i];
    const vwap = data.vwap[k];
    const x = coords.timeToX(b.time);
    const y = coords.priceToY(vwap);
    if (x == null || y == null) continue;
    out.line.push({ x, y });
    if (out.bands.length > 0) {
      // TV: Standard Deviation = mult x sigma; Percentage = mult x 1% of the
      // VWAP (checked live 25/09/2026: upper = vwap x 1.01 at mult 1).
      const unit = percent ? vwap * 0.01 : data.sd[k];
      for (const band of out.bands) {
        const yu = coords.priceToY(vwap + band.level.coeff * unit);
        const yl = coords.priceToY(vwap - band.level.coeff * unit);
        if (yu != null) band.upper.push({ x, y: yu });
        if (yl != null) band.lower.push({ x, y: yl });
      }
    }
  }
  return out;
}

/* ── Position forecast (LineToolPrediction) ──────────────────────────────────
 * The vector is a quarter ellipse centred at (source.x, target.y) with
 * rx = |dx|, ry = |dy| (chunk 176288 `_drawImpl`: ctx.ellipse(i.x, r.y, a, s)).
 * Status resolves against the bar AT the target's time
 * (`recalculateStateByData`): up → success once that bar's high touches the
 * target price, down → its low; a passed target bar that never touched fails;
 * a target still in the future keeps waiting. */

export type ForecastStatus = "waiting" | "success" | "failure";

/** Quarter-ellipse polyline from `a` (source) to `b` (target). */
export function forecastArcSamples(a: Pt, b: Pt, n = 32): Pt[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return [a, b];
  const rx = Math.abs(dx);
  const ry = Math.abs(dy);
  // Canvas-angle endpoints (y down): θ0 lands on the source, θ1 on the target.
  const t0 = dy < 0 ? Math.PI / 2 : -Math.PI / 2;
  const t1 = dx > 0 ? 0 : (dy < 0 ? Math.PI : -Math.PI);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    out.push({ x: a.x + rx * Math.cos(t), y: b.y + ry * Math.sin(t) });
  }
  return out;
}

export function forecastStatus(d: Drawing, coords: Coords | null): ForecastStatus {
  const p1 = d.points[1];
  if (!coords || !p1) return "waiting";
  const targetSec = timeToSec(p1.time);
  if (targetSec == null) return "waiting";
  const bars = coords.bars();
  if (bars.length === 0) return "waiting";
  const lastSec = timeToSec(bars[bars.length - 1].time);
  if (lastSec == null || targetSec > lastSec) return "waiting";
  // The bar covering the target time: last bar at or before it.
  let bar: OHLC | null = null;
  let isLast = false;
  for (let i = bars.length - 1; i >= 0; i--) {
    const ts = timeToSec(bars[i].time);
    if (ts != null && ts <= targetSec) {
      bar = bars[i];
      isLast = i === bars.length - 1;
      break;
    }
  }
  if (!bar) return "waiting";
  const up = p1.price > d.points[0].price;
  if (up ? bar.high >= p1.price : bar.low <= p1.price) return "success";
  return isLast ? "waiting" : "failure";
}

/** Volume profile over a bar range (reference VbP study, rules in
 *  vbp-engine.ts): built from the chart symbol's lower-timeframe bars when the
 *  host gives them (`lower`: timeframe by the span of the range), else from
 *  the chart bars. `developing`: the POC / VA high / VA low of the profile up
 *  to the end of each chart bar. Returns null when the range holds no bars. */
export type VolumeProfile = {
  lo: number;
  hi: number;
  step: number;
  rows: { up: number; down: number }[];
  poc: number;
  vaFrom: number;
  vaTo: number;
  maxTotal: number;
  maxDelta: number;
  lastTime: Time;
  developing: { time: Time; poc: number; vah: number; val: number }[] | null;
};
export type VolumeProfileOptions = {
  rowsLayout?: "rows" | "ticks";
  rows?: number;
  /** Price tick. */
  tick?: number;
  vaShare?: number;
  developing?: boolean;
  /** Lower-timeframe bars of the chart symbol (host). */
  lower?: LowerTimeframe;
};
const dirsCache = new WeakMap<object, boolean[]>();
function dirsOf(bars: readonly OHLC[]): boolean[] {
  let d = dirsCache.get(bars);
  if (!d || d.length !== bars.length) {
    d = barDirections(bars as unknown as LtfBar[]);
    dirsCache.set(bars, d);
  }
  return d;
}
export function volumeProfile(bars: OHLC[], fromSec: number, toSec: number, opts: VolumeProfileOptions = {}): VolumeProfile | null {
  const inRange = barsBetween(bars, fromSec, toSec);
  if (inRange.length === 0) return null;
  const vaPct = Math.min(1, Math.max(0, opts.vaShare ?? 0.7)) * 100;
  const tick = opts.tick && opts.tick > 0 ? opts.tick : 0.01;
  const grid: GridOptions = { layout: opts.rowsLayout === "ticks" ? "Ticks Per Row" : "Number Of Rows", rowSize: Math.max(1, Math.round(opts.rows ?? 24)) };
  const first = timeToSec(inRange[0].time) ?? 0;
  const lastBar = timeToSec(inRange[inRange.length - 1].time) ?? first;
  // Source bars: the lower timeframe of the range's span when the host gives it, else the chart bars.
  let source: readonly OHLC[] = inRange;
  let g0 = 0;
  let g1 = inRange.length - 1;
  const lower = opts.lower;
  if (lower) {
    const end = lower.barEnd(lastBar);
    const ltf = lower.bars(ltfForSpan(end - first, lower.seconds), first);
    if (ltf && ltf.length) {
      const times = ltf as unknown as { time: number }[];
      const a = lowerBound(times, first);
      const b = lowerBound(times, end) - 1;
      if (b >= a) {
        source = ltf;
        g0 = a;
        g1 = b;
      }
    }
  }
  const dirs = source === inRange ? barDirections(inRange as unknown as LtfBar[]) : dirsOf(source);
  const p = buildProfile(source as unknown as LtfBar[], dirs, g0, g1, tick, grid, vaPct);
  if (!p) return null;
  let developing: VolumeProfile["developing"] = null;
  if (opts.developing) {
    developing = [];
    let j = g0;
    for (let k = 0; k < inRange.length; k++) {
      const next = k + 1 < inRange.length ? (timeToSec(inRange[k + 1].time) ?? Infinity) : Infinity;
      while (j + 1 <= g1 && (timeToSec(source[j + 1].time) ?? 0) < next) j++;
      if ((timeToSec(source[g0].time) ?? 0) >= next) continue;
      const part = j === g1 ? p : buildProfile(source as unknown as LtfBar[], dirs, g0, j, tick, grid, vaPct);
      if (!part) continue;
      const L = profileLevels(part);
      developing.push({ time: inRange[k].time, poc: L.poc, vah: L.vah, val: L.val });
    }
  }
  const rows = p.up.map((up, i) => ({ up, down: p.down[i] }));
  const tot = rows.map((r) => r.up + r.down);
  return {
    lo: p.lo,
    hi: p.lo + rows.length * p.step,
    step: p.step,
    rows,
    poc: p.poc,
    vaFrom: p.vaLo,
    vaTo: p.vaHi,
    maxTotal: Math.max(...tot),
    maxDelta: Math.max(...rows.map((r) => Math.abs(r.up - r.down))),
    lastTime: inRange[inRange.length - 1].time,
    developing,
  };
}

/** Profile options of a volume profile drawing (its settings + the tick). */
function vpOptions(d: Drawing, coords: Coords): VolumeProfileOptions {
  const s = volumeProfileStyle(d.kind, d.style);
  return {
    rowsLayout: s.rowsLayout,
    rows: s.rows,
    tick: coords.pipSize(),
    vaShare: s.vaVolume / 100,
    developing: s.developingPoc.visible || s.developingVah.visible || s.developingVal.visible,
    lower: coords.lowerTimeframe,
  };
}

/** Anchored volume profile screen box: anchor x → last bar x, profile low →
 *  high. Null without data. */
export function anchoredVpBox(d: Drawing, pts: Pt[], coords: Coords | null): { left: number; right: number; top: number; bottom: number; vp: VolumeProfile } | null {
  if (!coords) return null;
  const bars = coords.bars();
  if (bars.length === 0) return null;
  const t0 = timeToSec(d.points[0].time);
  const tLast = timeToSec(bars[bars.length - 1].time);
  if (t0 == null || tLast == null) return null;
  const vp = volumeProfile(bars, t0, tLast, vpOptions(d, coords));
  if (!vp) return null;
  const xr = coords.timeToX(vp.lastTime);
  const yt = coords.priceToY(vp.hi);
  const yb = coords.priceToY(vp.lo);
  if (xr == null || yt == null || yb == null) return null;
  return { left: pts[0].x, right: xr, top: Math.min(yt, yb), bottom: Math.max(yt, yb), vp };
}

/** Fixed range volume profile screen box: the P0-P1 time span × the bars'
 *  price range over that span. "Extend Right": the range runs from P0 to
 *  the last bar (the right edge follows it). Null without data. */
export function fixedVpBox(d: Drawing, pts: Pt[], coords: Coords | null): { left: number; right: number; top: number; bottom: number; vp: VolumeProfile } | null {
  if (!coords || d.points.length < 2 || pts.length < 2) return null;
  const t0 = timeToSec(d.points[0].time);
  const t1 = timeToSec(d.points[1]!.time);
  if (t0 == null || t1 == null) return null;
  const bars = coords.bars();
  const extend = volumeProfileStyle(d.kind, d.style).extendRight;
  const lastSec = bars.length ? timeToSec(bars[bars.length - 1].time) : null;
  const from = Math.min(t0, t1);
  const to = extend && lastSec != null ? Math.max(lastSec, from) : Math.max(t0, t1);
  const vp = volumeProfile(bars, from, to, vpOptions(d, coords));
  if (!vp) return null;
  const yt = coords.priceToY(vp.hi);
  const yb = coords.priceToY(vp.lo);
  if (yt == null || yb == null) return null;
  const left = Math.min(pts[0].x, pts[1].x);
  const xr = extend ? coords.timeToX(vp.lastTime) : null;
  const right = xr != null ? Math.max(left, xr) : Math.max(pts[0].x, pts[1].x);
  return { left, right, top: Math.min(yt, yb), bottom: Math.max(yt, yb), vp };
}
