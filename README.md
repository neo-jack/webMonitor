# webMonitor

使用 Node.js 和 SQLite 构建的轻量前端监控，包括浏览器 SDK、事件接收服务与管理台，支持异常记录、Web Vitals、接口请求和会话时间线。

业务项目配置采集地址并接入 SDK，即可在管理台查看数据。

## 在线体验

[打开前端监控管理台](https://www.lanbinquan.top/3D/monitor/)

当前管理台无需登录，可查看数据和标记问题处理状态。

## 快速开始

使用 Node.js 24 或更新版本。

```bash
git clone https://github.com/neo-jack/webMonitor.git
cd webMonitor
npm ci
npm run build
npm start
```

本地管理台：`http://127.0.0.1:4318/`。访问 `/demo.html` 可以触发测试事件，管理台提供 SDK 接入示例。

跨域采集需要通过 `ALLOWED_ORIGINS` 配置业务网站的实际 Origin。配置项见 `.env.example`；如使用 `.env` 文件，启动命令为 `node --env-file=.env server.mjs`。

## 构建与验证

在仓库根目录执行：

```bash
# 验证采集、数据存储与图表统计
npm test

# 生成浏览器 SDK 和管理台产物
npm run build

# 打包供其他项目安装的 SDK
npm pack
```
