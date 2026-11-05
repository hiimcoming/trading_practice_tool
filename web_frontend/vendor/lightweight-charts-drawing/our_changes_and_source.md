# 画线库 B：来源与本项目改动记录

本目录是 [deepentropy/lightweight-charts-drawing](https://github.com/deepentropy/lightweight-charts-drawing) 的源码副本（MIT 许可证，原文见同目录 `LICENSE`）。
按规格书 D23：复制进项目后由我们自己维护，**不跟随上游自动更新**；上游以后有值得要的改进，人工挑选合并，并在下表登记。

## 来源

| 项目 | 值 |
|---|---|
| 上游版本 | 0.6.2（2026-10-15 发布） |
| 上游提交号 | `0291d9c7373e3795373c915a3a64f4f663b5a0db` |
| 复制日期 | 2026-10-20 |
| 复制内容 | `src/`、`test/`、`LICENSE`、`CHANGELOG.md`、`README.md`（未复制演示页 `demo/`、文档 `docs/`、上游构建配置） |

## 接入方式

- `web_frontend/vite.config.ts` 和 `tsconfig.json` 把包名 `lightweight-charts-drawing` 指向本目录的 `src/index.ts`，业务代码照常写 `import ... from 'lightweight-charts-drawing'`。
- `vite.config.ts` 定义了上游构建时注入的常量 `__VERSION__`（值为 `0.6.2-vendored`）。
- 上游自带的单元测试随项目一起跑：在 `web_frontend` 里运行 `npm test`。

## 本项目改动（每改一处登记一行）

| 日期 | 文件 | 改了什么 | 为什么 |
|---|---|---|---|
| 2026-10-20 | `src/runtime/manager.ts` | `DrawingManagerOptions` 新增可选项 `future`（交易日历），构造时传给 `makeCoords` 的第 6 个参数 | 上游 0.6.2 只在底层 `makeCoords` 支持交易日历，`DrawingManager` 没接进来，右侧未来区按中位间隔推算，跨周末会落到不交易的时刻。不传 `future` 时行为与上游完全相同 |
