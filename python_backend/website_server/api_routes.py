# -*- coding: utf-8 -*-
"""
网页接口（规格书第 4 节）。第 2 阶段只做取数据相关的三个：
  GET /api/markets       品种列表及档案（来自 common_settings/market_specs.json）
  GET /api/data/status   数据概况（来自各品种的数据说明卡 meta.json，不读 K 线本身；规格书 5.9 节）
  GET /api/data/bars     按时间段取 K 线（从 1m 现场合成）：供验收和开发使用；第 3 阶段的练习会话改用
                         /api/sessions/{id}/bars，并按盲练规则控制能看到什么

保护措施：品种只认档案里有的；周期、日线起点只认固定几个值；一次最多返回 MAX_BARS_PER_REQUEST 根，
一次最多读 MAX_DAYS_PER_REQUEST 天的 1m（只打开覆盖到的月份文件），避免小内存服务器被大请求拖垮。
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Response

from python_backend import backend_settings
from python_backend.market_data_downloader import download_common
from python_backend.trading_rules import kline_data

MAX_BARS_PER_REQUEST = 20_000
MAX_DAYS_PER_REQUEST = 120

router = APIRouter(prefix="/api")


def public_specs() -> dict:
    """品种档案（去掉以下划线开头的内部说明字段）。"""
    specs = download_common.load_market_specs()
    return {sym: {k: v for k, v in spec.items() if not k.startswith("_")} for sym, spec in specs.items()}


def spec_or_404(symbol: str) -> dict:
    specs = download_common.load_market_specs()
    if symbol not in specs:
        raise HTTPException(status_code=404, detail=f"没有这个品种：{symbol}。现有：{list(specs)}")
    return specs[symbol]


@router.get("/markets", summary="品种列表及档案")
def get_markets() -> dict:
    return {"markets": public_specs()}


@router.get("/data/status", summary="数据概况（只读）")
def get_data_status() -> dict:
    out = {}
    for symbol, spec in download_common.load_market_specs().items():
        meta = download_common.read_meta(spec["data_source"], symbol)
        months = meta.get("months", {})
        out[symbol] = {
            "data_source": spec["data_source"],
            "platform": spec["platform"],
            "first_bar_utc": meta.get("first_bar_utc"),
            "last_bar_utc": meta.get("last_bar_utc"),
            "months_ok": meta.get("months_ok", 0),
            "total_rows_1m": meta.get("total_rows", 0),
            "updated_at_utc": meta.get("updated_at_utc"),
            "months": {k: {"status": v.get("status"), "rows": v.get("rows"), "warnings": v.get("warnings", [])}
                       for k, v in sorted(months.items())},
        }
    return {"symbols": out}


@router.get("/data/practice_capacity", summary="可抽数据的月数与约可练几轮不重复（按品种、起始周期、背景根数）")
def get_practice_capacity(symbol: str = Query(..., max_length=20), timeframe: str = Query(..., max_length=4),
                          background_bars: int | None = Query(None)) -> dict:
    spec = spec_or_404(symbol)
    start_cfg = practice_sessions.load_settings()["practice_start"]
    if timeframe not in start_cfg["start_timeframes"]:
        raise HTTPException(status_code=422, detail={"message": f"不支持的起始周期 {timeframe}"})
    bg_cfg = start_cfg["background_bars"]
    bg = background_bars or practice_sessions.default_background_bars(start_cfg, timeframe)
    if not bg_cfg["min"] <= bg <= bg_cfg["max"]:
        raise HTTPException(status_code=422, detail={"message": f"背景根数应在 {bg_cfg['min']}–{bg_cfg['max']} 之间"})
    try:
        out = segment_picker.practice_capacity(symbol, timeframe, spec["day_anchor"], bg)
    except (OSError, ValueError) as e:
        print(f"[可练轮数] {symbol} {timeframe} 背景 {bg} 根计算失败：{e}")
        raise HTTPException(status_code=500, detail={"message": f"可练轮数计算失败：{e}"})
    return {"symbol": symbol, "timeframe": timeframe, "background_bars": bg, **out}


@router.get("/data/bars", summary="按时间段取 K 线（1m 现场合成）")
def get_bars(
    symbol: str = Query(..., description="品种，如 XAUUSD、BTCUSDT"),
    timeframe: str = Query("15m", description=f"周期：{', '.join(kline_data.TIMEFRAMES)}"),
    start: date = Query(..., description="开始日期（UTC，含），如 2026-09-01"),
    end: date = Query(..., description="结束日期（UTC，不含），如 2026-09-08"),
    day_anchor: str | None = Query(None, description="日线起点 utc_0 / ny_17，不填用品种档案的默认值"),
) -> dict:
    spec = spec_or_404(symbol)
    if timeframe not in kline_data.TIMEFRAME_MS:
        raise HTTPException(status_code=422, detail=f"不支持的周期 {timeframe}，可选 {kline_data.TIMEFRAMES}")
    anchor = day_anchor or spec["day_anchor"]
    if anchor not in kline_data.DAY_ANCHORS:
        raise HTTPException(status_code=422, detail=f"不支持的日线起点 {anchor}，可选 {list(kline_data.DAY_ANCHORS)}")
    if end <= start:
        raise HTTPException(status_code=422, detail="结束日期必须晚于开始日期")
    if (end - start) > timedelta(days=MAX_DAYS_PER_REQUEST):
        raise HTTPException(status_code=422, detail=f"一次最多取 {MAX_DAYS_PER_REQUEST} 天")
    start_ms = int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp() * 1000)
    end_ms = int(datetime(end.year, end.month, end.day, tzinfo=timezone.utc).timestamp() * 1000)
    df_1m = kline_data.read_1m_range(backend_settings.KLINE_DIR, spec["data_source"], symbol, start_ms, end_ms)
    bars = kline_data.synthesize(df_1m, timeframe, anchor, spec.get("week_start", "monday"))
    if len(bars) > MAX_BARS_PER_REQUEST:
        raise HTTPException(status_code=422, detail=f"结果有 {len(bars)} 根，超过上限 {MAX_BARS_PER_REQUEST}，请缩短时间段或换大周期")
    precision = spec["price_precision"]
    return {
        "symbol": symbol, "timeframe": timeframe, "day_anchor": anchor,
        "start_utc": start.isoformat(), "end_utc_exclusive": end.isoformat(), "count": int(len(bars)),
        "bars": [
            {"time": int(r.timestamp // 1000), "open": round(r.open, precision), "high": round(r.high, precision),
             "low": round(r.low, precision), "close": round(r.close, precision), "volume": round(r.volume, 6),
             "minute_count": int(r.minute_count)}
            for r in bars.itertuples(index=False)
        ],
    }


# ============================================================
# 用户与练习轮次（第 3 阶段）
# 路径里带用户名（第一版没有密码，规格书 5.7 节）；用户名一律先校验再使用。
# ============================================================

from pydantic import BaseModel, Field  # noqa: E402

from python_backend.website_server import practice_sessions, review_statistics, segment_picker, session_finish, user_database  # noqa: E402
from python_backend.website_server.practice_sessions import SessionError  # noqa: E402


def _call(fn, *args, **kwargs):
    """把业务错误统一转成带中文原因的 HTTP 错误。"""
    try:
        return fn(*args, **kwargs)
    except user_database.UsernameError as e:
        raise HTTPException(status_code=422, detail={"message": str(e)})
    except SessionError as e:
        raise HTTPException(status_code=e.status, detail={"message": str(e), **e.extra})


def _known_user(name: str) -> str:
    key = _call(user_database.validate_username, name)
    if not user_database.user_exists(key):
        raise HTTPException(status_code=404, detail={"message": f"没有这个用户：{name}"})
    return key


class EnterUserBody(BaseModel):
    username: str = Field(..., max_length=40)


class ClearHistoryBody(BaseModel):
    confirm_username: str = Field(..., max_length=40, description="再输入一次自己的用户名，确认清除")


class NewSessionBody(BaseModel):
    symbol: str = Field(..., max_length=20)
    start_timeframe: str = Field("15m", max_length=4)
    background_bars: int | None = None
    day_anchor: str | None = Field(None, max_length=8)
    leverage: float | None = None
    trading_balance: float | None = None
    funding_balance: float | None = None


class SaveStateBody(BaseModel):
    lease_token: str = Field(..., max_length=64)
    replay_ms: int
    timeframes_used: list[str] = Field(default_factory=list, max_length=10)
    state: dict = Field(default_factory=dict)
    events: list[dict] = Field(default_factory=list, max_length=500)
    drawings: str | None = Field(None, max_length=1_000_000, description="画线有改动时送整份 JSON 列表；不送 = 没变")


class FinishBody(BaseModel):
    lease_token: str = Field(..., max_length=64)
    replay_ms: int
    reason: str = Field("normal", max_length=20)
    final_total_assets: float | None = None


@router.post("/users", summary="输入用户名进入（不存在就新建）")
def post_user(body: EnterUserBody) -> dict:
    return _call(user_database.enter_user, body.username)


@router.get("/users", summary="某品种的最近练习用户列表")
def get_users(symbol: str = Query(..., max_length=20), limit: int | None = Query(None, ge=1, le=200)) -> dict:
    spec_or_404(symbol)
    n = limit or user_database.load_user_rules()["recent_users_shown"]
    return {"symbol": symbol, "users": user_database.recent_users(symbol, n),
            "few_trades_threshold": user_database.load_user_rules()["few_trades_threshold"]}


@router.get("/users/{name}", summary="用户概况：显示名、进行中的一轮、设置")
def get_user(name: str) -> dict:
    key = _known_user(name)
    _call(practice_sessions.cleanup_expired, key)
    active = practice_sessions.active_session(key)
    return {"username": key, "display_name": user_database.display_name(key), "active_session": active,
            "settings": user_database.get_settings(key)}


@router.put("/users/{name}/settings", summary="保存用户设置（上次的选择等）")
def put_user_settings(name: str, values: dict) -> dict:
    key = _known_user(name)
    if len(json.dumps(values)) > 20_000:
        raise HTTPException(status_code=413, detail={"message": "设置内容过大"})
    return {"settings": user_database.put_settings(key, values)}


@router.delete("/users/{name}/history", summary="一键清除自己的全部练习历史（含防重复记录）")
def delete_user_history(name: str, body: ClearHistoryBody) -> dict:
    key = _known_user(name)
    if body.confirm_username.lower() != key:
        raise HTTPException(status_code=422, detail={"message": "确认用的用户名不一致，未清除"})
    user_database.delete_user_history(key)
    return {"cleared": True}


@router.get("/users/{name}/sessions", summary="历史练习列表")
def get_user_sessions(name: str) -> dict:
    key = _known_user(name)
    states = _call(session_finish.report_states, key)
    return {"sessions": [{**s, "report_status": states.get(s["id"])} for s in _call(practice_sessions.list_sessions, key)]}


@router.post("/users/{name}/sessions", summary="开新一轮：服务器抽片段，返回初始 K 线")
def post_session(name: str, body: NewSessionBody) -> dict:
    key = _known_user(name)
    account = {"leverage": body.leverage, "trading_balance": body.trading_balance, "funding_balance": body.funding_balance}
    return _call(practice_sessions.create_session, key, body.symbol, body.start_timeframe, body.background_bars, body.day_anchor,
                 None, {k: v for k, v in account.items() if v is not None})


@router.post("/users/{name}/sessions/{session_id}/claim", summary="在本页继续这一轮（接管，旧标签页变只读）")
def post_claim(name: str, session_id: str) -> dict:
    return _call(practice_sessions.claim_session, _known_user(name), session_id)


@router.get("/users/{name}/sessions/{session_id}/history_bars", summary="某周期在某时刻之前已收盘的 K 线")
def get_history_bars(name: str, session_id: str, timeframe: str, end_ms: int, count: int = Query(500, ge=1, le=2000)) -> dict:
    return _call(practice_sessions.history_bars, _known_user(name), session_id, timeframe, end_ms, count)


@router.get("/users/{name}/sessions/{session_id}/future", summary="下一段 1m（约 3 个交易日）")
def get_future(name: str, session_id: str, from_ms: int) -> dict:
    return _call(practice_sessions.future_bars, _known_user(name), session_id, from_ms)


@router.post("/users/{name}/sessions/{session_id}/state", summary="保存进度")
def post_state(name: str, session_id: str, body: SaveStateBody) -> dict:
    if len(json.dumps(body.state)) > 2_000_000:
        raise HTTPException(status_code=413, detail={"message": "保存内容过大"})
    return _call(practice_sessions.save_state, _known_user(name), session_id, body.lease_token, body.replay_ms,
                 body.timeframes_used, body.state, body.events, body.drawings)


@router.post("/users/{name}/sessions/{session_id}/finish", summary="结束本轮（不满 300 根则丢弃）")
def post_finish(name: str, session_id: str, body: FinishBody) -> dict:
    key = _known_user(name)
    result = _call(practice_sessions.finish_session, key, session_id, body.lease_token, body.replay_ms,
                   body.reason, body.final_total_assets)
    if result.get("result") == "completed":
        # 第 5a 阶段：本轮记录已存好（第 ① 步），接着排队做服务器复算和简报；不能生成（旧轮次）时只记日志、不影响结束
        try:
            result["report"] = session_finish.request_report(key, session_id)
        except SessionError as e:
            result["report"] = {"status": "unavailable", "error": str(e)}
    return result


@router.get("/users/{name}/sessions/{session_id}/report", summary="单轮简报：进度和结果")
def get_report(name: str, session_id: str) -> dict:
    return _call(session_finish.report_status, _known_user(name), session_id)


@router.get("/users/{name}/statistics", summary="统计与审查：进步曲线、范围统计表、纪律审查、问题提示（按品种）")
def get_statistics(name: str, symbol: str = Query(..., max_length=20), range: str = Query("last5", max_length=10),  # noqa: A002
                   start: str | None = Query(None, max_length=10), end: str | None = Query(None, max_length=10)) -> dict:
    """range = custom 时用 start / end（YYYY-MM-DD，按该用户设置页的显示时区，含首尾两天；第 5b-2 阶段，D71）"""
    return _call(review_statistics.statistics_page, _known_user(name), symbol, range, start=start, end=end)


@router.get("/users/{name}/export", summary="下载我的数据：某品种、某范围的练习记录（Markdown 文件）")
def get_export(name: str, symbol: str = Query(..., max_length=20), range: str = Query("all", max_length=10),  # noqa: A002
               start: str | None = Query(None, max_length=10), end: str | None = Query(None, max_length=10)) -> Response:
    filename, text = _call(review_statistics.export_markdown, _known_user(name), symbol, range, start=start, end=end)
    return Response(content=text.encode("utf-8"), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.post("/users/{name}/sessions/{session_id}/report", summary="（重新）生成单轮简报")
def post_report(name: str, session_id: str) -> dict:
    return _call(session_finish.request_report, _known_user(name), session_id)
