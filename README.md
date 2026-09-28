# 105my-monitor · Orbit

能实际采集、存储和查看数据的轻量前端监控。包括异常追踪、Web Vitals、接口请求和访问会话时间线。

现有站点接入示例：**https://www.lanbinquan.top/3D/monitor/**。无需登录，任何访问者都可查看监控数据并标记问题已解决。SDK 与接收端分别位于此路径下的 `monitor.js` 和 `api/ingest`。

3Dpage 已集成 SDK：正式域名访问上报 `3Dpage / production`，版本跟随发布 SHA。本地开发不写入生产，监控异步加载，不阻塞主页；首次加载 SDK 就绪前的事件可能缺失。

## 本地运行

需要 Node.js 24 或更新版本。在本目录执行：

```powershell
npm install
npm run build
npm start
```

监控台：http://127.0.0.1:4318/ 。测试沙盒：http://127.0.0.1:4318/demo.html 。沙盒产生真实测试事件，项目名为 `sdk-playground`；初始数据库没有模拟线上数据。

修改 SDK 或界面后重新 `npm run build`。`npm run dev` 仅监听服务文件。`npm test` 执行接收服务集成测试。

## 接入 3Dpage / 其他前端

在 HTML 中、业务脚本之前添加（监控台“接入与测试”也可复制）：

```html
<script src="http://127.0.0.1:4318/monitor.js"></script>
<script>
  const monitor = PageMonitor.init({
    project: '3Dpage',
    endpoint: 'http://127.0.0.1:4318/api/ingest',
    environment: 'development',
    release: '1.0.0',
    beforeSend(event) {
      // 可按业务隐私要求返回 false 丢弃事件。
    }
  });
</script>
```

跨域时必须配置业务应用的实际 Origin，再启动采集服务：

```powershell
$env:ALLOWED_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173'
npm start
```

线上把 script 改为 `https://www.lanbinquan.top/3D/monitor/monitor.js`，endpoint 改为 `https://www.lanbinquan.top/3D/monitor/api/ingest`，并设置业务 Origin；CSP 需允许 script-src 与 connect-src。管理台“接入”会按当前地址生成完整路径。业务应用仍需主动接入 SDK，部署监控服务不会自动修改业务源码。

- React ErrorBoundary / Vue errorHandler 中手动调用 `monitor.captureException(error)`。
- `monitor.track('scene:ready', elapsedMs)` 记录自定义事件，可在会话时间线查看。
- `monitor.flush()` 尝试立即发送；`monitor.stop()` 停止采集并恢复网络和路由包装。
- 初始化每个页面只需调用一次；同一实例重复调用返回已有实例。

## 数据与运行配置

| 环境变量 | 默认 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `4318` | HTTP 端口 |
| `ALLOWED_ORIGINS` | 空 | 跨域采集允许的 Origin，逗号分隔 |
| `RETENTION_DAYS` | `30` | 数据保留天数 |
| `BASE_PATH` | 空（容器 `/3D/monitor`） | 管理页面、SDK、API 的共同前缀 |
| `PUBLIC_ORIGIN` | 空，本机请求 Host | HTTPS 反向代理后的同源判断依据 |
| `TRUST_PROXY` | `0` | 设为 `1` 后使用可信入口覆盖的 X-Real-IP 做限流 |

配置来自进程环境，不自动读取 `.env`。SQLite 文件位于 `data/monitor.sqlite`（包括 WAL 辅助文件），需备份时先停止服务。

## 自动部署

`.github/workflows/monitor-cicd.yml` 在 `master` 的监控代码变更后自动测试、构建并发布 SHA 镜像，PR 仅检查。部署脚本 `.github/deploy/monitor.sh` 只替换 `100my-page-monitor`，失败恢复旧容器，保留 `100my-page-monitor-data` 数据卷。

服务器配置 `/opt/100my-page/monitor.env` 独立保存，普通发布不覆盖。容器以非 root、只读根目录运行，不公开 4318 端口。已有 Caddy 负责 TLS，经主站 Nginx 将 `/3D/monitor/` 原路径代理到监控容器，HTTP 自动跳转 HTTPS。入口路由属于 3D workflow，后续监控业务变更无需重新构建主页。

公开采集入口 `POST /api/ingest` 不需要管理令牌。单批 1–50 条、最大 64 KiB；每来源 IP 每分钟最多 120 次。默认最多保留 100 条待发送事件，5 秒批量发送，失败指数退避；页面离开时尽力使用 Beacon 补发。客户端事件 ID 避免重试重复入库。

## 当前范围

- 捕获 JS 异常、未处理 Promise、资源失败、Fetch / XHR、History 路由、点击操作标签。
- 使用官方 web-vitals：LCP、INP、CLS、FCP、TTFB。不支持的指标保持空白；INP 需要真实交互，页面隐藏可触发更新。
- URL 去除查询和 hash，不采集正文、Cookie、输入内容、DOM。消息基础脱敏不等于覆盖所有业务隐私。
- 会话是标签页标识，不等于独立用户；Fetch 耗时截至响应头返回，XHR 耗时截至 loadend，不适合直接当作统一的后端执行时长。
- 管理台在当前筛选内最多统计最近 10000 条，截断会提示。更大规模需要服务端聚合、分页与容量规划。
- 本版没有 DOM 回放、source map 符号化、告警推送、角色管理或自动问题重开。
- 当前部署带 HTTPS 网关和网关限流；Origin 白名单不能阻止非浏览器伪造上报。仍为单机轻量方案，大规模或多租户使用需项目配额、容量规划与分布式存储。

开源调研见 [RESEARCH.md](RESEARCH.md)。

## 独立仓库部署与 SDK 包

本目录有独立 Git / 锁文件 / CI，不需要主页仓库。复制 `.env.example` 到 `.env` 并配置自己的 PUBLIC_ORIGIN、ALLOWED_ORIGINS、BASE_PATH，然后 `npm ci`、`npm run build`、`docker compose up -d --build`。数据保存在独立 monitor-data 卷；现有原站点发布继续使用 `.github` 的兼容流程。

Node 直接运行不会自动读取 `.env`；可以使用 `node --env-file=.env server.mjs`。Docker Compose 通过 env_file 读取。

`npm pack` 生成 `my-page-monitor-sdk-0.1.0.tgz`，其他项目可安装该文件并调用：

```js
import { init } from '@my-page/monitor-sdk';
const monitor = init({ project: 'my-app', endpoint: 'https://monitor.example.com/api/ingest' });
```

当前未发布 npm。也可继续用独立服务输出的 monitor.js 脚本，通过配置接入地址，无须安装包。

## GitHub 与提交历史

仓库：<https://github.com/neo-jack/webMonitor>（私有）。独立仓库主分支为 master，从整理后的项目初始提交开始维护；拆分前历史保存在本机项目归档中。CI 自动检查，只有仓库变量 `DEPLOY_ENABLED=true` 才执行镜像发布及服务器部署。npm 包发布仍单独维护。
