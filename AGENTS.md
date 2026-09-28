## 105my-monitor / Orbit

独立的轻量前端监控项目：浏览器 SDK、Node.js HTTP 接收服务、SQLite 存储和原生 JavaScript 管理界面。本目录是独立 Git 仓库，可独立构建部署。

**Important:** 默认只监听本机；按用户要求公开数据读取和问题处理，无登录校验；历史 `ADMIN_TOKEN` 配置不再生效。采集入口是公开写入端，Origin 白名单不是身份认证，部署保留反向代理 HTTPS、网关限流及脱敏。不得提交 `data/` 或令牌。

### Important files

- `sdk.js` — 浏览器采集和上报；官方 `web-vitals` 提供性能指标。SDK 不依赖管理界面。
- `server.mjs` — 批量校验、脱敏、事件 ID 去重、SQLite 持久化、筛选与问题状态。
- `index.html`、`app.js`、`style.css` — 原生管理界面，所有统计来自接收的事件。
- `favicon.svg` — 管理台和采集测试页共用的绿色监控波形标签页图标；HTML 使用相对路径，构建复制到 `dist/`，服务静态白名单以 `image/svg+xml` 返回。
- `demo.html` — 主动触发真实测试事件，固定标记为 `sdk-playground / development`。
- `build.mjs` — 构建 IIFE SDK 并将界面复制到 `dist/`。
- `test/server.test.mjs` — 接收、脱敏、授权、校验、持久化集成测试。
- `test/chart.test.mjs` — 趋势图时间范围、分组粒度、日期标签与范围外事件回归测试。
- `README.md`、`RESEARCH.md` — 运行、接入、边界和开源参考结论。
- `Dockerfile`、`.dockerignore` — 只打包服务与构建产物，内置 SQLite 不安装运行时依赖，非 root 运行。
- `.github/workflows/monitor-cicd.yml`、`.github/deploy/monitor.sh` — 独立自动部署，配置与回滚边界见上层部署说明。

### Implementation notes

- 独立 3D 主页 已集成生产 SDK，按自身配置上报项目 `3Dpage`、环境 `production`、版本为发布 SHA；本地页面默认不上报生产。SDK 与主页独立发布，保持全局 `PageMonitor.init` 接口兼容。

- Node.js >= 24，使用内置 `node:sqlite`；首次运行 `npm install`，随后 `npm run build`、`npm start`。默认地址 `http://127.0.0.1:4318`。
- `npm run dev` 只监听服务端变化，不编译浏览器文件；修改界面或 SDK 后重新执行 `npm run build`。
- 验证使用 `npm test`、`npm run build`，浏览器 `/demo.html` 验证捕获到展示的链路。
- `HOST`、`PORT`、`ALLOWED_ORIGINS`、`RETENTION_DAYS`、`BASE_PATH`、`PUBLIC_ORIGIN`、`TRUST_PROXY` 从进程环境读取，不自动加载 `.env`。
- 生产入口 `/3D/monitor/`；服务保留此前缀，HTML、SDK 测试页和管理 API 使用相对路径。裸前缀 308 补斜杠，根 `/healthz` 仅为容器健康探测。`PUBLIC_ORIGIN` 用于代理后同源校验，不依赖被代理的 HTTP scheme。
- `TRUST_PROXY=1` 仅供不暴露端口的容器使用；仅信任入口覆盖的 X-Real-IP 计数，不直接相信外部客户端的转发头。
- 页面参考 Codeground 的紧凑工作区：只保留导航、筛选、数据和必要操作，无品牌横幅、宣传标题、重复说明或底栏。正常连接仅小圆点及 tooltip；错误与截断仍明确显示。接入细则收在折叠项，沙盒入口保留。
- 数据默认保留 30 天，每小时清理；界面一次最多统计最近 10000 条事件，超过时明确提示截断。
- 趋势图跟随时间筛选：1 小时按 5 分钟、24 小时按小时、7 天和 30 天按天分组；跨日范围横轴显示月日，短范围显示时分。范围外事件不计入首尾分组。
- 趋势图按浏览器本地时区显示；测试固定本地日历时间，不用带东八区偏移的时间戳断言所有运行环境均显示相同小时。修改日期标签后分别以 `TZ=UTC` 和 `TZ=Asia/Shanghai` 运行 `npm test`。
- 不读取 Cookie、表单值、DOM 快照、请求正文；URL 删除查询和 hash，消息做基础邮箱及凭据关键词脱敏。业务自定义消息仍应在 `beforeSend` 中自行检查，返回 false 丢弃事件。
- SDK 有界队列、指数退避，离开页面尽力上报，不保证零丢失。停止后恢复自己包装的接口；web-vitals 已注册观察者不能完整卸载，但回调会忽略停止实例。
- 会话指标签页 sessionStorage 标识；时间线不等于 DOM 会话回放。指标按 project/session/metricId 去重后计算 P75。
- 错误分组按项目、类型、消息、首个栈帧；标记解决不会自动重开，尚无 source map 还原、通知、账号多租户及分布式存储。

- package.json 主入口导出 sdk.js，可 npm pack 后独立安装；不将服务端或数据库打入 SDK 包。compose.yaml 与 .env.example 提供独立部署，不依赖主页网络。

- GitHub 远程为 `neo-jack/webMonitor`，私有仓库、master 主分支；主分支以独立项目初始提交重建，旧历史保存在本机归档。上传默认仅 CI，部署需仓库变量 DEPLOY_ENABLED=true。
