# -*- coding: utf-8 -*-
"""
第 5a 阶段：结束本轮后的服务器复算与单轮简报（规格书 7.1、15.5、15.6 节）。
用 test_practice_sessions 的临时数据（BTCUSDT 两个月的正弦行情）模拟浏览器练完一轮：
逐根 1m 推进、在两根之间做操作并记事件（回放时刻 = 下一根开盘），结束时把账户随进度保存——和练习页的做法相同。
然后检查：服务器复算的每笔交易与「浏览器」一致；故意做的违规（进场没设止损〔超过 3 根宽限才补〕、往不利方向挪止损、止损后马上再开仓、重仓〔止损风险 > 10%〕）
都出现在违规清单里；浏览器结果被改动时简报标出「不一致」；排队任务能走完并留下简报；旧轮次（没有交易账户）给出原因。
"""

import json
import time

import pytest

from python_backend import backend_settings
from python_backend.trading_rules import kline_data as kd
from python_backend.trading_rules import order_fills_and_costs as of
from python_backend.website_server import practice_sessions as ps
from python_backend.website_server import session_finish as sf
from python_backend.website_server import user_database as udb
from tests.python_tests.test_practice_sessions import TF15, new_round, sandbox  # noqa: F401  （sandbox 是 pytest 夹具）

USER = "test_user_01"


def play_round(r: dict, plan: dict, n_bars: int) -> dict:
    """像浏览器一样练一轮：plan = {第几根 1m 之前: [操作函数(账户) -> 动作字典]}；返回结束后的账户。"""
    sid, lease, start = r["session_id"], r["lease_token"], r["session"]["segment_start_ms"]
    spec = ps.market_spec("BTCUSDT")
    ev = next(e for e in _events(sid) if e["type"] == "session_start")["payload"]
    acc = of.TradingAccount(of.new_account_state("BTCUSDT", ev["leverage"], ev["trading_balance"], ev["funding_balance"], start), spec)
    acc.s["last_bid"] = sf._initial_bid(spec, "BTCUSDT", start)
    bars = kd.read_1m_range(backend_settings.KLINE_DIR, spec["data_source"], "BTCUSDT", start, start + n_bars * kd.MINUTE_MS)
    events = []
    for i, b in enumerate(bars.itertuples()):
        t = int(b.timestamp)
        for make in plan.get(i, []):
            action = make(acc)
            decision = action.pop("_decision_ms", None)   # 浏览器把决策用时记在事件上（第 5b 阶段）
            returned = of.apply_action(acc, action)
            payload = {"action": action, "order_id": returned}
            if decision is not None:
                payload["decision_ms"] = decision
            events.append({"type": "trade_action", "replay_ms": t, "payload": payload})
        acc.process_bar({"t": t, "o": b.open, "h": b.high, "l": b.low, "c": b.close})
    end = start + len(bars) * kd.MINUTE_MS
    close_all = {"op": "close_all"}
    of.apply_action(acc, close_all)
    events.append({"type": "trade_action", "replay_ms": end, "payload": {"action": close_all}})
    ps.save_state(USER, sid, lease, end, ["15m"], {"account": acc.s}, events)
    assert ps.finish_session(USER, sid, lease, end)["result"] == "completed"
    return acc.s


def _events(sid: str) -> list[dict]:
    with udb.user_db(USER) as db:
        return [{"type": r["type"], "payload": json.loads(r["payload"])}
                for r in db.execute("SELECT type, payload FROM events WHERE session_id = ? ORDER BY id", (sid,))]


def pid0(acc):
    return acc.s["positions"][0]["id"]


PLAN = {
    # 1m 序号；起始周期 15m，第 0–14 根 1m 是第 0 根 15m
    0: [lambda a: {"op": "market", "direction": 1, "qty": 0.01, "sl": None, "tp": None}],                      # 第 1 笔：没设止损
    70: [lambda a: {"op": "set_stops", "position_id": pid0(a), "sl": a.s["last_bid"] - 200, "tp": None}],       # 第 4 根 15m 才补，超过 3 根宽限
    80: [lambda a: {"op": "set_stops", "position_id": pid0(a), "sl": a.s["last_bid"] - 600, "tp": None}],       # 往不利方向挪
    90: [lambda a: {"op": "close", "position_id": pid0(a), "qty": None}],
    100: [lambda a: {"op": "market", "direction": -1, "qty": 0.05, "sl": a.s["last_bid"] + 1.5, "tp": None}],   # 第 2 笔：下一根就被止损
    110: [lambda a: {"op": "market", "direction": 1, "qty": 0.4, "sl": a.s["last_bid"] - 300, "tp": None}],     # 第 3 笔：止损后马上再开；止损风险约 12%（重仓）
    130: [lambda a: {"op": "close", "position_id": pid0(a), "qty": None}],
}


def test_server_recompute_matches_browser_and_lists_violations(sandbox):  # noqa: F811
    udb.enter_user("Test_User_01")
    browser = play_round(new_round(), PLAN, 310 * 15)
    sid = ps.list_sessions(USER)[0]["id"]
    report = sf.generate_report(USER, sid)
    assert report["check"] == {"consistent": True, "differences": []}
    server = {t["position_id"]: t for t in report["trades"]}
    assert len(report["trades"]) == len(browser["trades"]) == 3
    for t in browser["trades"]:
        s = server[t["position_id"]]
        assert (s["close_ms"], s["close_reason"]) == (t["close_ms"], t["close_reason"])
        assert s["pnl"] == pytest.approx(t["pnl"], abs=1e-9)
    assert report["trades"][1]["close_reason"] in ("stop", "gap_stop")
    kinds = {(v["no"], v["kind"]) for v in report["violations"]}
    assert {(1, "no_stop_at_entry"), (1, "stop_moved_against"), (3, "quick_reentry")} <= kinds
    # 重仓 = 止损风险 > 10%（D72、D73）：第 2 笔 0.05 BTC 止损 1.5 美元远，约 0.2%，不算；第 3 笔 0.4 BTC 止损 300 美元远，约 12%，算
    f = report["facts"]
    assert f[1]["open_stop_risk"] < 0.1 and (2, "heavy_position") not in kinds
    assert f[2]["open_stop_risk"] > 0.1 and (3, "heavy_position") in kinds

    b = report["basics"]
    assert b["trades"] == 3 and b["net_pnl"] == pytest.approx(sum(t["pnl"] for t in browser["trades"]))
    assert b["cost_total"] == pytest.approx(sum(t["spread_cost"] + t["slippage_cost"] + t["fees"] for t in browser["trades"]))
    eq = report["equity"]
    assert eq["final_total"] == pytest.approx(browser["balance"] + browser["funding"])
    assert eq["points"][0][1] == pytest.approx(eq["initial_total"]) and eq["max_drawdown"] >= 0
    with udb.user_db(USER) as db:   # trades 表改写成服务器结果
        assert db.execute("SELECT COUNT(*) FROM trades WHERE session_id = ?", (sid,)).fetchone()[0] == 3


def test_stop_set_within_grace_is_not_a_violation(sandbox):  # noqa: F811
    """开仓后 3 根起始周期 K 线内补上止损不算「进场没设止损」，止损风险按补上那一刻算（D72）。
    第 0 根 1m 下单（第 1 根 1m 成交，属第 0 根 15m）；第 40 根 1m（第 2 根 15m）补止损 → 隔 2 根，在宽限内。"""
    udb.enter_user("Test_User_01")
    plan = dict(PLAN)
    plan[70] = [lambda a: {"op": "set_stops", "position_id": pid0(a), "sl": a.s["last_bid"] - 200, "tp": None}]
    plan[40] = plan.pop(70)
    play_round(new_round(), plan, 310 * 15)
    sid = ps.list_sessions(USER)[0]["id"]
    report = sf.generate_report(USER, sid)
    f1 = report["facts"][0]
    assert f1["sl_at_entry"] and f1["sl_set_bars"] == 2
    assert f1["open_stop_risk"] is not None and f1["open_stop_risk"] > 0
    kinds = {(v["no"], v["kind"]) for v in report["violations"]}
    assert (1, "no_stop_at_entry") not in kinds and (1, "stop_moved_against") in kinds



def test_leverage_change_is_replayed_by_server(sandbox):  # noqa: F811
    """改杠杆（D72）记进事件日志，服务器复算照样重放：空仓时 30 → 10 倍开仓、平仓后改 50 倍再开，结果与浏览器逐笔一致；
    持仓中改杠杆被拒（浏览器同样会拒，这里直接验证规则）。"""
    udb.enter_user("Test_User_01")
    plan = {
        0: [lambda a: {"op": "set_leverage", "leverage": 10},
            lambda a: {"op": "market", "direction": 1, "qty": 0.05, "sl": a.s["last_bid"] - 500, "tp": None}],
        30: [lambda a: {"op": "close", "position_id": pid0(a), "qty": None},
             lambda a: {"op": "set_leverage", "leverage": 50},
             lambda a: {"op": "market", "direction": -1, "qty": 0.05, "sl": a.s["last_bid"] + 500, "tp": None}],
        60: [lambda a: {"op": "close", "position_id": pid0(a), "qty": None}],
    }
    browser = play_round(new_round(), plan, 310 * 15)
    assert browser["leverage"] == 50
    sid = ps.list_sessions(USER)[0]["id"]
    r = sf.recompute(USER, sid)
    assert r["differences"] == [] and r["account"]["leverage"] == 50 and len(r["account"]["trades"]) == 2
    # 开仓那一刻的保证金占用 = 名义价值 ÷ 杠杆 ÷ 净值：第 1 笔按 10 倍、第 2 笔按 50 倍，所以占用比 ≈ 真实杠杆 ÷ 杠杆（保证金按开仓价、真实杠杆按现价，差千分之一以内）
    op = r["recorder"].open
    first, second = sorted(op)
    assert op[first]["margin_usage"] == pytest.approx(op[first]["leverage"] / 10, rel=1e-3)
    assert op[second]["margin_usage"] == pytest.approx(op[second]["leverage"] / 50, rel=1e-3)
    acc = of.TradingAccount(of.new_account_state("BTCUSDT", 30, 1000, 0, 0), ps.market_spec("BTCUSDT"))
    acc.s["positions"].append({"id": 1})
    with pytest.raises(of.TradingRuleError) as e:
        acc.set_leverage(20)
    assert e.value.code == "leverage_busy"

def test_mismatch_is_flagged(sandbox):  # noqa: F811
    udb.enter_user("Test_User_01")
    play_round(new_round(), PLAN, 310 * 15)
    sid = ps.list_sessions(USER)[0]["id"]
    with udb.user_db(USER) as db:   # 假装浏览器算错了一笔
        st = json.loads(db.execute("SELECT state FROM sessions WHERE id = ?", (sid,)).fetchone()["state"])
        st["account"]["trades"][0]["pnl"] += 5
        db.execute("UPDATE sessions SET state = ? WHERE id = ?", (json.dumps(st), sid))
    report = sf.generate_report(USER, sid)
    assert report["check"]["consistent"] is False
    assert any("盈亏" in d for d in report["check"]["differences"])


def test_queue_produces_report_and_rejects_old_rounds(sandbox):  # noqa: F811
    udb.enter_user("Test_User_01")
    play_round(new_round(), PLAN, 310 * 15)
    sid = ps.list_sessions(USER)[0]["id"]
    st = sf.request_report(USER, sid)
    assert st["status"] in ("queued", "running", "done") and st["steps"] == sf.STEPS
    for _ in range(100):
        st = sf.report_status(USER, sid)
        if st["status"] in ("done", "failed"):
            break
        time.sleep(0.1)
    assert st["status"] == "done" and st["report"]["basics"]["trades"] == 3
    assert sf.report_states(USER) == {sid: "done"}
    with udb.user_db(USER) as db:   # 模拟第 4 阶段之前的旧轮次：没有交易账户
        db.execute("UPDATE sessions SET state = '{}' WHERE id = ?", (sid,))
    with pytest.raises(ps.SessionError) as e:
        sf.request_report(USER, sid)
    assert e.value.status == 422
