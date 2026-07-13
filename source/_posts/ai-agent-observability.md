---
title: AI Agent 可观测性：如何记录推理、工具调用、失败与成本
date: 2026-07-13 14:43:39
description: '「AI Agent 可观测性」—— 面向 AI Agent 开发者，系统介绍如何用 Trace、Span、Log、Metric 记录 Agent 的推理步骤、LLM 调用、工具调用、失败恢复、成本与隐私边界，让 Agent 在生产环境中可调试、可审计、可优化。'
cover: /images/agent-observability-hero.svg
categories:
  - AI 工程
tags:
  - AI Agent
  - 可观测性
  - OpenTelemetry
  - 工具调用
  - 成本优化
---

![AI Agent 可观测性](/images/agent-observability-hero.svg)

> 做 AI Agent 最怕的不是“它答错了”，而是“它为什么答错，没人知道”。普通服务出问题，你还能看日志、看链路、看指标；Agent 出问题，如果没有记录推理步骤、工具调用、上下文、失败原因和成本，就只能靠猜。
>
> **AI Agent 可观测性** 的目标不是把所有对话原文都存下来，而是让每一次 Agent Run 都能被复盘：它看到了什么、决定了什么、调了什么工具、哪里失败、花了多少钱、最后为什么给出这个结果。

**本文脉络：**

- 一、为什么 Agent 比普通服务更需要可观测性
- 二、先区分三件事：日志、指标、Trace
- 三、一次 Agent Run 应该记录成一棵 Trace
- 四、推理过程到底要不要记录
- 五、工具调用怎么记录
- 六、失败要分类，不要只写 error
- 七、成本观测：Token、模型、工具和重试
- 八、质量观测：不要只看成功率
- 九、隐私与安全：可观测性不是全量留存
- 十、落地方案：从最小闭环开始
- 十一、常见问题

<!-- more -->

## 一、为什么 Agent 比普通服务更需要可观测性

普通后端服务的调用链通常比较确定。

用户请求进来，经过网关、服务、缓存、数据库，最后返回。虽然系统可能很复杂，但路径大体是工程师写死的。哪怕出了问题，你也可以沿着 trace 找：哪个接口慢、哪个 SQL 超时、哪个下游 500。

Agent 不一样。

Agent 的路径经常是模型“运行时决定”的：

- 先规划几步？
- 要不要检索知识库？
- 要不要调用工具？
- 调哪个工具？
- 工具失败后重试还是换方案？
- 什么时候停止？
- 什么时候把结果返回给用户？

这意味着 Agent 的问题也更难复现。用户只看到一句“抱歉，我无法完成”，但背后可能是：

| 表面现象 | 真实原因 |
| --- | --- |
| 回答很泛 | 关键上下文没有召回 |
| 答案错了 | 工具返回被模型误读 |
| 执行很慢 | Agent 循环调用了 12 次工具 |
| 成本很高 | 重试时重复带入长上下文 |
| 任务失败 | 某个工具超时后没有降级路径 |
| 行为危险 | 模型把用户输入当成了系统指令 |

没有可观测性，这些原因都藏在黑箱里。

所以 Agent 可观测性要回答的不是“服务挂了吗”这么简单，而是：

> 这次 Agent 为什么走了这条路径？它每一步依据是什么？哪一步开始偏了？下次怎么避免？

## 二、先区分三件事：日志、指标、Trace

AI Agent 可观测性通常离不开三类数据：Log、Metric、Trace。

它们不是互相替代，而是回答不同问题。

| 类型 | 适合回答 | 例子 |
| --- | --- | --- |
| Log | 某个具体事件发生了什么 | 工具调用失败，错误码是 timeout |
| Metric | 一段时间内整体表现如何 | P95 延迟、失败率、平均成本、Token 消耗 |
| Trace | 一次请求完整经历了什么 | 用户请求 → 计划 → LLM 调用 → 工具调用 → 最终回答 |

对 Agent 来说，**Trace 是主干**。

因为 Agent 的问题通常不是单点事件，而是多步组合：第一步计划偏了，第二步检索带错了材料，第三步工具又超时，最后模型只好编了一个看似合理的回答。

如果只有日志，你会看到很多碎片；如果只有指标，你只知道整体变差；只有 Trace 能把碎片串起来。

OpenTelemetry 官方对可观测性的定位也很适合借用：它提供统一的 API、SDK 和 Collector，用来采集 traces、metrics、logs，并把遥测数据发送到后端系统。近两年 GenAI semantic conventions 也在补齐模型调用、token、工具调用等生成式 AI 场景的标准字段。

换句话说，Agent 可观测性最好不要自创一套孤岛格式。能贴近 OpenTelemetry，就更容易接入现有监控体系。

## 三、一次 Agent Run 应该记录成一棵 Trace

一次用户请求，可以看成一次 `agent.run`。

根节点记录这次任务的整体信息，下面挂 Planner、LLM、Tool、Memory、Evaluator 等 span。

![AI Agent Trace 结构](/images/agent-observability-trace.svg)

一个比较实用的结构如下：

| 层级 | 记录对象 | 关键字段 |
| --- | --- | --- |
| Root Trace | 一次 Agent Run | `request_id`、`user_id_hash`、`session_id`、`goal`、`status`、`total_cost` |
| Planner Span | 计划生成 | `plan_id`、`steps_count`、`selected_strategy` |
| LLM Span | 一次模型调用 | `model`、`input_tokens`、`output_tokens`、`latency_ms`、`finish_reason` |
| Tool Span | 一次工具调用 | `tool_name`、`args_schema`、`duration_ms`、`status`、`result_size` |
| Memory Span | 记忆检索或写入 | `query`、`top_k`、`hit_ids`、`scores` |
| RAG Span | 检索增强 | `retriever`、`document_ids`、`scores`、`rerank_model` |
| Eval Span | 质量评估 | `score`、`label`、`judge_model`、`failure_reason` |

这里有两个经验。

第一，**不要只记录最终答案**。最终答案是结果，不是过程。真正能帮你 debug 的，是每一步看到了什么、选择了什么、花了多久。

第二，**不要把所有内容都明文记录**。比如用户隐私、完整 Prompt、完整工具返回都可能包含敏感信息。可以记录 hash、摘要、字段 schema、脱敏片段、引用 ID，而不是全量原文。

## 四、推理过程到底要不要记录

这是 Agent 可观测性里最容易争论的问题。

很多人一听“记录推理”，就想到把模型的完整思维链存下来。这个做法并不推荐。

更可取的是记录**可审计的决策摘要**，而不是完整隐藏推理。

比如记录：

```json
{
  "step": "select_tool",
  "decision": "call_order_status_tool",
  "reason_summary": "user asks refund failure; order status is required before answering",
  "confidence": 0.78
}
```

不要记录：

```json
{
  "chain_of_thought": "非常长的逐字推理过程..."
}
```

为什么？

| 原因 | 说明 |
| --- | --- |
| 安全 | 完整思维链可能泄露系统提示、策略和敏感上下文 |
| 噪声 | 长推理文本很难稳定分析，检索和聚合价值有限 |
| 成本 | 存储和查询成本会变高 |
| 可用性 | 工程排查更需要“决策点 + 依据摘要 + 输入输出 ID” |

所以，“记录推理”更准确地说，是记录 Agent 的**决策轨迹**：

- 当前步骤是什么
- 可选动作有哪些
- 最终选择了什么
- 选择依据摘要是什么
- 是否发生自我修正
- 是否触发安全规则或人工确认

这已经足够支持绝大多数复盘。

## 五、工具调用怎么记录

工具调用是 Agent 最需要观测的部分。

因为工具是模型接触外部世界的地方，也是最容易出现真实副作用的地方：查数据库、发请求、改文件、下单、发消息、提交代码。

每次工具调用至少记录这些字段：

| 字段 | 说明 |
| --- | --- |
| `tool_name` | 工具名，如 `search_docs`、`query_order` |
| `tool_version` | 工具版本，方便定位变更影响 |
| `args_schema` | 参数结构，不一定记录完整参数值 |
| `args_hash` | 参数 hash，用于复现和关联 |
| `start_time` / `duration_ms` | 调用耗时 |
| `status` | success / failed / timeout / cancelled |
| `result_size` | 返回大小，避免超大结果污染上下文 |
| `result_summary` | 脱敏摘要 |
| `side_effect` | 是否有写操作或外部副作用 |
| `permission_level` | read / write / admin / external |

示例：

```json
{
  "span_name": "tool.call",
  "tool_name": "query_order_status",
  "tool_version": "2026-07-01",
  "args_schema": {
    "order_id": "string"
  },
  "args_hash": "sha256:8f3a...",
  "duration_ms": 184,
  "status": "success",
  "result_size": 428,
  "result_summary": "order paid, refund blocked by settlement status",
  "side_effect": false,
  "permission_level": "read"
}
```

这里最重要的是 `side_effect`。

读操作失败，通常只是回答不完整；写操作失败或误调用，可能造成真实损失。比如发邮件、删除文件、修改配置、提交订单，这些都应该在 trace 里被明确标记。

## 六、失败要分类，不要只写 error

很多系统的日志里只有一句：

```text
Agent failed
```

这基本没用。

Agent 失败要分类，否则你无法判断该优化模型、工具、提示词、RAG，还是权限系统。

常见分类可以这样设计：

| 失败类型 | 例子 | 优先排查 |
| --- | --- | --- |
| `llm_error` | 模型 API 失败、限流、超时 | 模型服务、重试策略 |
| `tool_error` | 工具 500、超时、参数错误 | 工具稳定性、参数 schema |
| `retrieval_error` | 没召回关键资料 | RAG、索引、query rewrite |
| `format_error` | 输出不是合法 JSON | 输出约束、解析重试 |
| `permission_error` | 工具权限不足或越权拦截 | 权限系统、工具策略 |
| `context_error` | 上下文缺失、污染、过载 | Context Engineering |
| `loop_error` | Agent 重复调用、无法停止 | Planner、停止条件 |
| `safety_error` | 触发安全规则 | 安全策略、用户输入 |
| `human_intervention` | 需要人工确认 | 产品流程、风险动作 |

失败记录里还要写“恢复动作”：

```json
{
  "failure_type": "tool_error",
  "failure_stage": "query_order_status",
  "error_code": "timeout",
  "retry_count": 2,
  "recovery_action": "fallback_to_cached_order_snapshot",
  "final_status": "degraded_success"
}
```

有了这个字段，你才能区分：

- 失败后成功降级
- 失败后重试成功
- 失败后直接终止
- 失败后模型胡乱补全

最后一种最危险。

## 七、成本观测：Token、模型、工具和重试

Agent 的成本不只是一次模型调用的钱。

它通常由四部分组成：

| 成本来源 | 说明 |
| --- | --- |
| 输入 Token | 系统指令、用户输入、历史摘要、RAG 文档、工具结果 |
| 输出 Token | 模型生成的计划、回答、工具参数 |
| 工具成本 | 搜索 API、数据库查询、代码执行、第三方服务 |
| 重试成本 | 模型重试、工具重试、格式修复、反思再执行 |

很多 Agent 成本失控，不是因为单次模型贵，而是因为循环和重试。

比如一次任务看起来只问了一个问题，背后却发生了：

- 4 次 LLM 调用
- 6 次检索
- 3 次工具调用
- 2 次 JSON 修复重试
- 每次都带 20KB 历史上下文

所以成本指标要能按层级拆：

![AI Agent 可观测性指标面板](/images/agent-observability-dashboard.svg)

建议至少记录：

| 指标 | 用途 |
| --- | --- |
| `agent_run_cost_total` | 单次任务总成本 |
| `llm_input_tokens_total` | 输入 token 消耗 |
| `llm_output_tokens_total` | 输出 token 消耗 |
| `tool_cost_total` | 工具调用成本 |
| `retry_cost_total` | 重试带来的额外成本 |
| `cost_by_model` | 不同模型成本拆分 |
| `cost_by_user` / `cost_by_tenant` | 多租户计费和限额 |
| `cost_by_task_type` | 找出最贵的任务类型 |

成本观测的目标不是单纯省钱，而是知道钱花在哪里。

有些高成本是值得的，比如高风险任务多做一次验证；有些高成本是浪费，比如反复把同一段长文档塞进上下文。

## 八、质量观测：不要只看成功率

Agent 的“成功”很难只靠 HTTP 200 判断。

一个客服 Agent 返回了答案，接口是 200，但答案可能不忠实；一个代码 Agent 生成了 patch，但测试可能没跑；一个数据分析 Agent 给了结论，但 SQL 可能查错表。

质量指标要按任务类型设计。

常见维度包括：

| 指标 | 解释 |
| --- | --- |
| Task Success | 用户任务是否真的完成 |
| Faithfulness | 回答是否忠于证据和工具结果 |
| Tool Correctness | 工具是否选对、参数是否正确 |
| Groundedness | 结论是否有来源或可验证依据 |
| Human Escalation Rate | 需要人工接管的比例 |
| Correction Rate | 用户要求“不是这个意思”的比例 |
| Regeneration Rate | 用户点击重新生成的比例 |
| Safety Intervention Rate | 安全策略拦截比例 |

这里可以结合 LLM-as-Judge，但不要迷信裁判模型。

更稳的做法是混合：

- 规则校验：JSON 是否合法、必填字段是否齐全。
- 工具校验：SQL 是否只读、订单 ID 是否存在。
- 自动评估：用评审模型判断是否忠于证据。
- 人工抽检：对高风险任务定期 review trace。
- 用户反馈：点赞、踩、重试、人工接管。

可观测性和评估最好打通。trace 负责告诉你“发生了什么”，eval 负责告诉你“这样好不好”。

## 九、隐私与安全：可观测性不是全量留存

Agent 可观测性很容易走向另一个危险：为了 debug，把所有 Prompt、用户输入、工具结果、模型输出全存下来。

这在生产环境通常不可接受。

你需要从一开始就设计数据分级：

| 数据 | 建议 |
| --- | --- |
| 用户原文 | 默认脱敏或按需短期保存 |
| Prompt 全文 | 记录版本号、hash、模板变量，不默认明文保存 |
| 工具参数 | 敏感字段脱敏，保留 schema 和 hash |
| 工具结果 | 保留摘要、ID、大小、状态，敏感内容不落库 |
| 模型输出 | 按业务合规要求保存，支持删除 |
| Trace 元数据 | 可长期保存，用于统计和排障 |

几个实用规则：

- 对手机号、邮箱、地址、身份证、银行卡、Token 做自动脱敏。
- 高风险工具调用只记录必要字段，不存完整返回。
- 给 trace 设置保留周期，不要无限期保存。
- 区分 debug 环境和生产环境的记录粒度。
- 支持按用户或租户删除相关观测数据。
- 对内部观测平台做权限控制和审计。

可观测性本身也会成为敏感数据系统。别让排障工具变成新的数据泄露入口。

## 十、落地方案：从最小闭环开始

不建议一开始就做一个巨大的 Agent Observability 平台。

可以按这个顺序落地：

| 阶段 | 目标 | 做法 |
| --- | --- | --- |
| 1. Trace 打通 | 能复盘一次 Agent Run | 记录 root trace、LLM span、tool span |
| 2. 成本可见 | 知道钱花在哪里 | 记录 token、模型、工具、重试成本 |
| 3. 失败分类 | 知道主要失败来自哪里 | 统一 failure_type 和 recovery_action |
| 4. 隐私脱敏 | 避免观测数据变成风险 | 对输入、参数、结果做脱敏和保留周期 |
| 5. 质量评估 | 不只看接口成功 | 接入规则校验、LLM-as-Judge、人工抽检 |
| 6. 告警面板 | 让问题主动浮出来 | 按任务类型看延迟、失败、成本、质量 |

最小版本可以很朴素：

```json
{
  "trace_id": "tr_123",
  "run_id": "run_456",
  "task_type": "customer_refund",
  "status": "degraded_success",
  "total_latency_ms": 4820,
  "total_input_tokens": 6820,
  "total_output_tokens": 940,
  "total_cost_usd": 0.031,
  "spans": [
    {
      "type": "llm.call",
      "model": "example-model",
      "input_tokens": 2400,
      "output_tokens": 320,
      "latency_ms": 1380
    },
    {
      "type": "tool.call",
      "tool_name": "query_order_status",
      "status": "timeout",
      "duration_ms": 2000,
      "recovery_action": "retry"
    }
  ]
}
```

别小看这个最小版本。只要每次 Agent Run 都能被这样串起来，排障效率就会有明显提升。

## 十一、常见问题

| 问题 | 回答要点 |
| --- | --- |
| Agent 可观测性和普通服务可观测性有什么不同？ | 普通服务路径更固定；Agent 路径由模型动态决定，所以更需要记录计划、工具调用、上下文、失败恢复和成本。 |
| 一定要记录完整 Prompt 吗？ | 不一定。生产环境更推荐记录模板版本、hash、变量摘要和脱敏片段，只有在合规允许时短期保存明文。 |
| 推理过程要不要全量保存？ | 不建议保存完整隐藏推理。更实用的是记录决策摘要、可选动作、最终选择、依据摘要和结果。 |
| 成本只看 token 就够了吗？ | 不够。还要看工具成本、重试成本、长上下文成本、不同模型和任务类型的成本。 |
| 用 OpenTelemetry 是否有必要？ | 如果系统要接入现有监控体系，建议尽量贴近 OpenTelemetry。它提供统一的 trace、metric、log 采集模型，GenAI 语义约定也在覆盖模型和工具调用场景。 |
| 如何发现 Agent 在循环？ | 记录每轮 step、tool_name、args_hash、result_hash。如果连续多轮动作和结果高度相似，就可以触发 loop_error 或强制停止。 |
| 可观测性会不会带来隐私风险？ | 会。所以必须设计脱敏、权限、保留周期和删除机制。可观测性不是全量留存。 |

最后给一个判断：

> 一个不能被观测的 Agent，很难真正进入生产。

Demo 里答对几次不难，难的是上线后能解释每一次失败、控制每一次成本、复盘每一次危险动作。可观测性就是 Agent 从“能跑”走向“可运营”的那道门槛。

## 参考资料

- [OpenTelemetry GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
- [Inside the LLM Call: GenAI Observability with OpenTelemetry](https://opentelemetry.io/blog/2026/genai-observability/)
- [LangSmith Observability Docs](https://docs.langchain.com/langsmith/observability)
