// 数据概况页（规格书 5.9 节）：任何人都能打开，只展示、不提供任何操作。内容来自各品种的数据说明卡，不读 K 线本身。
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, type DataStatus } from '../backend_api_client/api_client';

const STATUS_TEXT: Record<string, string> = { complete: '完整', warnings: '有疑问（已写入，待人看）', failed: '失败' };

export function DataStatusPage() {
  const [data, setData] = useState<Record<string, DataStatus> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.dataStatus().then((r) => setData(r.symbols)).catch((e: ApiError) => setError(e.message));
  }, []);
  return (
    <div class="page">
      <header class="page-header">
        <h1>数据概况</h1>
        <nav>
          <a href="#/">首页</a>
        </nav>
      </header>
      {error && <div class="error card">{error}</div>}
      {data &&
        Object.entries(data).map(([sym, d]) => (
          <section key={sym} class="card">
            <h2>{sym}</h2>
            <div class="muted">
              来源 {d.data_source} · 平台规则 {d.platform} · {d.first_bar_utc ?? '—'} 至 {d.last_bar_utc ?? '—'} · {d.months_ok} 个月 ·
              1m 共 {d.total_rows_1m.toLocaleString()} 根 · 更新于 {d.updated_at_utc ?? '—'} · 每月 1 日 UTC 06:00 更新上一个月
            </div>
            <div class="month-grid">
              {Object.entries(d.months).map(([m, info]) => (
                <span
                  key={m}
                  class={`month-cell ${info.status}`}
                  title={`${m}：${STATUS_TEXT[info.status] ?? info.status}，${info.rows ?? 0} 根${info.warnings.length ? '\n' + info.warnings.join('\n') : ''}`}
                >
                  {m.slice(2)}
                </span>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}
