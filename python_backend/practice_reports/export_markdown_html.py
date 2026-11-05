# -*- coding: utf-8 -*-
"""
「下载我的数据」（规格书 5.10 节，第 5c 阶段，D70）：把一个用户在某个品种、某个范围内的练习记录写成一份 Markdown 文件。
目的是自己看，或整份交给 AI 分析；只出人和 AI 都能直接读的文字和表格，不含原始事件日志和 K 线数据，导出后不能再导入。
（D40 原定另出一份带净值曲线的 HTML，用户 2026-10-24 定第一版只出 Markdown，HTML 以后再做；文件名保留以便将来加。）

文件内容的顺序：
  ① 说明：数据是什么、统计口径（规格书 15.1 节、D68）、交易明细各列的含义；
  ② 总览：问题提示、MT4 式统计表、纪律审查各表（与「统计与审查」页同一份计算、同样的写法）；
  ③ 每轮一行的进步表（取代已取消的「每 5 轮阶段报告」，D68），后接每 5 轮一组的对比表（第 5b-2 阶段，D71；含全部轮次，不受范围影响）；
  ④ 每一轮的简报：揭晓信息、基本数字、出入金、违规清单、连续亏损段；
  ⑤ 全部交易明细（每笔一行）；
  ⑥ 可以直接复制给 AI 的提问模板。
输入全部是现成的字典（website_server/review_statistics.py 汇总好的统计页数据和各轮简报），这里只负责排版；
按架构铁律不碰数据库、不依赖项目内其他目录。
"""

from __future__ import annotations

import math
from datetime import datetime, timezone

END_REASON_TEXT = {"normal": "正常结束", "liquidation": "强平结束", "latest_data": "播到最新数据", "auto_after_days": "5 天后自动结束"}
CLOSE_REASON_TEXT = {"manual": "手动平仓", "stop": "止损", "gap_stop": "跳空止损", "tp": "止盈", "gap_tp": "跳空止盈",
                     "liquidation": "强平", "end_of_round": "结束本轮"}
ENTRY_TYPE_TEXT = {"market": "市价", "limit": "限价挂单", "stop": "止损挂单"}
TRANSFER_TEXT = {"to_trading": "资金账户 → 交易账户", "to_funding": "交易账户 → 资金账户"}

AI_PROMPT = """请根据以上我的模拟交易练习数据，帮我做一次复盘：
1. 指出我最主要的 3 个问题，每个问题都引用具体的数字（哪一轮、第几笔、胜率或金额）作为依据；
2. 对每个问题给出具体、可执行的改进建议（例如「止损后至少等 N 根 K 线再开仓」），不要泛泛而谈；
3. 说出我做得好、应该保持的 1–2 个习惯；
4. 如果样本太少、不足以下结论，请直接说明，不要强行总结。"""


# ============================================================
# 数字的写法（与网页一致：金额 2 位小数带千分位，占比按统计页的位数）
# ============================================================

def _none(x) -> bool:
    return x is None or (isinstance(x, float) and math.isnan(x))


def currency_of(spec: dict) -> str:
    """金额的货币写法（D72）：Exness 黄金账户是美元，写成 $1,234.56；币安 U 本位账户是 USDT，写成 1,234.56 USDT。"""
    return "USDT" if spec.get("platform") == "binance" else "$"


def money(x, cur: str = "") -> str:
    """金额：千分位 + 2 位小数；cur = "$" 放在数字前（不空格），其他（USDT）空一格放在数字后，空串不带货币。"""
    if _none(x):
        return "—"
    v = f"{x:,.2f}"
    return f"${v}" if cur == "$" else f"{v} {cur}" if cur else v


def signed_money(x, cur: str = "") -> str:
    if _none(x):
        return "—"
    return f"{'+' if x > 0 else '−' if x < 0 else ''}{money(abs(x), cur)}"


def p0(x) -> str:
    return "—" if _none(x) else f"{x * 100:.0f}%"


def p1(x) -> str:
    return "—" if _none(x) else f"{x * 100:.1f}%"


def p2(x) -> str:
    return "—" if _none(x) else f"{'+' if x > 0 else ''}{x * 100:.2f}%"


def n1(x, unit: str = "") -> str:
    return "—" if _none(x) else f"{x:.1f}{unit}"


def n2(x, unit: str = "") -> str:
    return "—" if _none(x) else f"{x:.2f}{unit}"


def rr(x) -> str:
    return "—" if _none(x) else f"{'+' if x > 0 else ''}{x:.2f}R"


def utc(ms) -> str:
    return "—" if _none(ms) else datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M")


def quote(x, precision: int) -> str:
    return "—" if _none(x) else f"{x:,.{precision}f}"


def qty_text(q: float, step: float) -> str:
    decimals = max(0, math.ceil(-math.log10(step) - 1e-9))
    return f"{q:.{decimals}f}"


def _cell(x) -> str:
    return str(x).replace("|", "\\|").replace("\n", "<br>")


def table(headers: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(_cell(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def kv_table(rows: list[tuple[str, str]]) -> str:
    return table(["项目", "数值"], [list(r) for r in rows])


# ============================================================
# ① 说明
# ============================================================

def _intro(spec: dict, settings: dict) -> str:
    cfg = settings["discipline_review"]
    sessions = "、".join(f"{name} {lo:02d}–{hi:02d}" for lo, hi, name in cfg["sessions_utc"])
    if spec["cost"]["model"] == "spread":
        rule = (f"按 Exness 规则模拟：1 手 = {spec['contract_size']:g} 单位，固定点差 {spec['cost']['spread']:g}，"
                f"滑点 {spec['slippage']['value']:g}，净值 ≤ 0 时强平。")
    else:
        rule = "按币安 U 本位永续规则模拟：挂单 / 吃单手续费、滑点，维持保证金率强平。"
    return f"""## 一、说明（请先读这一节）

- **数据是什么**：K 线回放 + 手动模拟交易的练习记录。每一轮从历史行情中随机抽一段，逐根回放，练习者手动下单；
  每轮都从初始资金重新开始，轮与轮之间资金不连续。{rule}
- **数字来源**：每轮结束后由服务器按操作记录重新计算一遍（以服务器结果为准）。时间一律 UTC。
- **不包含**：原始操作日志、K 线数据。
- **统计口径**：
  - 一笔交易 = 一个持仓从开仓到全部平掉（部分平仓不单独算一笔）；编号「第 N 笔」= 该轮第 N 个开出的持仓。
  - 盈利单 = 盈亏 > 0；盈亏 ≤ 0 都算亏损单。胜率 = 盈利笔数 ÷ 总笔数。
  - 盈亏比 = 平均盈利 ÷ 平均亏损；利润因子 = 总盈利 ÷ 总亏损。
  - R = 盈亏 ÷ 第一次设止损时的风险（|开仓价 − 止损价| × 数量）；没设过止损的交易没有 R。
    计划 R =（止盈 − 进场）÷（进场 − 止损），开仓时两者都设了才有。
  - 真实杠杆 = 全部持仓的名义价值 ÷ 交易账户净值。
  - 止损风险 = 所有持仓的止损都被打到时的亏损 ÷ 交易账户净值，按设上止损那一刻计算；止损风险 > {cfg['heavy_stop_risk'] * 100:g}% 算重仓
    （没按时设止损的交易记为「进场没设止损」，不算重仓）。实际止损占权益 = 止损出场的亏损 ÷ 止损触发前一刻的交易账户净值。
  - 进场设了止损 = 成交时就带止损，或开仓后 {cfg['stop_grace_bars']} 根 K 线内补上。
  - 守纪律的交易 = 同时满足：进场设了止损、没往不利方向挪或取消止损、不是止损后 {cfg['quick_reentry_bars']} 根 K 线内再开仓、
    不是重仓、不是亏损后放大仓位。
  - K 线根数按该轮的起始周期计；「止损后隔几根再开仓」中同一根 K 线算 0 根。
  - 时段按进场时刻（UTC 固定）：{sessions}。
  - 连续亏损段 = 一轮之内连续亏损 ≥ {cfg['loss_streak_min']} 笔（含手动认亏），不跨轮。
  - 累计盈亏 = 把所选各轮的逐笔盈亏首尾相接、从 0 开始；它不是账户净值（每轮都重新开始），最大回撤按它计算。
  - 进步表里的胜率、盈亏比、守纪律占比、平均 R 按「截至该轮的最近 {cfg['rolling_trades']} 笔」计算，其余按该轮自己的数。
  - 交易笔数少于 {cfg['sample_small_trades']} 笔时样本少，比率仅供参考。
- **交易明细各列**：轮 = 该品种第几轮；笔 = 该轮第几笔；进场方式 = 市价 / 限价挂单 / 止损挂单；
  初始止损 = 第一次设的止损价；平仓时止损 / 止盈 = 平仓那一刻挂着的止损止盈价；交易成本 = 点差 + 滑点 + 手续费；
  开仓杠杆、开仓止损风险 = 这笔成交那一刻整个账户的数；决策用时 = 从那根 K 线出现到下单的前台操作时间；「—」= 没有这个数。
"""


# ============================================================
# ② 总览
# ============================================================

def _stats_table(s: dict, cur: str) -> str:
    def dd_ratio(r, capital):
        if _none(r):
            return "—"
        return f"相当于单轮初始资金 {money(capital, cur)} 的 {r * 100:.1f}%" if r < 1 else f"约 {r:.1f} 个单轮初始资金（{money(capital, cur)}）"

    def streak(x):
        return f"{x['count']} 笔（{signed_money(x['amount'], cur)}）"

    def amount_first(x):
        return f"{signed_money(x['amount'], cur)}（{x['count']} 笔）"

    def share(k):
        return p0(k / s["trades"]) if s["trades"] else "—"

    worst = s["worst_round_drawdown"]
    # 照 MT4 测试报告的排版（D73）：三列「名称 | 数值」；行首的「最大 / 平均 / 最多」管这一行后两格
    rows = [
        ["总盈利", money(s["gross_profit"], cur), "总亏损", signed_money(s["gross_loss"], cur), "净盈亏", signed_money(s["net_pnl"], cur)],
        ["利润因子", n2(s["profit_factor"]), "期望收益（平均每笔）", signed_money(s["avg_pnl"], cur), "交易成本合计", money(s["cost_total"], cur)],
        ["绝对回撤", money(s.get("absolute_drawdown"), cur),
         "最大回撤", f"{money(s['max_drawdown'], cur)}（{dd_ratio(s['max_drawdown_of_round_capital'], s['round_capital'])}）", "", ""],
        ["交易总笔数", s["trades"], "做空（胜率）", f"{s['shorts']}（{p0(s['short_win_rate'])}）", "做多（胜率）", f"{s['longs']}（{p0(s['long_win_rate'])}）"],
        ["", "", "盈利交易（占总数）", f"{s['wins']}（{p0(s['win_rate'])}）", "亏损交易（占总数）", f"{s['losses']}（{share(s['losses'])}）"],
        ["最大", "", "盈利交易", signed_money(s["largest_win"], cur), "亏损交易", signed_money(s["largest_loss"], cur)],
        ["平均", "", "盈利交易", signed_money(s["avg_win"], cur), "亏损交易", signed_money(s["avg_loss"], cur)],
        ["最多", "", "连续盈利笔数（金额）", streak(s["longest_win_streak"]), "连续亏损笔数（金额）", streak(s["longest_loss_streak"])],
        ["最大", "", "连续盈利金额（笔数）", amount_first(s["max_win_streak_amount"]), "连续亏损金额（笔数）", amount_first(s["max_loss_streak_amount"])],
        ["平均", "", "连续盈利笔数", n1(s["avg_win_streak"]), "连续亏损笔数", n1(s["avg_loss_streak"])],
    ]
    return (table(["项目", "数值", "项目", "数值", "项目", "数值"], rows)
            + "\n\n绝对回撤 = 累计盈亏最低跌到 0 以下多少（没跌破为 0）；各轮都从初始资金重开，所以不算 MT4 的「相对回撤」。\n\n**补充**\n\n"
            + kv_table([
                ("时间段", "<br>".join(f"#{p['round_no']} {p['start_utc']} → {p['end_utc']}" for p in s["periods"]) or "—"),
                ("合计经历", f"{s['days']} 天 · {s['bars']} 根 K 线（{s['rounds']} 轮）"),
                ("盈亏比（平均盈利 ÷ 平均亏损）", n2(s["payoff_ratio"])),
                ("最严重一轮的回撤", f"{p1(worst['pct'])}（第 {worst['round_no']} 轮，按该轮总资产算）" if worst else "—"),
            ]))


def _rows(rows: list, extra=None) -> str:
    rows = [r for r in rows if r is not None]
    headers = ["项目", "笔数", "占比", "胜率", "平均 R"] + (["说明"] if extra else [])
    body = [[r["label"], r["count"], p0(r["share"]), p0(r["win_rate"]), rr(r["avg_r"])] + ([extra(r)] if extra else []) for r in rows]
    return table(headers, body)


def _streak_line(s: dict, cur: str) -> str:
    total_r = f"（{rr(s['total_r'])}）" if s["total_r"] is not None else ""
    return (f"- 第 {s['round_no']} 轮 第 {'、'.join(map(str, s['nos']))} 笔：连亏 {s['count']} 笔，跨 {s['span_bars']} 根 K 线，"
            f"之间隔 {' / '.join(map(str, s['gaps_bars']))} 根，手数{'变大过' if s['size_up'] else '没变大'}，"
            f"合计 {signed_money(s['total_pnl'], cur)}{total_r}，时段 {'、'.join(s['sessions'])}")


def _review(rv: dict, settings: dict, cur: str) -> str:
    cfg = settings["discipline_review"]
    r = rv["risk"]
    moved = rv["stops"][4]
    out = [f"### 纪律审查\n\n全部交易胜率 {p0(rv['overall_win_rate'])}（{rv['trades']} 笔）。每组都和它对照。"
           + ("**样本少，仅供参考。**" if rv["sample_small"] else "")]
    out.append("#### 止损止盈\n\n" + _rows(rv["stops"], lambda x: f"共 {x['times']} 次" if "times" in x else ""))
    if moved.get("compare"):
        c = moved["compare"]
        out.append(f"对比：从没往不利方向挪过止损的 {c['count']} 笔，胜率 {p0(c['win_rate'])}、平均 {rr(c['avg_r'])}。")
    gaps = [dict(g, label=f"止损后隔 {g['label']}再开仓") for g in rv["after_stop"]["gaps"]]
    out.append("#### 止损后行为\n\n" + _rows(gaps, lambda x: f"真实时间中位数 {x['median_minutes']:.0f} 分钟" if x.get("median_minutes") is not None else "")
               + "\n\n" + _rows([rv["after_stop"]["quick_reentry"], rv["after_stop"]["size_up_after_loss"]]))
    ls = rv["loss_streaks"]
    lines = [_streak_line(s, cur) for s in ls["items"]]
    out.append(f"#### 连续亏损（≥ {cfg['loss_streak_min']} 笔，一轮之内）\n\n" + (f"共 {ls['count']} 段，最长 {ls['longest']} 笔。\n\n" + "\n".join(lines) if ls["count"] else "没有。"))
    out.append("#### 进场方式\n\n" + _rows(rv["entry_types"]))
    fq = rv["frequency"]
    out.append(f"#### 交易频率\n\n平均每 100 根 K 线开 {n1(fq['trades_per_100_bars'])} 笔。"
               + ("\n\n" + _rows([fq["busiest"], fq["others"]]) if fq["busiest"] else ""))
    pl = rv["plan"]
    out.append(f"#### 计划执行\n\n开仓时同时设了止损和止盈的 {pl['with_plan']} 笔：计划 R 平均 {rr(pl['planned_r_avg'])}，"
               f"实际 R 平均 {rr(pl['actual_r_avg'])}。\n\n" + _rows([pl["cut_winners"]]))
    out.append(f"#### 持仓\n\n盈利单平均持仓 {n1(rv['holding']['win_bars'], ' 根')}，亏损单平均持仓 {n1(rv['holding']['loss_bars'], ' 根')}。")
    out.append("#### 时段（UTC）和方向\n\n" + _rows(rv["sessions"] + rv["directions"]))
    sp, pv = r["stop_pct"], r["planned_vs_actual_stop"]
    ml = r["max_leverage"]
    out.append("#### 资金使用与风险\n\n" + kv_table([
        ("最高真实杠杆", f"{ml['value']:.1f} 倍（第 {ml['round_no']} 轮第 {ml['no']} 笔，{utc(ml['ms'])}）" if ml else "—"),
        ("持仓期间平均真实杠杆", n1(r["avg_leverage_holding"], " 倍")),
        ("持仓时间占全程", p0(r["holding_time_share"])),
        ("最小强平距离", p1(r["min_liq_distance"])),
        ("止损风险最大值", p1(r["max_stop_risk"]) + (f"（另有 {r['stop_unlimited_trades']} 笔持仓中出现过没设止损 = 无上限）" if r["stop_unlimited_trades"] else "")),
        ("实际止损占权益", f"{p1(sp['min'])}–{p1(sp['max'])}，中位数 {p1(sp['median'])}，中间一半在 {p1(sp['q1'])}–{p1(sp['q3'])}（{sp['count']} 次止损）" if sp else "—"),
        ("计划止损风险 vs 实际", f"开仓时计划 {p1(pv['planned_avg'])}，实际 {p1(pv['actual_avg'])}" if pv["count"] else "—"),
        ("每轮实际止损占权益（中位数）", " · ".join(f"#{x['round_no']} {p1(x['median'])}" for x in r["stop_pct_by_round"]) or "—"),
    ]) + "\n\n" + _rows([dict(x, label=f"开仓时真实杠杆 {x['label']}") for x in r["leverage_buckets"]])
        + "\n\n" + _rows([x if x["label"] == "未设止损" else dict(x, label=f"开仓时止损风险 {x['label']}") for x in r["stop_risk_buckets"]])
        + "\n\n" + _rows([r["heavy"], r["not_heavy"], r["passive"]]))
    out.append("#### 决策用时（从 K 线出现到下单）\n\n" + _rows(rv["decision"]))
    return "\n\n".join(out)


def _overview(page: dict, settings: dict, cur: str) -> str:
    hints = page["hints"]
    hint_text = "\n".join(f"- {h}" for h in hints) if hints else f"没有发现明显的问题（样本少于 {settings['discipline_review']['hint_min_samples']} 笔的项目不提示）。"
    return ("## 二、总览\n\n### 问题提示\n\n" + hint_text + "\n\n### 统计表（MT4 式）\n\n" + _stats_table(page["stats"], cur)
            + "\n\n" + _review(page["review"], settings, cur))


# ============================================================
# ③ 每轮进步表
# ============================================================

def _progress(page: dict, cur: str) -> str:
    chosen = set(page["range_rounds"])
    w = page["progress"]["rolling_trades"]
    rows = []
    for p in page["progress"]["points"]:
        if p["round_no"] not in chosen:
            continue
        v = sum(p["violations"].values()) if p["violations"] else None
        rows.append([p["round_no"], p["trades"], f"{p0(p['win_rate'])}{'（样本少）' if p['sample_small'] else ''}", n2(p["payoff_ratio"]),
                     p0(p["disciplined_share"]), rr(p["avg_r"]), "—" if v is None else v, "—" if p["longest_loss_run"] is None else p["longest_loss_run"],
                     n1(p["after_stop_bars_median"], " 根"), n1(p["max_leverage"], " 倍"), p1(p["stop_pct_median"]),
                     n1(p["trades_per_100_bars"]), p2(p["return"]), p1(p["max_drawdown_pct"])])
    return (f"## 三、每轮进步表\n\n胜率、盈亏比、守纪律占比、平均 R = 截至该轮的最近 {w} 笔；其余为该轮自己的数。\n\n"
            + table(["轮", "笔数", "胜率", "盈亏比", "守纪律占比", "平均 R", "违规次数", "最长连亏", "止损后再开仓间隔（中位数）",
                     "最高真实杠杆", "实际止损占权益（中位数）", "每 100 根开仓", "收益率", "最大回撤"], rows)
            + "\n\n" + _groups(page, cur))


def _groups(page: dict, cur: str) -> str:
    """每 5 轮一组的对比（D71）：和统计页同一份数字；不受导出范围影响，列出该品种全部轮次的分组。"""
    size = page["group_size"]
    rows = [[f"第 {g['first']}–{g['last']} 轮" + ("" if g["complete"] else f"（未满 {size} 轮，已有 {len(g['round_nos'])} 轮）"),
             g["trades"], p0(g["win_rate"]), n2(g["payoff_ratio"]), n2(g["profit_factor"]), p0(g["disciplined_share"]),
             g["violations"], signed_money(g["net_pnl"], cur)] for g in page["groups"]]
    return (f"### 每 {size} 轮一组的对比\n\n按该品种的第几轮分组，含全部已完成轮次（不受上面的导出范围影响）；各组的数只用组内的交易算。\n\n"
            + table(["组", "笔数", "胜率", "盈亏比", "利润因子", "守纪律占比", "违规次数", "净盈亏"], rows))


# ============================================================
# ④ 每轮简报
# ============================================================

def _round(b: dict, cur: str) -> str:
    rv, eq, bs = b["reveal"], b["equity"], b["basics"]
    ret = (eq["final_total"] - eq["initial_total"]) / eq["initial_total"] if eq.get("initial_total") else None
    minutes = rv.get("real_minutes")
    lines = [f"### 第 {b['round_no']} 轮（{rv['start_utc']} → {rv['end_utc']} UTC）", "", kv_table([
        ("起始周期 / 经历", f"{rv['start_timeframe']} · {rv['days']} 天 · {rv['bars_played']} 根 K 线"),
        ("从开局到结束（真实时间）", "—" if minutes is None else f"{minutes // 60} 小时 {minutes % 60} 分"),
        ("结束方式", END_REASON_TEXT.get(rv["end_reason"], rv["end_reason"] or "—")),
        ("总资产", f"{money(eq['initial_total'], cur)} → {money(eq['final_total'], cur)}（收益率 {p2(ret)}）"),
        ("本轮最大回撤", f"{money(eq['max_drawdown'], cur)}（{p1(eq['max_drawdown_pct'])}）"),
        ("交易笔数（盈利 / 亏损）", f"{bs['trades']}（{bs['wins']} / {bs['losses']}）"),
        ("净盈亏", signed_money(bs["net_pnl"], cur)),
        ("交易成本（点差 / 滑点 / 手续费）", f"{money(bs['cost_total'], cur)}（{money(bs['spread_cost'], cur)} / {money(bs['slippage_cost'], cur)} / {money(bs['fees'], cur)}）"),
        ("强平次数", str(bs["liquidations"])),
        ("出入金", "；".join(f"{utc(t.get('ms'))} {TRANSFER_TEXT.get(t.get('direction'), t.get('direction', ''))} {money(t.get('amount'), cur)}" for t in bs["transfers"]) or "无"),
    ])]
    lines += ["", "**纪律违规**：" + ("无" if not b["violations"] else ""), *[f"- {v['text']}" for v in b["violations"]]]
    streaks = (b.get("summary") or {}).get("loss_streaks") or []
    if streaks:
        lines += ["", "**连续亏损段**："] + [f"- 第 {'、'.join(map(str, s['nos']))} 笔连亏 {s['count']} 笔，合计 {signed_money(s['total_pnl'], cur)}" for s in streaks]
    if not b["check"]["consistent"]:
        lines += ["", "**注意**：服务器复算与浏览器记录有差异（以服务器为准）：" + "；".join(b["check"]["differences"])]
    return "\n".join(lines)


# ============================================================
# ⑤ 交易明细
# ============================================================

def _trades(briefs: list[dict], facts_by_round: dict, spec: dict) -> str:
    prec, step = spec["price_precision"], spec["qty_step"]
    cur = currency_of(spec)
    rows = []
    for b in briefs:
        facts = {f["position_id"]: f for f in facts_by_round.get(b["round_no"], [])}
        for t in b["trades"]:
            f = facts.get(t["position_id"], {})
            reason = CLOSE_REASON_TEXT.get(t["close_reason"], t["close_reason"]) + (f"（分 {t['exits']} 次）" if t.get("exits", 0) > 1 else "")
            dec = t.get("decision_ms")
            rows.append([b["round_no"], t["no"], utc(t["open_ms"]), utc(t["close_ms"]), "多" if t["direction"] == 1 else "空",
                         qty_text(t["qty"], step), ENTRY_TYPE_TEXT.get(f.get("entry_type"), t["source"]),
                         quote(t["entry_price"], prec), quote(t["exit_price"], prec), money(t["initial_sl"]), money(t["sl_at_close"]),
                         money(t["tp_at_close"]), reason, signed_money(t["pnl"]), money(t["cost"]), rr(t["r"]), rr(f.get("planned_r")),
                         n1(f.get("open_leverage"), " 倍"), p1(f.get("open_stop_risk")) if f.get("sl_at_entry") else "未设止损",
                         f.get("hold_bars", "—"), f.get("session", "—"), "—" if dec is None else f"{dec / 1000:.0f} 秒",
                         "是" if f.get("disciplined") else "否"])
    return "## 五、交易明细\n\n" + table(
        ["轮", "笔", "开仓（UTC）", "平仓（UTC）", "方向", "手数" if spec.get("qty_unit", "手") == "手" else f"数量（{spec['qty_unit']}）", "进场方式", "进场价", "出场价", "初始止损", "平仓时止损", "平仓时止盈",
         "出场原因", f"盈亏（{cur}）", f"交易成本（{cur}）", "R", "计划 R", "开仓杠杆", "开仓止损风险", "持仓根数", "时段", "决策用时", "守纪律"], rows)


# ============================================================
# 汇总
# ============================================================

def render_markdown(display_name: str, spec: dict, page: dict, briefs: list[dict], facts_by_round: dict,
                    settings: dict, now: datetime) -> str:
    """整份 Markdown 文件。page = 统计页数据（review_statistics），briefs = 范围内各轮的简报（带 round_no）。"""
    rounds = page["range_rounds"]
    head = (f"# 练习记录：{display_name} · {spec.get('display_name', page['symbol'])}\n\n"
            f"- 导出时间：{now.strftime('%Y-%m-%d %H:%M')} UTC\n"
            f"- 范围：{page['range_label']}（第 {rounds[0]}–{rounds[-1]} 轮，共 {len(rounds)} 轮、{page['stats']['trades']} 笔交易；"
            f"该品种累计完成 {page['rounds_total']} 轮）\n" if rounds else
            f"# 练习记录：{display_name} · {spec.get('display_name', page['symbol'])}\n\n"
            f"- 导出时间：{now.strftime('%Y-%m-%d %H:%M')} UTC\n- 范围：{page['range_label']}（没有已完成的轮次）\n")
    if not rounds:
        return head + "\n" + _intro(spec, settings)
    cur = currency_of(spec)
    parts = [head, _intro(spec, settings), _overview(page, settings, cur), _progress(page, cur),
             "## 四、每轮简报\n\n" + "\n\n".join(_round(b, cur) for b in briefs),
             _trades(briefs, facts_by_round, spec),
             "## 六、给 AI 的提问模板（可直接复制）\n\n```\n" + AI_PROMPT + "\n```"]
    return "\n\n".join(parts) + "\n"
