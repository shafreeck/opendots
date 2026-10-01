# Morphz 源码核验记录

所有链接固定到 revision `7e8f7d81f8b00fd45544d94d5b9a321214633df1`，核验日 2026-09-30。本表记录代码与接口存在性，不声称本次执行了上游测试。

| 依据 | 结论 |
| --- | --- |
| [README](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/README.md) | Developer Preview，Agent Frame 独立于 Session，生产多租户边界仍在演进 |
| [TS SDK](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/sdk/typescript/src/index.ts) | createSession 支持已有 Context mount，sendMessage 是 legacy API，审批具 revision；WebSocket URL 不用于本项目 token 传递 |
| [SDK package](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/sdk/typescript/package.json) | @morphz/sdk 0.1.0，private:true |
| [Web routes](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs) | typed IO 与 Objective HTTP 路由，Objective 请求验证 |
| [Session IO HTTP](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web_session_io.rs) | typed IO ingress/history/stream、身份与格式合同 |
| [Session IO 实施说明](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/docs/session_io_implementation_v0_1.md) | IO v1 正式支持、固定指纹重试、opaque cursor、draft/reset、显式 writer fence；历史段落须结合后续说明阅读 |
| [Admission config](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/config.rs#L550-L583) | 激活上限、交谈/交付 reserved slots、aging 配置 |
| [Admission classes](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/admission.rs) | InteractiveControl、Delivery、Objective、ScheduledBackground、Maintenance 固定类别 |
| [Admission tests](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/activation_admission.rs) | dialogue_uses_reserved_capacity_while_background_is_saturated 测试存在 |
| [Scheduler Kernel](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/scheduler/kernel.rs) | 内核调度命令和事务权威，产品不得直接改内部数据库 |
| [Reconciler](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/recovery/reconciler.rs) | 审计和隔离具体 Thread generation，不推断业务成功 |
| [Context Store](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/context_store.rs) | revision、state hash、ContextMutationPlan 与 Frame 节点 |
| [Context DB runtime](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/context_db_runtime.rs) | projection/state 的事务安装与修改 |
| [Harness](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/harness.rs) | ExactHarnessRef、DomainHarness、版本 registry 与 artifact hash |
| [Runtime approval](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/runtime/session_approval.rs) | 真实 Session 审批权威，不能由演示按钮替代 |
| [Execution Target](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/execution_target.rs) | 执行目标抽象；桌面控制仍需相应能力适配和验证 |
| [License scope](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/LICENSE_SCOPE.md) | Apache-2.0 默认范围及例外 |

## 已发现的文档时效问题

`docs/morphz_runtime_core_implementation_status_v1.md` 标注旧基线 `aefa17b`，其中 Web/Desktop 尚未进入主实现的文字，与当前 README 已列 `application/` 构建路径不一致。优先当前源码和专项合同；不据旧索引宣布没有应用层。

## 原始 SDK 文件指纹

上游 `sdk/typescript/src/index.ts` SHA-256：
`4e7af2cc2b2cc59cdbfb041bdc25784a5ec13ac0c179225e1774cfb657a37e4a`

本项目 HTTP adapter 是独立代码，不能使用此哈希声称自身等同上游 SDK。
