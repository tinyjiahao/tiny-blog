---
title: Pi Agent Extension 开发指南：从工具、命令到事件拦截
date: 2026-07-23 11:00:00
description: '「Pi Agent Extension 开发指南」—— 面向 Pi Agent 使用者和开发者，介绍 Extension 能做什么、扩展放在哪里、如何注册工具和斜杠命令、如何监听事件与拦截工具、如何使用 UI、保存状态、调试扩展，以及什么时候应该选择 Extension 而不是 Skill 或 Prompt Template。'
cover: /images/pi-agent-extensions-hero.svg
categories:
  - AI 工程
tags:
  - PI Agent
  - AI Agent
  - Extension
  - Agent Harness
  - 工具调用
---

![Pi Agent Extension 开发指南](/images/pi-agent-extensions-hero.svg)

# Pi Agent Extension 开发指南：从工具、命令到事件拦截

Pi Agent 的核心很小，默认只提供读文件、写文件、改文件和执行命令这些基础能力。真正适配个人或团队工作流的部分，主要通过 Extension 完成。

Extension 是运行在 Pi 进程内的 TypeScript 模块。它可以注册新工具，让模型调用；也可以添加斜杠命令、快捷键、状态栏、弹窗、Provider、会话事件处理器，甚至拦截内置工具调用。

这篇文章不讲 Extension 系统为什么重要，而是从使用角度说明：扩展放在哪里、怎么写、怎么调试，以及什么时候应该用 Extension 而不是 Skill 或 Prompt Template。

<!-- more -->

## Extension 能做什么

一个 Extension 可以改变 Pi 的四类行为：

![Pi Agent Extension 能力全景](/images/pi-agent-extensions-capabilities.svg)

- 工具层：注册自定义工具，或覆盖 `read`、`bash`、`edit`、`write` 等内置工具；
- 交互层：注册 `/command`、快捷键、状态栏、widget、弹窗和自定义 TUI 组件；
- Agent 层：监听生命周期事件、拦截工具调用、改写工具结果、注入上下文或修改 system prompt；
- 集成层：注册自定义 Provider、连接外部服务、持久化会话状态、贡献 skills/prompts/themes。

官方 examples 里已经包含很多可直接参考的扩展：

```text
packages/coding-agent/examples/extensions/hello.ts
packages/coding-agent/examples/extensions/permission-gate.ts
packages/coding-agent/examples/extensions/tools.ts
packages/coding-agent/examples/extensions/tool-override.ts
packages/coding-agent/examples/extensions/provider-traffic-log.ts
packages/coding-agent/examples/extensions/plan-mode/
packages/coding-agent/examples/extensions/subagent/
```

如果你只想让模型遵循一套操作说明，通常用 Skill；如果你想改变 Pi 运行时行为，就用 Extension。

## 扩展放在哪里

Pi 支持两类自动发现位置：

![Pi Agent Extension 加载与调试流程](/images/pi-agent-extensions-lifecycle.svg)

```text
~/.pi/agent/extensions/       # 用户级，所有项目可用
.pi/extensions/               # 项目级，仅当前项目可用
```

单文件扩展：

```text
.pi/extensions/my-extension.ts
```

目录扩展：

```text
.pi/extensions/my-extension/
  index.ts
  utils.ts
  package.json
```

项目级扩展需要项目被 trust 后才会加载。扩展本质是代码，拥有 Pi 进程的权限，所以不要加载不可信仓库里的扩展。

临时测试可以用：

```bash
./pi-test.sh -e .pi/extensions/my-extension.ts
```

放到自动发现目录后，可以在交互模式里执行：

```text
/reload
```

这样不用重启 Pi 就能重新加载扩展。

## 最小 Extension

下面是一个最小扩展，它在 session 启动时显示一条通知，并注册一个 `/hello` 命令。

保存为：

```text
.pi/extensions/hello-command.ts
```

代码：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function helloExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("hello extension loaded", "info");
  });

  pi.registerCommand("hello", {
    description: "Say hello from extension",
    handler: async (args, ctx) => {
      ctx.ui.notify(`hello ${args || "world"}`, "info");
    },
  });
}
```

启动：

```bash
./pi-test.sh
```

在 Pi 里执行：

```text
/hello Pi
```

如果能看到通知，说明扩展已经加载并且命令注册成功。

## 给模型增加一个工具

Extension 最常见的用途是注册自定义工具。工具会进入模型可见的 tool 列表，模型可以主动调用它。

例如注册一个 `greet` 工具：

```typescript
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const greetTool = defineTool({
  name: "greet",
  label: "Greet",
  description: "Greet a person by name",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { greeted: params.name },
    };
  },
});

export default function greetExtension(pi: ExtensionAPI) {
  pi.registerTool(greetTool);
}
```

加载后，你可以输入：

```text
Use greet to greet Ada.
```

模型会看到 `greet` 工具的 schema，决定调用：

```json
{ "name": "Ada" }
```

Pi 执行工具后，会把工具返回的 `content` 作为 `toolResult` 写回上下文，再让模型继续生成最终回答。

这里有三个关键字段：

- `description`：告诉模型什么时候用这个工具；
- `parameters`：工具参数 schema；
- `execute()`：真正执行逻辑，返回给模型的结果。

`details` 不一定会展示给模型，但会持久化到 session，适合保存结构化状态。

## 添加斜杠命令

工具是给模型调用的，命令是给用户调用的。

```typescript
pi.registerCommand("model-info", {
  description: "Show current model",
  handler: async (_args, ctx) => {
    const model = ctx.model;
    if (!model) {
      ctx.ui.notify("No model selected", "error");
      return;
    }

    ctx.ui.notify(`${model.provider}/${model.id}`, "info");
  },
});
```

使用：

```text
/model-info
```

命令适合做这些事：

- 打开自定义 UI；
- 切换工具集合；
- 修改模型或 thinking level；
- 触发自定义总结、导出、同步；
- 把外部系统的信息注入会话。

命令在用户输入阶段优先处理。如果 `/name` 匹配到 extension command，就不会继续作为普通 prompt 发给模型。

## 监听事件和拦截工具

Extension 可以监听 Pi 生命周期事件。例如拦截危险 bash 命令：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function permissionGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = String(event.input.command ?? "");
    if (!command.includes("rm -rf")) return;

    const ok = await ctx.ui.confirm("Dangerous command", `Allow command?\n\n${command}`);
    if (!ok) {
      return { block: true, reason: "Blocked by permission gate" };
    }
  });
}
```

`tool_call` 发生在工具执行前。它可以：

- 放行；
- 修改 `event.input`；
- 返回 `{ block: true, reason }` 阻止执行。

工具执行后还可以监听：

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

`tool_result` 适合做日志、脱敏、结果补充和统一错误格式。

Pi 的事件比较多，如果你需要完整列表，可以单独看这篇速查：[Pi Agent Extension 可监听事件速查](/2026/07/23/pi-agent-extension-events/)。

这里先记住一个判断就够了：想拦截工具，优先看 `tool_call`；想改 system prompt，优先看 `before_agent_start`；想注入上下文，优先看 `context`；只是想记录运行过程，优先看 `agent_start`、`turn_end`、`tool_execution_end` 这类生命周期事件。

## 修改 system prompt 和上下文

扩展可以在每次 Agent 开始前修改 system prompt：

```typescript
pi.on("before_agent_start", async (event) => {
  return {
    systemPrompt: `${event.systemPrompt}\n\nAlways explain tradeoffs before editing files.`,
  };
});
```

这类修改只影响当前运行时，不需要改 Pi 源码。适合：

- 为某个项目追加团队规则；
- 临时启用 plan mode；
- 在特定命令后改变回答风格；
- 注入外部系统状态。

如果只是静态规则，优先考虑 `AGENTS.md` 或 Skill；如果规则需要根据事件、状态、命令动态变化，再用 Extension。

## 使用 UI 能力

Extension 的 UI 能力通过 `ctx.ui` 暴露。

常见方法：

```typescript
ctx.ui.notify("message", "info");
ctx.ui.confirm("title", "body");
ctx.ui.input("title", "placeholder");
ctx.ui.select("title", options);
ctx.ui.setStatus("my-ext", "running");
ctx.ui.setWidget("my-ext", ["line 1", "line 2"]);
```

需要注意运行模式：

- TUI 模式有完整交互能力；
- print/JSON 模式不适合弹窗；
- RPC 模式只支持可序列化的交互协议。

写扩展时不要假设永远有 UI。复杂交互前应检查当前 mode，不能交互时给出降级行为。

## 保存扩展状态

扩展需要持久化状态时，可以把状态写入 session entry 或工具 result details。

例如保存工具开关：

```typescript
pi.appendEntry("tools-config", {
  enabledTools: ["read", "bash"],
});
```

恢复时从当前 session branch 读取：

```typescript
pi.on("session_start", async (_event, ctx) => {
  const branch = ctx.sessionManager.getBranch();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === "tools-config") {
      // restore state
    }
  }
});
```

把状态放进 session 的好处是：fork、clone、tree navigation 时，状态能跟着分支走，而不是只有一个全局变量。

## 调试 Extension

开发扩展时建议用项目级 `.pi/extensions`，配合 `/reload`。

推荐流程：

```bash
mkdir -p .pi/extensions
touch .pi/extensions/my-extension.ts
./pi-test.sh
```

修改扩展后，在 Pi 中执行：

```text
/reload
```

调试方式：

- 用 `ctx.ui.notify()` 显示关键状态；
- 用 `console.error()` 打印日志；
- 用 `pi.on("tool_call")` 看模型实际调用参数；
- 用 provider traffic log 一类扩展记录模型请求和响应；
- 先用 `-e ./path.ts` 单次加载，稳定后再放入自动发现目录。

如果扩展涉及 TUI，建议用 tmux 固定终端大小：

```bash
tmux new-session -d -s pi-test -x 80 -y 24
tmux send-keys -t pi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t pi-test -p
tmux kill-session -t pi-test
```

## 什么时候不要用 Extension

不是所有定制都应该写成 Extension。

![Extension、Skill 与 Prompt Template 如何选择](/images/pi-agent-extensions-choose.svg)

适合用 `AGENTS.md`：

```text
项目编码规范
测试命令
提交要求
架构约定
```

适合用 Skill：

```text
某类任务的操作流程
带参考资料的专业能力
需要模型按需读取的大段说明
包含辅助脚本但不常驻运行时
```

适合用 Prompt Template：

```text
固定格式的 review prompt
release note prompt
issue triage prompt
handoff prompt
```

适合用 Extension：

```text
新增模型可调用工具
新增 slash command
拦截或替换工具调用
动态修改 system prompt
连接外部服务
自定义 TUI
持久化运行时状态
注册 Provider
```

一句话判断：如果只是“告诉模型怎么做”，用文档或 Skill；如果要“改变 Pi 怎么运行”，用 Extension。

## 安全边界

Extension 和 Pi 同进程运行，拥有启动 Pi 的用户权限。它可以读写文件、执行命令、访问网络、读取环境变量。

因此要注意：

- 只加载可信扩展；
- 谨慎启用项目级 `.pi/extensions`；
- 不要把 API key 硬编码进扩展；
- 对危险命令做 confirm 只能作为交互策略，不是沙箱；
- 真正的隔离应使用容器、虚拟机或系统权限；
- 发布扩展时明确说明它会读写哪些文件、执行哪些命令。

Pi 的 Project Trust 控制的是“是否加载项目里的可执行配置”，不是运行时沙箱。扩展一旦加载，就拥有当前进程权限。

## 一个推荐学习顺序

如果你想系统掌握 Extension，可以按这个顺序读：

```text
1. packages/coding-agent/examples/extensions/hello.ts
2. packages/coding-agent/examples/extensions/permission-gate.ts
3. packages/coding-agent/examples/extensions/tools.ts
4. packages/coding-agent/examples/extensions/tool-override.ts
5. packages/coding-agent/examples/extensions/provider-traffic-log.ts
6. packages/coding-agent/examples/extensions/plan-mode/index.ts
7. packages/coding-agent/docs/extensions.md
8. packages/coding-agent/src/core/extensions/types.ts
9. packages/coding-agent/src/core/extensions/runner.ts
10. packages/coding-agent/src/core/agent-session.ts
```

先从 `hello.ts` 理解最小工具，再看 `permission-gate.ts` 理解拦截，接着看 `tools.ts` 理解命令、UI 和状态持久化。等你需要写复杂工作流时，再深入 `runner.ts` 和 `agent-session.ts`。

## 总结

Pi 的 Extension 不是简单插件。它可以进入 Agent 运行过程的多个关键点：用户输入、system prompt、模型工具列表、工具调用、工具结果、session、compaction、Provider 和 TUI。

这也是 Pi 保持小核心的原因：核心提供稳定的模型、工具、会话和事件机制；真正的工作流由 Extension 决定。

使用 Extension 的基本路线是：

```text
放到 .pi/extensions 或 ~/.pi/agent/extensions
-> export default function(pi)
-> registerTool / registerCommand / pi.on(...)
-> /reload
-> 调试事件和工具调用
-> 持久化必要状态
```

掌握这条路线后，你就可以把 Pi 从一个通用 coding agent，逐步改造成适合自己项目和团队的专用 agent harness。
