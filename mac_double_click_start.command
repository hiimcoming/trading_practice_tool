#!/bin/bash
# K 线回放练习工具 · Mac 一键启动（双击本文件；或拖进终端按回车）。
# 会打开一个终端窗口：自动打包网页 → 启动后端 → 打开浏览器 http://127.0.0.1:8000 。
# 停止：关掉这个终端窗口，或按 Ctrl+C。真正干活的程序是 scripts/start_local_server.py。
cd "$(dirname "$0")" || exit 1
if [ ! -x ".venv/bin/python" ]; then
  echo "[启动] 没找到项目的 Python 环境（.venv）。请先按说明完成安装。"
  read -r -p "按回车键关闭……"
  exit 1
fi
exec .venv/bin/python scripts/start_local_server.py
