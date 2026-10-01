# 固定版本 Runtime 兼容记录

基线：Morphz 0.1.3，源码提交 `7e8f7d81f8b00fd45544d94d5b9a321214633df1`。opendots 不修改安装的官方 Runtime 或读取其数据库来绕过 API。

## 已核实：typed IO 临时文本事件的字段不一致

2026-09-30 的真实进程、隔离配置、确定性流式 provider 验证发现：模型 HTTP 请求已经产生文本前缀，但 `/api/sessions/:id/io/stream` 只返回 `stream.opened`、`input.accepted`，没有中间 `output.started` / `output.delta`。

固定源码中：

- `morphz/src/orchestrator/orchestrator.rs` 约 10479 行向 `runtime/model_stream` 写入 `attempt_id`
- `append_activation_route` 加入 thread、activation、root、principal 等路由，但没有 `model_attempt_id`
- `morphz/src/session_io/stream.rs` 约 108 行只读取 `model_attempt_id`；没有该字段就提前返回
- 上游自己的 `application/packages/application/src/conversation-feed.ts` 使用按 Session 限定的 `/ws`；其 `live-conversation.ts` 读取 `attempt_id`

这是针对上述固定版本的源码和进程证据，不外推到其他版本。原始 typed IO 流的中间文本测试失败没有被视为通过。

## 产品的明确兼容路径

- 输入、幂等回执、持久历史仍使用 Session IO v1
- 实时公开文本使用上游 application 相同的只读 `/ws?session_id=<已绑定 Session>` 观察接口
- 仅本地 `LocalOperatorAdapter` 可用；连接前重新读取已绑定 Session，令牌放在 Authorization 头，不放 URL
- 请求不包含 `observe_model_requests`；只投影公开的 started / text_delta / failed / incomplete，丢弃推理、模型请求、provider continuation、工具参数和其他未列入白名单的 payload
- 持久消息、任务完成与审批结果仍来自 typed IO / Runtime 权威，不来自临时模型文本
- HTTP 轮询发现授权失败会断开临时观察连接；浏览器不能指定 Principal、Context 或其他 Session

状态接口明确返回 `stream.transport="application_ws"` 和 `reconnectBehavior="discard_unfinished_until_fresh_start_or_durable_output"`。

## 重连限制

该固定版本的 WebSocket 连接快照只有执行状态，没有完整正在生成的文本前缀。断线或宿主重启后，opendots 丢弃未提交草稿，不把后来收到的后缀冒充完整回复。等待新的 started 事件或最终持久输出；不会为重建画面重新提交用户输入。

可选择 typed IO 观察模式做协议测试，但在该官方二进制上，不把其完整草稿快照能力标记为可用。后续上游修正字段后，可重新验证再切回。

## 复现

先按项目文档验证 Runtime 二进制来源与 checksum，然后运行：

```sh
OPENDOTS_RUNTIME_BINARY=/path/to/morphz node scripts/runtime-stream-smoke.mjs
```

测试仅启动隔离真实 Runtime 和本地确定性 provider，验证中间前缀、宿主在推理中重启、不重放输入、诚实丢弃草稿、最后唯一的完整持久输出。没有付费模型调用，不等于真实模型质量或生产运行验收。
