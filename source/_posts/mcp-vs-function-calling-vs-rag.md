---
title: MCP vs Function Calling vs RAG：AI 工具接入到底怎么选
date: 2026-07-05 20:10:00
description: '「MCP vs Function Calling vs RAG」—— 从 AI 应用接入外部能力的三个常见问题讲起，系统对比 MCP、Function Calling 和 RAG 的定位、适用场景、工程边界、组合方式与选型原则，帮助开发者判断什么时候该接工具、什么时候该检索知识、什么时候该抽象成 MCP Server。'
categories:
  - AI 工程
tags:
  - MCP
  - AI Agent
  - RAG
  - Function Calling
  - LLM
  - 工具调用
---

> 做 AI 应用时，很容易遇到三个听起来相近的问题：
>
> - 我要不要让模型调用函数？
> - 我要不要接 RAG？
> - 我要不要做 MCP Server？
>
> 这三个东西都能让模型“连接外部世界”，但它们解决的问题并不一样。Function Calling 偏向“让模型调用应用里的函数”，RAG 偏向“让模型基于外部知识回答”，MCP 偏向“让 AI 应用用标准协议连接外部工具、数据和工作流”。选错了，轻则架构绕，重则权限失控、维护困难。

**本文脉络：**

- 一、先给结论：三者不是替代关系
- 二、Function Calling：应用内的函数调用接口
- 三、RAG：让模型带着外部知识回答
- 四、MCP：AI 应用连接外部能力的标准协议
- 五、核心区别：到底谁负责什么
- 六、怎么选：按问题类型做判断
- 七、怎么组合：真实系统里通常三者一起用
- 八、常见误区
- 九、速查表

<!-- more -->

## 一、先给结论：三者不是替代关系

先把结论放前面：

| 技术 | 一句话定位 | 最适合解决 |
| --- | --- | --- |
| Function Calling | 让模型请求调用你应用里定义好的函数 | 单个应用内部的受控动作 |
| RAG | 先检索外部知识，再让模型基于知识回答 | 知识问答、文档问答、事实补充 |
| MCP | 让 AI 应用用标准协议连接外部工具、资源和提示词 | 多工具、多数据源、多客户端复用 |

它们不是三个互斥选项，而是三层不同抽象：

```text
RAG 解决：模型回答前，应该读哪些知识？

Function Calling 解决：模型需要做事时，怎么调用我应用里的函数？

MCP 解决：不同 AI 应用和外部系统之间，怎么用标准方式发现、授权、调用能力？
```

如果只做一个简单聊天机器人，可能 Function Calling 或 RAG 就够了。

如果要做一个能连接数据库、代码仓库、工单系统、监控平台、内部文档，并且希望多个 Agent 客户端复用这些能力的系统，MCP 的价值就开始出现。

## 二、Function Calling：应用内的函数调用接口

Function Calling 的核心思想是：应用把可调用函数的名称、描述和参数 schema 提供给模型，模型在需要时生成一次函数调用请求；应用拿到请求后，自己执行函数，再把结果返回给模型。

OpenAI 官方文档把 tool calling 描述成一个多步流程：

1. 应用把可用工具发给模型。
2. 模型返回要调用的工具和参数。
3. 应用侧执行对应代码。
4. 应用把工具结果再发回模型。
5. 模型基于结果生成最终回答。

这里最关键的是：**函数不是模型执行的，是你的应用执行的。**

比如一个电商客服机器人，可以定义这些函数：

```ts
const tools = [
  {
    name: "get_order_status",
    description: "查询订单状态",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" }
      },
      required: ["orderId"]
    }
  },
  {
    name: "create_refund_request",
    description: "创建退款申请",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        reason: { type: "string" }
      },
      required: ["orderId", "reason"]
    }
  }
];
```

当用户问“帮我查一下订单 123 的状态”时，模型不会自己连数据库，而是输出一个结构化调用：

```json
{
  "name": "get_order_status",
  "arguments": {
    "orderId": "123"
  }
}
```

应用收到后，调用自己的订单服务，再把结果交给模型生成自然语言回答。

Function Calling 的优点很直接：

| 优点 | 说明 |
| --- | --- |
| 简单 | 不需要额外协议层，直接在应用里定义函数 |
| 精准 | 参数 schema 清晰，适合结构化调用 |
| 可控 | 代码执行权在应用侧，方便做权限和校验 |
| 低成本 | 适合少量工具、单个应用、固定场景 |

它的限制也很明显：

| 限制 | 表现 |
| --- | --- |
| 复用性弱 | 每个应用都要重新接一遍工具 |
| 扩展成本高 | 工具越来越多时，schema、权限、审计容易散落 |
| 生命周期短 | 更像一次模型请求里的工具定义，不天然解决工具发现和管理 |
| 标准化不足 | 不同模型、不同应用的工具定义和调用方式可能不一样 |

所以 Function Calling 很适合“我这个应用要调用几个后端函数”，但不适合直接承担“企业 AI 工具平台”的全部职责。

## 三、RAG：让模型带着外部知识回答

RAG 的全称是 Retrieval-Augmented Generation，通常翻译成“检索增强生成”。

它解决的问题不是“让模型做事”，而是“让模型回答前先读资料”。

一个典型 RAG 流程是：

```text
用户问题
  -> 检索相关文档片段
  -> 把片段放进模型上下文
  -> 模型基于片段生成回答
  -> 返回引用来源或证据
```

比如你有一堆内部文档：

- 退款规则
- 运费模板
- 会员权益说明
- API 接口文档
- 故障复盘记录

如果只靠模型自身知识，它可能不知道你公司最新规则。RAG 的做法是把这些文档切块、向量化、建立索引。用户提问时，先做语义检索或混合检索，把最相关的片段拿出来，再交给模型回答。

OpenAI 的 Retrieval 文档也把 vector store 视为数据索引，用来做语义搜索并把外部内容带入模型上下文。

RAG 的价值主要在这几类场景：

| 场景 | 例子 |
| --- | --- |
| 文档问答 | “我们退款规则是什么？” |
| 知识库助手 | “这个 API 怎么鉴权？” |
| 客服辅助 | “这个用户的问题应该引用哪条政策？” |
| 代码/配置解释 | “这个模块的设计文档怎么说？” |
| 合规回答 | “根据内部规范，能不能这么处理？” |

RAG 的优势是：

| 优点 | 说明 |
| --- | --- |
| 补充知识 | 不依赖模型训练时是否见过这些内容 |
| 可追溯 | 可以返回来源片段，方便验证 |
| 更新快 | 文档更新后重建索引即可，不需要训练模型 |
| 风险低 | 主要是读取知识，不直接产生副作用 |

但 RAG 也有边界：

| 限制 | 说明 |
| --- | --- |
| 不擅长做动作 | 它能读文档，但不会自动创建工单或查实时订单 |
| 依赖检索质量 | 切块、召回、排序、去重做不好，回答就会飘 |
| 不等于事实正确 | 检索到错文档，模型也会基于错文档回答 |
| 不解决工具治理 | 它不负责工具权限、调用审计、能力发现 |

所以 RAG 适合“模型需要读知识”，不适合“模型需要操作系统”。

## 四、MCP：AI 应用连接外部能力的标准协议

MCP 的全称是 Model Context Protocol。它不是一个检索算法，也不是某个模型的 Function Calling 功能，而是一套开放协议。

官方文档里常用的定位是：MCP 是 AI 应用连接外部系统的开放标准。通过 MCP，AI 应用可以连接数据源、工具和工作流。

MCP Server 可以暴露三类能力：

| 能力 | 用途 | 例子 |
| --- | --- | --- |
| Tools | 让模型请求执行动作 | 查数据库、跑测试、创建 issue |
| Resources | 暴露可读取上下文 | 文件内容、数据库 schema、文档、日志 |
| Prompts | 暴露可复用工作流模板 | 生成 PR 描述、事故复盘模板 |

这和 Function Calling 很像，但抽象层级不一样。

Function Calling 通常是：

```text
某个应用
  -> 给某次模型请求传入 tools
  -> 模型返回函数调用
  -> 应用执行函数
```

MCP 更像：

```text
多个 AI 应用 / MCP Host
  -> 连接多个 MCP Server
  -> 发现每个 Server 暴露的 tools / resources / prompts
  -> 按统一协议调用
```

换句话说，MCP 更关注“工具和上下文如何被标准化暴露出来”，而不是“某个模型 API 怎么返回函数调用 JSON”。

它的价值在这些场景里会更明显：

| 场景 | 为什么适合 MCP |
| --- | --- |
| 多客户端复用 | 同一个 GitHub MCP Server 可以给多个 Agent 使用 |
| 多工具接入 | 文件系统、数据库、搜索、监控、工单都能统一接入 |
| 能力发现 | Host 可以列出 Server 提供哪些 tools/resources/prompts |
| 权限治理 | Host、Client、Server 可以分层做授权、确认、审计 |
| 本地与远程兼容 | stdio 适合本地，Streamable HTTP 适合远程服务 |

MCP 的限制也要看清：

| 限制 | 说明 |
| --- | --- |
| 比 Function Calling 重 | 多了协议、Server、传输和生命周期 |
| 仍需安全设计 | MCP 不是自动授权系统，工具越权仍要自己防 |
| 不替代 RAG | MCP 可以暴露资源，但不等于完整检索系统 |
| 不替代业务 API | MCP Server 背后仍然要接你的业务系统 |

MCP 更像 AI 时代的连接器标准。它不直接让模型变聪明，但能让模型所在的应用更容易连接世界。

## 五、核心区别：到底谁负责什么

可以从五个维度比较：

| 维度 | Function Calling | RAG | MCP |
| --- | --- | --- | --- |
| 核心问题 | 怎么让模型调用函数 | 怎么让模型读取知识 | 怎么让 AI 应用标准化连接外部能力 |
| 主要对象 | 函数/API | 文档/知识片段 | Tools/Resources/Prompts |
| 典型动作 | 执行代码、调接口 | 检索、召回、引用 | 发现、连接、调用、读取 |
| 副作用 | 可能有 | 通常没有 | 取决于 Tool |
| 复用范围 | 单应用内较常见 | 知识库或应用内 | 多 Host、多 Server、多工具 |

再换一种更工程化的说法：

| 你在问的问题 | 更接近 |
| --- | --- |
| “模型怎么调用这个函数？” | Function Calling |
| “模型回答前怎么查资料？” | RAG |
| “这些工具怎么给多个 Agent 统一接入？” | MCP |
| “用户授权、工具发现、stdio/HTTP 传输怎么处理？” | MCP |
| “公司文档怎么让模型能引用？” | RAG |
| “订单查询接口怎么让客服机器人调用？” | Function Calling 或 MCP Tool |

一个很实用的判断方法：

```text
如果核心是“读知识”，优先想 RAG。

如果核心是“做一个固定动作”，优先想 Function Calling。

如果核心是“把一组工具/资源标准化暴露给多个 AI 应用”，优先想 MCP。
```

## 六、怎么选：按问题类型做判断

### 1. 公司知识库问答

用户问：

> 年假政策是什么？报销流程怎么走？这个 API 的限流规则是什么？

优先选 RAG。

原因是问题核心是“从文档里找答案”。你需要的是文档切块、检索、重排、引用来源，而不是工具执行。

可以加少量 Function Calling，例如：

- 获取当前用户所在地区
- 获取员工类型
- 根据权限过滤文档集合

但主干仍然是 RAG。

### 2. 客服机器人查订单

用户问：

> 帮我查一下订单 123 到哪里了。

如果这是一个单独客服应用，Function Calling 就很合适：

```text
get_order_status(orderId)
```

如果订单查询能力还要给多个 Agent 使用，比如客服 Agent、运营 Agent、售后 Agent、内部排障 Agent 都要用，那可以把它封装成 MCP Server：

```text
order-mcp-server
  - get_order_status
  - get_refund_status
  - list_order_events
```

区别不在“能不能查订单”，而在“这套能力是不是要标准化复用”。

### 3. AI 帮开发者排查线上问题

用户问：

> 帮我看看最近支付接口错误率为什么升高了。

这个场景通常三者都要：

| 能力 | 作用 |
| --- | --- |
| RAG | 读取事故手册、接口文档、历史复盘 |
| Function Calling | 在应用内调用某些固定分析函数 |
| MCP | 连接日志、监控、数据库、Git、工单系统 |

如果只用 RAG，它知道文档，但不知道实时错误率。

如果只用 Function Calling，每个系统都要在应用里硬接一遍。

如果只用 MCP，但没有检索能力，它能查工具，却不一定能读到历史知识和规范。

真实的排障 Agent 往往是组合式：

```text
RAG 读背景知识
  + MCP 连接外部系统
  + Function Calling 执行应用内受控动作
```

### 4. 数据分析助手

用户问：

> 最近 7 天支付成功率按渠道拆一下，看看哪个渠道拖后腿。

如果只是一个应用内功能，可以用 Function Calling 暴露：

```text
get_payment_success_rate(startTime, endTime, groupBy)
```

如果希望 Agent 能探索数据库 schema、生成只读 SQL、读取查询结果，就更接近 MCP 数据库工具。

如果还需要解释指标口径、引用指标字典，那还需要 RAG：

```text
指标口径文档 -> RAG
数据库查询能力 -> MCP Tool
应用内固定报表函数 -> Function Calling
```

### 5. 生成标准化业务文档

用户说：

> 根据这次事故信息，按公司模板生成复盘报告。

这里可以这样拆：

| 需求 | 适合方式 |
| --- | --- |
| 读取复盘模板 | RAG 或 MCP Resource |
| 提供固定提示词模板 | MCP Prompt |
| 查询事故相关数据 | MCP Tool 或 Function Calling |
| 创建文档/工单 | Function Calling 或 MCP Tool |

如果模板和工具要沉淀给多个 Agent 用，MCP Prompt + MCP Tool 会比每个应用复制一份 prompt 更可维护。

## 七、怎么组合：真实系统里通常三者一起用

不要把架构设计成“只能三选一”。更合理的是把三者放在不同层次：

![MCP、Function Calling 与 RAG 在真实 AI 应用中的分层组合](/images/mcp-vs-function-calling-vs-rag-stack.svg)

举一个“内部研发 Agent”的完整例子：

| 用户需求 | 系统动作 | 技术 |
| --- | --- | --- |
| “这个接口报错多吗？” | 查监控和日志 | MCP Tool |
| “这个错误码是什么意思？” | 检索接口文档 | RAG |
| “相关代码最近谁改过？” | 查 Git commit | MCP Tool |
| “帮我生成排查摘要” | 套用团队模板 | MCP Prompt |
| “创建一个 issue” | 调用项目管理 API | Function Calling 或 MCP Tool |

这里 MCP 不是替代 RAG，而是帮 Agent 连接更多外部系统；RAG 不是替代 Function Calling，而是给回答补充知识；Function Calling 也不是落后方案，它仍然是应用内调用业务函数的最直接方式。

## 八、常见误区

### 1. 误区：有了 RAG，就不需要工具调用

RAG 主要解决“读知识”。它可以告诉你退款规则，但不会自动提交退款申请；它可以解释故障手册，但不会自动查询线上日志。

只要系统需要执行动作，就需要工具调用能力。

### 2. 误区：有了 Function Calling，就不需要 MCP

如果你的系统只有一个应用、几个函数，确实不需要 MCP。

但当你有多个 Agent、多个外部系统、多个团队都要复用同一组工具时，把所有函数都塞进每个应用里，会越来越难维护。MCP 的价值是把工具和上下文抽象成可复用的 Server。

### 3. 误区：MCP 就是更高级的 Function Calling

不准确。

MCP 不是某个模型的函数调用能力，而是 AI 应用和外部系统之间的协议。MCP Tool 最后可能仍然会被 Host 以“工具调用”的形式交给模型，但 MCP 关注的是 Server 如何暴露能力、Client 如何连接、Host 如何发现和管理能力。

### 4. 误区：MCP Resources 可以直接替代 RAG

MCP Resource 能暴露可读取上下文，比如文件、schema、文档片段。但完整 RAG 系统通常还包括：

- 文档切块
- 向量索引
- 关键词/向量混合检索
- 重排
- 去重
- 引用追踪
- 权限过滤

Resource 是上下文入口，不等于完整检索系统。

### 5. 误区：这些能力接上以后就安全了

恰好相反。外部能力越多，越需要安全边界。

至少要考虑：

- 工具最小权限
- 用户确认
- 参数校验
- 敏感字段脱敏
- 调用审计
- 速率限制
- 工具调用结果是否可能被 prompt injection 污染

AI 工具接入的工程难点，不只是“调通”，而是“可控地调通”。

## 九、速查表

最后用一张表收尾：

| 问题 | 优先选择 |
| --- | --- |
| 模型需要查公司文档、政策、API 手册 | RAG |
| 模型需要调用当前应用里的一个后端函数 | Function Calling |
| 模型需要连接多个外部系统 | MCP |
| 多个 Agent 要复用同一组工具 | MCP |
| 需要读取实时数据或执行动作 | Function Calling / MCP Tool |
| 需要基于知识片段回答并给出处 | RAG |
| 需要暴露可复用提示词模板 | MCP Prompt |
| 需要把数据库 schema、文件、日志作为上下文 | MCP Resource / RAG |
| 只是一个小功能，不需要复用 | Function Calling |
| 要做企业内部 Agent 工具平台 | MCP + RAG + Function Calling |

一句话记：

```text
读知识，先想 RAG。
调函数，先想 Function Calling。
做工具生态和标准化接入，先想 MCP。
```

真正成熟的 AI 应用，不会执着于“三选一”，而是把它们放在合适的位置：RAG 负责知识，Function Calling 负责应用内动作，MCP 负责标准化连接外部世界。

## 参考资料

- [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Retrieval](https://developers.openai.com/api/docs/guides/retrieval)
- [Model Context Protocol Documentation](https://modelcontextprotocol.io/docs/getting-started/intro)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification/2025-06-18)
- [MCP Resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
- [MCP Prompts](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts)
