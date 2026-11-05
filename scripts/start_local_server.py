# -*- coding: utf-8 -*-
"""
本地一键启动（第 6 阶段，D70；只支持 Mac）。平时双击根目录的 mac_double_click_start.command，它会调用本程序。

每次启动按顺序做四件事：
  1. 检查端口（默认 8000）有没有被占用：占用了说明已有一个在运行（可能是旧代码），提示先关掉那个窗口，然后退出；
     不替用户结束别的进程，也不连到旧的那个。
  2. 现场打包网页（npm run build，约 1 秒）：先打包到临时目录 web_frontend/dist_building，成功后再换掉 dist，
     所以打包失败时不会弄坏上一次的结果——提示失败原因，并继续用上一次成功打包的网页启动；从来没打包成功过才退出。
  3. 启动后端（同一个程序同时提供网页和接口：一个程序、一个端口）。
  4. 后端能连上后自动打开浏览器（装了 Chrome 就用 Chrome，否则用系统默认浏览器）访问 http://127.0.0.1:8000 。
停止：关掉这个终端窗口，或按 Ctrl+C。程序在终端窗口里前台运行，窗口关掉时系统会结束它，不留后台进程。

也可以在项目根目录直接运行：.venv/bin/python scripts/start_local_server.py [--no-browser]
（--no-browser：不自动打开浏览器；端口等可用环境变量 TPT_PORT / TPT_HOST 覆盖，见 backend_settings）
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))  # 直接运行本文件时也能 import python_backend

from python_backend import backend_settings  # noqa: E402

WEB_DIR = PROJECT_ROOT / "web_frontend"
BUILDING_DIR_NAME = "dist_building"
# 双击启动时终端的命令路径可能不全：补上 Homebrew（Apple 芯片 / Intel）常见的 Node 安装位置
EXTRA_PATHS = ["/opt/homebrew/bin", "/usr/local/bin"]
CHROME_APP = Path("/Applications/Google Chrome.app")


def say(text: str) -> None:
    print(f"[启动] {text}", flush=True)


def port_in_use(host: str, port: int) -> bool:
    """能连上就说明已有程序在监听这个端口。"""
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def find_npm() -> str | None:
    path = os.environ.get("PATH", "")
    for extra in EXTRA_PATHS:
        if extra not in path.split(os.pathsep):
            path = f"{path}{os.pathsep}{extra}" if path else extra
    os.environ["PATH"] = path  # npm 内部还要找 node，同样需要
    return shutil.which("npm")


def build_web() -> bool:
    """打包网页到临时目录，成功后替换 dist。返回是否打包成功。"""
    npm = find_npm()
    if npm is None:
        say("没找到 npm（Node），无法打包网页。")
        return False
    building = WEB_DIR / BUILDING_DIR_NAME
    shutil.rmtree(building, ignore_errors=True)
    say("正在打包网页……")
    started = time.monotonic()
    try:
        result = subprocess.run([npm, "--prefix", str(WEB_DIR), "run", "build", "--", "--outDir", BUILDING_DIR_NAME],
                                cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as e:
        say(f"打包没能运行：{e}")
        return False
    if result.returncode != 0 or not (building / "index.html").is_file():
        say("打包失败，原因如下（最后 30 行）：")
        print("\n".join((result.stdout + result.stderr).strip().splitlines()[-30:]), flush=True)
        shutil.rmtree(building, ignore_errors=True)
        return False
    try:
        dist = backend_settings.WEB_DIST_DIR
        shutil.rmtree(dist, ignore_errors=True)
        building.rename(dist)
    except OSError as e:
        say(f"打包成功，但替换网页文件失败：{e}")
        return False
    say(f"网页打包完成（{time.monotonic() - started:.1f} 秒）")
    return True


def open_browser_when_ready(url: str, host: str, port: int) -> None:
    """后台等后端能连上（最多 60 秒）再打开浏览器。"""
    for _ in range(240):
        if port_in_use(host, port):
            break
        time.sleep(0.25)
    else:
        say("后端 60 秒内没有启动成功，没有打开浏览器；请看上面的报错。")
        return
    try:
        if CHROME_APP.exists():
            subprocess.run(["open", "-a", str(CHROME_APP), url], check=False)
        else:
            webbrowser.open(url)
        say(f"已打开浏览器：{url}　（停止：关掉这个窗口，或按 Ctrl+C）")
    except OSError as e:
        say(f"没能自动打开浏览器（{e}），请手动访问 {url}")


def wait_enter_and_exit(code: int) -> None:
    """出错退出前停一下，让双击打开的窗口不至于一闪而过、看不到原因。"""
    try:
        input("按回车键关闭……")
    except (EOFError, KeyboardInterrupt):
        pass
    sys.exit(code)


def main() -> None:
    os.chdir(PROJECT_ROOT)
    host, port = backend_settings.HOST, backend_settings.PORT
    url = f"http://{host}:{port}"
    if port_in_use(host, port):
        say(f"端口 {port} 已被占用：已经有一个练习系统（或别的程序）在运行。")
        say("请先关掉之前运行它的那个终端窗口（或在那里按 Ctrl+C），再重新双击启动。")
        wait_enter_and_exit(1)
    if not build_web():
        if (backend_settings.WEB_DIST_DIR / "index.html").is_file():
            say("先用上一次成功打包的网页启动（可能不是最新的界面）。")
        else:
            say("也没有以前打包好的网页，无法启动。")
            wait_enter_and_exit(1)
    if "--no-browser" not in sys.argv:
        threading.Thread(target=open_browser_when_ready, args=(url, host, port), daemon=True).start()
    from python_backend.website_server import server_main  # 打包之后再加载后端（启动日志紧接在后面）

    server_main.main()
    say("已停止。")


if __name__ == "__main__":
    main()
