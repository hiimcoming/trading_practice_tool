// 首页（规格书 5.7 节）：输入用户名进入；「最近练习」用户列表按品种分标签页，各列可点击排序；样本太少的行变灰并标注。
import { useEffect, useMemo, useState } from 'preact/hooks';
import { ApiError, api, type MarketSpec, type RecentUser } from '../backend_api_client/api_client';
import { navigate } from './app';
import { ago, pct, signedPct, signedR } from './format_helpers';
import { DEFAULTS, local } from './shared_settings';

type SortKey = 'last_practice_at' | 'display_name' | 'completed_rounds' | 'total_trades' | 'win_rate' | 'avg_round_return' | 'profitable_round_ratio' | 'avg_r';

const COLUMNS: Array<{ key: SortKey; label: string; title?: string; num?: boolean }> = [
  { key: 'display_name', label: '用户名' },
  { key: 'last_practice_at', label: '最后练习' },
  { key: 'completed_rounds', num: true, label: '完成轮数', title: '只计已完成（满 300 根）的首次练习' },
  { key: 'total_trades', num: true, label: '交易笔数' },
  { key: 'win_rate', num: true, label: '胜率', title: '盈利笔数 ÷ 总笔数（扣除成本后盈亏 > 0 为盈利）' },
  { key: 'avg_round_return', num: true, label: '平均每轮收益率', title: '按总资产计算，小字为中位数' },
  { key: 'profitable_round_ratio', num: true, label: '盈利轮次占比' },
  { key: 'avg_r', num: true, label: '平均 R', title: '每笔交易的平均 R 倍数' },
];

export function HomePage() {
  const [name, setName] = useState(() => local.get('last_username', ''));
  const [error, setError] = useState<string | null>(null);
  const [markets, setMarkets] = useState<Record<string, MarketSpec>>({});
  const [tab, setTab] = useState(() => local.get('home_tab', DEFAULTS.practice_start.default_symbol));

  useEffect(() => {
    api.markets().then((r) => setMarkets(r.markets)).catch((e: ApiError) => setError(e.message));
  }, []);

  const enter = async (e: Event) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.enterUser(name.trim());
      local.set('last_username', r.display_name);
      navigate(`/u/${encodeURIComponent(r.username)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '进入失败');
    }
  };

  return (
    <div class="page">
      <header class="page-header">
        <h1>K 线回放练习</h1>
        <a href="#/data">数据概况</a>
      </header>
      <form class="card enter-card" onSubmit={enter}>
        <label for="username">用户名</label>
        <input
          id="username"
          value={name}
          maxLength={DEFAULTS.user_rules.username_max_length}
          placeholder="字母、数字、下划线，2–20 位"
          autoFocus
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
        <button class="primary" type="submit">
          进入
        </button>
        <span class="muted">不存在就自动新建；不区分大小写。第一版没有密码。</span>
        {error && <div class="error">{error}</div>}
      </form>
      <section class="card">
        <div class="tabs">
          <span class="tabs-title">最近练习</span>
          {Object.entries(markets).map(([sym, m]) => (
            <button
              key={sym}
              class={tab === sym ? 'tab active' : 'tab'}
              onClick={() => {
                setTab(sym);
                local.set('home_tab', sym);
              }}
            >
              {m.display_name}
            </button>
          ))}
        </div>
        <RecentUsersTable symbol={tab} />
      </section>
    </div>
  );
}

function RecentUsersTable({ symbol }: { symbol: string }) {
  const [rows, setRows] = useState<RecentUser[] | null>(null);
  const [few, setFew] = useState<number>(DEFAULTS.user_rules.few_trades_threshold);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'last_practice_at', desc: true });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    api
      .recentUsers(symbol)
      .then((r) => {
        setRows(r.users);
        setFew(r.few_trades_threshold);
      })
      .catch((e: ApiError) => setError(e.message));
  }, [symbol]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const v = (r: RecentUser) => r[sort.key] ?? (sort.desc ? -Infinity : Infinity);
    return [...rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : (x as number) - (y as number);
      return sort.desc ? -c : c;
    });
  }, [rows, sort]);

  if (error) return <div class="error">{error}</div>;
  if (!rows) return <div class="muted">加载中…</div>;
  if (rows.length === 0) return <div class="muted empty">这个品种还没有人完成过练习。</div>;
  return (
    <table class="data-table users-table">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th key={c.key} class={c.num ? 'num' : ''} title={c.title} onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : true })}>
              {c.label}
              {sort.key === c.key ? (sort.desc ? ' ▼' : ' ▲') : ''}
            </th>
          ))}
          <th>最近 10 轮</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => {
          const fewSamples = r.total_trades < few;
          return (
            <tr key={r.username} class={fewSamples ? 'few-samples' : ''}>
              <td>
                <a href={`#/u/${encodeURIComponent(r.username)}`}>{r.display_name}</a>
                {fewSamples && <span class="badge" title={`交易笔数少于 ${few} 笔，指标仅供参考`}>样本少</span>}
              </td>
              <td>{ago(r.last_practice_at)}</td>
              <td class="num">{r.completed_rounds}</td>
              <td class="num">{r.total_trades}</td>
              <td class="num">{pct(r.win_rate, 1)}</td>
              <td class={`num ${pnlClass(r.avg_round_return)}`}>
                {signedPct(r.avg_round_return)}
                <small class="muted"> 中位 {signedPct(r.median_round_return)}</small>
              </td>
              <td class="num">{pct(r.profitable_round_ratio, 1)}</td>
              <td class={`num ${pnlClass(r.avg_r)}`}>{signedR(r.avg_r)}</td>
              <td>
                <Sparkbars values={r.last10_returns} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export const pnlClass = (x: number | null | undefined) => (x === null || x === undefined || x === 0 ? '' : x > 0 ? 'profit' : 'loss');

/** 最近 10 轮的小柱状图：每根是一轮的收益率，绿正红负 */
function Sparkbars({ values }: { values: number[] }) {
  if (!values.length) return <span class="muted">—</span>;
  const max = Math.max(...values.map((v) => Math.abs(v)), 0.0001);
  const w = 6;
  const h = 22;
  return (
    <svg class="sparkbars" width={values.length * (w + 2)} height={h} aria-label="最近 10 轮收益率">
      {values.map((v, i) => {
        const bh = Math.max(1, (Math.abs(v) / max) * (h / 2 - 1));
        return (
          <rect key={i} x={i * (w + 2)} y={v >= 0 ? h / 2 - bh : h / 2} width={w} height={bh} class={v >= 0 ? 'bar-profit' : 'bar-loss'}>
            <title>{signedPct(v)}</title>
          </rect>
        );
      })}
    </svg>
  );
}
