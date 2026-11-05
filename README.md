# Trading Practice Tool

[中文说明](README.zh-CN.md)

A bar-replay and manual paper-trading website for practising discretionary trading. It picks a random stretch of historical candles, replays it bar by bar, and lets you trade on the chart: market and pending orders, draggable take-profit / stop-loss lines. Fills, costs, margin and liquidation follow the public rules of Exness (gold) and Binance (crypto perpetual futures). Each round ends with a report and a trading-discipline review.

> **Status: under development.** It currently runs locally on macOS. Installation steps and a full introduction will be added with the first release.

## Disclaimer

- For practice and education only. Nothing in this project is investment advice.
- Not affiliated with Exness, Binance or TradingView; it only follows their publicly documented rules.
- This repository contains no market data. Users download it themselves with the bundled downloaders.

## Acknowledgements

- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) for the charts.
- [lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing) for the drawing tools (MIT; the source is kept with its license under `web_frontend/vendor/`).
- Historical data from the public endpoints of Dukascopy and Binance.

## License

[MIT](LICENSE)
