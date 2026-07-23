---
title: Pi Agent Extension 可监听事件速查
date: 2026-07-23 12:00:00
description: '「Pi Agent Extension 可监听事件速查」—— 按启动、Session、Agent、Provider、Turn、Message、Tool 和模型设置分组，整理 Pi Agent Extension 可以监听的事件、触发时机、能否返回结果改写流程，以及常用监听代码示例。'
cover: /images/pi-agent-extension-events-hero.svg
categories:
  - AI 工程
tags:
  - PI Agent
  - Extension
  - AI Agent
  - Agent Harness
  - 事件系统
---

![Pi Agent Extension 可监听事件速查](/images/pi-agent-extension-events-hero.svg)

> 写 Pi Agent Extension 时，真正容易卡住的不是 `pi.on(...)` 怎么写，而是“不知道该监听哪个事件”。同样是想加一条规则，有时应该拦 `tool_call`，有时应该改 `before_agent_start`，有时只是监听 `agent_end` 做通知。
>
> 这篇就是一份事件速查表：按 Pi 的运行链路分组，说明每个事件什么时候触发、适合做什么、哪些事件能返回结果改变流程。

```
本文脉络：
  一    怎么理解 Pi 的事件系统
  二    启动和资源发现事件
  三    Session 事件
  四    Agent 和 Provider 事件
  五    Turn 和 Message 事件
  六    Tool 事件
  七    模型设置事件
  八    最常用的监听写法
  九    选择事件的经验
```

<!-- more -->

## 一、怎么理解 Pi 的事件系统

Pi Extension 的事件系统可以理解成一组运行时插槽。

有些插槽只是通知你“发生了什么”，比如 `agent_start`、`turn_end`、`model_select`。这类事件适合做日志、状态栏、通知和统计。

另一些插槽允许你返回结果，从而改变 Pi 的行为，比如：

| 事件 | 可以改变什么 |
| --- | --- |
| `input` | 改写用户输入，或直接处理掉 |
| `before_agent_start` | 修改 system prompt，插入 custom message |
| `context` | 替换送给模型的 messages |
| `tool_call` | 拦截工具，或修改工具参数 |
| `tool_result` | 修改工具返回内容 |
| `session_before_*` | 取消切换、fork、压缩、tree 跳转 |

所以选事件时先问一句：**我是要观察运行过程，还是要改变运行过程？**

## 二、启动和资源发现事件

| 事件 | 触发时机 | 可以做什么 |
| --- | --- | --- |
| `project_trust` | 判断项目是否可信时 | 返回 trust 决策，比如自动信任某些目录 |
| `resources_discover` | 发现 skills、prompts、themes 时 | 追加资源路径 |

这类事件发生得很早，适合做“运行时资源装配”。比如你的团队有一套统一 Skill 目录，可以通过 `resources_discover` 暴露给 Pi。

## 三、Session 事件

| 事件 | 触发时机 | 可以做什么 |
| --- | --- | --- |
| `session_start` | session 启动、加载、reload、新建或 fork 后 | 恢复扩展状态、设置 UI、初始化外部连接 |
| `session_info_changed` | session 名称等元信息变化 | 同步标题、状态栏或外部记录 |
| `session_before_switch` | 切换 session 前 | 返回 `{ cancel: true }` 取消切换 |
| `session_before_fork` | fork 前 | 取消 fork，或跳过 conversation restore |
| `session_before_compact` | 上下文压缩前 | 取消压缩，或返回自定义 compaction 结果 |
| `session_compact` | 压缩完成后 | 记录压缩日志、更新状态 |
| `session_shutdown` | quit、reload、new、resume、fork 前销毁运行时 | 清理 watcher、关闭连接、保存状态 |
| `session_before_tree` | 会话树跳转前 | 取消跳转，或自定义 summary |
| `session_tree` | 会话树跳转后 | 重建依赖当前 branch 的扩展状态 |

如果扩展自己维护状态，重点关注 `session_start`、`session_tree` 和 `session_shutdown`。因为会话切换、fork、tree navigation 都可能让当前 branch 发生变化，扩展不能一直拿旧状态继续跑。

## 四、Agent 和 Provider 事件

| 事件 | 触发时机 | 可以做什么 |
| --- | --- | --- |
| `input` | 用户输入进入 Agent 前 | 继续、改写输入，或标记已处理 |
| `before_agent_start` | 用户 prompt 处理后、Agent Loop 前 | 修改 system prompt，插入 custom message |
| `context` | 每次 LLM 调用前构建上下文时 | 替换 messages，用于 RAG、过滤、注入记忆 |
| `before_provider_request` | 请求发给模型 Provider 前 | 替换 provider payload，适合调试或适配特殊 Provider |
| `after_provider_response` | Provider 响应后、消费 stream 前 | 记录状态码、headers、延迟等信息 |
| `agent_start` | Agent Loop 开始 | 开始计时、设置 UI 状态 |
| `agent_end` | Agent Loop 结束 | 统计成本、自动提交、发送通知 |

这里最常用的是 `before_agent_start` 和 `context`。

`before_agent_start` 适合追加运行规则，比如“本轮必须先解释 tradeoff”。`context` 更底层，适合做上下文级别的事情，比如把外部检索结果插到 messages 里，或者过滤掉某些不该送给模型的内容。

## 五、Turn 和 Message 事件

| 事件 | 触发时机 | 可以做什么 |
| --- | --- | --- |
| `turn_start` | 每一轮 turn 开始 | 记录轮次、更新状态栏 |
| `turn_end` | 每一轮 turn 结束 | 分析本轮 message 和 tool results |
| `message_start` | user、assistant 或 toolResult message 开始 | 观察消息生命周期 |
| `message_update` | assistant 流式输出更新 | 做实时渲染、统计 token、隐藏 thinking |
| `message_end` | message 完成 | 替换最终 message，注意 role 必须保持一致 |

一次用户 prompt 可能会产生多轮 turn。只要模型调用工具，Pi 就会执行工具结果，再开启下一轮模型调用。想统计“这次任务跑了几轮”，看 `turn_start` / `turn_end`；想处理 assistant 流式输出，看 `message_update`。

## 六、Tool 事件

| 事件 | 触发时机 | 可以做什么 |
| --- | --- | --- |
| `tool_call` | 工具执行前 | 拦截工具，或原地修改 `event.input` |
| `tool_result` | 工具执行后 | 修改 `content`、`details`、`isError` |
| `tool_execution_start` | 工具开始执行 | 记录开始时间、显示运行状态 |
| `tool_execution_update` | 工具执行中有 partial update | 展示流式进度 |
| `tool_execution_end` | 工具执行结束 | 记录耗时、错误、结果大小 |
| `user_bash` | 用户用 `!` 或 `!!` 执行 bash 时 | 替换 bash 执行逻辑或结果 |

`tool_call` 是做权限和保护策略最常用的事件。比如拦截危险 bash、保护某些路径、把某些命令改成沙箱执行。

`tool_result` 则适合做结果后处理：脱敏、追加错误提示、把工具返回转换成更适合模型继续理解的格式。

## 七、模型设置事件

| 事件 | 触发时机 | 可以做什么 |
| --- | --- | --- |
| `model_select` | 模型被设置、切换或恢复时 | 更新状态栏、记录模型变化 |
| `thinking_level_select` | thinking level 改变时 | 更新 UI 或同步团队策略 |

这类事件通常不改流程，更多用来展示当前状态。比如状态栏显示当前模型、thinking level，或者把模型切换写到审计日志里。

## 八、最常用的监听写法

下面这几个例子覆盖了 80% 的扩展场景。

Session 启动时初始化：

```typescript
pi.on("session_start", async (_event, ctx) => {
  ctx.ui.notify("extension loaded", "info");
});
```

每次 Agent 开始前追加 system prompt：

```typescript
pi.on("before_agent_start", async (event) => {
  return {
    systemPrompt: `${event.systemPrompt}\n\nPrefer small, verifiable changes.`,
  };
});
```

拦截危险工具调用：

```typescript
pi.on("tool_call", async (event) => {
  if (event.toolName !== "bash") return;

  const command = String(event.input.command ?? "");
  if (command.includes("rm -rf")) {
    return { block: true, reason: "Dangerous command" };
  }
});
```

模型切换后更新状态栏：

```typescript
pi.on("model_select", async (event, ctx) => {
  ctx.ui.setStatus("model", event.model.id);
});
```

工具失败后补充提示：

```typescript
pi.on("tool_result", async (event) => {
  if (event.toolName === "bash" && event.isError) {
    return {
      content: [
        ...event.content,
        { type: "text", text: "Extension note: bash command failed." },
      ],
    };
  }
});
```

## 九、选择事件的经验

第一，`tool_call` 里可以直接修改 `event.input`，但修改后不会重新跑参数校验。所以它适合补默认参数、替换工作目录、阻止危险命令，不适合把参数改成完全不同的形状。

第二，能返回结果的事件才适合“改变流程”。比如 `before_agent_start` 可以改 system prompt，`tool_call` 可以拦截工具，`tool_result` 可以改工具结果；而 `agent_start`、`turn_start`、`model_select` 更适合做观察、记录和 UI 更新。

第三，不要把所有逻辑都塞进一个事件。权限放在 `tool_call`，状态恢复放在 `session_start`，上下文注入放在 `context`，收尾动作放在 `agent_end` 或 `session_shutdown`。分开放，后面才好调试。

第四，如果事件 handler 里用了 `ctx`，要注意 session replacement 和 reload。`ctx.newSession()`、`ctx.fork()`、`ctx.switchSession()`、`ctx.reload()` 之后，旧的 ctx 可能已经 stale，不要继续拿旧 ctx 做后续操作。

最后记住一句话：**事件不是越早监听越好，而是要卡在最贴近目标行为的位置。**
