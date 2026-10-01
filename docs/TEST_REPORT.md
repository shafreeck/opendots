# 历史验证记录 原模拟骨架

本文件仅对应基线提交 d948177 的模拟骨架，不描述当前实现。当前状态见 STATUS.md；真实 Runtime 证据见 RUNTIME_VALIDATION.md。

日期：2026-09-30。环境：Linux，Node v24.19.0。对象：opendots 0.1.0 本地模拟骨架。最终代码经独立复跑。

## 通过

`npm test`：18 tests，18 pass，0 fail，0 skipped。

- 7 项 source-pinned typed HTTP adapter mock 合同：capabilities、准确 chat envelope、opaque cursor 与 chat-only receive filter、Session/Objective 路由、审批 revision、缺少能力时关闭、错误脱敏和受信 URL/principal 配置
- 8 项 SQLite store：幂等与冲突、审批/拒绝、重启后的租约恢复与 stale worker fencing、过期 lease 禁止提交、持久聊天回执、事件页/游标原子去重、错误事件页回滚、关闭并重新打开数据库后的待处理任务恢复
- 3 项本地 HTTP 与真实 worker_threads 集成：后台模拟投递期间聊天继续响应；审批前阻止 worker、拒绝后终止；Host/Origin/CSRF/JSON/体积限制/静态路径隔离

`npm run check`：所有列出的 TypeScript/JavaScript 文件通过 Node 语法解析检查。这不是 tsc 静态类型检查；当前零依赖项目没有安装 TypeScript 编译器。

`node scripts/check-source-lock.mjs`：固定 revision 通过，liveIntegrationVerified=false。

第一次 Host 测试用 Node fetch 自定义 Host，fetch 正规化 header 导致测试没有真正发出伪造 Host。改用 node:http 发出精确 Host 后，收到403且整套通过；未因此放宽服务端检查。

## 未执行或受环境限制

- 真实 Morphz Runtime 未启动，未调用真实模型、第三方连接器、OAuth、SSH/桌面执行器；因此无真实端到端集成通过声明
- 上游 Rust workspace 全量 build/test/clippy 未运行；没有验证固定 Rust toolchain 在本环境可安装
- 没有付费 API 调用、部署或远程仓库操作
- 云浏览器访问本地 demo URL 返回 `net::ERR_BLOCKED_BY_CLIENT`，未完成浏览器可视化/响应式/无障碍交互 QA。已完成上述进程内 loopback HTTP 测试，但不能用它替代视觉验收
- 未做生产负载、跨主机、多租户、真实外部副作用、SSE draft/reset、OAuth 及备份恢复集成门禁；详见 ACCEPTANCE.md

## 可复现

安装 Node 24 后，在项目目录运行 `npm test`、`npm run check`、`npm start`。默认页面 http://127.0.0.1:3210 。无需 npm install、模型 key 或第三方账户。

注意：模拟 job 的 completed 仅表示本地模拟步骤结束；它不是 Morphz Objective 或外部服务的成功证据。项目将此边界在 UI、适配器注释、README 和方案中分别标明。
