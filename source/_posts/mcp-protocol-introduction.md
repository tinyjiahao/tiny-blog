---
title: MCP 协议是什么
date: 2026-07-04 20:40:07
description: '「MCP 协议是什么」—— 从 AI 应用连接外部工具的痛点讲起，系统梳理 Model Context Protocol 的定位、Host/Client/Server 架构、Tools/Resources/Prompts 三类能力、调用流程、传输方式、安全边界，并用 TypeScript 创建一个最小 MCP Server。'
categories:
  - AI 工程
tags:
  - MCP
  - AI Agent
  - LLM
  - 工具调用
---

![MCP 协议连接 AI 应用与外部系统](/images/mcp-protocol-hero.png)

> **MCP（Model Context Protocol）** 是一个让 AI 应用连接外部系统的开放协议。它把“模型要读哪些上下文、能调用哪些工具、有哪些可复用提示词”抽象成一套标准接口，让 AI Agent 不必为每个数据源、每个工具、每个应用都单独写一套集成逻辑。
>
> 如果把大模型看成大脑，MCP 就像它和现实世界之间的“标准接口层”：文件、数据库、搜索、日历、代码仓库、监控系统都可以通过 MCP Server 接进来，由 AI 应用统一发现、授权、调用和消费结果。

**本文脉络：**

- 一、为什么需要 MCP：AI 应用的“连接器爆炸”
- 二、MCP 是什么：给 AI 应用用的标准上下文协议
- 三、核心架构：Host、Client、Server 各做什么
- 四、三类服务端能力：Tools、Resources、Prompts
- 五、一次 MCP 调用是怎么发生的
- 六、本地与远程：stdio 和 Streamable HTTP
- 七、最小实战：创建一个 MCP Server，并让 AI Agent 调用
- 八、安全边界：为什么 MCP 不是“自动放权”
- 九、MCP 适合什么场景，不适合什么场景
- 十、MCP、Function Calling、RAG、Agent Skill 的区别
- 十一、常见问题

<!-- more -->

## 一、为什么需要 MCP：AI 应用的“连接器爆炸”

一个真正有用的 AI Agent，不能只会聊天。它至少要能做三件事：

| 能力 | 例子 | 没有外部连接时的问题 |
| --- | --- | --- |
| 读取上下文 | 读项目文件、数据库表结构、工单、文档 | 模型只能靠用户复制粘贴，信息不完整 |
| 调用工具 | 查日志、跑测试、创建 issue、发起部署 | 模型只能“建议你去做”，不能真正执行 |
| 使用业务模板 | 按公司规范写周报、生成 SQL、创建 PR 描述 | 每次都要重复告诉模型格式和约束 |

问题在于，这些能力往往分散在不同系统里。AI 应用越多，外部系统越多，重复适配的成本就越高，这就是常说的“连接器爆炸”。

MCP 想解决的不是“模型怎么变聪明”，而是“模型所在的应用怎么以统一方式连接世界”。有了 MCP，工具提供方可以把能力封装成 MCP Server；支持 MCP 的 AI 应用就能以相似方式发现、连接和调用它。

这也是官方文档里常用的类比：MCP 像 AI 应用的 USB-C。USB-C 统一了设备连接方式，MCP 则试图统一 AI 应用连接外部上下文和工具的方式。

## 二、MCP 是什么：给 AI 应用用的标准上下文协议

MCP 的全称是 **Model Context Protocol**，直译是“模型上下文协议”。这个名字里有两个关键词：

| 关键词 | 含义 |
| --- | --- |
| Model Context | 模型工作时需要的上下文，包括文件、数据、工具结果、用户确认、业务模板 |
| Protocol | 一套客户端和服务端都能遵守的消息格式、生命周期、能力发现、调用约定 |

更准确地说，MCP 是 AI 应用和外部系统之间的协议层。它不规定模型怎么推理，不规定 Agent 怎么规划任务，也不规定 UI 怎么展示结果；它关注的是：

- AI 应用如何发现一个外部系统能提供什么能力
- AI 应用如何读取外部上下文
- AI 应用如何调用外部工具
- AI 应用如何处理初始化、能力协商、通知、进度和返回值
- 本地进程和远程服务分别如何传输协议消息

所以 MCP 不是一个模型，也不是一个插件市场，更不是某个厂商专属能力。它更像一套“AI 应用连接外部能力的通用插座规范”。

## 三、核心架构：Host、Client、Server 各做什么

MCP 采用客户端-服务端架构，但这里的“客户端”容易和普通业务系统里的前端客户端混淆。MCP 里有三个角色：

| 角色 | 可以理解为 | 职责 |
| --- | --- | --- |
| MCP Host | AI 应用本体 | 管理用户界面、模型调用、权限确认、多个 MCP 连接 |
| MCP Client | Host 内部的连接对象 | 和某一个 MCP Server 保持一条专用连接 |
| MCP Server | 外部能力提供方 | 暴露工具、资源、提示词等能力 |

举个开发者熟悉的例子：VS Code 可以作为 MCP Host。它连接 GitHub MCP Server 时，会在内部创建一个 MCP Client 来维护这条连接；如果同时连接文件系统 MCP Server、数据库 MCP Server、Sentry MCP Server，就会有多个 MCP Client 分别维护对应连接。

这点很重要：**MCP Client 通常不是一个独立 App，而是 Host 里面负责连接某个 Server 的组件。**

也可以把它想成机场：

| 类比 | MCP 角色 |
| --- | --- |
| 机场大厅 | MCP Host，负责协调旅客、航班、安检和调度 |
| 每个登机口 | MCP Client，负责连接某一条具体航线 |
| 不同目的地机场 | MCP Server，提供某一类外部能力 |

用户看到的是 AI 应用，模型看到的是可用能力，真正把外部系统接进来的，是 Host 内部的 MCP Client 和各个 MCP Server。

## 四、三类服务端能力：Tools、Resources、Prompts

MCP Server 最常见的价值，是向 AI 应用暴露三类能力。

### 1. Tools：让模型可以“做事”

Tool 是可执行函数。模型可以在需要时请求调用它，例如：

- 查询数据库
- 搜索文档
- 读取 GitHub issue
- 创建工单
- 调用内部 API
- 执行一个受限的文件操作

Tool 的关键点是：它会产生动作，可能有副作用。因此 Host 通常需要做权限控制、用户确认、参数审查和结果展示。

比如一个数据库 MCP Server 可以暴露 `query_database` 工具。模型并不直接拿数据库账号去连库，而是通过 MCP Client 请求 Server 执行受控查询，再把结果返回给模型。

### 2. Resources：让模型可以“读上下文”

Resource 是可读取的数据源。它不强调动作，而强调上下文输入，例如：

- 某个文件的内容
- 数据库 schema
- API 返回的只读数据
- 项目配置
- 文档片段
- 日志片段

如果 Tool 像“按钮”，Resource 更像“资料柜”。模型在回答问题前，可以先读取相关资源，减少凭空猜测。

### 3. Prompts：让模型可以“复用工作流”

Prompt 是可复用的提示词模板，用来结构化某类交互。例如：

- 生成 PR 描述
- 写事故复盘
- 根据数据库 schema 生成 SQL
- 按团队规范做代码评审
- 根据日志生成排障报告

Prompt 的价值在于沉淀业务经验。它不是把所有规则塞进一次对话，而是让外部系统把可复用模板作为能力暴露出来，Host 可以按需展示和调用。

三者放在一起看：

| 能力 | 关键词 | 模型得到什么 | 典型例子 |
| --- | --- | --- | --- |
| Tools | Action | 可执行动作 | 查库、建 issue、跑脚本 |
| Resources | Context | 可读取上下文 | 文件、schema、文档、日志 |
| Prompts | Workflow | 可复用交互模板 | 周报模板、代码评审模板 |

## 五、一次 MCP 调用是怎么发生的

一次典型 MCP 交互，可以拆成六步：

1. Host 启动或连接 MCP Server。
2. MCP Client 和 MCP Server 完成初始化，协商协议版本和双方能力。
3. Client 向 Server 请求能力列表，例如有哪些 tools、resources、prompts。
4. Host 把合适的能力交给模型作为可用上下文。
5. 模型判断需要读取资源或调用工具时，Host 通过 MCP Client 发起请求。
6. Server 执行读取或动作，把结构化结果返回，Host 再交给模型继续推理或生成回答。

这里面有一个很容易忽略的点：MCP 不是“模型直接调用一切”。模型提出意图，Host 负责把关，Client 负责协议通信，Server 负责实际能力。这个分层让权限、审计、用户确认和错误处理都有地方落。

以“让 AI 帮我分析线上报错”为例：

| 步骤 | 发生了什么 |
| --- | --- |
| 用户提问 | “帮我看看最近支付接口为什么报错变多了” |
| 模型规划 | 需要看监控、日志、最近发布记录 |
| 能力发现 | Host 知道 Sentry、日志平台、Git 仓库 MCP Server 可用 |
| 读取资源 | 读取错误摘要、相关日志、最近 commit |
| 调用工具 | 查询某个时间窗口内的异常分布 |
| 生成结论 | 模型基于真实上下文给出原因、证据和建议 |

用户感受到的是“AI 会查东西了”，工程上发生的是“AI 应用通过 MCP 标准化地连接了多个外部系统”。

## 六、本地与远程：stdio 和 Streamable HTTP

MCP 的数据层基于 JSON-RPC 2.0。也就是说，Client 和 Server 之间传递的是结构化请求、响应和通知。

传输层目前常见两种标准方式：

| 传输方式 | 适合场景 | 工作方式 |
| --- | --- | --- |
| stdio | 本地 MCP Server | Host 启动 Server 子进程，通过标准输入输出交换 JSON-RPC 消息 |
| Streamable HTTP | 远程 MCP Server | 通过 HTTP POST/GET 传递消息，可结合 SSE 做流式返回和服务端通知 |

本地文件系统、命令行工具、个人机器上的开发辅助能力，常见做法是 stdio。它简单、快、没有网络开销，但通常只服务本机的一个 Host。

远程 SaaS、企业内部平台、云端数据服务，更适合 Streamable HTTP。它可以接认证、网关、审计、限流，也更适合多客户端访问。

这层设计的好处是：上层看到的都是 MCP 消息和能力，底层可以根据场景选择本地进程通信或远程 HTTP 通信。

## 七、最小实战：创建一个 MCP Server，并让 AI Agent 调用

理解 MCP 最快的方式，是写一个只有一个工具的本地 Server，然后让 AI Agent 连上它。

下面用 TypeScript 写一个 `tiny-tools` MCP Server。它只暴露一个工具：`get_server_time`，作用是返回当前服务器时间。这个例子故意不接数据库、不调外部 API，重点放在 MCP 的最小闭环：

| 步骤 | 目标 |
| --- | --- |
| 1 | 创建一个本地 MCP Server |
| 2 | 注册一个可被模型调用的 Tool |
| 3 | 用 stdio 方式启动 Server |
| 4 | 在 AI Agent 里配置连接 |
| 5 | 让 Agent 发现并调用工具 |

### 1. 初始化项目

先创建一个独立目录，不要放进博客仓库里：

```bash
mkdir tiny-mcp-server
cd tiny-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk@^1 zod@3
npm install -D typescript @types/node
mkdir src
touch src/index.ts tsconfig.json
```

截至 2026-07-04，TypeScript SDK v2 仍在演进中。为了让示例稳定可跑，下面使用 v1 主版本的 `@modelcontextprotocol/sdk`。

把 `package.json` 改成下面这样：

```json
{
  "name": "tiny-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "tiny-mcp-server": "./build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod 755 build/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0"
  },
  "files": [
    "build"
  ]
}
```

再写 `tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### 2. 编写最小 MCP Server

把下面代码写入 `src/index.ts`：

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "tiny-tools",
  version: "1.0.0",
});

server.registerTool(
  "get_server_time",
  {
    description: "Get the current server time in ISO format",
    inputSchema: {
      timezone: z
        .string()
        .optional()
        .describe("Optional timezone label, only used for display"),
    },
  },
  async ({ timezone }) => {
    const now = new Date();
    const label = timezone ? ` (${timezone})` : "";

    return {
      content: [
        {
          type: "text",
          text: `Current server time${label}: ${now.toISOString()}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("tiny-tools MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

这段代码做了三件事：

| 代码 | 含义 |
| --- | --- |
| `new McpServer(...)` | 创建一个 MCP Server，并声明名称和版本 |
| `server.registerTool(...)` | 注册一个工具，告诉 Agent 工具名、描述、参数结构和执行逻辑 |
| `new StdioServerTransport()` | 使用标准输入输出作为传输层，适合本地 Agent 启动子进程 |

注意：stdio 模式下不要用 `console.log` 输出调试日志，因为 stdout 要留给 MCP 的 JSON-RPC 消息。日志写到 `stderr`，也就是 `console.error`。

### 3. 构建并手动启动

执行：

```bash
npm run build
node build/index.js
```

如果看到类似下面的日志，说明进程能正常启动：

```text
tiny-tools MCP Server running on stdio
```

手动运行时它会停在那里等待 MCP Client 发消息，这是正常的。真正使用时，AI Agent 会作为 Host 启动这个进程，并通过 stdin/stdout 和它通信。

### 4. 在 AI Agent 中配置连接

不同 Agent 的配置入口不完全一样，但本地 stdio Server 的核心配置通常长这样：

```json
{
  "mcpServers": {
    "tiny-tools": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/tiny-mcp-server/build/index.js"]
    }
  }
}
```

把 `/ABSOLUTE/PATH/TO/...` 换成你机器上的绝对路径。以 macOS 为例，Claude Desktop 的配置文件通常在：

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

保存配置后，重启对应 AI Agent。重启成功后，Agent 会自动拉起这个 MCP Server，并发现 `get_server_time` 这个工具。

### 5. 让 Agent 调用工具

在 Agent 里可以直接问：

```text
请调用 tiny-tools 的 get_server_time 工具，告诉我当前服务器时间。
```

一次完整调用大致是这样发生的：

| 阶段 | 发生了什么 |
| --- | --- |
| 启动 | Agent 根据配置执行 `node build/index.js` |
| 初始化 | Agent 内部的 MCP Client 和 Server 做能力协商 |
| 发现工具 | Client 通过 `tools/list` 知道有 `get_server_time` |
| 模型决策 | 模型判断这个问题需要调用工具 |
| 执行工具 | Client 发送 `tools/call`，Server 返回 ISO 时间 |
| 生成回答 | Agent 把工具结果整理成自然语言回复 |

这个例子虽然小，但已经包含 MCP 的关键闭环：**Server 暴露能力，Agent 发现能力，模型选择能力，Host 受控调用能力**。

### 6. 下一步可以怎么扩展

有了这个骨架，可以继续把真实业务能力接进来：

| 扩展方向 | 示例 |
| --- | --- |
| 增加参数 | `get_order_status(orderId)` |
| 接内部 API | 查询工单、库存、部署状态 |
| 暴露资源 | 提供数据库 schema、项目 README、指标口径 |
| 增加提示词 | 暴露“生成事故复盘”“生成 PR 描述”等模板 |
| 加权限控制 | 高风险操作前要求用户确认，只读工具默认放行 |

如果只是给自己本地使用，stdio 很合适；如果要给团队或多个 Agent 复用，就可以考虑改成 Streamable HTTP，并把认证、审计、限流一起设计进去。

## 八、安全边界：为什么 MCP 不是“自动放权”

MCP 让 AI 应用更容易连接外部系统，也意味着安全边界更重要。

一个危险误解是：接了 MCP，模型就能自动访问一切。正确理解应该是：MCP 提供标准通道，但权限仍然必须由 Host、Server 和用户共同控制。

安全上至少要关注五件事：

| 风险 | 说明 | 防护思路 |
| --- | --- | --- |
| 过度授权 | Server 暴露了太多工具或数据 | 最小权限，只暴露必要能力 |
| 工具副作用 | 删除文件、发消息、改数据库等动作不可逆 | 高风险工具必须二次确认 |
| Prompt Injection | 外部资源里藏着诱导模型越权的指令 | 区分数据和指令，Host 做安全策略 |
| 凭证泄露 | Token、密钥、数据库账号进入模型上下文 | Server 侧保管凭证，只返回必要结果 |
| 远程连接风险 | 本地服务被网页或恶意请求探测 | 校验 Origin、绑定 localhost、加认证 |

尤其是 Streamable HTTP 场景，官方规范明确强调了 Origin 校验、本地服务绑定 localhost、连接认证等要求。这些不是“可选加固”，而是 MCP 能安全落地的前提。

一句话：MCP 标准化的是连接方式，不是替你完成权限设计。

## 九、MCP 适合什么场景，不适合什么场景

### 适合 MCP 的场景

| 场景 | 为什么适合 |
| --- | --- |
| AI 编程助手连接项目上下文 | 文件、Git、CI、Issue、监控都能作为外部能力 |
| 企业内部知识库问答 | 文档、权限、搜索、数据库可以封装成 MCP Server |
| 数据分析助手 | 暴露 schema、查询工具、指标口径和报表模板 |
| 运维排障助手 | 连接日志、告警、Trace、发布系统 |
| 个人自动化助手 | 连接日历、邮件、待办、笔记、浏览器 |

这些场景的共同点是：模型需要真实上下文，还需要在受控范围内执行动作。

### 不适合 MCP 的场景

| 场景 | 原因 |
| --- | --- |
| 只是一次性传几段文本给模型 | 直接放进上下文更简单 |
| 外部系统完全没有复用价值 | 写 MCP Server 可能得不偿失 |
| 需要强事务一致性的核心链路 | MCP 更适合 Agent 辅助，不适合替代核心业务协议 |
| 权限边界说不清楚 | 先做权限模型，再接 MCP |
| 延迟极敏感的在线请求 | Agent 工具调用链路通常不适合放在主交易路径 |

MCP 很强，但它不是所有集成问题的银弹。它最适合“AI 应用需要长期、重复、安全地连接一组外部能力”的场景。

## 十、MCP、Function Calling、RAG、Agent Skill 的区别

这几个概念经常被放在一起，但层次不同。

| 概念 | 解决什么问题 | 更像什么 |
| --- | --- | --- |
| Function Calling | 模型如何以结构化参数调用函数 | 模型侧工具调用格式 |
| RAG | 模型如何检索外部知识再回答 | 知识检索方案 |
| MCP | AI 应用如何标准化连接外部工具和上下文 | 应用与外部系统的协议 |
| Agent Skill | Agent 如何加载某类任务的操作手册和资料 | 可复用任务能力包 |

Function Calling 更靠近模型 API，回答“模型怎么表达我要调用某个函数”。

RAG 更靠近知识检索，回答“模型怎么拿到相关资料再回答”。

MCP 更靠近应用集成，回答“AI 应用怎么发现、连接和调用外部系统”。

Agent Skill 更靠近任务方法论，回答“Agent 做某类任务时应该遵守什么流程、用哪些模板和脚本”。

它们可以组合使用。比如一个 AI 编程助手通过 MCP 连接 GitHub Server；Server 暴露查 issue 的 Tool；模型用 Function Calling 风格决定调用参数；查到的 issue 和代码片段又成为 RAG 式上下文；最后 Agent Skill 规定如何写 PR 描述。

## 十一、常见问题

| 问题 | 简短回答 |
| --- | --- |
| MCP 是什么？ | Model Context Protocol，一个让 AI 应用连接外部系统的开放协议。 |
| MCP 解决什么问题？ | 解决 AI 应用和工具、数据源、工作流之间的标准化连接问题，避免连接器爆炸。 |
| MCP 的三类核心角色？ | Host 是 AI 应用，Client 是 Host 内部维护连接的组件，Server 是外部能力提供方。 |
| MCP Server 能暴露什么？ | Tools、Resources、Prompts，分别对应动作、上下文和交互模板。 |
| MCP 用什么消息协议？ | 数据层基于 JSON-RPC 2.0。 |
| MCP 常见传输方式？ | 本地常用 stdio，远程常用 Streamable HTTP。 |
| MCP 和 Function Calling 的区别？ | Function Calling 是模型调用函数的表达方式，MCP 是 AI 应用连接外部系统的协议。 |
| 如何创建一个最小 MCP Server？ | 用 SDK 创建 `McpServer`，注册 `Tool`，再用 `StdioServerTransport` 连接传输层即可。 |
| AI Agent 怎么连本地 MCP Server？ | 在 Agent 的 `mcpServers` 配置里声明 `command` 和 `args`，让 Agent 启动并连接这个本地进程。 |
| MCP 是否等于让模型自动访问所有数据？ | 不是。MCP 只是标准通道，权限、确认、审计和安全策略仍要由 Host 和 Server 设计。 |
| 什么时候该做 MCP Server？ | 当某个外部能力会被多个 AI 应用或多个 Agent 工作流长期复用时。 |

## 延伸阅读

- [What is the Model Context Protocol (MCP)?](https://modelcontextprotocol.io/docs/getting-started/intro)
- [MCP Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP Specification: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)
- [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
