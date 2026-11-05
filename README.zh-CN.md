# K 线回放练习工具

[English](README.md)

一个 K 线回放 + 手动模拟交易的练习网站：随机抽一段历史行情，逐根回放，在图上手动下单（市价单、挂单、拖动止盈止损线）。成交、成本、保证金和强平按 Exness（黄金）和币安（加密货币永续合约）的公开规则模拟；每轮结束给出报告和交易纪律审查。

> **状态：开发中。** 目前可在 macOS 本地运行；安装步骤和完整介绍将在第一个正式版本时补上。

## 免责声明

- 仅供练习和学习，不构成任何投资建议。
- 与 Exness、币安、TradingView 无任何关联，仅参照其公开规则。
- 本仓库不包含任何行情数据，用户用自带的下载器自行下载。

## 致谢

- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)：图表。
- [lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing)：画线工具（MIT 许可证；源码连同其许可证保存在 `web_frontend/vendor/`）。
- 历史行情来自 Dukascopy 和币安的公开接口。

## 许可证

[MIT](LICENSE)
