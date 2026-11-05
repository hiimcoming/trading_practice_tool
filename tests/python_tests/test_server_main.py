# -*- coding: utf-8 -*-
"""
后端直接提供打包好的网页（第 6 阶段，D70）：有 web_frontend/dist/index.html 就返回网页，没有就返回「先打包」的提示；
接口仍在 /api 下、优先于网页文件。
"""

from python_backend import backend_settings
from python_backend.website_server import server_main


def test_index_page_serves_built_web_or_hint(tmp_path, monkeypatch):
    monkeypatch.setattr(backend_settings, "WEB_DIST_DIR", tmp_path)
    res = server_main.index_page()
    assert res.status_code == 503 and "还没打包" in res.body.decode("utf-8")
    (tmp_path / "index.html").write_text("<title>K 线回放练习</title>", encoding="utf-8")
    res = server_main.index_page()
    assert res.status_code == 200 and "K 线回放练习" in res.body.decode("utf-8")


def test_api_routes_come_before_web_files():
    from starlette.routing import Mount

    routes = server_main.app.routes
    assert isinstance(routes[-1], Mount)                     # 网页文件挂在最后，兜底
    assert server_main.app.url_path_for("get_export", name="x") == "/api/users/x/export"
    assert server_main.app.url_path_for("get_markets") == "/api/markets"
