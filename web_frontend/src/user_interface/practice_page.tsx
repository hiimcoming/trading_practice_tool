// 练习页布局（规格书 5.6 节，K 线图优先）：
//   顶栏两行（D63）：第 1 行 ≡ 菜单、周期按钮 │ 回放控制、快进到下一次成交、「下单后自动走一根」勾选（D76）│ 保存状态、结束本轮；
//                    不勾时市价单排队，K 线图左上角显示「待成交：买入 ×N」；
//                    第 2 行左边留给画线设置工具条（第 4b 阶段），右边是账户资金信息（总资产、初始资金、交易账户、杠杆、保证金）
//   左侧窄画线工具栏 │ K 线图（占满剩余空间；左上角一行：品种 · 周期、星期时刻、进度，D56；已过几个交易日，D84；黄金周五收盘倒计时，D85） │ 右侧下单面板（order_panel.tsx）
//   底部持仓面板（positions_panel.tsx；标签页；可拖动高度、可收起成只剩标签的一条）
// 整页不出现滚动条；面板的展开状态和尺寸记在当前浏览器里。
// 强平（D27、D55）：资金账户有钱 → 弹出「转入并继续 / 结束本轮」；资金账户为 0 → 直接结束本轮（按已完成计）。
// 保存连续失败 20 次 → 页面停住，提示下次回来可从最后一次保存处续练（D52）。
// 窄屏（Mac 自带屏、开着竖排标签栏等）不挡页面，而是自动收紧：按钮只留图标、次要信息缩短、右侧面板默认收起（用户 2026-10-21 定，参考 Exness 网页版）。
// 快捷键（规格书 5.8 节）：空格或 → 下一根；Shift+→ 下一分钟；P 播放/暂停；数字 1–8 切换 1m–1w；B / S 买入 / 卖出草稿单；
//   Esc 先取消草稿单；画线快捷键见左侧工具栏。
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api, type FinishResult } from '../backend_api_client/api_client';
import { applyPageTheme, saveTheme, themeById } from '../chart_and_drawing/theme_palettes';
import { TIMEFRAMES, type Timeframe } from '../trading_rules/kline_synthesis';
import { navigate } from './app';
import { AccountDetails, AccountSummary, TransferForm } from './account_summary';
import { END_REASON_TEXT, money, weekdayTime } from './format_helpers';
import { OrderPanel } from './order_panel';
import { PositionsPanel } from './positions_panel';
import { PracticeController, type PracticeView } from './practice_controller';
import { DEFAULTS, withDefaults } from './shared_settings';

const DEFAULT_HINT = '空格/→ 下一根 · Shift+→ 下一分钟 · P 播放/暂停 · 1–8 切换周期 · B/S 买/卖草稿单 · ⌥H ⌥J ⌥T ⌥F ⌥⇧R 画线 · Esc 取消';

export function PracticePage({ username, sessionId }: { username: string; sessionId: string }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const drawingSettingsRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<PracticeController | null>(null);
  const [view, setView] = useState<PracticeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<'confirm' | 'working' | null>(null);
  const [liqDismissed, setLiqDismissed] = useState(false);
  const [result, setResult] = useState<FinishResult | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // 打开：读用户设置 → 接管这一轮 → 建引擎和图表
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const u = await api.user(username);
        const settings = withDefaults(u.settings);
        const theme = themeById(settings.theme);
        applyPageTheme(theme);
        saveTheme(theme);
        const c = await PracticeController.open(username, sessionId, settings, theme, {
          chart: chartRef.current!,
          toolbar: toolbarRef.current!,
          drawingSettings: drawingSettingsRef.current!,
          onHint: setHint,
        });
        if (disposed) return c.dispose();
        ctrlRef.current = c;
        setView(c.view);
        c.subscribe(() => setView(c.view));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : '打开练习失败');
      }
    })();
    return () => {
      disposed = true;
      void ctrlRef.current?.leave();
      ctrlRef.current = null;
    };
  }, [username, sessionId]);

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = ctrlRef.current;
      const target = e.target as HTMLElement | null;
      // Esc 先取消草稿单（逐级取消的第一级；持仓表里正在改的格子自己处理 Esc）
      const inPositions = target instanceof Element && target.closest('.positions-panel') !== null;
      if (c && e.key === 'Escape' && !inPositions && c.cancelDraft()) {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (!c || (target instanceof Element && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) || e.altKey || e.metaKey || e.ctrlKey) return;
      if (finishing || result) return;
      if (e.code === 'Space' || (e.code === 'ArrowRight' && !e.shiftKey)) {
        e.preventDefault();
        c.stepBar();
      } else if (e.code === 'ArrowRight' && e.shiftKey) {
        e.preventDefault();
        c.step1m();
      } else if (e.code === 'KeyP') {
        c.togglePlay();
      } else if (e.code === 'KeyB' || e.code === 'KeyS') {
        // B 买入、S 卖出：生成市价草稿单（规格书 5.8 节），提交前不生效
        c.startDraft('market', e.code === 'KeyB' ? 1 : -1);
      } else if (/^Digit[1-8]$/.test(e.code)) { // 1–8 对应 1m … 1w（D74 加了周线）
        void c.switchTimeframe(TIMEFRAMES[Number(e.code.slice(5)) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishing, result]);

  // 播到最新数据：自动结束本轮（规格书 5.2 节）
  useEffect(() => {
    if (view?.dataEnd && !finishing && !result) void doFinish('latest_data');
  }, [view?.dataEnd]);

  // 「已满 300 根」提示 6 秒后自动消失，免得一直挡住图左上角的进度
  useEffect(() => {
    if (!view?.justCompleted) return;
    const timer = window.setTimeout(() => ctrlRef.current?.dismissCompletionNotice(), 6000);
    return () => window.clearTimeout(timer);
  }, [view?.justCompleted]);

  // 转入后恢复交易：下次再强平时对话框要重新弹出
  useEffect(() => {
    if (view?.accountStatus === 'active') setLiqDismissed(false);
  }, [view?.accountStatus]);

  // 强平且资金账户为 0：本轮直接结束，按已完成计（D27）
  useEffect(() => {
    if (view?.accountStatus === 'ended_liquidation' && !finishing && !result) void doFinish('liquidation');
  }, [view?.accountStatus]);

  const doFinish = async (reason: 'normal' | 'latest_data' | 'liquidation' = 'normal') => {
    const c = ctrlRef.current;
    if (!c) return;
    setFinishing('working');
    try {
      const r = await c.finish(reason);
      ctrlRef.current = null;
      // 第 5a 阶段：完成的一轮直接进简报页（那里显示复算和生成简报的进度）；不能出简报的才在这里弹提示
      if (r.result === 'completed' && r.report && r.report.status !== 'unavailable') {
        navigate(`/u/${encodeURIComponent(username)}/report/${encodeURIComponent(sessionId)}`);
        return;
      }
      // D73：未满 300 根丢弃的，刚才已确认过一次，直接回「我的练习」，不再弹「本轮已丢弃」
      if (r.result === 'discarded') {
        navigate(`/u/${encodeURIComponent(username)}`);
        return;
      }
      setResult(r);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '结束失败');
    } finally {
      setFinishing(null);
    }
  };

  const askFinish = () => {
    const c = ctrlRef.current;
    if (!view || !c) return;
    c.stopPlay();
    const s = c.account.s;
    // 不满 300 根要确认丢弃；仍有持仓要提示会按现价平仓（D26）
    if (view.barsPlayed < view.completionBars || s.positions.length > 0) setFinishing('confirm');
    else void doFinish(view.accountStatus === 'liquidated_paused' ? 'liquidation' : 'normal');
  };
  const openPositions = ctrlRef.current?.account.s.positions.length ?? 0;

  const offset = ctrlRef.current?.settingsSnapshot.utc_offset_hours ?? 0;
  const queued = view ? ctrlRef.current?.queuedSummary() ?? null : null;

  return (
    <div class="practice">
      <header class="topbar">
        <div class="menu-wrap">
          <button class="icon" title="菜单" onClick={() => setMenuOpen(!menuOpen)}>
            ≡
          </button>
          {menuOpen && (
            <div class="menu" onClick={() => setMenuOpen(false)}>
              <a href="#/">首页</a>
              <a href={`#/u/${encodeURIComponent(username)}`}>我的练习</a>
              <a href={`#/u/${encodeURIComponent(username)}/settings`}>设置</a>
            </div>
          )}
        </div>
        <div class="segmented tf-buttons">
          {TIMEFRAMES.map((tf, i) => (
            <button
              key={tf}
              title={`快捷键 ${i + 1}`}
              class={view?.timeframe === tf ? 'active' : ''}
              disabled={!view || view.busy}
              onClick={() => void ctrlRef.current?.switchTimeframe(tf as Timeframe)}
            >
              {tf}
            </button>
          ))}
        </div>
        <span class="sep" />
        <button title="空格 或 →" disabled={!view || !ctrlRef.current?.canAdvance()} onClick={() => ctrlRef.current?.stepBar()}>
          ⏭<span class="label"> 下一根</span>
        </button>
        <button title="Shift+→" disabled={!view || !ctrlRef.current?.canAdvance()} onClick={() => ctrlRef.current?.step1m()}>
          +1m<span class="label"> 下一分钟</span>
        </button>
        <button title="P" disabled={!view || !ctrlRef.current?.canAdvance()} onClick={() => ctrlRef.current?.togglePlay()}>
          {view?.playing ? '⏸' : '▶'}
          <span class="label">{view?.playing ? ' 暂停' : ' 播放'}</span>
        </button>
        <button title="快进到下一次成交或止损止盈触发（最多 5 个交易日）" disabled={!view || !ctrlRef.current?.canAdvance()}
          onClick={() => void ctrlRef.current?.fastForward()}>
          {view?.fastForwarding ? '快进中…' : '⏩'}
          <span class="label">{view?.fastForwarding ? '' : ' 到下一次成交'}</span>
        </button>
        <select
          title="自动播放：当前周期每根间隔几秒"
          value={view?.autoplaySeconds ?? 1}
          onChange={(e) => ctrlRef.current?.setAutoplaySeconds(Number((e.target as HTMLSelectElement).value))}
        >
          {DEFAULTS.replay.autoplay_seconds_options.map((s) => (
            <option key={s} value={s}>
              {s} 秒
            </option>
          ))}
        </select>
        <label class="auto-step" title="勾选：点买入 / 卖出后立即成交并走完这一根。不勾：订单先排队（图上标「待成交」），按「下一根」或空格才成交，同一根可以连下几笔">
          <input type="checkbox" checked={view?.autoStep ?? false} disabled={!view}
            onChange={(e) => ctrlRef.current?.setAutoStep((e.target as HTMLInputElement).checked)} />
          <span class="label">下单后</span>自动走一根
        </label>
        <span class="spacer" />
        <span class={`save-status ${view?.saveStatus ?? ''}`}>
          {view?.saveStatus === 'unsaved' ? '未保存' : view?.saveStatus === 'saving' ? '保存中' : ''}
        </span>
        <button class="finish" disabled={!view || view.readOnly || finishing !== null} onClick={askFinish}>
          结束本轮
        </button>
      </header>
      {/* 顶栏第 2 行（D63）：左边是画线设置工具条（选中画线时出现，D64），右边是账户资金信息 */}
      <div class="topbar topbar-row2">
        <div class="drawing-settings-slot" ref={drawingSettingsRef} />
        <span class="spacer" />
        {view && ctrlRef.current && <AccountSummary ctrl={ctrlRef.current} view={view} />}
      </div>

      <div class="workspace">
        <nav class="draw-toolbar" ref={toolbarRef} />
        <div class="chart-area">
          <div class="chart" ref={chartRef} />
          {view && (
            <div class="chart-legend">
              <b>
                {view.symbol} · {view.timeframe}
              </b>
              <span>{view.lastBarMs ? weekdayTime(view.lastBarMs + 60_000, offset) : ''}</span>
              <span class={view.barsPlayed >= view.completionBars ? 'progress done' : 'progress'} title="已走完的起始周期 K 线根数">
                {view.barsPlayed >= view.completionBars ? '已完成 ' : '进度 '}
                {view.barsPlayed}/{view.completionBars}
                {view.timeframe !== view.startTimeframe ? `（按 ${view.startTimeframe} 计）` : ''}
                {view.isReplay ? ' · 复练' : ''}
              </span>
              <span title="从本轮起点到现在的行情时间，按交易日估算（周末休市不算，节假日不扣除）">{view.elapsedLabel}</span>
              {view.weekendCountdown && (
                <span
                  class={openPositions + (ctrlRef.current?.account.s.pending.length ?? 0) > 0 ? 'weekend-countdown at-risk' : 'weekend-countdown'}
                  title="黄金每周五纽约时间 17:00 收盘（夏令时 UTC 21:00、冬令时 22:00），节假日提前收盘不在内；有持仓或挂单时变橙色"
                >
                  {view.weekendCountdown}
                </span>
              )}
              {queued && (
                <span class="queued-badge">
                  待成交：{queued.direction === 1 ? '买入' : '卖出'} ×{queued.count} · 按「下一根」或空格成交
                </span>
              )}
            </div>
          )}
          {view?.flash && <div class="toast flash">{view.flash}</div>}
          {view?.notice && (
            <div class="toast notice" onClick={() => ctrlRef.current?.dismissNotice()}>
              {view.notice}（点此关闭）
            </div>
          )}
          {view?.waitingForData && <div class="chart-note">正在加载后面的行情…</div>}
          {view?.noEarlierData && <div class="chart-note">{view.noEarlierData}</div>}
          {view?.busy && <div class="chart-note">加载中…</div>}
          {view?.justCompleted && (
            <div class="toast" onClick={() => ctrlRef.current?.dismissCompletionNotice()}>
              已满 {view.completionBars} 根，本轮已算完成。可以继续练，或点「结束本轮」。（点此关闭）
            </div>
          )}
        </div>
        {view && ctrlRef.current && <OrderPanel ctrl={ctrlRef.current} view={view} />}
      </div>

      {view && ctrlRef.current && <PositionsPanel ctrl={ctrlRef.current} view={view} hint={hint ?? DEFAULT_HINT} />}

      {view?.accountStatus === 'liquidated_paused' && !liqDismissed && !finishing && !result && ctrlRef.current && (
        <div class="overlay">
          <div class="dialog wide">
            <p>
              <b>强平了</b>：交易账户已清零，全部持仓已平掉、挂单已撤销。资金账户还有 <b>{money(ctrlRef.current.account.s.funding)}</b>。
            </p>
            <p>从资金账户转入一笔就能继续练；不转入的话只能结束本轮（强平结束的一轮按已完成计入统计）。</p>
            <AccountDetails ctrl={ctrlRef.current} view={view} />
            <TransferForm ctrl={ctrlRef.current} onlyIn onDone={() => setLiqDismissed(false)} />
            <div>
              <button class="danger" onClick={() => void doFinish('liquidation')}>
                结束本轮
              </button>{' '}
              <button onClick={() => setLiqDismissed(true)}>先看看图（暂不决定）</button>
            </div>
          </div>
        </div>
      )}

      {view?.connectionLost && !result && (
        <div class="overlay">
          <div class="dialog">
            <p>
              <b>连不上服务器</b>：已经重试 20 次都失败，页面先停住。最后一次保存成功之后的操作没有存上。
            </p>
            <p>网络恢复后重新打开这一轮，会从最后一次保存的位置继续（未完成的一轮保存 {DEFAULTS.segment_rules.unfinished_keep_days} 天）。</p>
            <button class="primary" onClick={() => window.location.reload()}>
              重新打开
            </button>
          </div>
        </div>
      )}

      {error && (
        <div class="overlay">
          <div class="dialog">
            <p class="error">{error}</p>
            <button onClick={() => navigate(`/u/${encodeURIComponent(username)}`)}>返回我的练习</button>
            <button onClick={() => setError(null)}>关闭</button>
          </div>
        </div>
      )}

      {view?.readOnly && !result && (
        <div class="overlay">
          <div class="dialog">
            <p>
              <b>这一轮已在别处打开</b>（另一个标签页或另一台电脑），本页面已变为只读，防止记录被弄乱。
            </p>
            <button class="primary" onClick={() => window.location.reload()}>
              在本页继续（另一处会变为只读）
            </button>
            <button onClick={() => navigate(`/u/${encodeURIComponent(username)}`)}>返回我的练习</button>
          </div>
        </div>
      )}

      {finishing === 'confirm' && view && (
        <div class="overlay">
          <div class="dialog">
            {openPositions > 0 && (
              <p>
                还有 <b>{openPositions} 个持仓</b>，结束时会按现价全部平仓。
              </p>
            )}
            {view.barsPlayed < view.completionBars && view.accountStatus === 'active' && (
              <p>
                未满 {view.completionBars} 根（已走 {view.barsPlayed} 根），<b>结束后本轮不保存</b>，不计入任何统计和防重复记录。
              </p>
            )}
            <p>确定结束吗？</p>
            <button class="danger" onClick={() => void doFinish(view.accountStatus === 'liquidated_paused' ? 'liquidation' : 'normal')}>
              {view.barsPlayed < view.completionBars && view.accountStatus === 'active' ? '确定结束（丢弃）' : '确定结束'}
            </button>
            <button class="primary" onClick={() => setFinishing(null)}>
              继续练习
            </button>
          </div>
        </div>
      )}
      {finishing === 'working' && <div class="overlay"><div class="dialog">正在结束本轮…</div></div>}

      {result && (
        <div class="overlay">
          <div class="dialog">
            {result.result === 'discarded' ? (
              <p>本轮已丢弃（走了 {result.bars_played} 根，未满 300 根）。</p>
            ) : (
              <>
                <p>
                  <b>本轮已完成</b>（{END_REASON_TEXT[result.end_reason ?? 'normal']}，走了 {result.bars_played} 根）。
                </p>
                <p>
                  真实行情时间段：<b>{result.reveal?.start_utc}</b> → <b>{result.reveal?.end_utc}</b>
                </p>
                {result.report?.error && <p class="muted">{result.report.error}</p>}
              </>
            )}
            <button class="primary" onClick={() => navigate(`/u/${encodeURIComponent(username)}`)}>
              返回我的练习
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
