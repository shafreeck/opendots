# 安全边界

本项目当前是本地单用户实际 Runtime 集成。默认模式会请求真实模型与工具；仅显式 demo 模式为模拟器。HTTP 只监听 loopback，校验 Host/Origin/Fetch-Metadata、随机 CSRF 和有界请求体。真实审批已接入并以实际 Runtime 拒绝测试验证。不要直接暴露到局域网或公网：多用户身份、TLS、隔离和完整生产部署审核尚未完成。

## 信任边界

1. 浏览器输入均不可信。聊天文本不能变更 principal、执行目标或权限。用户输入显示使用纯文本，不能执行其 HTML。
2. BFF 对 Runtime 的 token 是服务凭据，只在服务端读取，不能返回到客户端或嵌入 URL。错误和日志不能输出 token。
3. Runtime 是认知与执行权威。产品 SQLite 持有产品自身的权威事实（稳定身份映射、用户命令、提醒意图、通知已读和电脑控制租约）以及 Runtime 事件投影；绝不直接读写 Runtime 数据库。
4. 连接器回包、网页和文件内容是数据，不能直接转换为授权。
5. 执行目标必须在执行侧重查最小权限与任务身份。上游沙箱不可用时失败关闭，不以 full_access 绕过。

## 已知威胁与下一步控制

- 重复请求：固定幂等键与输入指纹，冲突返回错误；不可在超时后换 key。
- 旧 worker：租约 fencing 防止过期尝试提交；真实外部副作用仍需 provider 对账。
- 混淆代理：服务端 principal 映射；校验 Session 属主和 Context 授权，不信任 body 用户 ID。
- 审批竞态：弹窗保存用户实际看见的请求快照与 revision，提交原 revision、allow_once/deny 和稳定命令键；由 Runtime 重查真实权限状态。产品不自行宣称实现了额外 action-digest/期限绑定。
- SSRF：真实 adapter base URL 由受信配置提供；浏览器不可传任意 URL；生产加目的地主机白名单与网络 policy。
- 数据泄露：最小化日志、凭据引用、内容保留策略、Session resource 隔离；备份单独保护。
- 资源耗尽：请求体上限、并发/队列限额、模型预算、连接器 rate limit；真实模型开销需要使用者配置。
- 浏览器跨站请求：本机也存在跨站/DNS rebinding 风险。已有 loopback/Host/Origin/CSRF 检查；多用户生产部署还需身份、严格 session cookie 与 TLS，不能把本机服务当成公网网关。

## 不确定副作用

一个外部服务可能已完成请求，但回执丢失。此时不能用新的 idempotency key 自动重发。记录 unknown，查询服务端事实或请用户确认。任务“已取消”也不能宣称撤销了已发生的外部行为。

## 变更管理

Morphz 升级先在隔离数据目录验证协议、writer fence、迁移和回滚；不得将本项目演示目录当成用户真实数据目录。新连接器和新执行目标逐项做权限审查、日志脱敏与故障注入。
