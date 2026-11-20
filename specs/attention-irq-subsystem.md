# Spec: 注意力中断调度器（attention IRQ subsystem）

面向 osagentic 项目，作为 dsh-superagent 的扩展层。沿用 dsh-superagent 领域词汇：Source、Trigger、Thread、Channel、Policy、Eval、Gate、Assessment、Decision、Mandate、Ticket、Assignment、Subscription、Fan-out、Executor、Report、Attention、Disposition、Input、Scope、Strength、Main Session、Executor Session、Outbox、Effects、Passes。

## Problem Statement

dsh-superagent 的核心原则是"消耗尽可能少的人类注意力，给出尽可能多的价值"，DeepSeek 的设计文章把人类注意力定为新的瓶颈。但原型对注意力的管理是启发式规则：问题立即转发、进展留在 Ticket、turn 内的 relay 合并到下一步、一次问一个具体问题、面板只列出需要人的项。

这些规则没有把注意力当作可度量、可调度、可预算的稀缺资源。当多个 Executor 并发产生 question / progress / ready / blocked / failed 时，团队成员会被碎片化通知频繁打断；高价值紧急决策可能被低价值通知淹没；没有人均/团队的注意力配额，也没有"价值 > 注意力成本"的量化反馈。operator 无法判断 agent 究竟消耗了团队多少注意力、这些注意力是否换来了相应价值。

## Solution

把人类注意力建模为可调度的稀缺资源，用操作系统中断子系统的理论替换启发式规则。每个需要人类介入的事件视为一个中断请求（IRQ），携带来源、紧急度、价值估计、截止时间、目标接收人、预计所需注意力时长。

调度器提供：注意力预算（per person / per team / per time window，类似 cgroups 配额）；上半部/下半部分类（threaded IRQ：急需决策的立即送达且不可节流，可延迟的进入调度队列）；中断合并（adaptive coalescing：按接收人+时间窗+主题聚合，负载越高窗口越大）；QoS 调度（优先级+截止时间+价值/成本比排序）；节流（预算耗尽时延后低价值中断）；自适应（按响应延迟与历史价值调整窗口与权重）；度量（记录每次中断的注意力成本与产出价值，把 philosophy 的定性原则变成优化目标）。

调度器复用 dsh-superagent 现有基础设施（Notices、Effects、Outbox、Store、Passes、Panel、DomainEvents），是增量式扩展，不引入新的内部 seam，不新增大量领域概念（遵循"few concepts / few settings"原则）。

## User Stories

1. 作为团队成员，我想要只在必须决策或能用上结果时被打断，以便把注意力留给真正重要的事。
2. 作为团队成员，我想要进展类通知被合并成一条摘要，以便不被碎片化消息频繁打断。
3. 作为团队成员，我想要阻塞/失败且急需我回答的问题立即送达，以便工作不因通知调度而停滞。
4. 作为团队负责人，我想要为每个人设置注意力预算（单位时间内的中断次数与时长上限），以便保护成员不被过载。
5. 作为团队负责人，我想要为整个团队设置注意力预算，以便控制 agent 对团队整体注意力的消耗。
6. 作为团队负责人，我想要预算耗尽时低价值中断被节流或延后，以便注意力优先留给高价值事项。
7. 作为团队负责人，我想要高价值、紧急的中断永远不被节流，以便关键决策不被延误。
8. 作为团队负责人，我想要按优先级+截止时间+价值/成本比排序送达通知，以便最重要的事先被看到。
9. 作为团队负责人，我想要负载越高合并窗口越大（自适应合并），以便繁忙时段进一步减少打断。
10. 作为团队负责人，我想要调度器根据接收人响应延迟与历史产出价值自适应调整权重，以便长期优化注意力分配。
11. 作为团队负责人，我想要用默认值替代大多数设置，以便不必逐项配置就能运行。
12. 作为团队负责人，我想要用文字描述的行为成为 prompt 文本而非新增设置，以便保持概念与设置精简。
13. 作为团队负责人，我想要在面板上看到每个人的剩余注意力预算与中断队列，以便量化"只列出需要人的项"。
14. 作为团队负责人，我想要在面板上看到被合并/节流的中断统计，以便判断调度是否过激。
15. 作为团队负责人，我想要在面板上看到每次中断的注意力成本与产出价值度量，以便验证"价值 > 成本"原则。
16. 作为团队负责人，我想要调整预算与合并窗口后策略版本化生效，以便变更可追溯、可回退。
17. 作为团队负责人，我想要策略变更影响到的待决中断被重新评估，以便运行中的工作与新规则一致。
18. 作为团队成员，我想要合并后的摘要保留每个原始事项的可追溯链接，以便需要时能展开细节。
19. 作为团队成员，我想要 acknowledgement 仍先于 answer/result 送达，以便对话顺序不被合并打乱。
20. 作为团队成员，我想要同一 Ticket 同一会话的消息保持有序，以便上下文连贯。
21. 作为团队成员，我想要紧急问题以结构化、一次一个的形式送达，以便我能直接回答而非阅读长报告。
22. 作为团队成员，我想要被节流的中断在预算恢复后补发，以便重要事项最终不被丢失。
23. 作为团队成员，我想要暂停处理期间不收到新通知，以便暂停真正生效。
24. 作为团队成员，我想要暂停结束后截止时间按暂停时长顺延，以便不因暂停而误判超时。
25. 作为主 Session（Router），我想要 relay/notice 的送达时机由调度器决定，以便我不被低价值中继淹没。
26. 作为主 Session，我想要紧急 worker 问题仍立即中继，以便我能及时协调人工决策。
27. 作为 Executor（worker），我想要我的 progress 报告被调度器聚合后再送达人类，以便我的正常工作不产生噪音。
28. 作为 Executor，我想要我的 blocked/failed 报告立即触发上半部中断，以便尽快获得人工输入。
29. 作为 Executor，我想要我直接在 Session 里与人协作时不被调度器阻拦，以便人工直接介入始终可用。
30. 作为运维，我想要预算与中断队列状态持久化并在重启后恢复，以便进程重启不丢失调度状态。
31. 作为运维，我想要重启后待决中断被恢复且不重复送达，以便恢复是幂等的。
32. 作为运维，我想要调度器复用 Outbox 的重试与 receipt，以便送达失败按既有退避策略处理。
33. 作为运维，我想要调度器健康状态上报到 HealthBoard，以便故障可见。
34. 作为运维，我想要 Source 关闭时其中断等待而非丢弃，以便与既有 Outbox 行为一致。
35. 作为扩展开发者，我想要调度器作为现有端口上的扩展层而非新内部 seam，以便测试与替换都在边界进行。
36. 作为扩展开发者，我想要调度器决策可注入时钟离线 replay，以便用历史事件评测策略。
37. 作为扩展开发者，我想要 A/B 对比启发式规则与调度器的注意力成本与产出价值，以便量化改进。
38. 作为扩展开发者，我想要误抑制率（紧急中断被延迟比例）作为正确性约束测试，以便保证正确性优先于优化。
39. 作为团队成员，我想要多个接收人各自独立计费注意力预算，以便群发通知不被重复计为一人负担。
40. 作为团队负责人，我想要 Feishu 字数限制与 GitHub 线程规则在合并后仍被遵守，以便聚合消息合法送达。

## Implementation Decisions

- 调度器是介导人类中断的调度层，位于 Notices（产生 Main Session 消息与 relay）与 Outbox/Channel 送达之间，并作用于 relay / notice / reply Effects 的执行时机。它决定"何时、以何种聚合形式、发给谁、是否抑制"，实际发送仍由 Outbox 完成。
- 遵循"few concepts"原则：中断不新增独立领域实体，而是从现有 Report / Attention / DomainEvents 派生的调度视图。新增概念最小化：注意力预算（attention budget）作为 Settings/Policy 的属性，IRQ 分类与调度作为调度层内部关注点。
- 上半部/下半部分类：上半部 = 必须立即决策才能继续的中断（waitsForPerson 为真、Attention 待答、blocked/failed 等待人工输入），立即送达，不可节流、不可合并、不可延迟，类比不可屏蔽的实时中断。下半部 = 可延迟中断（progress、ready 待审、低价值 notice），进入可调度队列。
- 注意力预算：per person / per team / per time window 的配额（中断次数与预计注意力时长），作为新聚合存入 Store，单写者，事务一致。送达时计费；预算耗尽时下半部中断被节流或延后，预算恢复后补发。多接收人各自独立计费。
- QoS 调度：下半部队列按 优先级 + 截止时间 + 价值/成本比 排序送达（mq-deadline / BFQ 思路）。价值估计来自 Report 类型与 Ticket 状态；成本估计来自预计所需注意力时长。
- 中断合并：按接收人 + 时间窗 + 主题聚合多个下半部中断为一条摘要，保留每个原始事项的可追溯链接。自适应合并：负载越高窗口越大（adaptive interrupt moderation / timer slack）。合并不得破坏 Outbox 的 per-ticket-per-conversation 有序性，acknowledgement 必须先于 answer/result。
- 自适应权重：根据接收人响应延迟、当前负载、历史产出价值动态调整合并窗口与优先级权重。
- 复用 Effects 持久队列：调度决策在 relay / notice / reply effect 执行前介入；延迟送达用既有退避与 `Later`（EAGAIN 语义）表达，不新增并行队列机制。Passes 与注入的 now 时钟驱动合并窗口与截止时间。
- 复用 Outbox：送达失败按既有指数退避重试，receipt 与 drop 语义不变；Source 关闭时中断等待而非丢弃。
- 度量：每次中断记录注意力成本（次数、时长、打断时机）与产出价值（任务推进、决策质量），作为 Store 读查询暴露给 Panel。可选新增 DomainEvents（irq.delivered / irq.coalesced / irq.throttled），当前无消费者也可记录。
- Settings/Policy 集成：预算上限、合并窗口、优先级权重作为版本化 Settings；默认值替代大多数设置；文字描述的行为成为 prompt 文本。策略版本变更经 policyChanged 通知受影响的待决中断并重新评估。仅面板可改动影响执行环境的字段。
- 暂停交互：暂停期间不送达（与既有 pause 停止 replies 一致）；恢复后截止时间按暂停时长顺延（与 Eval deadline 顺延一致）。
- 恢复/重启：预算与队列状态随 Store 持久化，重启后恢复待决中断；恢复幂等，不重复送达（与既有 restart recovery note、先查目录/git/GitHub 再重复外部动作一致）。
- 健康与面板：调度器在 HealthBoard 认领健康条目；Panel 增加剩余预算、队列深度、合并/节流统计、成本/价值度量视图，即"只列出需要人的项"的量化版本。
- 不阻碍人工直接介入：调度器只介导自动通知流，绝不阻拦人直接在 Executor Session 里协作（与 rejected concept"阻塞时锁住全部工具"一致）。
- Channel 约束：合并后的消息仍遵守 Feishu 字数限制与 GitHub 线程/回复规则（复用既有 Outbox/links 行为）。
- 技术栈与形态：TypeScript，与原型一致，作为 dsh-superagent 的扩展模块；不修改 DeepSeek Harness 内部。

## Testing Decisions

- 好测试只断言外部行为，不断言内部实现：人类接收人收到什么消息、何时收到、以何种聚合形式、什么被抑制/节流，以及 Attention / panel 的读状态。不断言调度器内部队列结构或分类算法。
- 单一最高层 seam：Source/Channel 外部边界。fake Source 经 SourceContext.receive 注入 Trigger，fake Channel 记录 Outbox.send 的送达；可控时钟经 Engine 的 now 注入驱动 Passes / Effects / 合并窗口 / 截止时间。整个运行时 + 调度器在此边界做黑盒测试。复用现有 SourceContext / Outbox / now 端口，不新增内部 seam。
- 被测模块：运行时整体 + IRQ 调度层在边界处的可观察契约（送达流、抑制、聚合、预算计费、有序性、恢复）。
- 正确性约束测试（非优化项）：上半部紧急中断永不节流/合并/延迟；误抑制率趋近零；acknowledgement 先于 answer/result；per-ticket-per-conversation 有序；预算计费精确；重启恢复待决中断且幂等无重复送达。
- 评测/replay：从 Store  replay 历史 Trigger / Ticket / Report / Decision 事件，构造多 Executor 并发工作负载；A/B 对比原型启发式规则与调度器；指标含人均中断次数、打断间隔、决策等待时间、任务完成价值、合并/节流比例、误抑制率。
- 测试确定性、隔离、全套件安全：fake 时钟、fake Source/Channel，无真实网络。
- Prior art：dsh-superagent 既有测试（pnpm check 运行 typecheck/tests/build），尤其 Engine 事务测试、Effects 重试与有序测试、Outbox 有序测试、restart/recovery 测试；原型已在端口边界用 fake 做测试，本 spec 沿用同一风格。

## Out of Scope

- 安全边界 / 沙箱：原型明确声明 wrappers 与目录是默认值而非安全边界，worker 以 operator 的 OS 用户身份无审批执行命令、可用绝对路径绕过 blocked commands。真正的隔离/权限强制是独立工作。
- Async ReAct / worker 内部推理与执行重叠。
- worker 内部的虚拟上下文 / 按需分页记忆管理。
- 跨设备持久执行 / 进程迁移 / 服务端 worker。
- 计算资源调度：WorkerSlots 的 token 预算抢占、模型路由（big.LITTLE）。本 spec 调度人类注意力，不调度计算。
- GitHub/Feishu 之外的新 Source。
- 修改 DeepSeek Harness 内部。
- auto-merge 逻辑 / Delivery requirements（由 prompt 治理）。
- 跨 Source 身份映射（rejected concept）。

## Further Notes

- 本项目直接命中 DeepSeek 的核心命题"human attention is the new bottleneck"，把 philosophy 的"价值 > 注意力成本"定性原则变成可调度、可度量、可优化的子系统。
- OS 中断子系统理论成熟（threaded IRQ、adaptive coalescing、QoS 调度、cgroups 配额、/proc/interrupts 度量），移植路径明确；把人类注意力建模为带预算与 QoS 的可调度资源，在现有 agent 框架里是空白。
- 遵循原型"few concepts / few settings / 面板只列出需要人的项 / 文档按序阅读"的设计约束。
- 背景参考：docs/os-agent-systems.md（OS × agent 映射调研文档）提供机制对照上下文。
- 原型为研究代码（MIT，TypeScript，非生产就绪），扩展需先审阅适配；本 spec 的调度层不改变原型"研究原型"定位。
- 发布：GitHub issue #1（https://github.com/Theater-ahyeon/osagentic/issues/1），已标记 ready-for-agent。
