# 更新记录 / Changelog

格式参照 [Keep a Changelog](https://keepachangelog.com/)；正式发版前版本号保持 0.0.0。

## [未发布 / Unreleased]

### 新增 / Added
- 用户页选品种和起始周期时，下面显示可练数据有几个月（约几年）、按当前周期和背景根数约可练几轮不重复；少于 5 轮橙色提醒，0 轮红色并禁止开始。4h、1d 的默认背景根数改为 50 根（其余仍 400），按周期分别记住；更早的行情往左拖即可加载。
  The start card shows how many months of data are available and roughly how many non-overlapping rounds the chosen timeframe allows, warning below 5 and blocking at 0. Default background bars for 4h/1d is now 50 (others 400), remembered per timeframe.
- 同一价位的几笔持仓（及挨得太近的止损止盈），图上标签以价位为中心竖着叠开、虚线连回价位，每张都能单独点 TP / SL、单独拖，不挡 K 线。
  Overlapping order-line labels stack vertically around their price with dashed leaders; each can be dragged or given TP/SL independently.
- 市价单排队时的提示更明显：关掉开平仓箭头时仍显示待成交箭头；下单按钮下方、持仓面板都显示待成交笔数；每次点击弹出短提示。
  Clearer queued-order feedback: pending marker always shown, queued rows in the positions panel, a note under the order buttons and a short toast per click.
- 用户页历史练习按品种分标签显示，旁边直接给出该品种的「统计与审查」和「直接看纪律审查」入口；下载区品种跟着标签切换。
  History split by symbol tabs with direct links to that symbol's statistics and discipline review.
- 部分平仓后，持仓盈亏和止损止盈线上的金额只算剩下的仓位（与顶栏浮动盈亏一致），已平部分以灰字「已平 ±x」显示；拖动止损止盈线时另显示整笔合计。
  After a partial close, position P/L and SL/TP labels cover only the remaining size; the closed part is shown separately, with a whole-trade total while dragging.
- 历史练习表最左边加「第 N 轮」（按品种数，与统计页、简报一致）；去掉「片段来源」列，复练 / 重复练习模式在行情片段后用小字标出。
  History table: round number column (per symbol, matching briefs); removed the "segment source" column.
- 顶栏新增「下单后自动走一根」勾选（默认不勾）：不勾时市价单先排队、图上标「待成交 ×N」，按「下一根」或空格才成交，同一根 K 线可连下多笔；有反向单在排队、或几笔合计保证金不够时当场提示。
  New "auto-step after order" toggle (off by default): market orders queue with a "pending ×N" marker and fill on the next bar, allowing several entries on the same bar.
- 统计页「纪律审查」重排为三层：六种犯错行为的卡片（犯了的 vs 没犯的胜率）、对比横条（市价 vs 挂单、方向、时段等）、默认收起的明细。
  Discipline review redesigned: behavior cards, win-rate comparison bars (market vs pending, direction, session…), collapsible details.
- 周线（1w）：币安周一起、黄金周日起；日线、周线往左可看到更早的行情（黄金 2015 年起，币安永续上线起，只作背景，不参与抽片段），拖到数据起点有提示。
  Weekly timeframe (Binance weeks start Monday, gold Sunday); older background history for daily/weekly charts with a start-of-data hint.
- 新品种 ETHUSDT 永续（币安规格已与官方核对，数据 2020-10 起）。
  New symbol: ETHUSDT perpetual (Binance specs verified against official data, history from 2020-10).
- 币安下单面板：可在空仓、无挂单时直接改杠杆；数量可按 USDT 名义价值、USDT 保证金或币数填写，并实时显示换算。
  Binance order panel: change leverage when flat; enter size in USDT notional, USDT margin or coins with live conversion.
- 简报、K 线图、统计页加页面路径（首页 › 我的练习 › 第 N 轮简报 › …）和「返回简报」；简报与统计页标题写明轮次、行情时间段和练习日期；
  金额带货币（$ / USDT）；从违规或逐笔交易点开 K 线图时只高亮这一笔并留出前后行情。
  Breadcrumbs and back-to-brief links; descriptive titles; currency-formatted amounts; single-trade highlight on the review chart.
- 前端工程骨架：Vite + TypeScript，图表库 Lightweight Charts 5.2.1（版本锁定）。
  Frontend scaffold: Vite + TypeScript with Lightweight Charts 5.2.1 (pinned).
- 引入画线库 lightweight-charts-drawing 0.6.2 的源码（`web_frontend/vendor/`，MIT），自行维护；
  补上 `DrawingManager` 的交易日历选项（`future`），跨周末画到右侧未来区的线落在真实交易时刻。
  Vendored lightweight-charts-drawing 0.6.2 (MIT) with a `future` trading-calendar option on `DrawingManager`.
- 行情数据层：Dukascopy / 币安 1 分钟 K 线按月存 Parquet，每月更新 + 完整性检查 + 校验值；1m 现场合成 5m–1d（日线起点 UTC 0 点或纽约 17:00）。
  Market data: monthly Parquet of 1m bars (Dukascopy, Binance) with integrity checks; on-the-fly synthesis to 5m–1d.
- 后端（FastAPI）：品种档案、数据概况、K 线、用户、练习轮次接口。
  FastAPI backend: markets, data status, bars, users and practice sessions.
- 回放练习页：随机抽片段（防重复、复练）、盲练、逐根回放与自动播放、多周期切换、断点续练、单标签页占用；首页用户列表、设置页、数据概况页。
  Replay practice: random segments with overlap control, blind mode, step/autoplay, multi-timeframe, resume, single-tab lock.
- 前后端 K 线合成对账用例（tests/cross_check_cases/）与「不偷看未来」截断不变性测试。
  Cross-language synthesis checks and truncation-invariance tests.
- 交易模拟（第 4 阶段）：交易账户 + 资金账户与出入金；市价单与四种挂单（买入 / 卖出 × 限价 / 止损），挂出即预占保证金；
  逐根 1 分钟判断成交（跳空止损 → 跳空止盈 → 盘中止损 → 盘中止盈）、Exness 固定点差 0.25 与币安挂单 / 吃单费率、滑点；
  保证金、真实杠杆、强平价与强平流程（Exness 净值归零、币安维持保证金率，强平后交易账户清零）；前后端两份规则逐笔对账（37 个用例）。
  Trading simulation: trading + funding accounts, market and four pending order types with margin reservation, 1-minute fill
  rules, Exness spread / Binance fees, slippage, margin, real leverage, liquidation; Python and TypeScript rules cross-checked.
- 下单界面：照 Exness 网页版的右侧下单面板（手数 / 保证金比例 / 风险比例三种仓位方式）、价格轴「+」、草稿单、B / S 快捷键；
  图上拖动止盈止损、挂单线，从持仓线拖出止盈止损，线标签上的 TP / SL 按钮与 ×；底部持仓 / 挂单 / 已平仓 / 出入金面板；
  两行顶栏（总资产、初始资金、交易账户、杠杆、保证金）；快进到下一次成交；开平仓箭头与连线（可隐藏）；测量尺；水平射线。
  Order UI: Exness-style order panel, price-axis "+", draft orders, draggable SL/TP and pending lines, positions panel,
  two-row account bar, fast-forward to next fill, trade markers, measuring ruler, horizontal ray.
- 画线工具（第 4b 阶段）：选中画线后顶栏出现设置条（颜色色板 + 不透明度、线宽 1–4、实线 / 虚线 / 点线、锁定、删除）；
  新画的线沿用该类工具上次的样式；画线按轮次随进度保存、断点续练恢复；⌘Z / ⌘⇧Z 撤销重做（只针对画线，清除全部也能撤销）。
  Drawing tools: settings bar for the selected drawing (colour + opacity, width, line style, lock, delete), remembered
  per-tool styles, per-round saving and restore, undo / redo for drawings.
- 图上草稿线标签加「提交」按钮（卖出红、买入蓝），与下单面板的提交按钮同一套检查；不能下单时变灰，悬停显示原因。
  "Submit" button on the draft order line label, sharing the order panel's checks; greyed out with the reason on hover.
- 部分平仓改为小菜单（25% / 50% / 75% 写明数量和预估盈亏，自定义：Exness 填手数、币圈填 USDT 名义价值）；
  持仓编号 #N 同时显示在持仓表、持仓线和止盈止损线上；已平仓「成本」改名「交易成本」。
  Partial-close menu (25/50/75 % with estimates, custom lots or USDT notional); position numbers on lines and table;
  "Cost" renamed "Trading cost".
- 第 5a 阶段：结束本轮后服务器按事件日志复算全部成交和盈亏（与浏览器逐笔比对，不一致在简报上标出），排队生成单轮简报
  （揭晓信息、资产曲线与最大回撤、基本数字、纪律违规清单、逐笔交易），带三步进度；历史练习列表加笔数、收益率、简报和静态 K 线图入口。
  Stage 5a: server-side recompute of each finished round, queued round brief with progress, history links and a static review chart.
- 第 5b-1 阶段：每个品种一个「统计与审查」页——进步曲线（按轮次，四层：结果 / 纪律 / 止损后行为 / 风险，可拖动、可勾选更多）、
  范围选择（最近 5 / 10 轮、30 天、全部）、问题提示、MT4 式统计表（与 CryptoTrade analyzer 对账）、纪律审查全部表格；练习时记录决策用时。
  Stage 5b-1: per-symbol statistics & review page with a per-round progress chart, range filter, hints, MT4-style table,
  full discipline review tables, and decision-time tracking.
- 统计与审查页改版：进步曲线改为「指标卡片（最新值、对比 5 轮前、小趋势线）+ 一张大图」；统计表曲线改为累计盈亏并标出每轮起点；
  杠杆超过 50 倍贴顶显示。Redesigned progress view (metric cards + detail chart), cumulative P&L curve, leverage capped at 50x on charts.
- 第 5c 阶段：用户页「下载我的数据」——选品种和范围，下载一份 Markdown 文件（字段说明与统计口径、问题提示、MT4 式统计表、
  纪律审查、每轮进步表、每轮简报、逐笔交易、AI 提问模板），数字与统计页同一份计算。
  Stage 5c: "Download my data" exports one Markdown file per symbol and range (definitions, statistics, discipline review,
  per-round progress, round briefs, all trades, an AI prompt template), using the same numbers as the statistics page.
- 第 6 阶段：Mac 一键启动 `mac_double_click_start.command`——每次启动现场打包网页（失败时沿用上次的结果并提示）、
  后端在同一端口直接提供网页（日常只需一个程序，浏览器打开 http://127.0.0.1:8000）、自动打开浏览器；端口被占用时提示先关旧窗口；
  关窗口或 Ctrl+C 即停止。
  Stage 6: one-click macOS launcher that builds the web app, serves it from the backend on a single port and opens the browser.
- 第 5b-2 阶段：统计与审查页和「下载我的数据」的范围加「自定义日期」（按练习完成日期，含首尾两天，「一天」按设置页的显示时区）；
  新增「每 5 轮一组的对比」（每组笔数、胜率、盈亏比、利润因子、守纪律占比、违规次数、净盈亏，满两组后画各组胜率折线，未满 5 轮的组单独标出），
  导出文件也带这张表；点连续亏损段打开的 K 线图自动选周期框住整段，这几笔大箭头、标持仓编号，其他交易变浅灰。
  Stage 5b-2: custom date range for statistics and export, five-round group comparison, and losing-streak highlighting on the review chart.
- 每次交易操作后立即保存，断网时自动重试（最多 20 次）；结束本轮时按现价平仓并把交易写入数据库。
  Immediate save after each action with retries; trades written to the user database at the end of a round.
- 公开到 GitHub 的准备：MIT 许可证、简版中英文 README（介绍、免责声明、致谢）；推送前敏感字眼扫描脚本 `scripts/scan_secrets_before_push.py`（可装成 git 推送前钩子，发现个人信息、密钥、被强行加入的数据文件就拦下推送）；`.gitignore` 补齐编辑器规则目录、服务器密钥、数据库和缓存文件。
  Ready for GitHub: MIT license, short bilingual README, a pre-push secret scanner (`scripts/scan_secrets_before_push.py`, installable as a git hook) and a more complete `.gitignore`.

### 变更 / Changed
- 纪律审查：开仓后 3 根 K 线内补上止损不再算「进场没设止损」；「重仓」改为止损风险超过净值 2%（原为真实杠杆 ≥ 3 倍）；旧简报打开时按新规则重算。
  Discipline review: stop-loss grace of 3 bars; heavy position now means stop risk above 2% of equity; old briefs are recomputed.
- 下单面板记住的仓位数值按品种分开保存。Order-size inputs are remembered per symbol.
- 重仓线改为止损风险 > 10%，止损风险分四档；未满 300 根结束只确认一次；用户页高级设置常开放右侧；画线时不显示价格轴「+」。
  Heavy-position threshold 10% with four stop-risk buckets; single discard confirmation; advanced settings always visible; axis "+" hidden while drawing.
- 统计与审查页：进步曲线卡片分「结果 / 风险 / 纪律」三排；统计表照 MT4 报告排版并补绝对回撤、连赢 / 连亏金额与平均笔数。
  Statistics page: progress cards grouped into results / risk / discipline; MT4-style statistics table with absolute drawdown and streak details.

### 修复 / Fixed
- 画在右侧未来区的方框（如跨周末），走过休市时间后会缩回到休市前那根 K 线：未来区改按「往后第几根 K 线」对齐。
  Drawings placed in the future area no longer shrink back after market closures (future area now counts real upcoming bars).
- 后端同一用户大量并发请求时 SQLite 打开 / 关闭可能互相卡死：数据库访问加进程级总锁。
  Possible SQLite deadlock under bursts of concurrent requests: database access is now serialized.
