# -*- coding: utf-8 -*-
"""
练习轮次与用户的集成测试（规格书 5.2、5.7 节）：在临时目录里造两个月的 BTCUSDT 1m（7×24、无缺口），
走一遍：用户名规则 → 开局 → 同一用户只能有一轮 → 标签页占用 → 不满 300 根结束即丢弃 → 满 300 根完成 →
防重复记录 → 5 天自动清理 → 首页汇总 → 一键清除历史。
"""

import json
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from python_backend import backend_settings
from python_backend.market_data_downloader import download_common
from python_backend.trading_rules import kline_data as kd
from python_backend.website_server import practice_sessions as ps
from python_backend.website_server import user_database as udb

M = kd.MINUTE_MS
TF15 = 15 * M


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(backend_settings, "LOCAL_DATA_DIR", tmp_path)
    monkeypatch.setattr(backend_settings, "KLINE_DIR", tmp_path / "kline")
    monkeypatch.setattr(backend_settings, "USER_DATABASES_DIR", tmp_path / "user_databases")
    monkeypatch.setattr(backend_settings, "LOG_DIR", tmp_path / "logs")
    meta = download_common.read_meta("binance_um", "BTCUSDT")
    for key in ("2026-08", "2026-09"):
        start, end = kd.month_bounds_ms(key)
        ts = np.arange(start, end, M, dtype="int64")
        price = 60000 + np.sin(np.arange(len(ts)) / 500) * 1000
        df = pd.DataFrame({"timestamp": ts, "open": price, "high": price + 5, "low": price - 5, "close": price + 1,
                           "volume": np.ones(len(ts))})
        path = kd.month_file_path(backend_settings.KLINE_DIR, "binance_um", "BTCUSDT", key)
        kd.write_month_file(path, df, key)
        meta["months"][key] = {"status": "complete", "rows": len(df), "first_bar_utc": "", "last_bar_utc": "",
                               "sha256": download_common.file_sha256(path)}
    download_common.write_meta(meta)
    return tmp_path


def new_round(user="Test_User_01", seed=1):
    return ps.create_session(user, "BTCUSDT", "15m", None, None, np.random.default_rng(seed))


def test_username_rules():
    for bad in ("a", "x" * 21, "中文", "a-b", "../x", "", "a b"):
        with pytest.raises(udb.UsernameError):
            udb.validate_username(bad)
    assert udb.validate_username("Test_User_01") == "test_user_01"


def test_enter_user_case_insensitive(sandbox):
    first = udb.enter_user("Test_User_01")
    again = udb.enter_user("TEST_USER_01")
    assert first["is_new"] and not again["is_new"] and again["display_name"] == "Test_User_01"


def test_create_session_payload(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    start = r["session"]["segment_start_ms"]
    assert start % TF15 == 0                                       # 对齐到起始周期（D49）
    # 背景根数默认 400；引子 1m 从当前周线开盘起（D74），起点离数据开头不到 400 根 + 一周时背景会少一些，但要从数据第一天开始
    bg = r["background_bars"]
    available = len(ps.closed_bars_before(ps.market_spec("BTCUSDT"), "BTCUSDT", "15m", "utc_0", r["past_1m"][0][0] * 1000, 10_000))
    assert len(bg) == min(400, available) and len(bg) > 0
    assert r["background_bars"][-1][0] * 1000 + TF15 <= start      # 背景都在起点之前、已收盘
    assert r["future_1m"][0][0] * 1000 == start                    # 未来从起点开始
    assert len(r["future_1m"]) == 3 * 1440                         # 约 3 个交易日（7×24 品种）
    assert all(b[0] * 1000 < start for b in r["past_1m"])          # 引子 1m 都在起点之前
    # 背景与引子 1m 首尾相接：背景最后一根收盘 = 引子第一根 1m 的开盘（中间不缺 K 线）
    assert r["background_bars"][-1][0] * 1000 + TF15 == r["past_1m"][0][0] * 1000


def test_only_one_active_round_and_lease(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    with pytest.raises(ps.SessionError) as e:
        new_round()
    assert e.value.status == 409 and e.value.extra["active_session_id"] == r["session_id"]
    sid, old = r["session_id"], r["lease_token"]
    ps.save_state("test_user_01", sid, old, r["session"]["segment_start_ms"] + TF15, ["15m"], {}, [])
    new = ps.claim_session("test_user_01", sid)["lease_token"]      # 另一个标签页接管
    with pytest.raises(ps.SessionError) as e:
        ps.save_state("test_user_01", sid, old, r["session"]["segment_start_ms"] + 2 * TF15, ["15m"], {}, [])
    assert e.value.status == 409 and e.value.extra.get("lease_lost")
    ps.save_state("test_user_01", sid, new, r["session"]["segment_start_ms"] + 2 * TF15, ["5m"], {}, [])
    assert ps.get_session("test_user_01", sid)["timeframes_used"] == ["15m", "5m"]


def test_finish_before_300_discards_everything(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    start = r["session"]["segment_start_ms"]
    out = ps.finish_session("test_user_01", r["session_id"], r["lease_token"], start + 299 * TF15)
    assert out == {"result": "discarded", "bars_played": 299}
    assert ps.list_sessions("test_user_01") == []
    with udb.user_db("test_user_01") as db:
        assert db.execute("SELECT COUNT(*) FROM segments").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 0


def test_finish_after_300_completes_and_records_segment(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    start = r["session"]["segment_start_ms"]
    saved = ps.save_state("test_user_01", r["session_id"], r["lease_token"], start + 300 * TF15, ["15m"], {}, [])
    assert saved["bars_played"] == 300
    out = ps.finish_session("test_user_01", r["session_id"], r["lease_token"], start + 310 * TF15)
    assert out["result"] == "completed" and out["bars_played"] == 310
    with udb.user_db("test_user_01") as db:
        seg = db.execute("SELECT start_ms, end_ms FROM segments").fetchone()
    assert (seg["start_ms"], seg["end_ms"]) == (start, start + 310 * TF15)
    users = udb.recent_users("BTCUSDT", 20)
    assert users[0]["display_name"] == "Test_User_01" and users[0]["completed_rounds"] == 1
    # 下一轮不能和刚练过的片段重叠超过 20%
    r2 = new_round(seed=2)
    s2 = r2["session"]["segment_start_ms"]
    e2 = s2 + 300 * TF15
    inter = max(0, min(e2, start + 310 * TF15) - max(s2, start))
    assert inter / (e2 - s2) <= 0.2


def test_liquidation_counts_even_before_300(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    out = ps.finish_session("test_user_01", r["session_id"], r["lease_token"], r["session"]["segment_start_ms"] + 50 * TF15,
                            reason="liquidation")
    assert out["result"] == "completed" and out["end_reason"] == "liquidation"


def test_cleanup_after_five_days(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    start = r["session"]["segment_start_ms"]
    ps.save_state("test_user_01", r["session_id"], r["lease_token"], start + 10 * TF15, ["15m"], {}, [])
    later = datetime.now(timezone.utc) + timedelta(days=6)
    assert ps.cleanup_expired("test_user_01", later)[0]["result"] == "discarded"      # 不满 300 根：删除
    r = new_round(seed=3)
    ps.save_state("test_user_01", r["session_id"], r["lease_token"], r["session"]["segment_start_ms"] + 320 * TF15, ["15m"], {}, [])
    out = ps.cleanup_expired("test_user_01", later)
    assert out[0]["result"] == "completed" and out[0]["end_reason"] == "auto_after_days"   # 满 300 根：自动结束
    assert ps.cleanup_expired("test_user_01", datetime.now(timezone.utc)) == []


def test_resume_payload_has_no_hole(sandbox):
    """练了两天后断点续练：背景 K 线和引子 1m 之间不能缺 K 线。"""
    udb.enter_user("Test_User_01")
    r = new_round()
    now = r["session"]["segment_start_ms"] + 2 * kd.TIMEFRAME_MS["1d"] + 37 * M
    ps.save_state("test_user_01", r["session_id"], r["lease_token"], now, ["15m"], {}, [])
    p = ps.claim_session("test_user_01", r["session_id"])
    assert p["background_bars"][-1][0] * 1000 + TF15 == p["past_1m"][0][0] * 1000
    assert p["past_1m"][-1][0] * 1000 == now - M and p["future_1m"][0][0] * 1000 == now


def test_history_bars_closed_before_time(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    now = kd.month_bounds_ms("2026-09")[0] + 14 * kd.TIMEFRAME_MS["1d"] + 7 * M  # 9 月 15 日 00:07：前面有足够历史，1h/4h/1d 都在半根
    for tf in ("1h", "4h", "1d"):
        bars = ps.history_bars("test_user_01", r["session_id"], tf, now, 40)["bars"]
        assert len(bars) == 40
        assert bars[-1][0] * 1000 + kd.TIMEFRAME_MS[tf] <= now   # 只给已收盘的


def test_clear_history(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    ps.finish_session("test_user_01", r["session_id"], r["lease_token"], r["session"]["segment_start_ms"] + 300 * TF15)
    udb.delete_user_history("Test_User_01")
    assert ps.list_sessions("test_user_01") == []
    assert udb.recent_users("BTCUSDT", 20) == []


def test_new_round_creates_trading_account(sandbox):
    udb.enter_user("Test_User_01")
    r = ps.create_session("Test_User_01", "BTCUSDT", "15m", None, None, np.random.default_rng(1),
                          {"leverage": 20, "trading_balance": 2000, "funding_balance": 500})
    acc = r["session"]["state"]["account"]
    assert (acc["leverage"], acc["balance"], acc["funding"], acc["status"]) == (20, 2000, 500, "active")
    with udb.user_db("test_user_01") as db:
        assert db.execute("SELECT initial_total_assets FROM sessions").fetchone()[0] == 2500


def test_new_round_rejects_bad_account_params(sandbox):
    udb.enter_user("Test_User_01")
    for bad in ({"leverage": 200}, {"leverage": 0.5}, {"trading_balance": 0}, {"funding_balance": -1},
                {"trading_balance": 1e9}):
        with pytest.raises(ps.SessionError):
            ps.create_session("Test_User_01", "BTCUSDT", "15m", None, None, np.random.default_rng(1), bad)


def test_default_account_when_not_given(sandbox):
    udb.enter_user("Test_User_01")
    acc = new_round()["session"]["state"]["account"]
    assert (acc["leverage"], acc["balance"], acc["funding"]) == (30, 1000, 0)


def test_finish_writes_trades_and_final_assets(sandbox):
    from python_backend.trading_rules import order_fills_and_costs as of
    udb.enter_user("Test_User_01")
    r = new_round()
    start = r["session"]["segment_start_ms"]
    spec = ps.market_spec("BTCUSDT")
    acc = of.TradingAccount(r["session"]["state"]["account"], spec)
    acc.s["last_bid"] = 60000.0
    acc.place_market(1, 0.01, sl=59000)
    acc.process_bar({"t": start, "o": 60000, "h": 61000, "l": 59500, "c": 60800})
    acc.close_position(acc.s["positions"][0]["id"])
    ps.save_state("test_user_01", r["session_id"], r["lease_token"], start + 300 * TF15, ["15m"], {"account": acc.s}, [])
    ps.finish_session("test_user_01", r["session_id"], r["lease_token"], start + 300 * TF15)
    t = acc.s["trades"][0]
    with udb.user_db("test_user_01") as db:
        row = dict(db.execute("SELECT * FROM trades").fetchone())
        final = db.execute("SELECT final_total_assets FROM sessions").fetchone()[0]
    assert row["direction"] == "long" and row["pnl"] == pytest.approx(t["pnl"])
    # R = 盈亏 ÷ (|开仓价 − 止损| × 0.01)
    assert row["r_multiple"] == pytest.approx(t["pnl"] / ((t["entry_price"] - 59000) * 0.01))
    assert final == pytest.approx(acc.s["balance"])
    assert udb.recent_users("BTCUSDT", 20)[0]["total_trades"] == 1


def test_many_concurrent_requests_do_not_deadlock(sandbox):
    """2026-10-22 实测后端卡死过：同一用户同时来很多保存和读取请求时，SQLite 打开 / 关闭互相等待。加总锁后必须全部按时完成。"""
    import threading
    udb.enter_user("Test_User_01")
    r = new_round()
    start = r["session"]["segment_start_ms"]
    errors, done = [], []

    def worker(i):
        try:
            if i % 2:
                ps.save_state("test_user_01", r["session_id"], r["lease_token"], start + (i % 10 + 1) * TF15, ["15m"],
                              {"account": r["session"]["state"]["account"]}, [{"type": "t", "replay_ms": start}])
            else:
                ps.active_session("test_user_01")
                udb.recent_users("BTCUSDT", 20)
            done.append(i)
        except Exception as e:  # noqa: BLE001 —— 测试里收集任何异常
            errors.append(repr(e))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    assert not any(t.is_alive() for t in threads), "有请求 30 秒还没完成（卡死）"
    assert errors == [] and len(done) == 40


def test_drawings_saved_with_state_and_restored_on_resume(sandbox):
    """第 4b 阶段（D64）：画线随保存进度送来，断点续练（接管）时原样返回；没送画线的保存不覆盖原有画线。"""
    udb.enter_user("Test_User_01")
    r = new_round()
    sid, lease, start = r["session_id"], r["lease_token"], r["session"]["segment_start_ms"]
    assert r["drawings"] == []
    lines = [{"id": "dw_1", "kind": "horizontal-line", "points": [{"time": start // 1000, "price": 60123.5}],
              "style": {"color": "rgba(58, 109, 240, 0.50)", "width": 2, "lineStyle": "dashed", "locked": True}},
             {"id": "dw_2", "kind": "trend-line", "points": [{"time": start // 1000, "price": 1.0}, {"time": start // 1000 + 3600, "price": 2.0}],
              "style": {"color": "#3A6DF0", "width": 1, "lineStyle": "solid"}}]
    ps.save_state("test_user_01", sid, lease, start + TF15, ["15m"], {}, [], json.dumps(lines))
    ps.save_state("test_user_01", sid, lease, start + 2 * TF15, ["15m"], {}, [])          # 画线没变：不送
    resumed = ps.claim_session("test_user_01", sid)
    assert resumed["drawings"] == lines
    ps.save_state("test_user_01", sid, resumed["lease_token"], start + 3 * TF15, ["15m"], {}, [], "[]")   # 清除全部
    assert ps.claim_session("test_user_01", sid)["drawings"] == []


def test_drawings_rejected_when_bad_or_lease_lost(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    sid, old, start = r["session_id"], r["lease_token"], r["session"]["segment_start_ms"]
    for bad in ("not json", '{"a": 1}', "[1, 2]"):
        with pytest.raises(ps.SessionError) as e:
            ps.save_state("test_user_01", sid, old, start + TF15, ["15m"], {}, [], bad)
        assert e.value.status == 422
    ps.claim_session("test_user_01", sid)                                                    # 别的标签页接管
    with pytest.raises(ps.SessionError) as e:
        ps.save_state("test_user_01", sid, old, start + TF15, ["15m"], {}, [], '[{"id": "x"}]')
    assert e.value.status == 409
    assert ps.load_drawings("test_user_01", sid) == []


def test_discarded_round_deletes_drawings(sandbox):
    udb.enter_user("Test_User_01")
    r = new_round()
    sid, lease, start = r["session_id"], r["lease_token"], r["session"]["segment_start_ms"]
    ps.save_state("test_user_01", sid, lease, start + TF15, ["15m"], {}, [], '[{"id": "dw_1", "kind": "rectangle"}]')
    ps.finish_session("test_user_01", sid, lease, start + 10 * TF15)
    with udb.user_db("test_user_01") as db:
        assert db.execute("SELECT COUNT(*) FROM drawings").fetchone()[0] == 0


def test_default_background_bars_by_timeframe():
    """D86：4h、1d 默认背景 50 根，其余周期 400 根（来自 common_settings/default_settings.json）。"""
    cfg = ps.load_settings()["practice_start"]
    assert [ps.default_background_bars(cfg, tf) for tf in ("15m", "1h", "4h", "1d")] == [400, 400, 50, 50]
