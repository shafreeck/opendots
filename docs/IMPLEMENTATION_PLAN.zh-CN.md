# opendots 实现方案

版本 0.3 当前实施范围 · 2026-09-30

用途：作为当前工程实施依据，实际完成情况以 STATUS.md 和验收记录为准。硬约束：不修改 Morphz Runtime 代码；手动记忆编辑器不纳入当前范围，后续确有需求再讨论。源码以 Git 管理，不再打包交付。

## 结论

把 opendots 建成 Morphz 上的个人助理产品层：一个持续身份和共享认知上下文，通过多个 Session 接收消息，通过 Runtime 原生的 Objective、Thread、Activation 推进工作。用户可以在任务执行期间继续交谈，后台工作有持久状态、权限边界和可追溯结果。复刻目标覆盖持续交谈、真实后台工作、记忆、主动服务、工具与计算机执行、审批、成果管理及语音。实施按可验收的垂直闭环推进，而不是用模拟对话界面替代产品。

此前代码仅是模拟骨架，不能作为完整复刻或真实能力的证据。此版方案重新以完整产品为目标：先采用 Morphz 已有 Runtime 和 application 业务层，再补个人助理体验、策略和外部接入。产品依据是公开可观察的交互能力与独立定义的验收，不依赖其他产品的私有提示、内部编排或个人数据。“完整”的含义必须是通过下文逐项验收，不宣称掌握或复制未公开实现。

## 源码基线和核验方式

- 上游：https://github.com/morphz-ai/morphz
- 固定提交：`7e8f7d81f8b00fd45544d94d5b9a321214633df1`
- 提交说明：`test(runtime): assert durable human approval handoff`
- 提交时间：2026-09-25 18:32:41 +0800
- 查验日：2026-09-30
- 当前工作区原有的 `morphz-light/Morphz-Launch-Source` 是视频工程，不是运行时源码；本次独立读取上游源码，没有更改原视频工程。
- 根 `Cargo.toml` 是 Rust workspace，默认包 `morphz`；固定工具链 `rust-toolchain.toml` 为 1.97.1。`sdk/typescript` 存在 HTTP SDK，但包标记 `private: true`，不可假设能从 npm 安装。
- 本项目锁定并核验上述 SDK 与 Rust HTTP 源码，采用薄 HTTP 适配器；必要许可证通知随附；不把整个上游塞入发行包。正式实现建议以现有 application 的 TypeScript/React/shared application host 为基础，Runtime 仍为独立 Rust 进程。原先 Node/SQLite 演示只保留为历史实验，不作为正式产品主干。

源码事实与实现效果分开：读到一个模块不代表本项目已完成集成；源码测试存在不代表本次执行过上游全部测试。后续升级必须更新固定提交、重新核对路由与数据契约。

## 需求和首版边界

首版面向单用户、本地优先，可后续演进成受认证的个人云服务。目标：

1. 持续聊天。新消息可以及时被接收，显示已接收、执行中、等待审批和最终交付；长任务不占住页面交互。
2. 持久工作。任务重启后可恢复；不把 TCP 断开、进程退出或模型暂时不可用误判成任务失败或完成。
3. 助理管理记忆。复用原版 Morphz 的记忆机制；用户在对话中纠正事实和偏好，可只读查看来源，不提供手动 Frame 编辑/删除界面。
4. 有边界的主动帮助。基于用户明确建立的提醒、日程和事件订阅产生候选提醒，去重、安静时段、频率限制可配置。
5. 可扩展工具与执行器。先接一个只读连接器，再做带审批的写操作；计算机执行通过能力声明和受控目标进行。
6. 审批与审计。用户知道将对什么目标做什么；失败、重试、取消和外部结果均有记录。

首个可用里程碑采用单用户、本地优先；完整目标包含桌面/Web与语音，移动端可后续实现。跨地区高可用、公有多租户、任意网站保证可用、无人值守支付和无限制计算机权限不纳入默认承诺。公有网络发布是独立安全阶段，不以功能完成自动授权部署。

## Morphz 复用矩阵

| 产品需要 | 已核验上游位置 | opendots 的职责 | 实施状态边界 |
| --- | --- | --- | --- |
| Agent 与共享 Context | `morphz/src/context_state.rs`、`context_store.rs`、`sdk/typescript/src/index.ts` 的 session mount | 持久用户到 agent/context/session 的映射，明确上下文共享范围 | 上游已有；产品绑定与恢复待验证 |
| 消息收件与幂等 | SDK `sendMessage`、`morphz/src/web_session_io.rs`、`session_io/mod.rs` | BFF 生成并保留 client_message_id；超时同 ID 重试；接收不等于完成 | 上游已有；真实接入与流式合同待验证 |
| 并发工作 | `scheduler/kernel.rs`、`scheduler/domain.rs`、`activation_admission.rs`、`thread_control.rs`、`objective.rs` | UI 优先级和显式 dispatch 策略；映射原生 Thread / Objective，不另造认知调度内核 | 上游已有；真实并发交谈待产品验收 |
| 崩溃恢复 | `recovery/reconciler.rs`、`scheduler/store.rs`、`memory/sqlite.rs` | 恢复产品投影和消息投递；业务终态以 Runtime 为准 | 上游已有；跨层恢复和副作用对账待验证 |
| 记忆与冲突 | `context_store.rs`、`context_db_runtime.rs`、`context_state.rs` | 复用来源化 Frame 记忆与只读查看；通过对话纠正 | 上游机制已有；记忆产品策略需新增 |
| 可编程认知策略 | `harness.rs`、`harness_package.rs`、`plan_execution.rs` | 版本化个人助理 Harness，定义小型领域行为与契约 | 上游机制已有；个人助理 Harness 需新增 |
| 权限 | `approval.rs`、`approval_authority.rs`、`runtime/session_approval.rs`、`permission.rs` | 用产品语言展示动作、目标、范围、过期时间；只转发匹配审批 | 上游权威已有；产品审批视图与映射待实现 |
| 执行目标 | `execution_target.rs`、`edge_node.rs`、`sandbox.rs`、`secret_store.rs` | 目标状态、能力显示、断线体验、最小权限配对 | 上游目标基础已有；实际设备与能力需验证 |

这些路径均相对固定提交。关键固定源码链接见文末“来源索引”；仓库 SOURCE_AUDIT.md 另有更细记录。

## 推荐结构与数据权威

浏览器 / 后续桌面壳 → opendots BFF → Morphz Session Service → Runtime 核心 → 受控工具和执行目标。

正式客户端使用后文“正式代码基座选择”的共享业务宿主：Desktop 内嵌业务模块并走受限 IPC，Web 才经 BFF/HTTP；不是要求所有桌面操作绕本机 HTTP。旁路产品服务包括身份映射、事件投影、连接器凭据引用、提醒规则、通知投递和审计导出。它们不直接写 Morphz 内部数据库，不伪造 Frame 事务或调度终态。

权威分工：
- Morphz 保存认知状态、Thread/Objective 生命周期、Activation、权限决定和执行证据。
- opendots/application 对用户创建的项目、内容对象/成果版本、任务定义、偏好和授权订阅拥有产品数据权威；这些不是可随意丢弃的缓存。另保存消息路由、投递幂等键、消费游标和可重建的运行状态投影。任务定义与 Runtime 执行实例通过稳定 ID/回执关联，不能互相代替。
- 外部服务拥有邮件是否已发送、文件是否已上传等事实；确认回执写回审计。不能凭本地队列的 done 状态证明外部操作成功。
- 原始消息内容属于不可信数据；来自网页或邮件的文字不能授予工具权限。

本地先用 SQLite（WAL、事务、唯一键）；产品扩大时使用 PostgreSQL 和事务 outbox。不能把独立数据库间的两次写入当成一个原子事务。用持久状态机、幂等请求和回执对账消除不确定性。

## 一个会话如何在工作时继续响应

每条用户消息先获得持久收件回执，再决定属于新话题、现有任务的补充还是明确中断。默认策略应在真实模型测试后确定，不把每条消息都隐式取消当前工作。

- 简短交谈走低延迟通道；后台工作用同 Agent/Context 下的原生工作 Thread 或 Objective。
- 同一 Session 的串行约束、并行输入和 steering 由 Runtime 保证。`parallel` 是请求语义，不能据此承诺无限并发。
- 复用 Morphz `ActivationAdmissionConfig` 的固定 admission classes、reserved slots 和 aging，不在产品层重造优先队列。源码默认 max_in_flight=16、max_queued=256、dialogue_delivery_reserved_slots=1、reserved_queue_slots=16；这些是上游默认值，不是 opendots 的性能保证。产品层提供配置、预算和可观测性。
- UI 同时展示聊天和任务卡；终态消息只在有最终结果证据时发出，进展不能伪装成果。
- 草稿流可替换且非持久，最终消息与任务状态独立。SSE 断线按 durable cursor 回补，支持显式 reset；不要把 UI 草稿拼接当成持久日志。

建议性能验收目标（尚未测量）：本机无模型收件 P95 小于 300ms；长任务运行时界面仍可收件；真实模型首字时间独立统计，不用网络回执冒充模型响应。

## 会话接口分阶段接入

正式接入采用源码锁定的 typed IO 适配层；此前骨架的 mock 契约测试不替代真实 Runtime 验证。官方 TypeScript SDK 的 `createSession`、`getSession`、`sendMessage`、`sessionEvents`、`sessionPendingApprovals`、`decideSessionApproval` 是已核验存在的方法，但 `sendMessage` 走 legacy `/messages`，未把它冒称为 typed IO SDK。

P1 直接接入已存在的 typed IO 路由：
- `GET /api/session-io/capabilities`
- `POST /api/sessions/:id/io/messages`
- `GET /api/sessions/:id/io/events`
- 下一步补 `GET /api/sessions/:id/io/stream` 的持久回补与草稿处理
- typed input 使用 `io_version: "1"`、固定 `client_message_id`、`morphz.chat@1` 和 `activation.dispatch_mode`。
- `after` 是不透明且绑定 Session 的游标，不解析成数字，不凭 event ID 猜造游标。
- 精确数值与未知字段不能经有损 JSON 数字转换；首个适配器只发字符串 chat，扩展 domain JSON 时使用无损 wire 表示。能力协商失败明确报错，不静默降级丢字段。

注意固定版本没有 `GET /api/objectives/:id`。已有 `GET /api/contexts/:id/overview` 返回观察数据，但其 handler 是 operator-only，不能当作普通用户或 trusted-gateway principal 可直接使用的任务查询 API。单用户本机可信宿主可在严格绑定 Context 后通过窄 operator adapter 读取；远程/多用户应复用 application 授权域投影，或新增明确的 principal-scoped Runtime 查询 API。不得为解决403而把浏览器或普通 gateway 升级成 operator。

原生后台目标 API 已存在：`POST /api/objectives` 接收 coordinator_session_id、delivery_session_id、stated_objective 等字段；协调与交付 Session 必须属于同一 Agent/Context。暂停/恢复 Objective 需要 expected_revision；Thread 控制还必须绑定对应 generation/revision。完整 Objective 控制是 P1 的实现与验收任务，不是模拟队列的别名。

服务 token 只在 BFF 保存，浏览器不持有，不放在 URL。上游 SDK 的 WebSocket URL helper 可能含 token，本项目不使用此路径。principal 来自已验证身份映射，不能接受浏览器任意指定。生产环境必须验证 Runtime 的 Trusted Gateway 配置和用户到 Session 的授权边界。P0 必须逐路由审计 operator、trusted gateway、principal 三种角色；Frame recall/lifecycle、Context scheduler 等路由也可能只允许 operator，路径存在不代表普通用户可访问。产品应在服务端绑定对象权限，不透传任意 Context ID，也不向客户端发放 operator 凭据。

## 持久任务和副作用语义

逻辑产品状态：queued、accepted、running、waiting_approval、waiting_external、succeeded、failed、cancelled、unknown。最终映射须由上游事件合同决定，不能把所有 Runtime 状态强行压成布尔值。

每个工作记录至少含用户、会话、原生任务绑定、请求幂等键、输入摘要哈希、尝试次数、租约持有者与过期时间、外部回执、最后事件游标。租约属于具体投递尝试，过期后旧 worker 不得提交新状态。

恢复顺序：读取未完成投递 → 查询已有 Runtime receipt / history → 仅在需要时重发相同 client_message_id → 回放事件重建 UI → 恢复通知 outbox。恢复不能推断新的业务成功。上游 Reconciler 本身也只处理限定的恢复/隔离边界。

对邮件发送、订单提交等副作用：使用 provider idempotency key 或查询回执；不支持幂等且结果未知时进入 unknown，展示待核查，不自动重发。所谓“恰好一次”限于已验证的事务/去重边界，不能扩展到网络之外。

取消分三层：停止新任务派发、请求运行时取消、外部操作可能已经提交。取消通知必须说明实际达到哪一层，避免“点击取消”被误解为撤销已发送消息。

## 记忆产品化

用 Morphz 的 Frame/Relation 和 revision 机制承载认知记忆；不把整段对话不断复制到系统提示，也不先建立另一个竞争的向量真相库。

记忆由原版 Morphz Agent 的既有机制维护，保留来源、版本和事实的时效语义。用户通过普通对话补充或纠正事实/偏好，产品提供现有 API 支持的只读检索和来源查看。当前不建立手动 Frame 编辑器、不新增 Runtime 写接口、不直接操作 Runtime 数据库，也不承诺用退役动作完成历史数据擦除。

不同 Frame 更新允许由 Runtime 的 OCC/MVCC 判断是否安全 rebase；同 Frame 或来源已变更时重新读取、比较并请求适当处理，不盲目覆盖。暂时的信息按 TTL 降权或失效。凭据只存 Secret Store 的引用，不进入记忆正文或模型日志。

可选向量检索最后再接，作为可重建索引。首先验收对话中的准确提取、事实纠正、来源展示和隔离，而不是用检索命中率替代认知质量。

## 主动提醒与连接器

提醒服务保存明确的触发器、IANA 时区、DST 处理方式、到期/终止条件、通知渠道和用户授权。Morphz 已有 `/api/sessions/:id/schedules` 创建与单 schedule 控制路由，字段包括 intent、not_before（RFC3339）、interval_seconds 与 dependency_thread_ids；这是绝对时间/间隔基础，不等于完整日历规则。产品负责保留“每周一当地上午”等原始意图并计算下一次 instant，时区变化和夏令时跳跃须有明确规则。webhook 验签、来源鉴权、重放防护、事件去重后才进入候选事项处理。轮询只用于服务不支持 webhook 的情况，并有速率预算。

候选事项流程：收件 → 规则匹配 → 检查是否已完成/已告知 → 价值和紧急度筛选 → 安静时段与频率控制 → 投递 → 用户反馈。首版只实现用户建立的提醒，不默认扫描全部个人数据，不把所有事件都当成需要打扰的事项。

连接器采用独立 Adapter：声明只读/写操作、所需 scope、参数 schema、幂等能力、回执查询能力、超时和限流。先以一个只读日历/文件搜索连接器完成契约和安全测试，再实现一项有明确审批的写操作。OAuth 授权、凭据轮换、撤销与数据删除另设验收。

## 权限和计算机执行

权限采用默认拒绝与最小范围，独立于模型的自然语言判断。审批卡绑定精确 action hash、目标、数据范围、金额/资源上限（如适用）、revision 和有效期；变更关键参数必须重新审批。审批消费与执行派发之间保留可审计关系，拒绝重复消费、过期授权和越界作用域。

真实生产集成复用 Morphz approval authority，不仅在 UI 放一个同意按钮。模型文本不能伪造 allow；工具回包不能升级权限；服务端再次校验。审计至少记录请求者、规则版本、审批者、动作摘要、调用与回执关联、结果和取消情况，并脱敏 secrets。

计算机目标先从 Morphz 已有 Execution Target / Managed SSH 能力开始，进一步的桌面鼠标键盘代理、配对和离线重连视为需开发适配器。执行器声明能力、在线状态和允许目录；断线后任务进入等待目标，不静默换到其他机器。执行端重复校验权限并使用沙箱；不允许远程工具接收未受限的任意 shell 字符串。

## 完整产品能力与可观察验收

以下是目标能力清单，不是现有代码完成清单。所有“已核验复用”仅表示固定提交中有对应源码；opendots 的真实接入、效果和产品验收均待完成。

| 能力 | 用户应该得到的真实行为 | Morphz 可复用依据 | opendots 需要补齐 | 核心验收 |
| --- | --- | --- | --- | --- |
| 持续身份与个性化 | 重开后仍认识同一用户；名称/偏好可编辑；个人和共享范围清楚 | Agent/Context、application identity/model-settings | 产品设置、用户同意与身份迁移 | 重启不换 Agent；其他用户不能冒用 principal |
| 随时交谈与后台工作 | 任务在做，用户仍能问问题；无需开另一聊天才能继续 | native admission、application conversation-feed/continuation | 延迟预算、清晰反馈、针对任务的补充输入 | 慢工具期间新问题获得实际回答 |
| 持久目标管理 | 看见任务状态、阻塞、成果；可补充、暂停、恢复、取消 | Objective/Thread/Activation、application execution/task-runtime | 产品任务视图和控制语义 | 定向取消不伤及其他工作；新 generation 不被旧控制击中 |
| 记忆 | 正确记住来源化事实，区分临时计划和长期偏好，能通过对话纠正 | Frame 生命周期、recall、OCC/MVCC | 原版记忆机制、对话反馈和只读来源查看 | 纠正生效且旧值不再被当成事实 |
| 主动服务 | 明确任务/事件到来时提醒；少而有用；能够查看原因和关闭 | session schedules、notifications | 事件订阅、价值筛选、时区/DST、静默/频率规则 | 重放不重复提醒，已完成事项不再催促 |
| 连接器 | 查真实资料、处理授权的真实操作，显示来源与结果 | host_tools、application agent-tools | provider adapters、OAuth、限流和回执对账 | 写操作在目标系统可验证，不能只见本地“完成” |
| 计算机任务 | 在指定电脑/环境中完成工作；离线时说明并等待 | Execution Target/Edge、sandbox、application browser/local-files | 桌面能力代理、配对与状态、画面/文件回传 | 掉线不换机器，不绕过权限执行 |
| 权限审批 | 知道谁将对何目标做何事；允许/拒绝真正约束执行 | approval authority、scope/revision | 人类可理解的审批卡、策略管理、越权测试 | 拒绝/过期/改目标后不执行 |
| 文件与成果 | 得到实际可打开的文件/页面，版本、来源和权限可靠 | Artifact/资源 API、application content/store/reader | 成果分类、版本比较、交付与导出 UX | 文件字节可读，链接权限正确，编辑保留身份 |
| 语音 | 语音与文字是同一助理；可打断播报、追问、继续任务 | application speech/speech-stream | 会话桥、轮次/打断、通话后状态衔接 | 语音发起工作在文字显示且不重放 |
| 多端与通知 | 文字/桌面/指定消息渠道看到一致状态和去重通知 | shared host、typed stream | 渠道路由、端设备注册、通知回执 | 切端不丢事件、不重复发送或泄漏 |
| 透明与隐私 | 能看来源、工具步骤、权限、数据留存，能导出/删除 | Runtime events、trajectory、secret store | 用户可用的审计、脱敏、保留/删除/备份规则 | 一次结果可追到输入、权限和外部回执 |

不复制其他产品的品牌、界面资产或未公开行为。像素级外观一致不属于此方案的完成标准；个人助理的行为闭环、可靠性与可控性才是。

## 正式代码基座选择

关键修正：不应只利用 Rust Runtime 后再从空白重写整个助理应用。固定源码已经包含 `application/`，其 `package.json` 标记 Apache-2.0、Node >=24.13，包含 React、Electron、TypeScript、测试和共享宿主。应先评估并选择性复用这些模块，保留来源和许可证，建立 opendots 独立产品入口与品牌。

推荐策略是“Runtime 固定版本 + application 共享域层的受控派生 + opendots 产品模块”。不直接整体复制上游 UI，也不在未审计耦合前把所有文件当成可稳定发布 SDK。P0 列出每个保留模块的依赖、API、迁移方式和上游更新冲突成本。能够以薄 adapter 调用的优先 adapter；application 层确需复制的保留 provenance 与修改记录；Runtime 固定为未修改的上游版本。

可复用的实际路径（均在固定提交）：
- `application/packages/application/src/application.ts`、`application-operations.ts`、`store.ts`：共享业务宿主与命令/持久存储边界
- `session-io.ts`、`conversation-feed.ts`、`continuation.ts`、`runtime-connection.ts`：typed IO、连续对话与 Runtime 连接
- `execution.ts`、`agent-tools.ts`、`host-tools-ipc.ts`：执行视图、任务工具、宿主回调。`agent-tools.ts` 已有 start-task/task-status/control-task，不另造同名无权威队列
- `identity.ts`、`identity-config.ts`、`model-settings.ts`：身份和模型配置基础
- `local-files.ts`、`browser.ts`、`reader-import.ts`、`reader-tools.ts`、`pdf.ts`、`search-index.ts`：资料、浏览器和成果基础
- `notifications.ts`、`speech.ts`、`speech-stream.ts`：通知与音频基础；存在这些模块不等于完整主动助理或全双工通话已验证
- `application/packages/core/src/` 的 content、conversation、execution、task-runtime、retrieval、sources：领域对象
- `application/apps/service/src/http.ts`：Web HTTP 接入；`application/apps/desktop/main.cjs`：桌面壳与受限桥

宿主原则来自 `application/docs/24-shared-application-host.md`：Desktop 内嵌普通业务模块，以受限 IPC 调用；Web 经 HTTP 调用同一业务合同；Runtime 独立。不能把 Vite 或本机 HTTP 服务设成桌面正常运行前提，也不能向 renderer 暴露 Node/任意 SQL。

连续对话原则来自 `application/docs/17-continuous-conversation-and-execution.md`：导航位置、内容归属、Session 和执行范围分别管理；新输入固定提交时的项目/对象/作者，切换页面不能重定向在途任务；消息按真实交付顺序追加，不把晚到结果塞回旧消息位置。上游历史验收记录只作为参考，不是 opendots 的验收证据。

## 产品模块与实现边界

建议正式仓库逻辑布局如下，仅为规划，不表示本次创建：

- `apps/web`：连续聊天、任务、记忆、提醒、文件、设置和审批界面
- `apps/desktop`：内嵌共享业务层、受限 IPC、系统通知、音频与本地执行能力
- `packages/application`：沿用/派生上游业务合同；身份、对象、输入快照、命令幂等
- `packages/runtime-adapter`：源码锁定的 Session IO/Objective/approval/Frame/schedule/target API
- `packages/assistant-domain`：用户意图、任务视图、来源化记忆、提醒候选、偏好规则
- `packages/connectors`：统一连接器合同与具体服务适配
- `packages/delivery`：事务 outbox、渠道身份、去重、回执、失败/未知结果
- `packages/voice`：ASR/TTS、音频会话与文字/任务事件桥
- `harnesses/personal-assistant`：版本化认知流程，声明输入/输出与工具边界，不拥有额外执行权限
- `tests/contracts`、`tests/runtime`、`tests/model`、`tests/devices`：四层验收证据

除模型 provider 差异外，业务流程不依赖特定模型的专有“agent orchestration”功能；Runtime 拥有确定性状态，Harness 定义认知流程。任何模型输出只能提出任务和动作，不能直接修改权限或伪造外部成功。

## 数据模型和状态合同

这些是 opendots 产品侧概念模型，最终迁移应复用 application 已有实体，避免重复表：

| 概念 | 必要字段 | 权威与写入规则 |
| --- | --- | --- |
| UserBinding | user/principal/agent/context/main_session IDs、revision | 可信宿主创建；浏览器不自报 principal；unknown 创建先读后决定重试 |
| InputCommand | command_id、client_message_id、原始内容与hash、scope快照、提交者、receipt | 提交前持久化；同 ID 异内容冲突；回执不代表完成 |
| TaskView | objective/thread/activation/generation IDs、state、revision、source_event、result_refs | Runtime 事件投影；不得本地猜测终态 |
| EventCursor | principal/session、opaque cursor、处理版本 | 与事件落盘/投影原子更新；不能用 receipt cursor 跳过历史 |
| ApprovalView | approval_id/revision、动作摘要、scope、requested resources、expiry、decision | 决定回到 Runtime authority；显示层无权授予额外权限 |
| MemoryView | frame_id/revision、来源、有效期、类型、确认状态 | Frame 是认知权威；产品只读展示，修正通过普通对话表达 |
| ReminderRule | user intent、timezone、local calendar rule、next instant、quiet hours、stop condition | 产品解释日历规则；Runtime schedule承载具体唤醒；更新有revision |
| ConnectorAccount | provider、account reference、allowed scopes、revoked_at、secret reference | 不存明文 token 于模型可见数据；撤销立即生效 |
| EffectReceipt | effect_id、request hash、provider key、authority reference、status、external receipt | authorized→dispatched→confirmed/unknown/failed；未知不等于失败 |
| ArtifactVersion | object/resource IDs、version、content hash、source task、owner/ACL | 内容与版本来源可核验；分享权限独立于创建 |
| DeliveryRecord | recipient/channel、content ref、dedupe key、attempt、receipt/status | 投递 outbox；同一业务消息不会因重连重复发出 |

任务状态不能只有 pending/done：至少区分 submitted、accepted、running、waiting approval、waiting target、waiting external、pause requested、paused、stop requested、stopped、succeeded、failed、unknown。不是要求覆盖上游状态名称，而是 UI 必须忠实表达上游不同事实。

“用户打断”拆成：打断音频播报、停止当前流式呈现、向现有任务追加指令、取消某 Thread/Objective。四者不能共用一个含糊按钮。取消是有回执的命令；stopRequested 不可显示成 stopped；停止未来 schedule 也不能自动等同杀掉正在运行的执行。

## 关键端到端流程

### 建立个人空间

登录或本地受信身份 → 创建/解析持久 UserBinding → 确定 Agent、Context 与主 Session → 加载增量历史与现有任务 → 校验模型/目标能力 → 进入可用或具体配置阻塞状态。身份创建超时先按固定对象 ID 读取核对，不无脑重复创建。没有模型配置时展示未配置，绝不回退成看似真实的模板回复。

### 真实任务期间继续交谈

用户输入 → InputCommand 落盘 → typed IO 接收 → 模型/Runtime选择交谈或 Objective → 工具在受控目标运行。用户第二条输入仍走 interactive admission；后台工具等待不占住前台 UI。Runtime 发布真实 output/execution events → 原子更新投影 → 聊天交付和任务视图同步。最终文件必须来自真实 artifact/resource 回执。

### 故障和恢复

启动先恢复既有绑定和未确认命令，再回补事件，最后恢复通知 outbox。请求已提交但响应丢失，使用相同内容与 ID 查询/重试。运行时中断依其 lease/generation 机制恢复；产品不从“进程还在/不在”推断业务状态。每个非幂等外部 effect 进入 unknown 后必须查询或人工核查，不自动重做。

### 主动处理

用户建立有边界的提醒/关注事项 → 定时或已授权事件到达 → 查是否仍适用、已完成或已告知 → 生成候选 → 应用频率/安静时段/敏感性规则 → 保存 delivery outbox → 发送到用户已绑定渠道 → 记录回执和反馈。发现事项本身不自动授予外部写权限；“提醒我”不是“替我发送/购买”。

### 授权外部动作

模型提出动作 → 服务端能力与授权核验 → 必要时生成带真实范围的审批 → 用户决定 → Runtime 验证 revision/scope → connector/executor 再核验 → 执行并记录回执 → 更新任务。审批参数改变、过期或目标离线期间权限撤销，均重新核验。日志避免复制秘密值。

## 文件和成果的完整体验

成果不是“任务完成”的一段文字。复用 application 的内容/对象存储和 Runtime resource/artifact 机制，区分原始输入、处理中间件、可交付版本与外部引用。

- 上传前确定文件所有者、Session/项目范围、大小和类型限制；大文件采用可恢复 staging
- 模型引用内容保留来源 Event/Resource；不得把任意路径或 URL 当成已授权读取
- 文档编辑生成新版本，保留对象身份、原始字节、hash 和任务来源；覆盖/分享分别受权限控制
- 下载时重新授权；有效链接不等于用户能访问，交付前验证权限和内容存在
- 按格式做质量检查：代码测试、文档渲染、表格重算、图片/视频元数据和视觉检查；生成 API 成功不是成果质量通过
- 外部文件/云服务引用与本地副本清楚标识；不默认同步或合并数据库

验收应包括同文件多次编辑、旧版本恢复、附件下载失败、权限撤销、重复交付、内容hash不一致、文件生成完成但消息投递失败。

## 语音与文字连续性

源码已有 speech/speech-stream 音频基础，其实现不能直接证明完整通话产品。opendots 需要音频会话控制层：获得麦克风许可、VAD/ASR、端点检测、输出 TTS、播放队列、打断与重连。音频 provider 选择和数据传输范围由用户配置，不能默默将录音交给新服务。

同一 user/Agent/Context 下为通话建立适当 Session/输入来源标记；稳定 utterance_id 映射 client_message_id，ASR partial 可替换，final 才作为持久输入；重连不把 partial/final 各提交一次。用户打断 TTS 只停止播放，除非明确请求，不取消后台任务。

语音中形成的任务、授权和成果仍经统一业务合同。重要动作需要可理解的确认与文字记录；没有足够明确的确认就保持待审批。结束通话后保留进行中工作和必要文字摘要，不自动重放通话。首版目标是点按通话/语音交互，不承诺拨打第三方电话或加入会议。

验收：噪声/断网、用户抢话、ASR更正、双重提交、长工具运行中追问、音频播放结束但任务未结束、从语音切文字后的同一任务控制，以及录音保留/删除设置。

## 模型与执行环境的实施前提

真实助理需要运行中的 Morphz、受支持模型/provider、受控工作目录和执行权限。工程验证分为不计费的确定性 provider 和已授权的真实模型，两者效果证据不同。

当前查验仅确认本云环境 Node 24 与 bwrap 可用，未发现 cargo/rustup/morphz 可执行程序；这不是永久产品限制。后续 P0 可选官方固定版本二进制或固定工具链源码构建，校验来源与hash；使用隔离数据目录，不接触用户已有生产 profile。计划交付范围内未继续安装或启动。

实施前需要确定：模型提供方与模型、凭据由何种安全方式配置、API 成本预算、允许的工具目录/联网范围、第一批连接器、首发桌面/Web优先顺序。缺这些信息仍能设计和做确定性测试，但不能把真实模型行为或外部业务效果标记完成。

## 验证分层与完成标准

- L1 单元与协议替身：证明适配器封装、状态机、授权规则、幂等和UI交互。不能证明真实 Runtime 行为
- L2 真实 Morphz + 确定性测试 provider：证明实际调度、工具、持久化、恢复、审批和stream合同。模型输出仍是可控夹具
- L3 真实模型 + 受控真实工具：证明助理能理解请求、执行任务、产生可检验成果，且持续对话、取消、记忆达到可用质量
- L4 真实渠道/设备：证明连接器、桌面、通知和语音在实际环境中工作，不仅在模拟浏览器或HTTP服务器里通过

每条能力在验收记录里使用四种状态：未实现、已实现未验证、在指定层验证通过、有已知缺口。不存在一个“测试全绿”就自动覆盖全部能力的总状态。

首个真实垂直演示：让助理在指定目录制作一份实际文件，期间提出无关问题并获得真实回答；精确取消另一个工作；重启宿主后查看任务和成果；触发一次真实需要审批的工具行为并拒绝；确认没有副作用。通过只能称“核心闭环可用”，不能称完整复刻。

完整单用户目标完成条件：能力矩阵每项至少达到约定层级，关键安全/恢复无未解P0，使用者按真实场景试用通过，成本/延迟/模型错误率有记录，限制清单准确。目标例：连续7天受控 soak、无重复已确认副作用、100%测试拒绝权限生效；具体样本数与阈值在P0定稿，不提前声称已实现。

## 当前差距和交付解释

| 范围 | 当前真实状态 | 进入完成状态还缺什么 |
| --- | --- | --- |
| 完整产品设计 | 本方案覆盖目标、源码复用、流程、数据和门禁 | 用户确认优先级后进入P0 |
| 原模拟代码 | 本地18项测试通过；与真实能力验收无等价关系 | 不能当正式产品替代物 |
| Runtime/BFF真实接通 | 未验证；没有已运行的真实Runtime实例 | 环境、provider、真实协议/权限联调 |
| 真模型任务与工具 | 未实现为已验收产品 | L3场景与实际成果证据 |
| 记忆/主动服务/连接器/执行器 | 有上游基础与本文设计，无opendots完整验收 | 按P2/P3逐项建设 |
| 语音/跨端/成果版本体验 | 有可复用模块，未完成opendots产品集成 | P4及真实设备/渠道验证 |
| 安全发布和运维 | 只有设计边界，无发布准入通过 | P5审计、迁移/回滚和试运行 |

当前按用户授权继续实施，使用 Git 管理；不打包源码、不修改 Runtime，不把计划写成完成承诺。

## 实施顺序和资源估算

不再把模拟骨架当作产品里程碑。每阶段都必须在真实 Morphz 上产出可观察行为，并保留通过和未通过记录。

| 阶段 | 实施内容 | 出口条件 | 粗估历时 |
| --- | --- | --- | --- |
| P0 复用验证和产品合同 | 审计 application 可复用模块及逐路由权限角色/API缺口、建立能力矩阵、模型/执行器环境与权限方案、固定升级基线 | 一个固定 Runtime 与隔离数据目录可重现；明确实际模型和授权范围 | 1 至 2 周 |
| P1 真实工作闭环 | 共享宿主、身份映射、typed IO、Objective、增量消息、定向控制、真实审批、成果交付 | 真模型执行一个文件任务，期间持续交谈；重启不丢状态、不重复副作用 | 2 至 3 周 |
| P2 长期个人助理 | 原版记忆形成/对话纠正、用户提醒、事件来源、去重、安静时段、预算与审计 | 跨天连续场景中记忆准确、提醒可解释、用户可停用与控制 | 2 至 3 周 |
| P3 工具与计算机 | 首批只读/写连接器、凭据生命周期、目标配对/能力、掉线恢复、安全审批 | 至少一种真实外部写入与一种受控计算机任务，权限/重试故障注入通过 | 2 至 4 周 |
| P4 语音与成果体验 | 同一身份/任务的语音轮次、打断、语音与文字切换、文档/附件版本化与回跳 | 通话中建立的任务可在文字继续，重连不重复；成果可打开并有版本来源 | 2 至 3 周 |
| P5 产品化与试运行 | 安装升级、备份、数据迁移、隐私、可访问性、性能、连续运行评测 | 所选发布形态全部安全门禁和用户场景通过，明确剩余限制 | 2 至 4 周 |

估算前提：3 至 4 人，覆盖 Rust/Runtime、TypeScript/桌面、集成/安全、测试；工作有依赖也可部分并行，首个可用垂直版本约 3 至 5 周，完整单用户目标约 10 至 16 周。这里是基于范围的规划区间，尚未完成 P0 技术 spike，不能当报价或交付承诺。单人实现、上游变化、连接器审核、模型行为调优会显著延长。多租户云服务和原生移动端另估。

关键路径：协议/身份/权限 → 持久输入与任务 → 流式交付与控制 → 工具副作用可靠性 → 记忆与主动服务 → 语音/多端 → 发布。连接器数量不能替代核心闭环质量；先接两种代表性服务，再复制已验证的接入规范。

## 验收场景

- 一个耗时任务进行中，第二条用户消息可被接收且历史不丢失；界面不会把两次输出交叉拼成一条。
- 相同幂等键相同内容只创建一次；相同键不同内容冲突，不能悄悄覆盖。
- 收件提交后立刻杀死 worker，再启动能够继续；过期 worker 不能覆盖新租约持有者。
- 服务接收成功但客户端没收到响应：同键重试；不创建第二项工作。
- SSE 断线后只补缺失事件；草稿 reset 可用；游标乱序/重复不会产生重复通知。
- 需要权限的操作在拒绝、过期或参数变化后无法执行；审计能关联到确切动作。
- 目标执行器掉线后显示等待；重连后重新校验任务与权限，不自行转移机器。
- 对话中用户明确纠正后，后续回答正确采用新事实；只读记忆来源不伪造成功或人工编辑。
- 提醒覆盖夏令时切换、跨时区、已完成事项、事件重放和安静时段。
- 只有真实终态证据才显示成功；外部结果未知时保留 unknown。
- 第二用户无法读取第一用户 Session、资源、事件与审批；未过隔离测试不能开放公网。

此前自动测试仅覆盖本地模拟和 HTTP mock 合同；上述完整清单是正式实现的准入门禁，不是已通过声明。

## 主要风险和处理

上游仍是 Developer Preview。API 和行为可能调整，固定提交与适配层可以控制升级范围，但不能消除兼容工作。核心状态文档含历史段落，当前源码与专门协议文档优先，不照抄过时结论。

多进程能力有实现和契约测试，不等于生产多租户服务已经成熟。先做单用户单 Runtime，隔离数据库与凭据；跨进程和高可用必须做独立故障注入与容量验证。

源码许可总体支持复用 Apache-2.0 范围内的软件，但商标、网站内容、论文、专利文档和第三方组件有不同边界。许可证范围为根 Apache-2.0 默认，例外包括 third_party、docs/ip、论文、网站编辑内容及品牌资产；发布前补实际依赖清单、NOTICE 和法律审查，不借用任何产品的官方身份或视觉资产。

## 下一步建议

实施按 P0/P1 等阶段的真实验收推进，始终使用未修改的 Morphz Runtime。最重要的首个演示是：用户交代一个真实任务，执行期间继续问另一件事，重启后两者仍有正确的状态与结果。它比先做大量连接器或精美角色动画更能验证 opendots 的核心价值。

## 来源索引

以下链接均指向固定提交 7e8f7d81f8b00fd45544d94d5b9a321214633df1；本文查验的是源码与公开文档，未把上游历史验收当作 opendots 完成证据。

- [README.md](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/README.md)
- [application/package.json](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/package.json)
- [application/docs/17-continuous-conversation-and-execution.md](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/docs/17-continuous-conversation-and-execution.md)
- [application/docs/24-shared-application-host.md](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/docs/24-shared-application-host.md)
- [application/packages/application/src/application.ts](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/application.ts)
- [application/packages/application/src/agent-tools.ts](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/agent-tools.ts)
- [application/packages/application/src/session-io.ts](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/session-io.ts)
- [application/packages/application/src/speech.ts](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/application/packages/application/src/speech.ts)
- [morphz/src/web.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web.rs)
- [morphz/src/web_session_io.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/web_session_io.rs)
- [morphz/src/config.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/config.rs)
- [morphz/src/activation_admission.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/activation_admission.rs)
- [morphz/src/context_store.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/context_store.rs)
- [morphz/src/recovery/reconciler.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/recovery/reconciler.rs)
- [morphz/src/harness.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/harness.rs)
- [morphz/src/runtime/session_approval.rs](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/morphz/src/runtime/session_approval.rs)
- [docs/session_io_implementation_v0_1.md](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/docs/session_io_implementation_v0_1.md)
- [LICENSE_SCOPE.md](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/LICENSE_SCOPE.md)
- [NOTICE](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/NOTICE)
- [TRADEMARKS.md](https://github.com/morphz-ai/morphz/blob/7e8f7d81f8b00fd45544d94d5b9a321214633df1/TRADEMARKS.md)
