// 练习页的「控制中心」：把回放引擎、K 线图、交易账户、后端接口连起来（不含界面布局，布局在 practice_page.tsx）。
// 负责：开局 / 断点续练（接管占用凭证）→ 推进（下一根、下一分钟、自动播放）→ 切周期 → 往左加载更早历史 →
//      自动保存（每 10 秒、每推进 20 根 1m、关页面前；规格书 15.4 节）→ 被别的标签页接管时变只读 →
//      满 300 根提示完成 → 播到最新数据自动结束 → 结束本轮。
// 「你不动，时间就不走」：只有用户操作或自动播放才推进。
// 交易（第 4 阶段）：交易账户按 trading_rules 的规则逐根 1m 处理成交和强平（回放引擎每揭开一根 1m 通知一次）；
//   点「买入 / 卖出」后按下一根开盘价成交（D53）；顶栏勾了「下单后自动走一根」才自动走完当前周期这一根，
//   不勾（默认，D76）就排队，图上最后一根标半透明的「待成交 ×N」箭头，按「下一根」（空格）时成交——这样同一根可以连下几笔；
//   平仓立即按当前价成交（D57）；每次交易操作后立即保存（D52）。
//   保存失败：先等 10 秒、之后每 20 秒重试，最多 20 次，期间可继续交易；20 次都失败则页面停住（D52）。
//   强平：资金账户有钱则暂停（不能推进，只能转入或结束）；资金账户为 0 则由页面直接结束本轮（D27、D55）。
// 下单表单与草稿单（4.3，D59）：表单状态放在这里（价格轴「+」、B/S 快捷键、下单面板、图上的草稿线都要用）；
//   草稿单 = 还没提交的订单，图上画进场、止损、止盈三条线，点「提交」才生效，Esc 取消。
// 快进（规格书 5.8、15.8 节）：逐根 1m 往后走，直到有成交、止损止盈触发、挂单失效或强平；最多 5 个交易日。
// 画线（第 4b 阶段，D64）：每完成一次画线操作立即保存——整份画线随「保存进度」一起送（共用占用凭证检查和断网重试），
//   只在画线有改动时才带上；样式记忆（每类工具最后一次用的样式）稍等 1 秒再存进用户设置（拖滑杆时不连发）。

import { ApiError, api, toBars, toBars1m, type FinishResult, type MarketSpec, type ReplayEvent } from '../backend_api_client/api_client';
import { PracticeChart, type TradeOverlay } from '../chart_and_drawing/practice_chart';
import { PriceAxisPlus } from '../chart_and_drawing/price_axis_plus';
import { buildLines, closeLine, dropLine, quickLine, quickTargetKey, submitLine, type DragPreview } from './order_lines_logic';
import type { ThemePalette } from '../chart_and_drawing/theme_palettes';
import { ReplayEngine, elapsedTradingDays, tradingDaysLabel, weekendCountdownLabel, type StepResult } from '../replay_engine/replay_engine';
import { TIMEFRAME_MS, type Bar1m, type Timeframe, type WeekStart } from '../trading_rules/kline_synthesis';
import { accountMetrics, closePrice, floatingPnl, positionMargin, spreadOf, unitsOf, type MarketSpec as RuleSpec } from '../trading_rules/margin_and_liquidation';
import {
  TradingAccount,
  TradingRuleError,
  applyAction,
  classifyPending,
  fillFee,
  pendingName,
  newAccountState,
  takerFill,
  type AccountState,
  type AccountStatus,
  type Direction,
  type Position,
  type TradingAction,
} from '../trading_rules/order_fills_and_costs';
import { DecisionTimer } from './decision_timer';
import { qtyText } from './format_helpers';
import { DEFAULTS, type UserSettings } from './shared_settings';

export type SaveStatus = 'saved' | 'saving' | 'unsaved';

/** 下单表单（市价 / 挂单两个标签共用）。draft 不为 null = 有一张草稿单（B/S 快捷键、价格轴「+」、挂单标签生成） */
export interface OrderForm {
  tab: 'market' | 'pending';
  draft: Direction | null;
  priceText: string;
  slText: string;
  tpText: string;
}

export const KIND_TEXT: Record<string, string> = { buy_limit: '买入限价', sell_limit: '卖出限价', buy_stop: '买入止损', sell_stop: '卖出止损' };

const parseNum = (t: string): number | null => {
  const x = Number(t.replace(/,/g, '').trim());
  return t.trim() === '' || !Number.isFinite(x) ? null : x;
};

export interface PracticeView {
  symbol: string;
  market: MarketSpec;
  timeframe: Timeframe;
  startTimeframe: Timeframe;
  playing: boolean;
  autoplaySeconds: number;
  barsPlayed: number;
  /** 图左上角进度后面的「已过 2.4 个交易日（约 x 周）」（D84） */
  elapsedLabel: string;
  /** 黄金周五收盘前 4 小时的「距周末收盘 3:45」（D85）；其他时候、币安品种为 null */
  weekendCountdown: string | null;
  completionBars: number;
  lastBarMs: number | null;
  readOnly: boolean;
  saveStatus: SaveStatus;
  waitingForData: boolean;
  /** 往左拖到了数据起点（D74）：显示「更早没有数据，数据从某天开始」，几秒后自动消失；null = 不显示 */
  noEarlierData: string | null;
  dataEnd: boolean;
  justCompleted: boolean;
  isReplay: boolean;
  pickMode: string | null;
  busy: boolean;
  error: string | null;
  /** 交易账户状态：进行中 / 强平后暂停 / 强平后结束 */
  accountStatus: AccountStatus;
  /** 交易账户每变化一次加 1（界面据此刷新） */
  tradeVersion: number;
  /** 给用户的一句提示（下单被拒的原因等），点掉或下次操作后消失 */
  notice: string | null;
  /** 保存连续失败 20 次：页面停住（D52） */
  connectionLost: boolean;
  form: OrderForm;
  /** 开局时的总资产（顶栏「初始资金」，D63）；旧轮次没有时为 null */
  initialTotalAssets: number | null;
  /** 快进进行中 */
  fastForwarding: boolean;
  /** 下单后自动走一根（D76，顶栏勾选，按用户存） */
  autoStep: boolean;
  /** 2 秒后自动消失的短提示（D80：市价单排队时每点一次说一声）；null = 不显示 */
  flash: string | null;
}

const HISTORY_COUNT = 500;
const RETRY_FIRST_MS = 10_000;
const RETRY_NEXT_MS = 20_000;
const MAX_SAVE_FAILURES = 20;
/** 关页面时的保存用 keepalive 发送，浏览器限制约 64KB；画线太多时这一次不带画线（每次画线操作后早已保存过） */
const KEEPALIVE_DRAWINGS_LIMIT = 50_000;
const STYLE_SAVE_DELAY_MS = 1000;

export class PracticeController {
  view: PracticeView;
  private engine!: ReplayEngine;
  private chart!: PracticeChart;
  private acc!: TradingAccount;
  private plus!: PriceAxisPlus;
  /** 已经提示过的订单结果条数（挂单失效时提示一次） */
  private resultsSeen = 0;
  /** 下单面板提供：当前的手数文字（价格轴「+」菜单里显示） */
  qtyTextForMenu: () => string = () => '';
  /** 下单面板提供：草稿单的手数（图上草稿线的标签和盈亏用） */
  draftQty = 0;
  /** 下单面板提供：草稿单现在能不能提交（reason 为 null 才能）和提交动作，图上草稿线标签的「提交」按钮用；null = 没有草稿 */
  draftSubmit: { reason: string | null; submit: () => void } | null = null;
  /** 正在图上拖的线和它此刻的价格（拖动中标签实时变化，D59） */
  private dragPreview: DragPreview | null = null;
  private spec!: RuleSpec;
  private lease = '';
  private timeframesUsed = new Set<Timeframe>();
  /** 周末休市的品种（黄金）：算已练交易日时跳过周六、周日（D84） */
  private weekendClosed = false;
  private pendingEvents: ReplayEvent[] = [];
  private stepsSinceSave = 0;
  private dirty = false;
  private playTimer: number | null = null;
  private saveTimer: number | null = null;
  private retryTimer: number | null = null;
  private saveFailures = 0;
  /** 还没送到服务器的画线（全部画线的 JSON）；null = 画线没有新改动 */
  private unsavedDrawings: string | null = null;
  private styleSaveTimer: number | null = null;
  /** 决策用时（第 5b 阶段）：每揭开一根 1m 重新计时，下单时读出来记在事件上 */
  private readonly decision = new DecisionTimer(DEFAULTS.discipline_review.decision_idle_minutes);
  private inflight: Promise<void> | null = null;
  private loadingEarlier = false;
  private noEarlierTimer: number | null = null;
  private completionNotified = false;
  private listeners = new Set<() => void>();
  private readonly onPageHide = () => void this.save(true);

  private constructor(
    private readonly username: string,
    private readonly sessionId: string,
    private settings: UserSettings,
  ) {
    this.view = null as unknown as PracticeView;
  }

  /** 打开一轮练习：接管占用凭证（旧标签页随之变只读），取初始数据，建引擎、交易账户和图表 */
  static async open(
    username: string,
    sessionId: string,
    settings: UserSettings,
    theme: ThemePalette,
    dom: { chart: HTMLElement; toolbar: HTMLElement; drawingSettings: HTMLElement; onHint: (t: string | null) => void },
  ): Promise<PracticeController> {
    const c = new PracticeController(username, sessionId, settings);
    const p = await api.claimSession(username, sessionId);
    c.lease = p.lease_token;
    const s = p.session;
    c.engine = new ReplayEngine(
      {
        startMs: s.segment_start_ms,
        replayMs: s.replay_ms,
        startTimeframe: s.start_timeframe,
        dayAnchor: s.day_anchor,
        weekStart: (p.market as { week_start?: WeekStart }).week_start ?? 'monday',
        background: toBars(p.background_bars),
        past1m: toBars1m(p.past_1m),
        future1m: toBars1m(p.future_1m),
        futureReachedDataEnd: p.future_reached_data_end,
        barsPlayedAtInit: s.bars_played,
        prefetchWhenRemainingRatio: DEFAULTS.replay.prefetch_when_remaining_ratio,
        keep1mDays: DEFAULTS.replay.keep_1m_days_in_browser,
      },
      {
        historyBars: (tf, end, count) => api.historyBars(username, sessionId, tf, end, count),
        future1m: (from) => api.future1m(username, sessionId, from),
      },
    );
    c.spec = p.market as unknown as RuleSpec;
    c.acc = new TradingAccount(c.restoreAccount(s.state.account as AccountState | undefined, s.symbol, s.replay_ms, p), c.spec);
    c.engine.onReveal = (b) => c.onReveal(b);
    c.chart = new PracticeChart(dom.chart, {
      precision: p.market.price_precision,
      tickSize: p.market.tick_size,
      maxBarsPerScreen: DEFAULTS.replay.max_bars_per_screen,
      theme,
      blind: settings.blind_mode,
      utcOffsetHours: settings.utc_offset_hours,
      startMs: s.segment_start_ms,
      toolbar: dom.toolbar,
      onHint: dom.onHint,
      onNearLeftEdge: () => void c.loadEarlier(),
      futureBars: (lastMs) => c.futureBars(lastMs),
      drawingSettingsSlot: dom.drawingSettings,
      savedDrawings: p.drawings ?? [],
      drawingStyles: settings.drawing_styles,
      onDrawingsChanged: (json) => {
        c.unsavedDrawings = json;
        c.dirty = true;
        void c.save();
      },
      onDrawingStylesChanged: (m) => c.saveDrawingStylesSoon(m),
    });
    c.weekendClosed = p.market.skip_saturday === true;
    const lastTf = (s.state.timeframe as Timeframe | undefined) ?? s.start_timeframe;
    c.timeframesUsed = new Set(s.timeframes_used);
    c.view = {
      symbol: s.symbol,
      market: p.market,
      timeframe: s.start_timeframe,
      startTimeframe: s.start_timeframe,
      playing: false,
      autoplaySeconds: settings.autoplay_seconds,
      barsPlayed: c.engine.barsPlayed(),
      elapsedLabel: c.elapsedLabel(),
      weekendCountdown: c.weekendCountdown(),
      completionBars: p.completion_bars,
      lastBarMs: c.engine.last1m()?.t ?? null,
      readOnly: false,
      saveStatus: 'saved',
      waitingForData: false,
      noEarlierData: null,
      dataEnd: c.engine.isAtDataEnd(),
      justCompleted: false,
      isReplay: Boolean(s.is_replay),
      pickMode: s.pick_mode,
      busy: false,
      error: null,
      accountStatus: c.acc.s.status,
      tradeVersion: 0,
      notice: null,
      connectionLost: false,
      form: { tab: 'market', draft: null, priceText: '', slText: '', tpText: '' },
      initialTotalAssets: s.initial_total_assets ?? null,
      fastForwarding: false,
      autoStep: settings.auto_step_after_market,
      flash: null,
    };
    c.completionNotified = c.view.barsPlayed >= c.view.completionBars;
    c.resultsSeen = c.acc.s.order_results.length;
    c.chart.setBars(c.engine.bars(s.start_timeframe), false);
    if (lastTf !== s.start_timeframe) await c.switchTimeframe(lastTf, false);
    c.addMarkersToggle(dom.toolbar);
    c.chart.orderLines.setHandlers({
      // 从 TP / SL 按钮拖出来的线，按它对应的止盈 / 止损线处理
      onDrag: (key, price) => {
        c.dragPreview = { key: key.startsWith('quick|') ? quickTargetKey(key) : key, price };
        c.refreshOverlay();
      },
      onDrop: (key, price) => {
        c.dragPreview = null;
        if (c.canAdvance()) dropLine(c, key.startsWith('quick|') ? quickTargetKey(key) : key, price);
        c.refreshOverlay();
      },
      onClose: (key) => {
        if (c.canAdvance() || key === 'draft' || key === 'dsl' || key === 'dtp') closeLine(c, key);
      },
      onQuick: (key, kind) => {
        if (c.canAdvance()) quickLine(c, key, kind);
      },
      onSubmit: (key) => {
        if (c.canAdvance()) submitLine(c, key);
      },
    });
    c.plus = new PriceAxisPlus(c.chart.chart, c.chart.series, dom.chart, {
      tick: p.market.tick_size,
      precision: p.market.price_precision,
      qtyText: () => c.qtyTextForMenu(),
      kindName: (dir, price) => c.pendingKindName(dir, price),
      isBusy: () => !c.canAdvance() || c.chart.orderLines.isDragging() || c.chart.drawings.tool() !== null, // D73：画线时不出「+」
      onChoose: (dir, price) => c.startDraft('pending', dir, price),
    });
    c.refreshOverlay();
    c.saveTimer = window.setInterval(() => void c.periodicSave(), DEFAULTS.replay.autosave_every_seconds * 1000);
    window.addEventListener('pagehide', c.onPageHide);
    return c;
  }

  /**
   * 左侧工具栏 👁 后面加「显示 / 隐藏开平仓箭头和连线」按钮（D62）：和设置页的「交易标记」是同一个设置，
   * 点一下立即生效并存到服务器（存失败只是下次不记得，不影响练习）。
   */
  private addMarkersToggle(toolbar: HTMLElement): void {
    const b = document.createElement('button');
    b.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M5 15V5M2.5 7.5 5 5l2.5 2.5" stroke="#2962ff"/><path d="M13 3v10M10.5 10.5 13 13l2.5-2.5" stroke="#b0002a"/></svg>';
    const sync = () => {
      const on = this.settings.show_trade_markers;
      b.title = on ? '隐藏开平仓箭头和连线' : '显示开平仓箭头和连线';
      b.classList.toggle('off', !on);
    };
    b.addEventListener('click', () => {
      this.settings = { ...this.settings, show_trade_markers: !this.settings.show_trade_markers };
      sync();
      this.refreshOverlay();
      void api.saveSettings(this.username, { show_trade_markers: this.settings.show_trade_markers }).catch(() => undefined);
    });
    sync();
    const hideDrawings = [...toolbar.querySelectorAll('button')].find((x) => x.title.startsWith('隐藏 / 显示全部画线'));
    if (hideDrawings) hideDrawings.after(b);
    else toolbar.append(b);
  }

  /** 样式记忆存进用户设置：等 1 秒没有新改动再存（存失败只是下次不记得，不影响练习） */
  private saveDrawingStylesSoon(m: Record<string, unknown>): void {
    this.settings = { ...this.settings, drawing_styles: m };
    if (this.styleSaveTimer !== null) window.clearTimeout(this.styleSaveTimer);
    this.styleSaveTimer = window.setTimeout(() => {
      this.styleSaveTimer = null;
      void api.saveSettings(this.username, { drawing_styles: m }).catch(() => undefined);
    }, STYLE_SAVE_DELAY_MS);
  }

  /** 断点续练用保存的账户；第 3 阶段开的旧轮次没有账户，按默认参数新建。还没有价格时用最后一根已收盘 K 线的收盘价 */
  private restoreAccount(saved: AccountState | undefined, symbol: string, replayMs: number, p: { background_bars: number[][]; past_1m: number[][] }): AccountState {
    const lev = (this.spec as unknown as { leverage: { default: number } }).leverage.default;
    const a = saved ?? newAccountState(symbol, lev, DEFAULTS.practice_start.account.trading_balance, DEFAULTS.practice_start.account.funding_balance, replayMs);
    if (a.last_bid === null) {
      const last = p.past_1m[p.past_1m.length - 1] ?? p.background_bars[p.background_bars.length - 1];
      a.last_bid = last ? last[4] : null;
    }
    return a;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<PracticeView>): void {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn();
  }

  setTheme(theme: ThemePalette): void {
    this.chart.setTheme(theme);
  }

  // ---------------- 推进 ----------------

  /** 能否推进 / 交易：只读、断线、强平暂停或结束、快进进行中都不能 */
  canAdvance(): boolean {
    return !this.view.readOnly && !this.view.connectionLost && !this.view.fastForwarding && this.acc.s.status === 'active';
  }

  stepBar(): void {
    if (!this.canAdvance()) return;
    this.applyStep(this.engine.stepBar(this.view.timeframe));
  }

  step1m(): void {
    if (!this.canAdvance()) return;
    this.applyStep(this.engine.step1m());
  }

  /** 回放引擎每揭开一根 1m：交易账户处理这一根（成交、止损止盈、强平） */
  private onReveal(b: Bar1m): void {
    this.decision.reset(); // 新的 K 线出现：决策用时重新计时（D68）
    if (this.acc.s.status !== 'active') return; // 强平后这一根剩下的 1m 照常揭开，但不再交易
    try {
      this.acc.processBar(b);
    } catch (e) {
      console.error('[交易] 处理 1m 出错', e);
    }
  }

  private elapsedLabel(): string {
    return tradingDaysLabel(elapsedTradingDays(this.engine.startMs, this.engine.replayMs, this.weekendClosed), this.weekendClosed);
  }

  private weekendCountdown(): string | null {
    return this.weekendClosed ? weekendCountdownLabel(this.engine.replayMs) : null;
  }

  private applyStep(result: StepResult): void {
    const last = this.engine.lastBar(this.view.timeframe);
    if (last) this.chart.updateLast(last);
    this.dirty = true;
    this.stepsSinceSave++;
    const played = this.engine.barsPlayed();
    const patch: Partial<PracticeView> = {
      barsPlayed: played,
      elapsedLabel: this.elapsedLabel(),
      weekendCountdown: this.weekendCountdown(),
      lastBarMs: this.engine.last1m()?.t ?? null,
      waitingForData: result === 'waiting_for_data',
      dataEnd: result === 'data_end',
    };
    if (!this.completionNotified && played >= this.view.completionBars) {
      this.completionNotified = true;
      patch.justCompleted = true;
    }
    this.set(patch);
    const liquidated = this.afterTrading();
    if (result === 'waiting_for_data') {
      void this.engine.waitForPrefetch().then(() => this.set({ waitingForData: false }));
    }
    if (result === 'data_end') {
      this.stopPlay();
      return;
    }
    if (liquidated || this.stepsSinceSave >= DEFAULTS.replay.autosave_every_1m_bars) void this.save();
  }

  togglePlay(): void {
    if (this.playTimer !== null) return this.stopPlay();
    if (!this.canAdvance() || this.view.dataEnd) return;
    this.playTimer = window.setInterval(() => {
      if (!this.view.waitingForData) this.stepBar();
    }, this.view.autoplaySeconds * 1000);
    this.set({ playing: true });
  }

  stopPlay(): void {
    if (this.playTimer !== null) window.clearInterval(this.playTimer);
    this.playTimer = null;
    if (this.view.playing) this.set({ playing: false });
  }

  setAutoplaySeconds(sec: number): void {
    const wasPlaying = this.playTimer !== null;
    this.stopPlay();
    this.set({ autoplaySeconds: sec });
    if (wasPlaying) this.togglePlay();
  }

  dismissCompletionNotice(): void {
    this.set({ justCompleted: false });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  // ---------------- 交易 ----------------

  get account(): TradingAccount {
    return this.acc;
  }

  get marketSpec(): RuleSpec {
    return this.spec;
  }

  /** 执行一次交易操作；不合法时在页面上提示原因并返回 false */
  private trade(action: TradingAction, advance = false): boolean {
    if (this.view.readOnly || this.view.connectionLost) return false;
    try {
      const decisionMs = action.op === 'market' || action.op === 'pending' ? this.decision.read() : null;
      const id = applyAction(this.acc, action);
      this.pendingEvents.push({
        type: 'trade_action',
        replay_ms: this.engine.replayMs,
        payload: { action, order_id: id ?? null, ...(decisionMs !== null ? { decision_ms: decisionMs } : {}) },
      });
    } catch (e) {
      if (e instanceof TradingRuleError) {
        this.set({ notice: e.message });
        return false;
      }
      throw e;
    }
    this.set({ notice: null });
    this.dirty = true;
    // D53：市价单按下一根开盘价成交；勾了「下单后自动走一根」才走完当前周期这一根（D76），
    // 不勾就留在队列里等用户按「下一根」；自动播放中都不额外多走，在下一步成交
    if (advance && this.view.autoStep && this.playTimer === null && this.canAdvance()) this.stepBar();
    else this.afterTrading();
    void this.save();
    return true;
  }

  marketOrder(direction: Direction, qty: number, sl: number | null, tp: number | null): boolean {
    const short = this.queuedMarginShortfall(direction, qty);
    if (short) {
      this.set({ notice: short });
      return false;
    }
    const ok = this.trade({ op: 'market', direction, qty, sl, tp }, true);
    const q = this.queuedSummary();
    if (ok && q) {
      const unit = this.view.market.platform === 'exness' ? ' 手' : ` ${this.view.symbol.replace(/USDT$/, '')}`;
      this.showFlash(`${direction === 1 ? '买入' : '卖出'} ${qtyText(qty, this.spec.qty_step)}${unit} 已排队（共 ${q.count} 笔），按「下一根」或空格成交`);
    }
    return ok;
  }

  private flashTimer: number | null = null;
  /** 短提示：2 秒后自动消失；连点时每次重新计时（D80） */
  private showFlash(text: string): void {
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.set({ flash: text });
    this.flashTimer = window.setTimeout(() => {
      this.flashTimer = null;
      this.set({ flash: null });
    }, 2000);
  }

  /**
   * 排队的市价单连同这一笔，按现价估算要占的保证金；可用保证金不够时返回提示文字（D76：点的当下就说，
   * 不等按「下一根」成交时才逐笔失败）。只是界面上的提前检查：真正成交时交易规则仍按开盘价再查一次。
   */
  private queuedMarginShortfall(direction: Direction, qty: number): string | null {
    const s = this.acc.s;
    if (s.last_bid === null || s.status !== 'active') return null;
    const entry = (d: number) => (d === 1 ? s.last_bid! + spreadOf(this.spec) : s.last_bid!);
    const queued = s.queue.reduce((sum, q) => sum + positionMargin(q.qty, entry(q.direction), this.spec, s.leverage), 0);
    const need = queued + positionMargin(qty, entry(direction), this.spec, s.leverage);
    const free = accountMetrics(s.balance, s.positions, s.last_bid, this.spec, s.leverage, s.pending).free_margin;
    if (free >= need) return null;
    const n = s.queue.length + 1;
    return n > 1
      ? `可用保证金不够同时成交这 ${n} 笔（约需 ${need.toFixed(2)}，可用 ${free.toFixed(2)}）`
      : `可用保证金不够（约需 ${need.toFixed(2)}，可用 ${free.toFixed(2)}）`;
  }

  /** 排队等成交的市价单（D76）：方向、笔数和合计数量；没有时为 null。排队的单方向一定相同（反向的当场被拒） */
  queuedSummary(): { direction: Direction; count: number; qty: number } | null {
    const q = this.acc.s.queue;
    return q.length ? { direction: q[0].direction as Direction, count: q.length, qty: q.reduce((sum, x) => sum + x.qty, 0) } : null;
  }

  /** 顶栏「下单后自动走一根」勾选（D76）：立即生效并存到服务器（存失败只是下次不记得） */
  setAutoStep(on: boolean): void {
    this.settings = { ...this.settings, auto_step_after_market: on };
    this.set({ autoStep: on });
    void api.saveSettings(this.username, { auto_step_after_market: on }).catch(() => undefined);
  }

  closePosition(positionId: number, qty: number | null = null): boolean {
    return this.trade({ op: 'close', position_id: positionId, qty });
  }

  closeAllPositions(): void {
    for (const p of [...this.acc.s.positions]) this.closePosition(p.id);
  }

  setStops(positionId: number, sl: number | null, tp: number | null): boolean {
    return this.trade({ op: 'set_stops', position_id: positionId, sl, tp });
  }

  transfer(direction: 'to_funding' | 'to_trading', amount: number): boolean {
    return this.trade({ op: 'transfer', direction, amount });
  }

  /** 现在为什么不能改杠杆（D72：空仓、没有挂单、没有排队的市价单才能改）；能改返回 null */
  leverageReason(): string | null {
    if (this.view.readOnly) return '只读模式';
    const s = this.acc.s;
    if (s.positions.length || s.pending.length || s.queue.length) return '有持仓或挂单时不能改杠杆（先平仓、撤单）';
    return null;
  }

  /** 改杠杆（D72）：规则检查在交易账户里；成功后记成这个品种下次开局的默认杠杆 */
  setLeverage(leverage: number): boolean {
    if (!this.trade({ op: 'set_leverage', leverage })) return false;
    this.settings = { ...this.settings, leverage_by_symbol: { ...this.settings.leverage_by_symbol, [this.acc.s.symbol]: leverage } };
    void api.saveSettings(this.username, { leverage_by_symbol: this.settings.leverage_by_symbol }).catch(() => undefined);
    return true;
  }

  // ---------------- 下单表单、草稿单、挂单 ----------------

  updateForm(patch: Partial<OrderForm>): void {
    this.set({ form: { ...this.view.form, ...patch } });
    this.refreshOverlay();
  }

  /** 生成草稿单：市价（B/S 快捷键）或挂单（价格轴「+」、挂单标签）；price 为挂单价 */
  startDraft(type: 'market' | 'pending', direction: Direction, price: number | null = null): void {
    if (!this.canAdvance()) return;
    const f = this.view.form;
    this.updateForm({ tab: type, draft: direction, priceText: price === null ? (type === 'pending' ? f.priceText : '') : String(price) });
  }

  /** 取消草稿单（Esc 或「取消」）：清空表单里的价格和止盈止损，回到市价标签 */
  cancelDraft(): boolean {
    if (this.view.form.draft === null) return false;
    this.updateForm({ tab: 'market', draft: null, priceText: '', slText: '', tpText: '' });
    return true;
  }

  /** 这个方向在这个价位是什么挂单（如「买入限价」）；不能挂返回 null */
  pendingKindName(direction: Direction, price: number): string | null {
    const bid = this.acc.s.last_bid;
    if (bid === null) return null;
    try {
      return KIND_TEXT[pendingName(direction, classifyPending(direction, price, bid, this.spec))];
    } catch {
      return null;
    }
  }

  placePending(direction: Direction, price: number, qty: number, sl: number | null, tp: number | null): boolean {
    const ok = this.trade({ op: 'pending', direction, price, qty, sl, tp });
    if (ok) this.updateForm({ tab: 'market', draft: null, priceText: '', slText: '', tpText: '' });
    return ok;
  }

  modifyPending(orderId: number, price: number, qty: number, sl: number | null, tp: number | null): boolean {
    return this.trade({ op: 'modify_pending', order_id: orderId, price, qty, sl, tp });
  }

  cancelPending(orderId: number): boolean {
    return this.trade({ op: 'cancel_pending', order_id: orderId });
  }

  /** 草稿市价单提交（B/S 生成的）：和点「买入 / 卖出」一样，成交后清掉草稿 */
  submitMarketDraft(qty: number): boolean {
    const f = this.view.form;
    if (f.draft === null) return false;
    const ok = this.marketOrder(f.draft, qty, parseNum(f.slText), parseNum(f.tpText));
    if (ok) this.updateForm({ draft: null, slText: '', tpText: '' });
    return ok;
  }

  /**
   * 快进到下一次成交或止损止盈触发（规格书 5.8、15.8 节）：逐根 1m 推进，账户一有成交、订单结果（成交 / 失效 / 撤销）
   * 或强平就停；最多 5 个交易日（Exness 每天约 1380 根 1m，币安 1440 根），到上限还没触发就停下并提示。
   * 推进中不逐根重画图表，结束后一次性刷新（避免卡住页面）。
   */
  async fastForward(): Promise<void> {
    const s = this.acc.s;
    if (!this.canAdvance() || this.view.fastForwarding) return;
    if (s.positions.length === 0 && s.pending.length === 0 && s.queue.length === 0) {
      this.set({ notice: '没有持仓或挂单，快进不会触发任何成交' });
      return;
    }
    this.stopPlay();
    const days = 5;
    const limit = days * (this.spec.platform === 'binance' ? 1440 : 1380);
    const mark = () => s.fills.length + s.order_results.length + s.liquidations.length;
    const before = mark();
    this.set({ fastForwarding: true, notice: null });
    let n = 0;
    let result: StepResult = 'ok';
    while (n < limit) {
      result = this.engine.step1m();
      if (result === 'waiting_for_data') {
        await this.engine.waitForPrefetch();
        result = this.engine.step1m();
        if (result === 'waiting_for_data') break;
      }
      if (result === 'data_end') break;
      n++;
      if (mark() !== before || s.status !== 'active') break;
      if (n % 400 === 0) await new Promise((r) => setTimeout(r)); // 让页面喘口气，不卡死
    }
    this.chart.setBars(this.engine.bars(this.view.timeframe), true);
    this.chart.scrollToLatest();
    this.set({ fastForwarding: false });
    this.applyStep(result);
    if (mark() === before && s.status === 'active' && result !== 'data_end') {
      this.set({ notice: n >= limit ? `已快进 ${days} 个交易日，未触发` : '后面的行情还没加载好，请稍后再试' });
    }
    void this.save();
  }

  /** 交易账户变化后：重画图上的交易标记、通知界面；返回这一次是否刚发生强平 */
  private afterTrading(): boolean {
    const before = this.view.accountStatus;
    const status = this.acc.s.status;
    this.noticeFailedOrders();
    this.refreshOverlay();
    this.set({ tradeVersion: this.view.tradeVersion + 1, accountStatus: status });
    if (status !== 'active') this.stopPlay();
    return before === 'active' && status !== 'active';
  }

  /** 挂单没成交就失效（保证金不足、因反向成交而撤销、触发时持有反向仓位）时提示用户（规格书 6.7 节） */
  private noticeFailedOrders(): void {
    const results = this.acc.s.order_results;
    const TEXT: Record<string, string> = {
      margin_insufficient: '保证金不足，未成交',
      cancelled_opposite: '反方向已成交，自动撤销',
      opposite_position: '触发时持有反向仓位，已撤销',
    };
    const msgs: string[] = [];
    for (const r of results.slice(this.resultsSeen)) {
      if (TEXT[r.result]) msgs.push(`${KIND_TEXT[r.kind] ?? (r.kind === 'market' ? '市价单' : r.kind)}：${TEXT[r.result]}`);
    }
    this.resultsSeen = results.length;
    if (msgs.length) this.set({ notice: msgs.join('；') });
  }

  /*
   * 部分平仓后的盈亏口径（D78，照 Exness / MT5）：持仓表「盈亏」、持仓线、止损止盈线上的金额只算**还拿着的部分**；
   * 已平掉的部分另记「已平」（钱早已进了余额）。开仓手续费按手数比例分摊：剩下的部分担 剩余手数 ÷ 开仓手数 那一份。
   * 例：2000 买黄金 0.02 手，2010 平 0.01 → 已平 +10；剩下 0.01 现价 2010 盈亏 +10、止损 1995 显示 −5，整笔合计 +5。
   * 已平 + 剩余 = 原来的整笔数字，两者相加不多不少。
   */

  /** 剩下的部分分摊到的开仓手续费 */
  private openFeeShare(p: Position): number {
    const fill = this.acc.s.fills.find((f) => f.position_id === p.id && f.action === 'open');
    return fill && p.initial_qty > 0 ? fill.fee * (p.qty / p.initial_qty) : 0;
  }

  /** 已平掉的部分的盈亏（平仓所得 − 平仓手续费 − 分摊的开仓手续费）；没部分平过仓为 0 */
  closedPartPnl(p: Position): number {
    return p.exits.length ? p.realized_gross - (p.fees - this.openFeeShare(p)) : 0;
  }

  /** 剩下的部分在某个价位止损（吃单 + 滑点）或止盈（挂单、不计滑点）出场时的盈亏（含分摊的开仓手续费和这次的平仓手续费） */
  outcomeAt(p: Position, level: number, kind: 'sl' | 'tp'): number {
    const [price] = kind === 'sl' ? takerFill(-p.direction, level, this.spec) : [level];
    const gross = (price - p.entry_price) * p.direction * unitsOf(p.qty, this.spec);
    return gross - this.openFeeShare(p) - fillFee(this.spec, p.qty, price, kind === 'tp');
  }

  /** 剩下的部分的当前盈亏（浮动盈亏 − 分摊的开仓手续费；不含平仓时的手续费，与 Exness 显示一致） */
  positionPnl(p: Position): number {
    const bid = this.acc.s.last_bid;
    return (bid === null ? 0 : floatingPnl(p, bid, this.spec)) - this.openFeeShare(p);
  }

  /**
   * 持仓在本轮的编号：本轮第几笔开出的持仓（图上的持仓线、止盈止损线和持仓表都写「#编号」，多笔持仓时能对上）。
   * 内部编号和订单、平仓共用一个计数器（会跳号），所以按「本轮全部持仓里排第几」来编，平掉之前的持仓也不会变。
   */
  positionNo(positionId: number): number {
    const s = this.acc.s;
    let n = 1;
    for (const t of s.trades) if (t.position_id < positionId) n++;
    for (const p of s.positions) if (p.id < positionId) n++;
    return n;
  }

  /** 部分平仓的预估盈亏：和真正平仓同一个成交价（现价按平仓方向吃单 + 滑点），减去这次平仓的手续费（界面上写「≈」） */
  partialCloseEstimate(p: Position, qty: number): number {
    const bid = this.acc.s.last_bid;
    if (bid === null || p.qty <= 0) return 0;
    const [price] = takerFill(-p.direction, closePrice(p.direction, bid, this.spec), this.spec);
    return (price - p.entry_price) * p.direction * unitsOf(qty, this.spec) - fillFee(this.spec, qty, price, false);
  }

  /** ATR(N)：当前周期、只用已收盘 K 线的真实波幅简单平均（D18）；K 线不够时返回 null */
  atr(): number | null {
    const n = DEFAULTS.trading_panel.atr_period;
    const bars = this.engine.closedBars(this.view.timeframe);
    if (bars.length < n + 1) return null;
    let sum = 0;
    for (let i = bars.length - n; i < bars.length; i++) {
      const b = bars[i];
      const prev = bars[i - 1].c;
      sum += Math.max(b.h - b.l, Math.abs(b.h - prev), Math.abs(b.l - prev));
    }
    return sum / n;
  }

  /** 下单面板每次刷新后调用：更新草稿单的「能否提交」；能否提交或原因变了才重画图上标签 */
  setDraftSubmit(next: { reason: string | null; submit: () => void } | null): void {
    const changed = (this.draftSubmit === null) !== (next === null) || this.draftSubmit?.reason !== next?.reason;
    this.draftSubmit = next;
    if (changed) this.refreshOverlay();
  }

  refreshOverlay(): void {
    const s = this.acc.s;
    const overlay: TradeOverlay = {
      timeframe: this.view?.timeframe ?? this.engine.startTimeframe,
      dayAnchor: this.engine.dayAnchor,
      weekStart: this.engine.weekStart,
      lines: buildLines(this, this.dragPreview),
      positions: s.positions.map((p) => ({ direction: p.direction, entry_price: p.entry_price, open_ms: p.open_ms })),
      trades: s.trades.map((t) => ({ direction: t.direction, entry_price: t.entry_price, open_ms: t.open_ms, pnl: t.pnl, exits: t.exits })),
      showMarkers: this.settings.show_trade_markers,
      queued: this.queuedSummary(),
    };
    this.chart.setTradeOverlay(overlay);
  }

  // ---------------- 切周期与历史 ----------------

  async switchTimeframe(tf: Timeframe, record = true): Promise<void> {
    if (tf === this.view.timeframe) return;
    this.set({ busy: true, error: null });
    try {
      if (!this.engine.hasTimeframe(tf)) await this.engine.loadTimeframe(tf, HISTORY_COUNT);
      const from = this.view.timeframe;
      this.chart.setBarsAtLatest(this.engine.bars(tf));
      this.timeframesUsed.add(tf);
      if (record) this.pendingEvents.push({ type: 'switch_timeframe', replay_ms: this.engine.replayMs, payload: { from, to: tf } });
      this.dirty = true;
      this.set({ timeframe: tf, busy: false });
      this.refreshOverlay();
    } catch (e) {
      this.set({ busy: false, error: e instanceof ApiError ? e.message : '切换周期失败' });
    }
  }

  private async loadEarlier(): Promise<void> {
    if (this.loadingEarlier) return;
    this.loadingEarlier = true;
    try {
      const tf = this.view.timeframe;
      const added = await this.engine.loadEarlier(tf, HISTORY_COUNT);
      // 等待期间可能已切到别的周期：那就只把加载结果留在引擎里，不画到图上（否则会把别的周期的 K 线盖到当前图上）
      if (tf !== this.view.timeframe) return;
      if (added > 0) {
        this.chart.setBars(this.engine.bars(tf), true);
        this.refreshOverlay();
      } else if (!this.engine.hasMoreHistory(tf)) this.showNoEarlierData(tf);
    } catch {
      // 加载更早历史失败不影响练习，下次拖到左边再试
    } finally {
      this.loadingEarlier = false;
    }
  }

  /** 画线未来区用的后续 K 线开盘时刻（D74）：同一周期、同一最后一根、同一回放时刻内结果不变，缓存起来（重画时会被反复调用） */
  private futureCache: { key: string; opens: number[] } | null = null;
  futureBars(lastMs: number): { opens: number[]; tfMs: number } {
    const tf = this.view?.timeframe ?? this.engine.startTimeframe;
    const key = `${tf}|${lastMs}|${this.engine.replayMs}|${this.engine.futureCount()}`;
    if (this.futureCache?.key !== key) this.futureCache = { key, opens: this.engine.futureBarOpens(tf, lastMs) };
    return { opens: this.futureCache.opens, tfMs: TIMEFRAME_MS[tf] };
  }

  /** 拖到数据起点时提示 4 秒（D74）：免得以为程序没加载；拖动中会反复触发，每次重新计时 */
  private showNoEarlierData(tf: Timeframe): void {
    const first = this.engine.bars(tf)[0];
    if (!first) return;
    this.set({ noEarlierData: `已到数据起点，更早没有数据了（最早一根 K 线：${new Date(first.t).toISOString().slice(0, 10)}）` });
    if (this.noEarlierTimer !== null) window.clearTimeout(this.noEarlierTimer);
    this.noEarlierTimer = window.setTimeout(() => {
      this.noEarlierTimer = null;
      this.set({ noEarlierData: null });
    }, 4000);
  }

  // ---------------- 保存与结束 ----------------

  private async periodicSave(): Promise<void> {
    // 没有改动时也定期保存一次，顺便检查是否已被别的标签页接管；重试等待中不打扰重试节奏
    if (this.retryTimer === null) await this.save();
  }

  /**
   * 保存进度（含交易账户）。fromRetry：由重试计时器发起。
   * 重试等待期间，其他时机（交易操作、定时）只记「有改动」，不另发请求，免得把 20 次机会很快用完。
   */
  async save(keepalive = false, fromRetry = false): Promise<void> {
    if (this.view.readOnly || this.view.connectionLost) return;
    if ((this.retryTimer !== null && !fromRetry && !keepalive) || this.inflight) {
      this.dirty = true;
      return;
    }
    this.inflight = this.doSave(keepalive);
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
    // 保存期间又有新改动（例如刚好推进或下单）：紧接着再存一次
    if (this.dirty && this.retryTimer === null && !this.view.connectionLost && !this.view.readOnly && !keepalive) void this.save();
  }

  private async doSave(keepalive: boolean): Promise<void> {
    const events = this.pendingEvents.splice(0);
    const drawings = this.unsavedDrawings !== null && !(keepalive && this.unsavedDrawings.length > KEEPALIVE_DRAWINGS_LIMIT)
      ? this.unsavedDrawings
      : null;
    if (drawings !== null) this.unsavedDrawings = null;
    const wasDirty = this.dirty;
    this.dirty = false;
    this.stepsSinceSave = 0;
    if (wasDirty) this.set({ saveStatus: 'saving' });
    try {
      await api.saveState(
        this.username,
        this.sessionId,
        {
          lease_token: this.lease,
          replay_ms: this.engine.replayMs,
          timeframes_used: [...this.timeframesUsed],
          state: { timeframe: this.view.timeframe, account: this.acc.s },
          events,
          ...(drawings !== null ? { drawings } : {}),
        },
        keepalive,
      );
      this.saveFailures = 0;
      this.retryTimer = null;
      this.set({ saveStatus: this.dirty ? 'unsaved' : 'saved' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        this.stopPlay();
        this.set({ readOnly: true, saveStatus: 'saved' });
        return;
      }
      // 网络断了：事件放回去，按 10 秒、20 秒……重试，最多 20 次（D52）；恢复前页面顶部显示「未保存」
      this.pendingEvents.unshift(...events);
      if (drawings !== null && this.unsavedDrawings === null) this.unsavedDrawings = drawings; // 期间又画了就以新的为准
      this.dirty = true;
      this.saveFailures++;
      this.retryTimer = null;
      if (this.saveFailures >= MAX_SAVE_FAILURES) {
        this.stopPlay();
        this.set({ saveStatus: 'unsaved', connectionLost: true });
        return;
      }
      this.set({ saveStatus: 'unsaved' });
      if (!keepalive) {
        const wait = this.saveFailures === 1 ? RETRY_FIRST_MS : RETRY_NEXT_MS;
        this.retryTimer = window.setTimeout(() => void this.save(false, true), wait);
      }
    }
  }

  /** 保存失败了几次（页面提示用） */
  get failedSaves(): number {
    return this.saveFailures;
  }

  /**
   * 结束本轮：仍有持仓或挂单时先按现价全部平仓、撤单（D26），保存后请服务器判断：
   * 满 300 根记为完成，不满则整轮丢弃（强平结束的按已完成计，D27）。
   */
  async finish(reason: 'normal' | 'latest_data' | 'liquidation' = 'normal'): Promise<FinishResult> {
    this.stopPlay();
    const s = this.acc.s;
    if (s.positions.length || s.pending.length || s.queue.length) {
      this.acc.closeAllNow();
      this.pendingEvents.push({ type: 'trade_action', replay_ms: this.engine.replayMs, payload: { action: { op: 'close_all' }, order_id: null } });
      this.dirty = true;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    while (this.inflight) await this.inflight; // 等正在进行的保存完成，再把最终状态存一次
    await this.save(false, true);
    if (this.view.saveStatus === 'unsaved') throw new ApiError('还有进度没保存成功（网络问题），恢复连接后才能结束本轮', 0);
    const result = await api.finish(this.username, this.sessionId, {
      lease_token: this.lease,
      replay_ms: this.engine.replayMs,
      reason,
    });
    this.dispose();
    return result;
  }

  dispose(): void {
    this.stopPlay();
    if (this.saveTimer !== null) window.clearInterval(this.saveTimer);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.styleSaveTimer !== null) {
      window.clearTimeout(this.styleSaveTimer);
      this.styleSaveTimer = null;
      void api.saveSettings(this.username, { drawing_styles: this.settings.drawing_styles }).catch(() => undefined);
    }
    window.removeEventListener('pagehide', this.onPageHide);
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.decision.destroy();
    this.plus?.destroy();
    this.chart.destroy();
    this.listeners.clear();
  }

  /** 离开页面（不结束本轮）：保存后释放资源 */
  async leave(): Promise<void> {
    await this.save();
    this.dispose();
  }

  get settingsSnapshot(): UserSettings {
    return this.settings;
  }
}
