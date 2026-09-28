# 前端监控源码调研

2026-09-21 实际浅克隆到 `all-project/.github/前端监控/`，未执行上游项目的安装、同步或发布脚本。此实现自行编写，性能计算使用正式 npm 依赖 web-vitals。

| 项目 | 阅读入口 | 借鉴设计 | 许可 |
| --- | --- | --- | --- |
| [Sentry JavaScript](https://github.com/getsentry/sentry-javascript) | `packages/browser/src/integrations/globalhandlers.ts`、`transports/fetch.ts` | 分开处理全局异常与 Promise 拒绝；使用原始 fetch 发送；关注 keepalive 大小上限 | MIT |
| [web-vitals](https://github.com/GoogleChrome/web-vitals) | `README.md`、`src/onINP.ts` | 使用标准指标、处理页面隐藏、按 metric ID 更新；不把简单平均耗时叫做 INP | Apache-2.0 |
| [Mito](https://github.com/mitojs/mitojs) | `packages/browser/src/plugins/fetch.ts`、`browserTransport.ts` | SDK 采集与传输分离，排除自身上报地址，保留业务网络成功/失败语义 | MIT |

## 本项目的选择

链路：浏览器 SDK → 批量 POST → 校验、脱敏、去重 → SQLite → 管理界面。

1. 错误包含堆栈、页面、版本、环境、会话和最近 15 条操作线索。使用消息与首栈帧分组，避免一次异常一行淹没后台。
2. 网络包装原样返回业务 Response，异常继续抛出，不读取响应体。没有沿用学习示例中全量记录请求/响应正文的做法。
3. LCP/INP/CLS 直接使用 web-vitals，不复制其复杂的生命周期计算；多次回调按 ID 取最新值后计算 P75。
4. SQLite 能在本机保留数据且不依赖额外服务，适合当前独立小项目。大量事件需要数据库与查询架构升级。
5. 展示会话事件时间线，不引入 rrweb/DOM 录制，保持第一版体积、存储和隐私范围可控。

## 后续适合扩展的方向

服务端分组统计与分页、正式身份认证与项目写入配额、发布版本与 source map 上传、告警规则、采样策略、可选且有用户授权的 rrweb 回放。当前版本不把这些规划表述为已实现。
