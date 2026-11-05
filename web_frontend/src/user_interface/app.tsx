// 网站外壳：按地址栏 # 后面的路径切换页面（不需要服务器配合），并统一套用配色。
//   #/                      首页：输入用户名、最近练习的用户
//   #/data                  数据概况（公开只读）
//   #/u/{用户名}             用户页：开始练习、进行中的一轮、历史练习、清除历史
//   #/u/{用户名}/settings    设置
//   #/u/{用户名}/practice/{轮次}  练习页
//   #/u/{用户名}/report/{轮次}    单轮简报（第 5a 阶段）
//   #/u/{用户名}/review/{轮次}[/{时刻}]  已完成轮次的静态 K 线图（第 5a 阶段）；/{起}-{止}/{持仓编号}/{第几笔} 高亮连续亏损段（5b-2）
//   #/u/{用户名}/stats/{品种}[/from/{轮次}]  统计与审查（第 5b 阶段）；从简报点进来时带 /from/{轮次}，可返回那份简报（D72）
//                                            带 /review 时打开后自动滚到纪律审查（D79）
import { useEffect, useState } from 'preact/hooks';
import { parseReviewStreak } from '../chart_and_drawing/review_chart';
import { applyPageTheme, loadSavedTheme } from '../chart_and_drawing/theme_palettes';
import { DataStatusPage } from './data_status_page';
import { HomePage } from './home_page';
import { PracticePage } from './practice_page';
import { ReportPage, ReviewPage } from './report_page';
import { StatsPage } from './stats_page';
import { SettingsPage } from './settings_page';
import { UserPage } from './user_page';

export function navigate(path: string): void {
  window.location.hash = path;
}

function useHashPath(): string {
  const [path, setPath] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const on = () => setPath(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return path;
}

export function App() {
  const path = useHashPath();
  useEffect(() => applyPageTheme(loadSavedTheme()), []);
  useEffect(() => {
    document.title = 'K 线回放练习'; // 标题里不放任何日期（盲练，规格书 15.7 节）
  }, [path]);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'data') return <DataStatusPage />;
  if (parts[0] === 'u' && parts[1]) {
    if (parts[2] === 'settings') return <SettingsPage username={parts[1]} />;
    if (parts[2] === 'practice' && parts[3]) return <PracticePage key={parts[3]} username={parts[1]} sessionId={parts[3]} />;
    if (parts[2] === 'stats' && parts[3]) {
      const from = parts[4] === 'from' && parts[5] ? parts[5] : null;
      const focusReview = parts[4] === 'review'; // D79：用户页「直接看纪律审查」
      return <StatsPage key={`${parts[3]}/${from}/${focusReview}`} username={parts[1]} symbol={parts[3]} fromSession={from} focusReview={focusReview} />;
    }
    if (parts[2] === 'report' && parts[3]) return <ReportPage key={parts[3]} username={parts[1]} sessionId={parts[3]} />;
    if (parts[2] === 'review' && parts[3]) {
      const streak = parseReviewStreak(parts[4], parts[5], parts[6]);
      return (
        <ReviewPage key={parts.slice(3).join('/')} username={parts[1]} sessionId={parts[3]}
          focusMs={!streak && parts[4] ? Number(parts[4]) : null} streak={streak} />
      );
    }
    return <UserPage key={parts[1]} username={parts[1]} />;
  }
  return <HomePage />;
}
