# -*- coding: utf-8 -*-
"""
后端设置：项目里各个目录的位置、网站监听的地址和端口。

- 所有路径都从本文件所在位置推出来（项目相对路径），不写死任何个人电脑或服务器的路径。
- 可以用环境变量覆盖（部署到 VPS 时把数据放到别处、换端口）：
    TPT_LOCAL_DATA_DIR  数据目录（默认：项目根目录下的 local_data/）
    TPT_HOST            监听地址（默认 127.0.0.1，只允许本机访问）
    TPT_PORT            监听端口（默认 8000）
"""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

COMMON_SETTINGS_DIR = PROJECT_ROOT / "common_settings"
WEB_DIST_DIR = PROJECT_ROOT / "web_frontend" / "dist"  # 打包好的网页（npm run build 的结果），由后端直接提供
MARKET_SPECS_FILE = COMMON_SETTINGS_DIR / "market_specs.json"

LOCAL_DATA_DIR = Path(os.environ.get("TPT_LOCAL_DATA_DIR", PROJECT_ROOT / "local_data")).resolve()
KLINE_DIR = LOCAL_DATA_DIR / "kline"
USER_DATABASES_DIR = LOCAL_DATA_DIR / "user_databases"
LOG_DIR = LOCAL_DATA_DIR / "logs"

HOST = os.environ.get("TPT_HOST", "127.0.0.1")
PORT = int(os.environ.get("TPT_PORT", "8000"))
