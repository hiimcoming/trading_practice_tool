// 设置页（规格书 5.1 节末尾）：配色、显示时区、盲练开关、自动播放间隔、图上的交易标记（D57）、买价线（5.8 节）、快捷键说明。
// 设置按用户存在服务器上。
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api } from '../backend_api_client/api_client';
import { THEMES, applyPageTheme, saveTheme, themeById } from '../chart_and_drawing/theme_palettes';
import { DEFAULTS, withDefaults, type UserSettings } from './shared_settings';

const SHORTCUTS: Array<[string, string]> = [
  ['空格 或 →', '下一根（当前周期走完一根）'],
  ['Shift + →', '下一分钟（只推进 1 根 1m）'],
  ['P', '自动播放 / 暂停'],
  ['1 – 7', '切换周期 1m / 5m / 15m / 30m / 1h / 4h / 1d'],
  ['B / S', '生成买入 / 卖出草稿单（图上先画出线，点「提交」才成交）'],
  ['⌥H / ⌥J / ⌥T / ⌥F / ⌥⇧R', '画水平线 / 水平射线（向右）/ 线段 / 斐波那契回撤 / 方框'],
  ['Delete 或 Backspace', '删除选中的画线'],
  ['Esc', '逐级取消：草稿单 → 未完成的点 → 当前工具 → 选中'],
];

export function SettingsPage({ username }: { username: string }) {
  const [s, setS] = useState<UserSettings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api
      .user(username)
      .then((u) => setS(withDefaults(u.settings)))
      .catch((e: ApiError) => setMsg(e.message));
  }, [username]);

  const save = async (patch: Partial<UserSettings>) => {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    if (patch.theme) {
      const t = themeById(patch.theme);
      applyPageTheme(t);
      saveTheme(t);
    }
    try {
      await api.saveSettings(username, patch as Record<string, unknown>);
      setMsg('已保存');
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '保存失败');
    }
  };

  if (!s) return <div class="page">{msg ?? '加载中…'}</div>;
  return (
    <div class="page">
      <header class="page-header">
        <h1>设置</h1>
        <nav>
          <a href={`#/u/${encodeURIComponent(username)}`}>返回我的练习</a>
        </nav>
      </header>
      <section class="card settings">
        <div class="form-row">
          <label>配色</label>
          <div class="segmented">
            {THEMES.map((t) => (
              <button key={t.id} class={s.theme === t.id ? 'active' : ''} onClick={() => void save({ theme: t.id })}>
                {t.name}
                {t.id === DEFAULTS.display.default_theme ? '（默认）' : ''}
              </button>
            ))}
          </div>
        </div>
        <div class="form-row">
          <label>显示时区</label>
          <div class="segmented">
            <button class={s.utc_offset_hours === 0 ? 'active' : ''} onClick={() => void save({ utc_offset_hours: 0 })}>
              UTC
            </button>
            <button class={s.utc_offset_hours === 8 ? 'active' : ''} onClick={() => void save({ utc_offset_hours: 8 })}>
              UTC+8
            </button>
          </div>
          <span class="muted">只改变时间标签，不改变 K 线切分。</span>
        </div>
        <div class="form-row">
          <label>盲练</label>
          <label class="inline">
            <input type="checkbox" checked={s.blind_mode} onChange={(e) => void save({ blind_mode: (e.target as HTMLInputElement).checked })} />
            开启（隐藏年月日；K 线图横轴不显示时间，十字线只显示 K 线序号）
          </label>
        </div>
        <div class="form-row">
          <label>自动播放</label>
          <select value={s.autoplay_seconds} onChange={(e) => void save({ autoplay_seconds: Number((e.target as HTMLSelectElement).value) })}>
            {DEFAULTS.replay.autoplay_seconds_options.map((x) => (
              <option key={x} value={x}>
                每根 {x} 秒
              </option>
            ))}
          </select>
        </div>
        <div class="form-row">
          <label>交易标记</label>
          <label class="inline">
            <input type="checkbox" checked={s.show_trade_markers} onChange={(e) => void save({ show_trade_markers: (e.target as HTMLInputElement).checked })} />
            图上显示开仓、平仓箭头和两者之间的连线
          </label>
        </div>
        <div class="form-row">
          <label>买价线</label>
          <label class="inline">
            <input type="checkbox" checked={s.show_ask_line} onChange={(e) => void save({ show_ask_line: (e.target as HTMLInputElement).checked })} />
            Exness 品种在图上显示一条淡色虚线代表买价（= K 线价格 + 点差）
          </label>
        </div>
        {msg && <div class="muted">{msg}</div>}
      </section>
      <section class="card">
        <h2>快捷键</h2>
        <table class="data-table">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
