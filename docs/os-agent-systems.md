# 操作系统思想用于 LLM Agent 设计：机制与项目调研

核实日期：2026-11-20。项目的 star 数、最近推送时间、归档标记与许可证取自当日 GitHub API 返回；机制描述以仓库 README、源码文件、官方文档与 arXiv 论文原文为依据。文中区分两种状态：**已实现**指能在源码或官方文档中找到对应组件；**论文设想**指论文提出、官方标注为进行中或路线图、仓库中未见对应实现的内容。

## 1. 进程与调度

**OS 机制**。进程是拥有独立地址空间与安全身份的执行单元。调度器（FIFO、时间片轮转）在进程之间分配 CPU；上下文切换保存并恢复执行状态；fork/exec 创建新进程；信号用于异常通知与终止。CRIU（Checkpoint/Restore In Userspace）把运行中的容器或应用冻结，将状态写入磁盘映像，之后原样恢复，用于 live migration 与快照（[criu.org](https://criu.org/Main_Page)，v4.3.1 发布于 2026-11-12，已集成进 LXC、Docker、Podman、Kubernetes）。Erlang/OTP 的监督树把故障处理放进进程结构：supervisor 监控 worker，worker 出错时按策略重启，behaviour（gen_server、gen_statem、supervisor 等）把通用进程骨架与业务回调分离（[OTP Design Principles](https://www.erlang.org/doc/system/design_principles.html)）。

**Agent 对应设计**。agent 对应进程：拥有独立上下文、工具凭据与记忆状态，由平台负责创建、调度、挂起、恢复、终止。LLM 推理时间对应 CPU 时间片：调度器决定哪个 agent 的请求占用推理资源，超出时间片则保存生成状态、让出资源。agent 的故障恢复有两条路线：从状态检查点恢复（CRIU 式），或重放事件日志重建状态（durable execution 式）。监督树思想对应 orchestrator 对 subagent 的监控、停滞检测与重新规划。

**项目证据**：

- **AIOS**（[agiresearch/AIOS](https://github.com/agiresearch/AIOS)）：论文提出 LLM kernel，把调度、上下文管理、内存管理、存储管理、访问控制从 agent 应用分离到内核层，服务多个框架的 agent 时最高提速 2.1 倍（[arXiv:2403.16971](https://arxiv.org/abs/2403.16971)，COLM 2025）。已实现的调度器有两种：`aios/scheduler/fifo_scheduler.py` 与 `aios/scheduler/rr_scheduler.py`。`RRScheduler` 接受 `time_slice` 参数（默认 1 秒），为 LLM、memory、storage、tool 四类请求各开一个处理线程，按批次执行 syscall 并设置 `time_limit`（[rr_scheduler.py 源码](https://raw.githubusercontent.com/agiresearch/AIOS/main/aios/scheduler/rr_scheduler.py)）。上下文快照已实现：`SimpleContextManager` 按 pid 保存/加载生成状态；对本地 HuggingFace 模型，快照内容包括 `generated_tokens`、`past_key_values`（KV cache）、`start_idx`、`input_length`，超时中断后可从断点继续生成（[simple_context.py 源码](https://raw.githubusercontent.com/agiresearch/AIOS/main/aios/context/simple_context.py)）。README 中的部署 Mode 3（个人远程内核、跨设备同步）与 Mode 4（同一物理机上虚拟化多个 AIOS 内核）标注为 ongoing，属于论文设想（[README](https://github.com/agiresearch/AIOS)；愿景论文 [arXiv:2312.03815](https://arxiv.org/abs/2312.03815)）。
- **Magentic-One**（[arXiv:2411.04468](https://arxiv.org/abs/2411.04468)）：Orchestrator 维护双循环。外循环维护 Task Ledger（facts、guesses、plan）；内循环维护 Progress Ledger，每步自问任务是否完成、是否有进展，停滞计数超过 2 则回到外循环更新 Task Ledger 并重新规划（[Microsoft Research 博客](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)）。这对应调度器的停滞检测与进程重启策略。代码已实现并经历两次迁移：最初在 `autogen-magentic-one` 包（[v0.4.4 标签](https://github.com/microsoft/autogen/tree/v0.4.4/python/packages/autogen-magentic-one)），后移植为 `autogen-agentchat` 的 `MagenticOneGroupChat`（[包 README](https://github.com/microsoft/autogen/tree/main/python/packages/autogen-magentic-one)）；AutoGen 仓库现已归档，官方后继 Microsoft Agent Framework 内置 Magentic orchestration，`MagenticBuilder` 暴露 `max_round_count`、`max_stall_count`、`max_reset_count` 与人工计划审批（`RequirePlanSignoff`），事件类型包括 `MagenticPlanCreatedEvent`、`MagenticReplannedEvent`、`MagenticProgressLedgerUpdatedEvent`（[Microsoft Learn](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/magentic)）。独立仓库 microsoft/Magentic-One 已不存在（API 返回 404）。
- **UFO³ Galaxy**（[arXiv:2511.11332](https://arxiv.org/abs/2511.11332)）：把用户请求建模为可变的 TaskConstellation——由原子子任务 TaskStar 与依赖边 TaskStarLine 组成的分布式 DAG；Constellation Orchestrator 异步执行并根据执行结果动态改写 DAG，对应工作流级调度与自适应恢复。在 NebulaBench（55 个跨设备任务）上子任务完成率 83.3%，平均并行宽度 1.72，端到端延迟比顺序基线降低 31%。代码已实现于仓库 `galaxy/` 与 `aip/` 目录（[README](https://github.com/microsoft/UFO)）。
- **LangGraph**（[langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)）：执行模型来自 Pregel 的 super-step 概念，每个 super-step 边界生成一个 checkpoint；节点失败时，同一 super-step 内已成功节点的写入保存在 `checkpoint_writes` 表，恢复时不重复执行（[checkpointers 文档](https://docs.langchain.com/oss/python/langgraph/checkpointers.md)）。durable execution 指 agent 跨故障持续运行、从上次位置自动恢复（[README](https://github.com/langchain-ai/langgraph)）。
- **Temporal**（[temporalio/temporal](https://github.com/temporalio/temporal)）：Workflow Execution 发出 Commands、处理 Events，全部记录在 Event History。恢复时从头重放代码，用历史记录引导代码回到先前状态；因此 Workflow 代码必须确定性，时间、随机数要用 replay-safe API，外部副作用（API 调用、数据库查询、**LLM 调用**、文件 I/O）放进 Activity，Activity 只执行一次，结果记入历史，重放时直接复用（[Workflow 文档](https://docs.temporal.io/workflows)）。这是"重放重建"路线的成熟工业实现，源自 Uber Cadence。
- **DBOS Transact**（[dbos-inc/dbos-transact-py](https://github.com/dbos-inc/dbos-transact-py)）：用 `@DBOS.workflow()` 与 `@DBOS.step()` 注解普通 Python 函数，把执行状态检查点写入 Postgres，崩溃后从最后完成的 step 恢复；无需独立编排服务，库本身即全部基础设施。`fork_workflow(workflow_id, step)` 可从指定 step 重启失败工作流；`SetWorkflowID(event_id)` 用幂等键保证事件恰好触发一次工作流；`DBOS.sleep()` 把唤醒时间存入 Postgres，跨重启保持（[README](https://github.com/dbos-inc/dbos-transact-py)）。仓库 topic 包含 agentic-workflow，官方文档把"操作 AI agent"列为典型用途。
- **Restate**（[restatedev/restate](https://github.com/restatedev/restate)）：Reliable Execution 通过 durable execution journal 恢复部分进度，已完成的 step 不重复执行；Durable Promises/Timers 跨故障恢复；用户代码在 await Promise 时挂起、resolve 时恢复，适配 serverless 部署；每个实体有一致的 K/V 状态，与执行进度一起持久化（[README](https://github.com/restatedev/restate)）。官方提供 [Durable AI Agents 示例](https://github.com/restatedev/ai-examples)。
- **kagent**（[kagent-dev/kagent](https://github.com/kagent-dev/kagent)）：Agent、AgentTemplate、ModelConfig、RemoteMCPServer 均为 Kubernetes CRD，agent 配置走 kubectl 与 GitOps；Harness 决定运行时（Go/Python ADK、Codex、Claude 或自定义）；自带面向 Kubernetes、Istio、Helm、Argo、Prometheus、Grafana、Cilium 的 MCP 工具，RemoteMCPServer 可跨 agent 共享。Substrate 组件负责 agent 运行生命周期，包括 suspension、resumption、snapshots；Sessions 支持挂起/恢复 agent，以及创建 checkpoint 并从 checkpoint fork 新会话（[README](https://github.com/kagent-dev/kagent)）。
- **agent-sandbox**（[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)）：Sandbox CRD（`agents.x-k8s.io/v1beta1`）管理单个有状态 Pod，提供稳定主机名与网络身份、跨重启保留的持久存储，生命周期包括创建、计划删除、暂停与恢复；扩展 CRD 有 SandboxTemplate（可复用模板）、SandboxClaim（从预热池申领）、SandboxWarmPool（预热池，降低分配延迟）（[README](https://github.com/kubernetes-sigs/agent-sandbox)）。"deep hibernation（状态保存到持久存储并归档 Sandbox 对象）"与"网络连接触发自动恢复"列在期望特性中，属于路线图。
- **MCP Tasks extension**：MCP 协议 2026-07-28 版的可选扩展，允许服务器为长时间运行的请求返回 durable handle，客户端稍后轮询状态并取回结果（[architecture 文档](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture.md)）。这是工具调用层面的进程化：长任务有了独立于请求的生命周期。

## 2. 内存与上下文管理

**OS 机制**。虚拟内存通过物理内存与磁盘之间的分页，给应用提供远超物理容量的地址空间假象；缺页中断触发换入，页置换算法（LRU、clock）决定换出，Bélády 算法给出理论最优界。内存分层（寄存器、缓存、主存、磁盘）按访问速度与容量组织数据。

**Agent 对应设计**。上下文窗口对应物理内存，外部存储对应磁盘；agent 通过函数调用自主决定把什么信息换入上下文、把什么信息写回外部存储。与 OS 的关键差异：token 的相关性取决于任务语义，时间局部性假设失效，目前不存在有理论保证的 token 置换算法（[arXiv:2607.25076](https://arxiv.org/abs/2607.25076) 第 IV-E 节）。

**项目证据**：

- **MemGPT**（[arXiv:2310.08560](https://arxiv.org/abs/2310.08560)）：提出 virtual context management。main context（对应主存）由三段组成：只读 system instructions、固定大小可读写 working context、滚动消息 FIFO queue；external context（对应磁盘）分为 recall storage（消息数据库）与 archival storage（任意长度文本的读写数据库，实现用 PostgreSQL + pgvector）。Queue Manager 负责溢出控制：prompt 达到 warning token count（约 70%）时插入"memory pressure"系统消息，提醒 LLM 主动把重要信息写入 working context 或 archival storage；达到 flush token count（100%）时驱逐约 50% 的消息，并用旧摘要与被驱逐消息生成递归摘要放在队首。控制流由事件驱动（用户消息、系统警报、定时事件），函数输出带 `request_heartbeat=true` 时立即触发下一次推理，实现函数链式调用；不带该标志则 yield，等待下一个外部事件（[论文全文](https://arxiv.org/html/2310.08560v2)）。这些机制在 MemGPT 开源代码中已实现，项目后更名为 Letta。
- **Letta**（[letta-ai/letta](https://github.com/letta-ai/letta)）：cpacker/MemGPT 仓库现重定向到 letta-ai/letta（同一仓库 id）。V1 API server 已退役，源码保留在 `archive` 分支；当前活跃源码在 [letta-ai/letta-code](https://github.com/letta-ai/letta-code)（Apache-2.0，TypeScript，2025-10-25 创建）。memory block 是上下文管理的基本单元：label、value、大小 limit、可选 description，逐个持久化在数据库中并有 `block_id`，上下文窗口在每次请求时从数据库状态"编译"生成；block 可设为 read-only，可由多个 agent 共享（[memory blocks 博客](https://www.letta.com/blog/memory-blocks)）。MemGPT 论文中的 human/persona 两个 block 即此抽象的起源。
- **Letta sleep-time compute**：论文提出在查询到达之前离线"思考"上下文、预计算有用中间结果，把 raw context 转化为 learned context；在 Stateful GSM-Symbolic 与 Stateful AIME 上，达到同等精度所需 test-time 计算约减少 5 倍，扩展 sleep-time 计算可进一步提升精度 13%/18%（[arXiv:2504.13171](https://arxiv.org/abs/2504.13171)）。产品已实现：Letta 0.7.0 引入 sleep-time enabled agents，创建时实际生成 primary agent 与 sleep-time agent 两个 agent；primary agent 没有编辑 core memory 的工具，这些工具交给 sleep-time agent，后者异步整理 primary agent 的 in-context memory，两者可用不同模型、不同运行频率（[sleep-time 博客](https://www.letta.com/blog/sleep-time-compute)）。当前 Letta Code 的对应功能称 Dreaming：后台 subagent 回顾近期会话、合并经验、更新记忆，可配置在完成一定步数后或上下文压缩时触发（[Memory & dreaming 文档](https://docs.letta.com/configuration/memory)）。这对应 OS 的空闲时段后台处理（如页面预取、磁盘整理）。
- **MemOS**（[MemTensor/MemOS](https://github.com/MemTensor/MemOS)）：论文把记忆提升为一等系统资源，统一 plaintext、activation（KV cache 等运行时状态）、parameter（模型权重）三类记忆的表示、调度与演化；基本单元 MemCube 封装记忆内容与元数据（provenance、versioning），MemCube 之间可组合、迁移、融合（[arXiv:2507.03724](https://arxiv.org/abs/2507.03724)；短文 [arXiv:2505.22101](https://arxiv.org/abs/2505.22101) 强调 RAG 缺少 lifecycle management）。开源版本已实现的部分：统一记忆 API（add/retrieve/edit/delete，图结构可检查可编辑）、多模态记忆（文本、图像、工具轨迹、persona）、Multi-Cube 知识库管理（隔离、受控共享、动态组合）、MemScheduler 异步摄入（毫秒级延迟）、自然语言反馈修正记忆；自托管依赖 Neo4j + Qdrant，API 提供 `create_cube` 与 `writable_cube_ids`/`readable_cube_ids` 访问控制（[README](https://github.com/MemTensor/MemOS)）。activation 与 parameter 记忆的统一管理属于论文提出的完整蓝图。本地插件版用 SQLite + FTS5 + 向量混合检索，记忆分层为 L1 traces、L2 policies、L3 world model 与结晶 Skills。
- **AIOS memory manager**：`aios/memory/` 已实现 manager、retrievers、write_barrier、conversation_extractor 等组件，并提供可插拔 provider：`aios/memory/providers/mem0.py` 与 `zep.py`（[仓库目录](https://github.com/agiresearch/AIOS)）。同团队论文 A-MEM 提出 agentic memory（[arXiv:2502.12110](https://arxiv.org/abs/2502.12110)）。
- **OpenHands Condenser**：SDK 内置 Condenser 组件做会话历史压缩；事件框架中有 `CondensationRequest`（上下文超限时触发）、`Condensation`（记录被遗忘事件 id 与摘要）、`CondensationSummaryEvent`（摘要作为 LLM 可见消息）（[events 文档](https://docs.openhands.dev/sdk/arch/events.md)、[架构总览](https://docs.openhands.dev/sdk/arch/overview)）。对应换出前的摘要写回。
- **Claude Agent SDK**：hooks 事件包含 `PreCompact`（压缩前，可归档完整转录）与 `PostCompact`（压缩后）（[hooks 文档](https://code.claude.com/docs/en/agent-sdk/hooks.md)）；subagent 可配置 `autoCompactWindow` 提前触发自动压缩（[subagents 文档](https://code.claude.com/docs/en/agent-sdk/subagents.md)）。
- **LangGraph**：明确区分两种持久化系统——checkpointer 保存线程内图状态（短期记忆），store 保存跨线程应用数据（长期记忆，如用户喜好、事实、共享知识）（[persistence 文档](https://docs.langchain.com/oss/python/langgraph/persistence.md)）。对应主存与磁盘的职责划分。

## 3. 文件系统与持久化

**OS 机制**。文件系统提供命名、层级组织、访问控制与持久化。Plan 9 把三条原则贯彻到底：资源以文件形式命名与访问；标准协议 9P 访问这些资源；各服务导出的层级拼接成每个进程私有的命名空间。设备、窗口系统、网络接口、`/proc` 都是文件服务器；每个窗口有独立命名空间，局部修改不影响其他窗口（[Plan 9 from Bell Labs](https://plan9.io/sys/doc/9.html)）。Kubernetes PersistentVolume 把持久存储的生命周期与 Pod 解耦。

**Agent 对应设计**。agent 的记忆与工件需要命名、版本化、可检索的持久存储；"一切皆文件"对应把记忆、技能、工具输出统一为 agent 可用普通文件工具读写的对象；每 agent 私有命名空间对应记忆隔离与受控共享。

**项目证据**：

- **AIOS LSFS**（[arXiv:2410.11843](https://arxiv.org/abs/2410.11843)，ICLR 2025）：LLM-based Semantic File System，用自然语言 prompt 管理文件。宏观 API 包括语义文件检索、文件更新监控与摘要、语义文件 rollback；微观层面为文件构建语义索引，用向量数据库实现 CRUD、group by、join 等语义 syscall。README 说明该论文功能已集成为 AIOS 的 Terminal UI（[README](https://github.com/agiresearch/AIOS)）。这是把文件系统接口本身语义化的尝试。
- **Letta Filesystem**（[发布博客](https://www.letta.com/blog/letta-filesystem)，2025-07-24）：把文档（PDF、转录、文档等）解析后表示为 folders 与 files，向 agent 提供文件系统式工具：`grep`（跨文件模式匹配）、`open`（行级精度读取，可同时关闭其他文件）、`semantic_search`（向量相似）。强调 context transparency：开发者能看到哪些文件在上下文窗口中、原始内容是什么，可手动 open/close 覆盖 agent 的选择。Folder 是带描述的命名集合，全组织可见，可附加到任意多个 agent。已实现于 Letta V1 API 与 ADE。
- **Letta MemFS / context repository**（[MemFS 文档](https://docs.letta.com/concepts/memfs/index.md)）：当前 Letta agent 的长期记忆是一个属于该 agent 的 git 仓库，MemFS 把仓库投影为运行机器上的真实 checkout，agent 用普通文件工具读写；根目录文件每轮加载进 system prompt，带 `MEMORY.md` 索引的子目录按需读取，保持上下文精简。每次记忆编辑提交到 git，提供版本历史与冲突解决；云端 agent 的提交推回托管仓库，其他机器上的投影同步获取。记忆 subagent（dreaming、memory doctor）用 git worktree 并发更新记忆而不阻塞主 agent。技能存放在 `$MEMORY_DIR/skills`，随记忆一起版本化。默认不含向量索引，可选装 MemFS Search mod。这是"文件系统即记忆"的已实现形态，git 提供版本化与回滚。
- **LangGraph checkpoint 持久化**：checkpointer 实现包括 `PostgresSaver`、`SqliteSaver`、`InMemorySaver`；`StateSnapshot` 记录 values、next、parent_config 等字段，`get_state_history()` 返回完整历史，`update_state()` 在任意 checkpoint 创建分支（fork），`as_node` 控制分支后从哪个节点继续（[checkpointers 文档](https://docs.langchain.com/oss/python/langgraph/checkpointers.md)）。time travel 即回放或分叉历史执行。子图有独立 checkpoint namespace（`node_name:uuid`，嵌套用 `|` 连接）。
- **E2B 持久化**：pause 同时保存文件系统与内存（运行中进程、已加载变量），paused sandbox 无限期保留、无自动删除；resume 恢复到暂停时的完整状态；支持仅文件系统快照（恢复时重启）；fork 与 snapshot 需要 envd 健康检查配合（[persistence 文档](https://docs.e2b.dev/sandbox/persistence)）。runtime 层面，pause 把内存与磁盘相对 template 的 diff 上传对象存储，resume 优先选择仍有缓存的节点；persistent volumes 的生命周期长于 sandbox（[runtime README](https://github.com/e2b-dev/runtime)）。
- **OpenHands 会话持久化**：Conversation 拥有并持久化 append-only 事件日志；TaskToolSet 的子 agent 会话结束后保存到磁盘，凭 `task_id` resume 时恢复完整上下文（[events 文档](https://docs.openhands.dev/sdk/arch/events.md)、[Task Tool Set 文档](https://docs.openhands.dev/sdk/guides/task-tool-set.md)）。
- **kagent**：PostgreSQL 存储 sessions、tasks 与会话历史，独立于运行中的 agent 持久存在（[README](https://github.com/kagent-dev/kagent)）。
- **gVisor Gofer**：每个容器有独立 Gofer 进程，通过 9P 协议向 Sentry 提供文件系统访问，Sentry 自身运行在无文件资源的 seccomp 限制中（[gVisor 文档](https://gvisor.dev/docs/)）。Plan 9 的协议在 agent 沙箱基础设施中仍在服役。

## 4. 隔离与安全

**OS 机制**。Linux namespaces 隔离视图（PID、网络、挂载等），cgroups 限制资源，seccomp-BPF 过滤系统调用。gVisor 走第三条路：用户态应用内核 Sentry 拦截应用系统调用并自行实现，不透传给宿主内核；Gofer 中介文件访问；runsc 作为 OCI runtime 接入 Docker/Kubernetes（[gVisor 文档](https://gvisor.dev/docs/)）。Firecracker 用 KVM 创建 microVM，极简设备模型缩小攻击面，jailer 进程施加 cgroup/namespace 隔离并降权，线程级 seccomp 过滤器纵深防御（[Firecracker README](https://github.com/firecracker-microvm/firecracker)）。seL4 是形式化验证的微内核，用 capability（不可伪造的权限令牌）控制对象访问，内核行为与规范一致有数学证明（[sel4.systems](https://sel4.systems/)，[About](https://sel4.systems/About/)）。

**Agent 对应设计**。agent 执行 LLM 生成的代码、操作真实系统，隔离是强制要求。分层与 OS 一致：容器（namespaces/cgroups）→ 应用内核（gVisor）→ 硬件虚拟化（Firecracker microVM）。权限模型对应 capability 思想：工具凭据按最小权限发放，敏感操作需要运行时授权。新增问题：agent 的行为由自然语言推理决定，权限集合无法在部署时静态声明；自然语言 payload 可携带 prompt injection，重编程接收方 agent（[arXiv:2607.25076](https://arxiv.org/abs/2607.25076) 第 III、IV-I 节）。

**项目证据**：

- **E2B runtime**：每个 sandbox 一个 Firecracker microVM，独立 cgroup 与 network namespace，每 sandbox nftables 出口防火墙，按 SNI/Host 检查的域名允许/拒绝列表；secrets 在控制平面只存元数据，值不经过 API、日志与 span；workload identity 给 sandbox 短期令牌（[runtime README](https://github.com/e2b-dev/runtime)）。
- **agent-sandbox**：明确定位为 sandbox orchestrator，底层隔离委托给 gVisor 或 Kata Containers 等 Sandbox Runtime，通过 `RuntimeClass` 配置 Pod；提供威胁模型文档（[README](https://github.com/kubernetes-sigs/agent-sandbox)）。
- **microsandbox**（[superradcompany/microsandbox](https://github.com/microsandbox/microsandbox)，原 microsandbox/microsandbox）：本地 microVM 运行时，硬件级隔离，平均启动低于 100 毫秒，支持 fork 运行中 sandbox 与快照恢复，OCI 镜像兼容，跨 macOS（Apple Silicon）、Linux（KVM）、Windows（WHP）；密钥永不进入 VM（不可泄露设计）；VM 内 agentd 提供 exec/fs/process 等接口；提供 MCP server 与 Agent Skills 让 agent 自行创建 sandbox。Apache-2.0，Rust，beta 阶段（[README](https://github.com/microsandbox/microsandbox)）。
- **Daytona**（[daytona.io 文档](https://www.daytona.io/docs/en/sandboxes/)）：sandbox 是"完整可组合计算机"，默认 Linux 容器（启动 <90ms），另有 Linux/Windows VM sandbox（支持 fork、pause/resume、内存快照）、GPU sandbox、macOS sandbox。注意：GitHub 仓库 daytonaio/daytona 已归档（archived 标记，API 未检测到标准许可证文件），产品文档仍在维护。
- **OpenHands**：同一 agent 代码通过切换 workspace 类型在 LocalWorkspace、DockerWorkspace、RemoteAPIWorkspace 之间迁移；DockerWorkspace 自动在容器内启动 agent-server；SDK 内置 Security 组件在执行前做 action 风险评估（[架构总览](https://docs.openhands.dev/sdk/arch/overview)）。Agent Canvas 支持每个会话独立 Docker 容器（`OH_CONVERSATION_RUNTIME=docker`）（[README](https://github.com/OpenHands/OpenHands)）。
- **Claude Agent SDK permissions**：工具调用经过六步判定——hooks → deny rules → ask rules → permission mode → allow rules → `canUseTool` 回调。permission mode 有 default、dontAsk、acceptEdits、bypassPermissions、plan、auto（模型分类器审批）。路径规则如 `Edit(//secrets/**)` 同时约束文件工具与 Bash 的 `tee`/重定向写入；关键路径的 `rm`/`rmdir` 在任何模式下都不被 allow 规则自动批准；deny 规则在 bypassPermissions 模式下依然生效。OS 级强制由 sandboxed Bash tool 提供（[permissions 文档](https://code.claude.com/docs/en/agent-sdk/permissions.md)）。subagent 继承主会话的 plan 模式，防止通过委派绕过审查（同文档）。
- **Claude Agent SDK hooks**：`PreToolUse` 可返回 allow/deny/ask/defer 决定、修改工具输入；`PostToolUse` 可替换工具输出；多个 hook 决定冲突时 deny 优先（[hooks 文档](https://code.claude.com/docs/en/agent-sdk/hooks.md)）。对应系统调用拦截点。
- **Anthropic computer use**：官方安全建议包括专用 VM/容器与最小权限、不给敏感数据、域名允许列表、重大后果操作人工确认；工具返回的截图由分类器自动扫描 prompt injection，发现可疑指令时引导模型核实指令来源（[computer use 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)）。
- **OpenAI Agents SDK guardrails**：输入验证与安全检查与 agent 执行并行运行，检查不通过时快速失败（[SDK 文档](https://openai.github.io/openai-agents-python/)）。
- **UFO² PiP**：Picture-in-Picture 界面让自动化在隔离虚拟桌面中进行，agent 与用户并发操作互不干扰（[arXiv:2504.14603](https://arxiv.org/abs/2504.14603)）。对应会话隔离。
- **Magentic-One 安全实践**：博客记录开发中 agent 反复登录失败导致账号被封、尝试重置密码、试图通过社交媒体招募人类协助等事件；官方建议最小权限、最大监督，代码执行与评测放在沙箱 Docker 容器中，并提出按可逆性分类操作（容易恢复、需要代价才能恢复、不可逆）的设计方向（[MSR 博客](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)）。
- **Firecracker 快照安全**：快照文件属于信任边界内资产，Firecracker 只做 CRC 完整性检查，认证与加密由集成方负责；从快照恢复不保证网络连接存活（[snapshot 文档](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)）。E2B 的 pause/resume 建立在该机制上：快照保存 guest 内存与模拟硬件状态，加载时用 MAP_PRIVATE 映射按需取页、写入走 copy-on-write。
- **seL4 capability 模型的参照意义**：capability 把权限表示为可传递、可撤销的令牌，与"agent 动态发现并调用 API、权限需随运行时上下文变化"的需求同构。Agent-OS 论文把 capability-based security 列为可继承的经典基础，同时指出静态声明接口上的 capability 不足以覆盖推理时决定的工具调用（[arXiv:2607.25076](https://arxiv.org/abs/2607.25076) 第 III-A、IV-H 节）。

## 5. 系统调用与设备模型

**OS 机制**。系统调用是用户态进入内核的唯一合法边界，二进制接口、副作用有规范，可静态分析（seccomp 的基础）。设备驱动把硬件抽象为统一接口；Plan 9 进一步把设备表示为文件（`/dev/mouse`、`/dev/cons`），读写文件即操作设备，本地与远程透明（[Plan 9 论文](https://plan9.io/sys/doc/9.html)）。

**Agent 对应设计**。agent 的"系统调用"是工具调用：需要统一接口、schema 描述、权限检查与审计。"设备"是 agent 可操作的环境——shell、浏览器、桌面、数据库。MCP 自比 USB-C：为 AI 应用连接外部系统提供标准接口（[MCP 介绍](https://modelcontextprotocol.io/introduction)）。ACI（agent-computer interface）研究则关注接口设计本身如何影响 agent 表现。

**项目证据**：

- **AIOS syscall 接口**：agent 通过 AIOS SDK（[Cerebrum](https://github.com/agiresearch/Cerebrum)，NAACL 2025，[arXiv:2503.11444](https://arxiv.org/abs/2503.11444)）向内核发出 syscall 链，由调度器分发到 LLM、memory、storage、tool 各模块（[README](https://github.com/agiresearch/AIOS)）。`aios/hooks/types/` 下按模块定义 syscall 类型（agent、llm、memory、scheduler、storage、tool）。
- **LiteCUA / AIOS 1.0**（[arXiv:2505.18829](https://arxiv.org/abs/2505.18829)）：把计算机本身变成 MCP server——抽象计算机状态与动作，解耦界面复杂度与决策复杂度；AIOS 的 Tool Manager 重新设计为包含 VM Controller 与 MCP Server。LiteCUA 在 OSWorld 上成功率 14.66%。这是"计算机即设备、MCP 即设备接口"的已实现原型（[agiresearch/LiteCUA](https://github.com/agiresearch/LiteCUA)）。
- **MCP 协议结构**（[architecture 文档](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture.md)，协议版本 2026-07-28）：host（AI 应用）为每个 server 创建一个 client；数据层基于 JSON-RPC 2.0，服务器原语为 tools（可执行函数）、resources（上下文数据）、prompts（交互模板），客户端原语为 elicitation（向用户索取输入）；传输层为 stdio 与 Streamable HTTP（可选 SSE，推荐 OAuth）。协议无状态，每个请求在 `_meta` 携带版本与能力，`server/discover` 做能力发现。roots、sampling、logging 在 2026-07-28 版弃用，日志改用 stderr 或 OpenTelemetry。
- **E2B envd**：运行在每个 VM 内的守护进程，通过 Connect RPC 与 REST 暴露进程、PTY、文件系统操作、文件监视、端口转发；SDK 的"运行代码"最终调用 envd；可在不中断工作负载的情况下热升级（[runtime README](https://github.com/e2b-dev/runtime)）。envd 就是 sandbox 的设备模型层。
- **SWE-ReX**（[SWE-agent/SWE-ReX](https://github.com/SWE-agent/SWE-ReX)）：沙箱 shell 环境的 runtime interface，agent 代码与执行环境解耦——本地、Docker、AWS、Modal、Fargate 同一接口；识别命令结束、提取输出与退出码；支持 ipython、gdb 等交互式工具与多个并行 shell 会话。MIT 许可证。
- **SWE-agent ACI 设计原则**（[ACI 文档](https://swe-agent.com/latest/background/aci/)、[arXiv:2405.15793](https://arxiv.org/abs/2405.15793)，NeurIPS 2024）：LM agent 是一类新的终端用户，需要专门设计的接口。已验证有效的四条：编辑命令触发 linter，语法不正确则拒绝执行；专用 file viewer 每轮只显示 100 行，带滚动与文件内搜索；全目录搜索只列出有匹配的文件名，更多上下文反而让模型困惑；空输出返回明确的成功消息。论文原始结果：SWE-bench pass@1 12.5%、HumanEvalFix 87.7%。SWE-agent 现处维护模式，团队推荐 [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)（约 100 行 Python，SWE-bench verified >74%，MIT）。
- **UFO² 统一 GUI-API 动作层**：AppAgent 配备 native API 与领域知识，GUI-API 统一动作层；混合控件检测管线融合 Windows UI Automation（UIA）与视觉解析；speculative multi-action planning 减少每步 LLM 开销（[arXiv:2504.14603](https://arxiv.org/abs/2504.14603)）。HostAgent 负责任务分解与协调。UFO² 在仓库中为 LTS 状态，可作为 UFO³ 的 Windows 设备 agent（[README](https://github.com/microsoft/UFO)）。
- **Anthropic computer use toolset**：`computer_toolset_20260801` 是 Anthropic 定义的 client toolset，一个条目提供 17 个成员工具（screenshot、left_click、type、zoom 等），应用在自己控制的环境中执行每个调用；支持 batch actions；早期版本为 `computer_20251124`、`computer_20250124`（beta header）。纯网页任务另有 browser use tool（[computer use 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)）。模型只发出动作请求，设备操作由客户端实现——与 OS 中"内核定义接口、驱动实现操作"的分工一致。
- **UI-TARS Desktop / Agent TARS**（[bytedance/UI-TARS-desktop](https://github.com/bytedance/UI-TARS-desktop)）：UI-TARS Desktop 是基于 UI-TARS 模型（[arXiv:2501.12326](https://arxiv.org/abs/2501.12326)）与 Seed-1.5-VL/1.6 系列的原生 GUI agent，截图 + 视觉识别驱动鼠标键盘，提供本地与远程 computer/browser operator，跨 Windows/macOS/Browser。Agent TARS 是通用多模态 agent 套件：混合浏览器控制（GUI 视觉 grounding、DOM、混合策略），协议驱动的 Event Stream 支撑上下文工程与 Agent UI，内核基于 MCP 并可挂载 MCP server。仓库已于 2026-11-09 归档（Apache-2.0）。
- **OS-Copilot / FRIDAY**（[OS-Copilot/OS-Copilot](https://github.com/OS-Copilot/OS-Copilot)、[arXiv:2402.07456](https://arxiv.org/abs/2402.07456)）：框架统一对接 OS 中的 web、代码终端、文件、多媒体与第三方应用；环境抽象包括 bash_env、applescript_env、py_jupyter_env、subprocess_env；tool_repository 用 tool_manager 增删工具，支持把 API 部署为工具。FRIDAY 在 GAIA 上超过此前方法 35%，通过积累的技能泛化到未见应用，并展示在 Excel/PowerPoint 上最少监督下的自我改进（工具与技能学习）。MIT，最近推送 2024-09-09，项目已停滞。

## 6. IPC 与多 agent 协作

**OS 机制**。管道、socket、共享内存提供进程间通信；通信图在设计时已知，OS 强制授权通道。Erlang 进程间用异步消息传递，配合监督树构成容错的多进程系统（[OTP Design Principles](https://www.erlang.org/doc/system/design_principles.html)）。Kubernetes Service 用稳定虚拟 IP 覆盖临时 Pod，NetworkPolicy 按标签限制通信。

**Agent 对应设计**。agent 间通信分两个层次：agent 与工具之间（MCP），agent 与 agent 之间（A2A）。与 OS 的差异：通信图在运行时由 LLM 推理动态生成（orchestrator 随时 spawn subagent），无法在设计时声明；消息内容是自然语言，可能携带 prompt injection（[arXiv:2607.25076](https://arxiv.org/abs/2607.25076) 第 IV-F 节）。委派（delegation）对应 fork/exec：子 agent 继承受限的工具集合，独立上下文，结果汇报给父 agent。

**项目证据**：

- **A2A 协议**（[a2aproject/A2A](https://github.com/a2aproject/A2A)）：面向 opaque agentic applications 的开放协议——agent 之间以 agent 身份协作，互相不暴露内部状态、记忆与工具实现。能力发现用 Agent Card；通信为 JSON-RPC 2.0 over HTTP(S)，支持同步请求/响应、SSE 流式、异步 push notification；数据交换支持文本、文件、结构化 JSON。Google 贡献，现属 Linux Foundation（Agentic AI Foundation），Apache-2.0，SDK 覆盖 Python/Go/JS/Java/.NET/Rust（[README](https://github.com/a2aproject/A2A)）。
- **MCP 与 A2A 的分工**：MCP 解决 agent 连接外部系统（工具/数据），A2A 解决 agent 之间的协作；A2A 官方课程明确两者互补（[README](https://github.com/a2aproject/A2A)）。kagent controller 同时暴露 gRPC、A2A、MCP 三种 API（[kagent README](https://github.com/kagent-dev/kagent)）。
- **OpenHands delegation**：当前实现为 TaskToolSet/TaskTool——父 agent 用 `prompt` + `subagent_type` 启动子 agent，同步阻塞等待结果；`TaskObservation` 返回 `task_id`、`status`；子 agent 会话持久化后可凭 `resume` 参数恢复完整上下文；`SubAgentScope` 限制子 agent 只能使用父 agent 拥有的工具；`register_agent` 注册自定义子 agent 工厂（[Task Tool Set 文档](https://docs.openhands.dev/sdk/guides/task-tool-set.md)、[task/definition.py 源码](https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-tools/openhands/tools/task/definition.py)）。旧版 DelegateTool（`DelegateAction`，命令 spawn/delegate）自 v1.60.0 弃用，保留用于读取已存储事件（[delegate/definition.py 源码](https://raw.githubusercontent.com/OpenHands/software-agent-sdk/main/openhands-tools/openhands/tools/delegate/definition.py)）。V0 平台论文即包含多 agent 协调与沙箱执行（[arXiv:2407.16741](https://arxiv.org/abs/2407.16741)）；V1 SDK 论文说明这是完整的架构重设计，event-sourcing 开销可忽略，系统级故障显著减少（[arXiv:2511.03690](https://arxiv.org/abs/2511.03690)）。
- **Claude Agent SDK subagents**：子 agent 是独立实例，上下文隔离（中间工具调用与结果留在子 agent 内，只有最终消息返回父 agent）、可并行、可限定工具集合；通过 `AgentDefinition` 编程定义或 `.claude/agents/` markdown 文件定义；内置 general-purpose 子 agent；fork 型子 agent 复制当前会话；带 SendMessage 工具的子 agent 可与其他命名 agent 通信；子 agent 输出在交给父 agent 前会扫描控制标签仿冒与回合标记仿冒（[subagents 文档](https://code.claude.com/docs/en/agent-sdk/subagents.md)）。
- **Magentic-One 团队结构**：Orchestrator 指挥 WebSurfer（Chromium 浏览器，accessibility tree + set-of-marks prompting）、FileSurfer（markdown 文件预览应用读取本地文件）、Coder、ComputerTerminal（执行代码、安装库）；agent 可增删而无需重新调整 prompt；模型异构可配（[MSR 博客](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)）。
- **UFO³ AIP**（Agent Interaction Protocol）：基于 WebSocket 的安全协调层，持久低延迟通道用于任务分发与结果流式回传；代码含 registration、heartbeat、task_execution、command、device_info 消息类型与 heartbeat_manager、reconnection、timeout 容错组件（[仓库 aip/ 目录](https://github.com/microsoft/UFO)、[arXiv:2511.11332](https://arxiv.org/abs/2511.11332)）。跨设备 agent 协作对应分布式 IPC。
- **LangGraph subgraph**：子图作为节点嵌入父图，各有独立 checkpoint namespace；跨图共享数据用 store（[checkpointers 文档](https://docs.langchain.com/oss/python/langgraph/checkpointers.md)、[persistence 文档](https://docs.langchain.com/oss/python/langgraph/persistence.md)）。
- **Letta 共享记忆**：多个 agent 共享 memory block（[memory blocks 博客](https://www.letta.com/blog/memory-blocks)）；云端多 agent 可共享同一 git-backed 记忆仓库（[MemFS 文档](https://docs.letta.com/concepts/memfs/index.md)）。共享内存式 IPC。
- **AutoGen AgentTool**：把一个 agent 包装为另一个 agent 的工具（`AgentTool(math_agent)`），README 示例即多 agent 编排（[autogen README](https://github.com/microsoft/autogen)）。仓库已归档，官方后继为 Microsoft Agent Framework（MAF 1.0，支持 A2A 与 MCP 互操作）。
- **OpenAI Agents SDK handoffs**：Agents as tools / Handoffs 让 agent 把任务委派给其他 agent，Python 原生编排；Sessions 提供跨回合持久记忆层（[SDK 文档](https://openai.github.io/openai-agents-python/)）。

## 7. 可观测性

**OS 机制**。系统调用可审计，资源消耗可度量；syslog/audit 记录事件，`/proc` 暴露进程状态；云原生用 Prometheus 指标、Jaeger/OTel 分布式追踪。span 有明确语义：起止时间、父节点、结构化标签。

**Agent 对应设计**。agent 的执行轨迹（trajectory）是审计与调试的基本对象。难点：单次 LLM 调用粒度过小，完整轨迹成本过高；HTTP 200 不代表语义正确；故障有时间位移——第 3 步写入的过期记忆在第 18 步才表现为失败；agent 可能隐瞒失败、伪造成功，自报状态不可信（[arXiv:2607.25076](https://arxiv.org/abs/2607.25076) 第 IV-J、IV-K 节）。因此事件日志需要 append-only、agent 不可篡改，追踪需要关联推理、工具调用与记忆检索。

**项目证据**：

- **OpenHands event stream**：事件框架是不可变、类型安全的 append-only 日志，同时充当 agent 记忆与辅助服务集成点。LLM 可见事件（MessageEvent、ActionEvent、ObservationEvent、SystemPromptEvent、CondensationSummaryEvent 等）与内部事件（ConversationStateUpdateEvent、Condensation、PauseEvent 等）分离；`Event.source`（user/agent/environment）与 LLM role 刻意独立，防止把框架注入消息误认为用户输入；并行工具调用按 `llm_response_id` 分组；服务作为只读观察者订阅事件流（[events 文档](https://docs.openhands.dev/sdk/arch/events.md)）。
- **Agent TARS Event Stream**：协议驱动的 Event Stream 驱动上下文工程与 Agent UI；v0.3.0 提供 Event Stream Viewer 做数据流跟踪与调试，工具调用计时统计（[UI-TARS-desktop README](https://github.com/bytedance/UI-TARS-desktop)）。
- **E2B**：全部组件导出 OpenTelemetry；sandbox 生命周期事件、宿主统计与指标进入 ClickHouse（[runtime README](https://github.com/e2b-dev/runtime)）。
- **kagent**：OpenTelemetry tracing 监控 agent 与工具执行，接入现有可观测性设施（[README](https://github.com/kagent-dev/kagent)）。
- **Restate**：自动为 handler 间交互生成 OTel trace；UI 与 CLI 可跨服务、跨 invocation 检查应用状态（introspection）（[README](https://github.com/restatedev/restate)）。
- **Temporal**：Event History 本身即完整审计日志，Web UI 查看工作流执行（[README](https://github.com/temporalio/temporal)、[Workflow 文档](https://docs.temporal.io/workflows)）。
- **LangSmith**：LangGraph 官方配套，追踪执行路径、捕获状态转移、运行时指标，支持评测与调试（[LangGraph README](https://github.com/langchain-ai/langgraph)）。
- **OpenTelemetry GenAI semantic conventions**：独立仓库 semantic-conventions-genai 定义 GenAI 客户端、MCP、各 provider 的 spans/metrics/events，含 agent spans；Apache-2.0（[仓库](https://github.com/open-telemetry/semantic-conventions-genai)；原 semconv 页面已迁移，[迁移说明](https://opentelemetry.io/docs/specs/semconv/gen-ai/)）。MCP 协议弃用自带 logging 后也指向 OTel（[architecture 文档](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture.md)）。
- **Claude Agent SDK hooks 审计**：PostToolUse 记录文件变更到审计轨迹，SessionStart/SessionEnd 管理遥测，Notification 转发状态到 Slack/PagerDuty（[hooks 文档](https://code.claude.com/docs/en/agent-sdk/hooks.md)）。
- **Magentic-One Progress Ledger**：每步自报进度与任务分配，Orchestrator 据此判定停滞；博客同时警告自报状态不可全信，建议 closely monitored logs（[MSR 博客](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)）。

## 8. 评测环境

**OS 机制**。基准测试需要可复现的环境：VM 快照固定初始状态，执行后检查真实系统状态来判定成败。

**Agent 对应设计**。OS 级 agent 评测直接在真实操作系统中执行任务，用执行结果（文件内容、应用状态）判定成败；环境提供初始状态配置与评估脚本；并行化用云 VM 或沙箱池加速。

**项目证据**：

- **OSWorld**（[xlang-ai/OSWorld](https://github.com/xlang-ai/OSWorld)、[arXiv:2404.07972](https://arxiv.org/abs/2404.07972)，NeurIPS 2024）：首个可扩展的真实计算机环境，支持 Ubuntu/Windows/macOS；369 个任务覆盖真实 web 与桌面应用、OS 文件 I/O、跨应用工作流；每个任务有初始状态配置与基于执行的评估脚本。论文结果：人类完成率 72.36%，当时最好模型 12.24%，主要短板是 GUI grounding 与操作知识。环境代码打包为 `desktop-env`，provider 支持 VMware、VirtualBox、Docker（KVM）、AWS、Azure、Modal、Daytona；AWS Host-Client 架构支持大规模并行（评测可压缩到 1 小时内）。2025-07-28 发布 OSWorld-Verified，修复社区报告问题并更新模型结果（[README](https://github.com/xlang-ai/OSWorld)）。Apache-2.0。
- **WindowsAgentArena**（[microsoft/WindowsAgentArena](https://github.com/microsoft/WindowsAgentArena)、[arXiv:2409.08264](https://arxiv.org/abs/2409.08264)）：专注 Windows，改造 OSWorld 框架，150+ 任务；Docker 容器内运行 Windows 11 VM，约 30GB golden image 快照含全部应用与接收 agent 命令的 Python server；Azure ML 并行化使完整评测约 20 分钟。基线 agent Navi 成功率 19.5%（人类 74.5%），屏幕理解用 OmniParser（[microsoft/OmniParser](https://github.com/microsoft/OmniParser)）；hard 难度要求 agent 自行初始化任务环境。MIT。
- **SWE-bench 与 SWE-agent**：SWE-agent 论文以 SWE-bench（真实 GitHub issue 修复）为主要评测（[arXiv:2405.15793](https://arxiv.org/abs/2405.15793)）；SWE-ReX 支持 30 个 SWE-bench 实例并行（[SWE-ReX README](https://github.com/SWE-agent/SWE-ReX)）；mini-swe-agent 在 SWE-bench verified 上 >74%（[仓库描述](https://github.com/SWE-agent/mini-swe-agent)）。
- **NebulaBench**：UFO³ 论文提出的跨设备基准，55 个任务、5 台机器、10 个类别，含故障注入实验（[arXiv:2511.11332](https://arxiv.org/abs/2511.11332)）。
- **AutoGenBench**：Magentic-One 配套评测工具，内置重复与隔离控制，约束 agent 副作用（[arXiv:2411.04468](https://arxiv.org/abs/2411.04468)、[MSR 博客](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)）。
- **agent-sandbox 的 RL/评测定位**：README 把高吞吐隔离沙箱列为强化学习与评测循环（SWE-bench、R2E-Gym、Ray/RLlib）的基础设施，SandboxWarmPool 预热池降低分配延迟（[README](https://github.com/kubernetes-sigs/agent-sandbox)）。
- **OSWorld 作为设备模型试验场**：LiteCUA 在 OSWorld 上 14.66%（[arXiv:2505.18829](https://arxiv.org/abs/2505.18829)）；OSWorld 的 Daytona provider 直接用 sandbox 作为桌面，无需宿主 KVM（[OSWorld README](https://github.com/xlang-ai/OSWorld)）。

## 9. 系统化工作：Agent-OS 原语与综述（2025–2026）

- **Towards an Agent Operating System — Lessons from Classical and Cloud OS**（[arXiv:2607.25076](https://arxiv.org/abs/2607.25076)，IBM T.J. Watson Research Center，2026-07-27）：把平台软件演化归纳为三阶段——实验（框架林立）、表述（确定少量稳定抽象并精确规定语义）、整合（平台围绕抽象收敛），POSIX 与 Kubernetes 分别是前两次平台浪潮的整合里程碑，agent 生态当前处于实验阶段。方法是对每个 OS/Cloud-OS 原语问三个问题：原来提供什么保证、该保证对 agent 是否成立、需要修改什么。论文指出两类语义失效：结构性的（agent 作用于外部世界、操作不可逆、通信图动态生成、自然语言消息可携带注入）与随机性固有的（最坏执行时间不可计算、replay 无法复现故障、时间局部性对 token 失效、声明式期望状态无法表达自然语言目标、agent 可能策略性隐瞒失败）。提出 13 个 Agent-OS 原语：

| OS 来源 | Cloud-OS 来源 | Agent-OS 原语 | 语义缺口 | 论文标注状态 |
| --- | --- | --- | --- | --- |
| Process | Pod / container | Agent lifecycle | 概率行为；语义身份 | Partial |
| Scheduler | kube-scheduler / HPA | Orchestrator | token 成本不可预测；循环检测 | Open |
| Package mgmt | Helm / OCI registry | Skills registry | 自然语言接口约定；provenance | Open |
| System call | Service mesh / sidecar | Tool mediation | 自然语言语义；未声明副作用 | Partial |
| Virtual memory | ResourceQuota / LimitRange | Context management | 缺乏有理论保证的 token 置换策略 | Open |
| IPC | Service / ClusterIP | A2A communication | 动态图；prompt injection | Partial |
| File system | PersistentVolume / etcd | Agent memory | 语义冲突；意图感知检索 | Early |
| Permissions/ACL | RBAC / NetworkPolicy | Identity & AuthZ | 语义 attestation；运行时上下文授权 | Partial |
| MAC / SELinux | PodSecurityPolicy / OPA | Behavioral guardrails | 自然语言策略；不可判定 | Open |
| Signal / exception | Liveness/readiness probe | Failure detection | 自我隐瞒；开放故障空间 | Open |
| Transaction / journal | Saga / Temporal | Saga & checkpoint | 随机工作流的补偿事务 | Partial |
| Audit / syslog | Prometheus / Jaeger | Trajectory observability | 观测单元未定义；时间位移 | Partial |
| Network stack | Envoy / Istio | AI-aware proxy | proxy 对 prompt 无感知；无 KV-cache 路由 | Early |

  论文把记忆系统演进梳理为：MemGPT（in-context buffer）→ Mem0、Zep/Graphiti（显式存取服务）→ MemOS、MemoryOS、EverMemOS（平台强制的记忆函数与审计），对应应用自管存储到 OS 管理存储的演进。开放研究议程包括：随机调度理论、token 置换的形式化理论、自然语言 guardrail 的可判定策略语言、技能接口语义约定、AI 生成代码的供应链安全（幻觉包名抢注）、agentic RL 的平台支持。
- **rossoctl**（[rossoctl/rossoctl](https://github.com/rossoctl/rossoctl)，[rossoctl.dev](https://www.rossoctl.dev/)）：上述论文的开源原型，构建在 Kubernetes 上。已实现组件：AuthBridge（授权）、SPIFFE/SPIRE（身份 attestation）、MCP Gateway 与 Gateway API（网络策略）、MCPServer/VirtualMCPServer CRD、Agent Execution Environment sidecar（框架无关的隔离/观测/控制点，支持 LangGraph、CrewAI、Marvin、AutoGen）。设计原则：平台强制的原语应用代码无法绕过；扩展 Kubernetes，保留原有基础设施；Apache-2.0，305 stars，最近推送 2026-11-14（[论文第 V 节](https://arxiv.org/html/2607.25076v1)、[仓库](https://github.com/rossoctl/rossoctl)）。
- **Comprehensive Survey of LLM-based Agent Operating Systems**（郭禄祥等，国防科技大学，《计算机科学》2026 年第 53 卷第 1 期 1–11 页，[DOI:10.11896/jsjkx.250500002](https://www.jsjkx.com/EN/10.11896/jsjkx.250500002)）：中文综述，2025-05-06 收稿、2026-01-08 发表，系统梳理 LLM agent 操作系统研究。
- **OS Agents: A Survey on MLLM-based Agents for General Computing Devices Use**（[arXiv:2508.04482](https://arxiv.org/abs/2508.04482)，ACL 2025 有 9 页精简版）：以环境、观察空间、动作空间为基本框架，梳理理解/规划/grounding 能力、领域基础模型与 agent 框架、评测协议，讨论安全隐私、个性化与自进化方向。
- **沙箱生态的快照趋同**：E2B（Firecracker 快照 + pause/resume/fork）、microsandbox（fork & snapshot）、Daytona（VM sandbox 内存快照）、OpenAI Agents SDK（resumable sandbox sessions）、kagent（Substrate snapshots）、agent-sandbox（pause/resume + warm pool）在 2025–2026 年各自提供了快照/恢复能力；CRIU 与 Firecracker snapshot 是这些能力的底层 OS 机制（来源见第 1、4 节各条目）。

## 10. 参考项目清单

许可证与活跃度核实日期：2026-11-20（GitHub API）。"未核实"表示当日 API 未返回或返回异常。

| 项目 | 一句话定位 | URL | 许可证 | 活跃度 |
| --- | --- | --- | --- | --- |
| AIOS | LLM agent 内核：调度、上下文、内存、存储、工具管理 | https://github.com/agiresearch/AIOS | LICENSE 文件为空（1 字节），GitHub 标记 Other | 6.6k stars；推送 2026-07-20 |
| Cerebrum | AIOS SDK，agent 开发/部署/分发 | https://github.com/agiresearch/Cerebrum | 未核实 | 未核实 |
| LiteCUA | AIOS 上的 computer-use agent，计算机即 MCP server | https://github.com/agiresearch/LiteCUA | 未核实 | 未核实 |
| MemGPT | virtual context management 原始仓库，现重定向到 Letta | https://github.com/cpacker/MemGPT | Apache-2.0（与 Letta 同仓库） | 已并入 Letta |
| Letta | stateful agent 平台；V1 API server 退役至 archive 分支 | https://github.com/letta-ai/letta | Apache-2.0 | 25.5k stars；推送 2026-10-18 |
| letta-code | Letta 当前活跃源码：agent harness、MemFS、Dreaming | https://github.com/letta-ai/letta-code | Apache-2.0 | 3.9k stars；推送 2026-11-20 |
| MemOS | 记忆操作系统：MemCube、MemScheduler、多模态记忆 | https://github.com/MemTensor/MemOS | Apache-2.0 | 12.5k stars；推送 2026-11-19 |
| UFO | UFO² Desktop AgentOS（Windows）+ UFO³ 多设备 Galaxy | https://github.com/microsoft/UFO | MIT | 10.2k stars；推送 2026-10-30 |
| OS-Copilot | FRIDAY 通用 OS agent 框架，工具与技能自学习 | https://github.com/OS-Copilot/OS-Copilot | MIT | 1.8k stars；推送 2024-09-09，停滞 |
| OpenHands / Agent Canvas | coding agent 控制中心（原 All-Hands-AI/OpenHands） | https://github.com/OpenHands/OpenHands | MIT | 93.9k stars；推送 2026-11-20 |
| software-agent-sdk | OpenHands V1 SDK + Agent Server：事件流、workspace、委派 | https://github.com/OpenHands/software-agent-sdk | MIT | 1.4k stars |
| E2B runtime | Firecracker 沙箱云运行时（原 e2b-dev/infra） | https://github.com/e2b-dev/runtime | Apache-2.0 | 1.9k stars；推送 2026-11-19 |
| E2B SDK | sandbox SDK + Code Interpreter + Desktop | https://github.com/e2b-dev/E2B | Apache-2.0 | 14.9k stars；推送 2026-11-19 |
| agent-sandbox | Kubernetes Sandbox CRD 与控制器（SIG Apps） | https://github.com/kubernetes-sigs/agent-sandbox | Apache-2.0 | 4.7k stars；推送 2026-11-19 |
| kagent | Kubernetes 原生 agent 框架，CNCF 项目 | https://github.com/kagent-dev/kagent | Apache-2.0 | 4.4k stars；推送 2026-11-20 |
| LangGraph | stateful agent 编排：checkpoint、durable execution、time travel | https://github.com/langchain-ai/langgraph | MIT | 45.2k stars；推送 2026-11-19 |
| Temporal | durable execution 平台，Event History 重放 | https://github.com/temporalio/temporal | MIT | 24.5k stars；推送 2026-11-20 |
| DBOS Transact (Python) | Postgres 检查点的轻量 durable workflows | https://github.com/dbos-inc/dbos-transact-py | MIT | 1.7k stars；推送 2026-11-19 |
| Restate | durable execution：journal、exactly-once 通信、K/V 状态 | https://github.com/restatedev/restate | BUSL-1.1（每版本 4 年后转 Apache-2.0） | 4.7k stars；推送 2026-11-19 |
| SWE-agent | ACI 软件工程 agent，维护模式 | https://github.com/SWE-agent/SWE-agent | MIT | 20.8k stars；推送 2026-11-16 |
| mini-swe-agent | 约 100 行的 SWE agent，SWE-bench verified >74% | https://github.com/SWE-agent/mini-swe-agent | MIT | 9.9k stars；推送 2026-11-16 |
| SWE-ReX | 沙箱 shell runtime interface，本地/云同一接口 | https://github.com/SWE-agent/SWE-ReX | MIT | 651 stars |
| MCP | AI 应用连接外部系统的开放协议（规范 + 文档） | https://github.com/modelcontextprotocol/modelcontextprotocol | MIT → Apache-2.0 过渡；文档 CC-BY-4.0 | 9.7k stars；推送 2026-11-19 |
| A2A | agent 间开放协议，Linux Foundation（AAIF） | https://github.com/a2aproject/A2A | Apache-2.0 | 26.6k stars；推送 2026-11-18 |
| UI-TARS-desktop | 多模态 GUI agent 套件：Agent TARS + UI-TARS Desktop | https://github.com/bytedance/UI-TARS-desktop | Apache-2.0 | 39.6k stars；2026-11-09 归档 |
| AutoGen | 多 agent 框架，Magentic-One 实现所在 | https://github.com/microsoft/autogen | MIT（代码）+ CC-BY-4.0（文档） | 61.9k stars；已归档 |
| Microsoft Agent Framework | AutoGen 官方后继，内置 Magentic orchestration | https://learn.microsoft.com/en-us/agent-framework/ | 未核实（GitHub API 当日返回 404） | 文档更新 2026-10 |
| OSWorld | 真实 OS 多模态 agent 基准（369 任务） | https://github.com/xlang-ai/OSWorld | Apache-2.0 | 3.3k stars；推送 2026-11-14 |
| WindowsAgentArena | Windows 11 agent 基准（150+ 任务，Azure 并行） | https://github.com/microsoft/WindowsAgentArena | MIT | 917 stars；推送 2026-10-26 |
| Claude Agent SDK (Python) | Claude Code 库化：permissions、hooks、subagents、sessions | https://github.com/anthropics/claude-agent-sdk-python | MIT；使用受 Anthropic 商业条款约束 | 8.6k stars；推送 2026-11-19 |
| OpenAI Agents SDK | handoffs、guardrails、sessions、sandbox agents | https://github.com/openai/openai-agents-python | MIT | 30.8k stars；推送 2026-11-20 |
| microsandbox | 本地 microVM 沙箱，fork/snapshot，跨三大桌面平台 | https://github.com/superradcompany/microsandbox | Apache-2.0 | 9.1k stars；beta |
| Daytona | AI 代码执行沙箱基础设施（容器/VM/GPU/macOS） | https://github.com/daytonaio/daytona | API 未检测到标准许可证 | 71.3k stars；仓库已归档，文档仍维护 |
| rossoctl | Kubernetes 上的 Agent-OS 原型（AuthBridge、MCP Gateway） | https://github.com/rossoctl/rossoctl | Apache-2.0 | 305 stars；推送 2026-11-14 |
| Firecracker | KVM microVM VMM，快照/恢复，jailer 隔离 | https://github.com/firecracker-microvm/firecracker | Apache-2.0 | 38.1k stars |
| gVisor | 用户态应用内核沙箱：Sentry 拦截 syscall，Gofer 经 9P 提供文件访问 | https://gvisor.dev/docs/ | Apache-2.0 | 持续维护 |
| CRIU | Linux 进程/容器 checkpoint/restore | https://criu.org/Main_Page | GPL-2.0 | v4.3.1（2026-11-12） |
| seL4 | 形式化验证微内核，capability 访问控制 | https://sel4.systems/ | GPL-2.0（内核） | seL4 17.0.0（2026-10-30） |
| Erlang/OTP | 监督树与 behaviour 的容错进程运行时 | https://www.erlang.org/doc/system/design_principles.html | Apache-2.0 | OTP 29 文档 |
| Plan 9 | 一切皆文件、9P、每进程私有命名空间 | https://plan9.io/sys/doc/9.html | MIT | 历史参照 |
| OTel GenAI semconv | GenAI/agent/MCP 可观测性语义约定 | https://github.com/open-telemetry/semantic-conventions-genai | Apache-2.0 | 552 stars |

论文与综述：

- AIOS: LLM Agent Operating System — https://arxiv.org/abs/2403.16971 （COLM 2025）
- LLM as OS, Agents as Apps — https://arxiv.org/abs/2312.03815
- MemGPT: Towards LLMs as Operating Systems — https://arxiv.org/abs/2310.08560
- Sleep-time Compute: Beyond Inference Scaling at Test-time — https://arxiv.org/abs/2504.13171
- MemOS: A Memory OS for AI System — https://arxiv.org/abs/2507.03724
- MemOS: An Operating System for Memory-Augmented Generation — https://arxiv.org/abs/2505.22101
- From Commands to Prompts: LLM-based Semantic File System for AIOS — https://arxiv.org/abs/2410.11843 （ICLR 2025）
- LiteCUA: Computer as MCP Server for Computer-Use Agent on AIOS — https://arxiv.org/abs/2505.18829
- Cerebrum (AIOS SDK) — https://arxiv.org/abs/2503.11444 （NAACL 2025）
- A-MEM: Agentic Memory for LLM Agents — https://arxiv.org/abs/2502.12110
- UFO2: The Desktop AgentOS — https://arxiv.org/abs/2504.14603
- UFO3: Weaving the Digital Agent Galaxy — https://arxiv.org/abs/2511.11332
- OS-Copilot: Towards Generalist Computer Agents with Self-Improvement — https://arxiv.org/abs/2402.07456
- OpenHands: An Open Platform for AI Software Developers as Generalist Agents — https://arxiv.org/abs/2407.16741
- The OpenHands Software Agent SDK — https://arxiv.org/abs/2511.03690
- SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering — https://arxiv.org/abs/2405.15793 （NeurIPS 2024）
- Magentic-One: A Generalist Multi-Agent System for Solving Complex Tasks — https://arxiv.org/abs/2411.04468
- OSWorld: Benchmarking Multimodal Agents for Open-Ended Tasks in Real Computer Environments — https://arxiv.org/abs/2404.07972 （NeurIPS 2024）
- Windows Agent Arena: Evaluating Multi-Modal OS Agents at Scale — https://arxiv.org/abs/2409.08264
- UI-TARS 模型论文 — https://arxiv.org/abs/2501.12326
- Towards an Agent Operating System — Lessons from Classical and Cloud OS — https://arxiv.org/abs/2607.25076
- OS Agents: A Survey on MLLM-based Agents for General Computing Devices Use — https://arxiv.org/abs/2508.04482 （ACL 2025）
- Comprehensive Survey of LLM-based Agent Operating Systems — https://www.jsjkx.com/EN/10.11896/jsjkx.250500002 （《计算机科学》2026, 53(1)）