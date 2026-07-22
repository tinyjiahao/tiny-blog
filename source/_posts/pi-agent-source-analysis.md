---
title: Pi Agent 源码分析
date: 2026-07-23 10:00:00
description: '「Pi Agent 源码分析」—— 从一次 Prompt 的执行链路出发，拆解 Pi Agent 的仓库分层、CLI 启动、AgentSession 装配、Agent Loop、Provider 适配、工具调用、事件系统、JSONL 会话树、上下文压缩和扩展边界。'
cover: /images/pi-agent-source-hero.svg
categories:
  - AI 工程
tags:
  - PI Agent
  - AI Agent
  - 源码分析
  - Agent Harness
  - 工程化
---

![Pi Agent 源码分析](/images/pi-agent-source-hero.svg)

# Pi Agent 源码分析

Pi Agent 表面上是一个终端编码助手：用户输入任务，模型读取代码、执行命令、修改文件，最后给出结果。

但从源码看，Pi 是一套分层的 Agent Harness：底层统一不同模型的流式接口，中间层维护 Agent 状态并运行模型—工具循环，上层负责会话、扩展、上下文和终端交互。

本文将回答一个根本的问题：

> 当用户在终端中提交一条 Prompt 后，这条消息到底经过了哪些对象、函数和数据结构，最终如何驱动模型完成一系列真实操作？

## 一、先看仓库的分层

与 Pi Agent 执行直接相关的代码主要分布在四个 package 中：

![Pi Agent 仓库分层](/images/pi-agent-source-layers.svg)

```text
packages/
├── ai/             统一模型、消息与 Provider API
├── agent/          Agent 状态、Agent Loop、工具调度与事件
├── coding-agent/   CLI、AgentSession、工具、会话、扩展与运行模式
└── tui/            终端输入、组件和差量渲染
```

它们的依赖方向是：

```text
pi-coding-agent ──→ pi-agent-core ──→ pi-ai
        │                              ↑
        ├──────────────────────────────┘
        └────────→ pi-tui
```

四层分别解决四类问题。

| 层级 | 核心问题 | 主要入口 |
|---|---|---|
| `pi-ai` | 如何用统一方式调用不同模型 | `packages/ai/src/types.ts`、`api/`、`providers/` |
| `pi-agent-core` | 如何让模型持续调用工具完成任务 | `agent.ts`、`agent-loop.ts`、`types.ts` |
| `pi-coding-agent` | 如何把通用 Agent 组装成编码产品 | `main.ts`、`core/sdk.ts`、`core/agent-session.ts` |
| `pi-tui` | 如何将事件流实时呈现在终端 | `tui.ts`、`components/`、interactive mode |

源码阅读中最容易混淆的是 `Agent` 与 `AgentSession`。可以先记住这个区别：

- `Agent` 负责一次运行中的状态与循环；
- `AgentSession` 负责一个长期编码会话的产品能力。

## 二、完整调用链

一次交互式 Prompt 的主路径可以压缩为：

![一次 Prompt 的源码级流转](/images/pi-agent-source-prompt-flow.svg)

```text
用户输入
  ↓
InteractiveMode
  ↓
AgentSession.prompt()
  ↓
Agent.prompt()
  ↓
agentLoop()
  ↓
Provider stream
  ↓
assistant message / tool calls
  ↓
executeToolCalls()
  ↓
toolResult messages
  ↓
下一轮 Provider stream
  ↓
AgentSession 保存事件与会话
```

真正重要的不是函数数量，而是数据在调用链中的形态变化：

```text
终端文本
  → AgentMessage
  → LLM Message
  → Provider 请求
  → 流式事件
  → AssistantMessage
  → ToolCall
  → ToolResultMessage
  → 新一轮模型上下文
```

下面从入口开始逐层展开。

## 三、CLI 入口：Pi 如何启动

`pi` 命令在 `packages/coding-agent/package.json` 中指向构建后的 `dist/cli.js`。源码入口 [cli.ts](../packages/coding-agent/src/cli.ts) 很薄，主要完成异常处理，然后将参数交给 `main()`。

真正的启动编排位于 [main.ts](../packages/coding-agent/src/main.ts)。`main(args)` 需要完成的工作远多于参数解析：

1. 解析 CLI 参数；
2. 分流 install、update、config 等包管理命令；
3. 判断 interactive、print、JSON 或 RPC 模式；
4. 确定当前目录和目标会话；
5. 处理 Project Trust；
6. 加载全局与项目设置；
7. 初始化认证与模型注册表；
8. 加载 Extensions、Skills、Prompt Templates 和主题；
9. 创建 `AgentSession`；
10. 启动对应的表现层。

这里有一个重要的安全顺序：项目级设置和可执行扩展不能在信任决策之前直接加载。Pi 会先发现可能需要信任的项目资源，再根据交互选择、保存的决定或非交互默认策略确定是否启用它们。

因此，启动过程不是简单的：

```text
解析参数 → 创建 Agent
```

而更接近：

```text
解析意图 → 确定环境边界 → 加载资源 → 装配运行时 → 选择交互表面
```

## 四、`createAgentSession()`：依赖装配中心

SDK 工厂 [core/sdk.ts](../packages/coding-agent/src/core/sdk.ts) 中的 `createAgentSession()` 是理解对象关系的最佳入口。

它将分散的基础设施组合起来，包括：

- `AuthStorage`：保存 API Key 与 OAuth 凭据；
- `ModelRegistry`：发现和解析可用模型；
- `SessionManager`：持久化或恢复会话；
- `SettingsManager`：合并全局和项目设置；
- `ResourceLoader`：加载上下文文件、Skills、模板和主题；
- `ExtensionRunner`：管理扩展生命周期；
- Coding Tools：创建文件、搜索和 Shell 工具；
- `Agent`：底层通用运行时；
- `AgentSession`：产品级会话协调器。

其核心装配关系可以写成简化伪代码：

```ts
const tools = createCodingTools(cwd, options);

const agent = new Agent({
  initialState: {
    systemPrompt,
    model,
    thinkingLevel,
    tools,
    messages,
  },
  convertToLlm,
  transformContext,
});

const session = new AgentSession({
  agent,
  sessionManager,
  modelRegistry,
  settingsManager,
  extensionRunner,
});
```

这段伪代码展示了 Pi 的依赖注入思路：`Agent` 不负责寻找模型、扫描文件或读取用户设置，它只接收已经准备好的状态和回调。

## 五、`AgentSession`：产品层的总协调器

[agent-session.ts](../packages/coding-agent/src/core/agent-session.ts) 是 Coding Agent 中体量最大的核心文件之一。它并没有重新实现 Agent Loop，而是在 `Agent` 外围增加产品行为。

`AgentSession.prompt()` 接收用户输入后，主要处理以下工作：

- 识别 Skills 调用和 Prompt Template；
- 运行扩展提供的输入与生命周期 Hook；
- 处理正在运行时的 steering 或 follow-up；
- 将文本和图片转换成 Agent 消息；
- 调用底层 `agent.prompt()`；
- 处理重试和上下文溢出；
- 在需要时触发自动 Compaction；
- 将 Agent 事件写入会话并转发给 UI。

`AgentSession` 的存在说明，通用 Agent Runtime 与完整 Coding Agent 产品之间还有很大距离。

底层 `Agent` 只需要知道：

```text
我有哪些消息、模型和工具？
```

而 `AgentSession` 还必须回答：

```text
消息是否要持久化？
当前项目是否可信？
上下文是否需要压缩？
扩展能否拦截这次调用？
错误是否应该重试？
用户是在 steering 还是排队 follow-up？
```

## 六、`Agent`：状态与运行入口

[agent.ts](../packages/agent/src/agent.ts) 中的 `Agent` 是一个有状态对象。它保存两类信息。

第一类是业务状态：

- `systemPrompt`
- `model`
- `thinkingLevel`
- `tools`
- `messages`

第二类是运行状态：

- `isStreaming`
- `streamingMessage`
- `pendingToolCalls`
- `errorMessage`
- steering queue
- follow-up queue

`prompt()` 与 `continue()` 是两个主要入口：

- `prompt()` 会先追加新的用户消息；
- `continue()` 不添加消息，直接从已有上下文继续运行。

二者最终都进入内部运行方法，创建 `AbortController`，将 Agent 配置传给低层 `agentLoop()`，并消费返回的事件流。

`Agent` 自身没有使用显式 `enum` 表示状态机。状态变化由事件归约而来。例如：

- `agent_start` 将运行标记为开始；
- `message_update` 更新正在流式生成的消息；
- `tool_execution_start` 增加 pending tool call；
- `tool_execution_end` 移除 pending tool call；
- `agent_end` 完成本次运行。

这使事件既是 UI 的观察接口，也是 Agent 内部状态变化的驱动信号。

## 七、Agent Loop：真正的执行核心

[agent-loop.ts](../packages/agent/src/agent-loop.ts) 是 Pi Agent 最值得精读的文件。

对外暴露的主要入口是：

- `agentLoop()`：从新 Prompt 开始；
- `agentLoopContinue()`：从已有消息继续；
- `runAgentLoop()`：直接运行并等待结果；
- `runAgentLoopContinue()`：直接继续并等待结果。

它们最终进入 `runLoop()`。忽略事件细节后，主循环可以简化为：

```ts
let pendingMessages = prompts;

while (true) {
  while (pendingMessages.length > 0 || hasToolCalls) {
    append(pendingMessages);

    const assistant = await streamAssistantResponse(context);
    const toolResults = await executeToolCalls(assistant);

    append(assistant, toolResults);

    if (shouldStopAfterTurn()) break;

    pendingMessages = await getSteeringMessages();
  }

  const followUps = await getFollowUpMessages();
  if (followUps.length === 0) break;

  pendingMessages = followUps;
}
```

这段循环揭示了三个关键事实。

### 1. 一次 Prompt 不等于一次模型调用

只要 assistant message 中包含工具调用，Pi 就会执行工具、生成 `toolResult`，然后再次调用模型。

### 2. 一个 turn 有明确边界

一个 turn 包含一次模型响应以及这次响应触发的全部工具调用。完成后发出 `turn_end`，然后才判断是否进入下一轮。

### 3. Steering 与 Follow-up 的优先级不同

Steering 用于改变正在进行的任务，会在 turn 边界优先注入；Follow-up 只有在当前工具链和 steering 都处理完后才会进入新的循环。

## 八、上下文如何送到模型

`streamAssistantResponse()` 在真正调用 Provider 前，会依次执行两层转换：

```text
AgentMessage[]
  ↓ transformContext()
AgentMessage[]
  ↓ convertToLlm()
Message[]
  ↓ Provider adapter
Provider-specific request
```

两层转换的职责不同。

`transformContext()` 面向 Agent 消息，可以：

- 裁剪历史；
- 注入动态上下文；
- 执行自定义 Compaction；
- 实现 RAG 或长期记忆。

`convertToLlm()` 则负责协议边界：

- 过滤 UI 专用消息；
- 将自定义 Agent 消息转换成标准 LLM 消息；
- 保证最终只包含模型能够理解的 user、assistant 和 tool result。

Pi 将这两步分开，是因为“模型应该看到哪些上下文”和“消息如何满足 Provider 协议”并不是同一个问题。

## 九、`pi-ai`：统一 Provider 差异

[packages/ai/src/types.ts](../packages/ai/src/types.ts) 定义了模型层的公共语言，包括：

- `Model`
- `Message`
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`
- 文本、图片、thinking 和 tool call content block
- 流式事件
- usage 与 stop reason

不同 Provider 的适配器位于 `packages/ai/src/api/` 和 `packages/ai/src/providers/`。

例如 OpenAI Responses、Anthropic Messages 和 Google Generative AI 的请求格式不同，但 Agent Loop 不直接判断 Provider 类型。适配器负责把统一消息转换成厂商请求，再将厂商流转换成统一事件。

因此，上层看到的是：

```text
text_delta
thinking_delta
toolcall_delta
done
error
```

而不是某一家 SDK 的专用对象。

这层抽象让 Pi 可以在一个会话中切换模型，同时保持工具循环与 UI 事件语义基本一致。

## 十、工具调用如何落地

工具在 `AgentTool` 中包含名称、描述、TypeBox 参数 Schema 和 `execute()` 函数。

![Pi Agent 工具调用流水线](/images/pi-agent-source-tool-pipeline.svg)

模型生成 tool call 后，`executeToolCalls()` 会经历以下阶段：

1. 根据名称查找工具；
2. 解析并校验参数；
3. 发出 `tool_execution_start`；
4. 运行 `beforeToolCall`；
5. 执行工具主体；
6. 接收可选的进度更新；
7. 运行 `afterToolCall`；
8. 发出 `tool_execution_end`；
9. 创建标准 `ToolResultMessage`。

Pi 支持 parallel 与 sequential 两种工具执行模式。

默认并行模式下：

- preflight 按源顺序执行；
- 获准工具可以并发运行；
- 完成事件按真实完成顺序发出；
- 写入上下文的 tool result 仍按 assistant 中的调用顺序排列。

如果某个工具要求 sequential，整个 batch 会顺序执行。这避免具有副作用或顺序依赖的调用被错误并发。

Coding Agent 提供的本地工具位于 `packages/coding-agent/src/core/tools/`，包括 `read`、`bash`、`edit`、`write`、`grep`、`find` 和 `ls`。这些才是模型访问文件系统和进程的真实入口。

## 十一、事件为什么贯穿整个系统

Agent Loop 不直接调用 TUI，而是不断发出事件：

```text
agent_start
turn_start
message_start
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
```

事件被多个层级消费：

- `Agent` 用事件更新内部运行状态；
- `AgentSession` 用事件保存消息和协调重试、压缩；
- Interactive Mode 用事件增量更新 TUI；
- JSON Mode 将事件直接输出为 JSONL；
- RPC Mode 将事件转成进程协议；
- SDK 调用方可以订阅同一套生命周期。

这种设计把执行核心与表现层解耦。Agent Loop 不需要知道自己运行在终端、脚本还是另一个应用内部。

## 十二、会话为什么是 JSONL 树

[session-manager.ts](../packages/coding-agent/src/core/session-manager.ts) 负责 Coding Agent 会话。

![Pi Agent JSONL 会话树与上下文压缩](/images/pi-agent-source-session-tree.svg)

Pi 使用 append-only JSONL 保存 entry。每个 entry 带有自己的 `id`，并通过 `parentId` 指向父节点，因此一份会话文件可以形成树，而不是只能保存线性消息列表。

会话中保存的不只有消息，还包括：

- 模型切换；
- thinking level 切换；
- Compaction；
- Branch Summary；
- 标签；
- 自定义扩展数据；
- Session Info。

恢复会话时，Pi 从当前叶节点沿 `parentId` 回溯，重建当前活动分支，再将 entry 转换成 Agent 上下文。

这套结构直接支撑：

- `/tree`：在同一会话树中切换节点；
- `/fork`：从某条历史路径创建新会话；
- `/clone`：复制当前活动分支；
- `/export`：导出可阅读记录。

树结构的代价是恢复逻辑比线性日志复杂，但它完整保留了探索过程，不需要覆盖失败路径。

## 十三、长上下文如何处理

随着工具结果和消息不断增加，模型上下文最终会接近上限。Pi 通过 Compaction 将较早历史总结成更短的上下文表示。

自动压缩有两种典型触发方式：

- proactive compaction：在接近上限时提前压缩；
- overflow recovery：Provider 报告上下文溢出后压缩并重试。

Compaction 不会删除 JSONL 中的原始历史。它只追加一个压缩 entry，并改变后续构建模型上下文的起点。因此：

```text
模型看到的是压缩后的上下文
会话文件保留的是完整历史
```

这一点体现了 Pi 对“运行上下文”和“审计历史”的区分。

## 十四、扩展系统插在哪里

Pi 的 Extension 不是简单的工具注册表。它可以介入多个层级：

- 注册工具、命令与快捷键；
- 注册或替换 Provider；
- 监听 Agent、Turn、Tool 和 Session 事件；
- 在 Provider 请求前修改上下文；
- 在工具执行前阻止调用；
- 自定义消息渲染；
- 添加 TUI Widget、Overlay、Header 或 Footer；
- 改写 Compaction、权限与远程执行策略。

这解释了 Pi 为什么可以不内置 MCP、Sub-agent、Plan Mode 和权限弹窗。核心提供的是稳定原语与生命周期插槽，具体策略可以由扩展实现。

代价同样明确：Extension 运行在 Pi 进程中，拥有与进程相同的系统权限。可扩展性并不自动等于安全隔离。

## 十五、一次 Prompt 的源码级复盘

现在可以把完整过程重新串起来。

用户在 TUI 中输入一条任务后：

1. Interactive Mode 将文本交给 `AgentSession.prompt()`；
2. `AgentSession` 处理模板、Skills、扩展和消息排队；
3. `Agent.prompt()` 将 user message 加入初始 Prompt；
4. `agentLoop()` 发出 `agent_start` 与 `turn_start`；
5. `streamAssistantResponse()` 转换上下文并调用 `pi-ai`；
6. Provider 的流式片段变成 assistant message update；
7. 如果 assistant 包含 tool call，`executeToolCalls()` 校验并执行；
8. 工具结果转换成 `ToolResultMessage`；
9. Agent Loop 将结果加入上下文并开始下一个 turn；
10. 模型不再请求工具后，循环检查 steering 与 follow-up；
11. 没有待处理消息时发出 `agent_end`；
12. `AgentSession` 完成持久化，TUI 保留最终显示。

最核心的一行仍然是：

```text
messages → model → tool calls → tool results → messages
```

Pi 的其他模块，都在保证这个循环可扩展、可观察、可恢复并适合真实工程环境。

## 总结

Pi Agent 的源码可以归纳成三层核心循环：

```text
Provider 层：统一不同模型的消息与流
Agent 层：循环调用模型和工具
Session 层：把循环变成可持久化、可扩展的编码产品
```

`pi-ai` 解决模型差异，`pi-agent-core` 解决 Agent 执行，`pi-coding-agent` 解决工程产品化，`pi-tui` 解决交互呈现。

因此，从源码角度看，Pi Agent 的本质并不复杂：它是一个围绕消息构建的模型—工具循环。但要让这个循环在真实工程环境中可靠运行，就需要状态、事件、Provider 适配、会话树、上下文压缩和扩展边界共同协作。
