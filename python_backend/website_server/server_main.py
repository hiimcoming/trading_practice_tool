# -*- coding: utf-8 -*-
"""
网站后端程序入口（FastAPI + uvicorn）。

运行（项目根目录）：.venv/bin/python -m python_backend.website_server.server_main
启动后：接口说明页 http://127.0.0.1:8000/docs （地址和端口可用环境变量 TPT_HOST / TPT_PORT 覆盖，见 backend_settings）。
接口都在 /api 下（api_routes）；其余地址提供打包好的网页（web_frontend/dist，第 6 阶段起，规格书第 4 节「一个程序，一个端口」），
所以日常使用只开这一个程序，浏览器打开 http://127.0.0.1:8000 即可。网页还没打包时首页显示一句提示。
日常启动用根目录的 mac_double_click_start.command（scripts/start_local_server.py 会先打包网页再启动本程序）；
开发时仍可另开 Vite 开发服务器（5173），它把 /api 转给这里。
"""

from __future__ import annotations

import logging

import uvicorn
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from python_backend import backend_settings
from python_backend.website_server import api_routes

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
logger = logging.getLogger("server")

app = FastAPI(
    title="K 线回放练习工具 · 后端接口",
    description="取品种档案、数据概况和 K 线。时间一律 UTC；K 线的 time 为开盘时刻（UTC 秒）。",
    version="0.0.0",
)
app.include_router(api_routes.router)


@app.get("/", include_in_schema=False, response_model=None)
def index_page():
    """首页：有打包好的网页就给网页，没有就提示先打包（其余静态文件由下面的 StaticFiles 提供）。"""
    index = backend_settings.WEB_DIST_DIR / "index.html"
    if index.is_file():
        return HTMLResponse(index.read_text(encoding="utf-8"), headers={"Cache-Control": "no-cache"})
    return HTMLResponse("<p>网页还没打包。请用根目录的 mac_double_click_start.command 启动（会自动打包），"
                        "或在项目根目录运行 npm --prefix web_frontend run build。</p>", status_code=503)


# 必须放在所有接口之后：先匹配 /api，剩下的地址才当成网页文件。check_dir=False：启动后重新打包也能照常提供
app.mount("/", StaticFiles(directory=backend_settings.WEB_DIST_DIR, html=True, check_dir=False), name="web")


def main() -> None:
    logger.info(f"[启动] 后端监听 http://{backend_settings.HOST}:{backend_settings.PORT}，数据目录 {backend_settings.KLINE_DIR}")
    if not (backend_settings.WEB_DIST_DIR / "index.html").is_file():
        logger.warning("[启动] 没找到打包好的网页（web_frontend/dist），首页只会显示提示；接口照常可用")
    uvicorn.run(app, host=backend_settings.HOST, port=backend_settings.PORT, log_level="info")


if __name__ == "__main__":
    main()
