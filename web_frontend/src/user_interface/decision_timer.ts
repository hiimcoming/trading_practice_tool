// 决策用时（规格书 7.3、15.1 节，第 5b 阶段 D68）：从这根 K 线出现（最近一次推进，回放每揭开一根 1m 就重新计时）到下单，
// 只计页面在前台、且有鼠标或键盘操作的时间——两次操作之间隔得不超过 N 分钟【可改，default_settings.json 的
// discipline_review.decision_idle_minutes，默认 5】才把这段算进去；切到别的标签页的时段不计。离开电脑不会把数字撑大。
// 下单（市价单、挂单）时读一次，随这次操作的事件一起保存，服务器复算时对到对应的那一笔。

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

export class DecisionTimer {
  private activeMs = 0;
  private last: number | null = null;
  private readonly idleMs: number;
  private readonly onActivity = () => this.touch();
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      // 浏览器先把状态改成 hidden 再通知，所以这里不看状态、直接把切走之前的那段记上
      this.accrue();
      this.last = null; // 后台的时段不计
    } else {
      this.last = Date.now();
    }
  };

  constructor(idleMinutes: number) {
    this.idleMs = idleMinutes * 60_000;
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, this.onActivity, { passive: true, capture: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    this.reset();
  }

  /** 新的一根 K 线出现：重新计时 */
  reset(): void {
    this.activeMs = 0;
    this.last = document.visibilityState === 'hidden' ? null : Date.now();
  }

  /** 到此刻为止的决策用时（毫秒） */
  read(): number {
    this.touch();
    return Math.round(this.activeMs);
  }

  destroy(): void {
    for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, this.onActivity, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private touch(): void {
    if (document.visibilityState === 'hidden') return;
    this.accrue();
  }

  /** 把上次操作到现在的这段记上（不超过空闲上限才算） */
  private accrue(): void {
    const now = Date.now();
    if (this.last !== null && now - this.last <= this.idleMs) this.activeMs += now - this.last;
    this.last = now;
  }
}
