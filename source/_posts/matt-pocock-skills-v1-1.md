---
title: MattPocock Skills v1.1.0 版本改动
date: 2026-07-14 16:08:05
description: '介绍 mattpocock/skills v1.1.0 的主要变化，包括规划技能重组、Wayfinder 与 Research、新版 Grilling、TDD、Code Review 和 Triage。'
categories:
  - AI 工程
tags:
  - AI Agent
  - Skill
  - Claude Code
  - Codex
  - 工程实践
---

> `mattpocock/skills` 发布了 v1.1.0。本次更新重组了规划流程，加入 `wayfinder` 和 `research`，并调整了 `grilling`、`tdd`、`code-review` 等技能。
>
> 本文是「[MattPocock Skills：给真实工程师的 AI Agent 工作流](/2026/07/06/matt-pocock-skills/)」的后续，主要介绍 v1.1.0 相比上一篇文章发生了哪些变化。

![Matt Pocock Skills v1.1](/images/matt-pocock-skills-v1-1-cover.png)

<!-- more -->

## 一、规划技能统一

v1.1.0 对规划相关技能做了一次重组：

| 原技能 | v1.1.0 状态 | 新技能 |
| --- | --- | --- |
| `to-prd` | 重命名 | `to-spec` |
| `to-plan` | 合并 | `to-tickets` |
| `to-issues` | 合并后删除 | `to-tickets` |

原来的主要流程是：

```text
idea
  → grill-with-docs
  → to-prd
  → to-issues
  → implement
```

v1.1.0 改成：

```text
idea
  → grill-with-docs
  → to-spec
  → to-tickets
  → implement
```

### 1. `to-prd` 改为 `to-spec`

`to-spec` 会把当前对话中已经确认的内容整理成一份 Spec，并发布到配置好的 Issue Tracker。

它仍然会在说明中提到 PRD，方便用户理解和搜索，但 `spec` 成为整套技能统一使用的名称。

`to-spec` 本身不负责重新访谈用户。需求澄清应该在前面的 `grill-with-docs` 中完成，它只负责整理当前对话已经形成的共识。

### 2. `to-plan` 和 `to-issues` 合并为 `to-tickets`

`to-tickets` 可以接收一份 Plan、Spec 或当前对话，并将其拆成一组可执行的 Tickets。

每个 Ticket 应该是一个 tracer-bullet 式的垂直切片，并明确记录它依赖哪些其它 Tickets。

如果项目使用本地 Markdown，blocking edges（依赖关系）会以文本形式写入 `tickets.md`，用户通常按顺序执行。

如果项目使用真实的 Issue Tracker，则优先使用 Tracker 提供的原生 sub-issues 和 blocking edges。没有未完成依赖的 Ticket 会进入当前 frontier，可以由多个 Agent 并行执行。

### 3. 支持 Wide Refactor

`to-tickets` 还增加了对 wide refactor 的处理。

例如修改一个数据库字段名，可能影响整个代码库的几千个调用点。这类改动很难拆成普通垂直切片，因为迁移一部分调用方后，项目可能暂时无法通过构建。

新版使用 expand–contract 方式拆分：

```text
Expand
  让新旧形式暂时共存

Migrate
  分批迁移调用方

Contract
  删除旧形式并完成最终验证
```

这样可以让每一批改动尽量保持 CI 通过。

## 二、新增 `wayfinder`

`wayfinder` 用于规划超出单个 Agent 会话承载范围的大型工作。

它的前身是 `decision-mapping`。v1.1.0 将其重命名、重新设计，并从 `in-progress` 移到正式的 Engineering Skills 中。

### 1. 先确定 Destination

Wayfinding 的第一步是确定 `Destination`，也就是本次大型工作的最终目标。

Destination 会固定整个工作的范围。后续所有调查 Ticket、原型和决策都应该服务于这个目标。

### 2. 只负责规划，不直接实现

`wayfinder` 的任务是找出通往 Destination 的路径，不是直接构建最终功能。

它会把尚未解决的问题拆成不同类型的 Tickets：

| Ticket 类型 | 用途 |
| --- | --- |
| Grilling | 需要通过提问让用户做出决定 |
| Prototype | 用可丢弃原型回答设计问题 |
| Research | 调查文档、源码、规范等资料 |
| Task | 必须由人或 Agent 完成的实际操作，例如开通权限 |

当所有影响实现的未知问题都解决后，Wayfinder 的工作就完成了。后续可以再进入 `to-spec`、`to-tickets` 和 `implement`。

### 3. Map 只保存索引

Wayfinder 会在 Issue Tracker 中创建一个共享 Map。Map 本身只保存 Ticket 的简要信息和链接。

完整的调查过程和决定只保存在对应 Ticket 中，避免同一个决定同时出现在 Map 和 Ticket 中，最后形成两个不同版本。

### 4. 区分未确定和不做

Map 中有两个容易混淆的部分：

| 区域 | 含义 |
| --- | --- |
| `Not yet specified` | 属于当前范围，但还没有确定的问题 |
| `Out of scope` | 已明确不在本次 Destination 范围内的工作 |

前者会随着调查推进逐渐变成 Tickets；后者不会重新进入待处理列表。

### 5. HITL 与 AFK

Wayfinder 会标记 Ticket 是否需要人类参与：

- HITL：Human in the Loop，例如 Grilling 和需要用户选择的 Prototype；
- AFK：Agent 可以独立完成，例如 Research。

HITL Ticket 必须等待用户参与。Agent 不能自己替用户回答 Grilling 中的问题。

### 6. Wayfinder 不是默认入口

`wayfinder` 适合绿色项目、巨大功能或需要多个会话才能规划清楚的工作。

如果开场调查没有发现大量未知问题，它会提前停止并询问用户接下来怎么做，而不是为普通任务创建一个不必要的 Map。

## 三、新增 `research`

`research` 是一个 model-invoked Skill，用于调查技术问题并留下带引用的研究文档。

它会启动一个后台 Agent，优先查看：

- 官方文档；
- 源代码；
- 技术规范；
- 第一方 API；
- 其它可信的一手资料。

研究结果会保存为一份 Markdown 文件，放到项目约定的文档目录中。

主 Agent 可以在后台调查进行时继续处理其它工作。完成后的研究文档可以继续交给 `grilling`、`to-spec`、`prototype` 或设计相关技能使用。

`research` 也被加入了 `ask-matt` 和 Wayfinder 的可用流程中。

## 四、`code-review` 正式发布

原来位于 `in-progress` 中的 `review` 被重命名为 `code-review`，并移到 `engineering` 目录，成为正式发布的 Skill。

`implement` 完成代码后，也会进入 `code-review`。

它继续沿着两个方向评审代码：

| 方向 | 检查内容 |
| --- | --- |
| Standards | 是否符合项目编码标准和代码设计要求 |
| Spec | 是否正确、完整地实现了原始 Spec 或 Ticket |

v1.1.0 为 Standards 方向加入了一组 Fowler Code Smell 基线，包括：

- Mysterious Name
- Duplicated Code
- Feature Envy
- Data Clumps
- Primitive Obsession
- Repeated Switches
- Shotgun Surgery
- Divergent Change
- Speculative Generality
- Message Chains
- Middle Man
- Refused Bequest

这些代码味道不是硬性违规规则。

如果项目自身的编码标准与这套基线不同，项目标准优先。Agent 在报告代码味道时，也应该把它作为需要判断的问题，而不是直接宣布代码违反规则。

## 五、`grilling` 增加 Confirmation Gate

v1.1.0 对 `grilling` 做了两项重要调整。

### 1. Confirmation Gate：用户确认后才能执行

在用户确认双方已经形成共同理解之前，Agent 不能执行讨论出来的计划。

这意味着 Grilling 结束和开始实现是两个不同动作。Agent 不能因为已经问完问题，就默认获得了开工许可。

### 2. 区分 Facts 和 Decisions

`grilling` 现在明确区分事实和决定：

| 类型 | 处理方式 |
| --- | --- |
| Facts | Agent 应该探索代码库、文档或运行结果，自己查清楚 |
| Decisions | Agent 必须询问用户，并等待用户回答 |

例如“项目当前使用哪个数据库”属于 Fact，可以查看配置文件；“是否允许用户删除已经发布的内容”属于 Decision，应该由用户决定。

这个变化可以避免 Agent 在组合调用 `grilling` 时，一边提问，一边又替用户回答自己的问题。

## 六、`prototype` 改为 Model-invoked

`prototype` 现在可以由模型自动调用，也可以被其它技能使用。

它的用途是编写可丢弃代码，回答一个设计问题。新版主要覆盖两种情况：

- 状态或业务逻辑是否合理；
- UI 应该选择哪个方向。

状态和逻辑问题可以用一个可运行的终端程序验证；UI 问题可以生成几种差异明显的界面供用户比较。

Prototype 的目的不是交付功能。设计问题得到答案后，原型代码可以被丢弃。

## 七、`tdd` 调整为参考型 Skill

v1.1.0 删除了 `tdd` 中重复描述 Red–Green 循环的 Workflow 和逐周期检查清单，只保留对实际行为有约束作用的规则。

新版强调：

- 一次实现一个垂直切片；
- 测试应该写在预先确认的 seam 上；
- 写测试前先与用户确认 seam；
- 先看到测试失败，再编写实现；
- 测试的预期值必须来自独立的信息来源。

### 1. 从 Red–Green–Refactor 改为 Red–Green

Refactor 阶段从 TDD Skill 中移除：

```text
旧版：Red → Green → Refactor
新版：Red → Green
```

重构相关规则和文档被移到 `code-review`。现在 TDD 主要负责建立行为反馈，Code Review 负责检查设计和代码味道。

### 2. 新增 Tautological Test 反模式

Tautological Test 指测试使用和实现代码相同的方式计算期望值。

例如实现和测试都使用同一个错误公式计算价格，测试依然会通过。这类测试只是把实现逻辑重复了一次，无法提供独立验证。

新版要求测试的期望值来自独立来源，例如明确的业务规则、固定样例或人工计算结果。

## 八、`triage` 支持外部 Pull Request

`triage` 不再只处理 Issues，也可以处理外部贡献者提交的 Pull Requests。

PR 会被当作“附带代码的请求”，进入和 Issue 相同的 Triage 状态机。

相关变化包括：

- 通过项目配置决定是否处理外部 PR；
- 只发现外部贡献者提交的 PR；
- 将原来的 Bug reproduce 泛化为 verify the claim；
- 如果请求已经实现，可以将其处理为 `wontfix`；
- 避免把“已经实现”错误记录为 out-of-scope。

`setup-matt-pocock-skills` 也增加了是否把 PR 作为请求来源的配置。

## 九、`writing-great-skills` 增加两个失败模式

`writing-great-skills` 新增了 Negation 和 Negative Space。

### 1. Negation

Negation 指通过否定句告诉 Agent 不要做什么。

例如：

```text
不要一次修改多个文件。
```

这句话仍然把“一次修改多个文件”放进了上下文，可能让这个行为变得更容易被模型想到。

更好的方式是描述正向行为：

```text
每次只修改当前步骤涉及的一个文件，验证后再继续。
```

### 2. Negative Space

Negative Space 指 Skill 没有写明的部分。

这些空白并不是中立状态，而是会交给模型根据预训练经验自行判断。

编写 Skill 时应该检查每个遗漏：如果某个决定必须稳定，就补充规则；如果确实允许多种选择，则明确将它保留为开放分支。

## 十、`ask-matt` 补全技能路由

`ask-matt` 原先没有覆盖完整的技能集。v1.1.0 补充了以下路由：

- `tdd`
- `diagnosing-bugs`
- `domain-modeling`
- `codebase-design`
- `grilling`
- `prototype`
- `research`
- `wayfinder`

其中 `diagnosing-bugs` 增加了“Something's broken”入口；`domain-modeling` 和 `codebase-design` 被放到“Vocabulary underneath”部分；`prototype` 也有了独立入口。

新版推荐的主要流程是：

```text
idea
  → /to-spec
  → /to-tickets
  → /implement
```

`wayfinder` 是针对绿色项目或巨大功能的特殊入口，不是所有任务都必须经过的新主流程。

## 十一、和上一篇文章相比，哪些技能变了

| Skill | 上一篇文章中的状态 | v1.1.0 变化 |
| --- | --- | --- |
| `to-prd` | 主要规划技能 | 改名为 `to-spec` |
| `to-issues` | 将 PRD 拆成 Issues | 被 `to-tickets` 替代 |
| `to-tickets` | 未介绍 | 新增，合并 Plan 和 Issue 拆分能力 |
| `wayfinder` | 未介绍 | 新增正式技能 |
| `research` | 已列入清单 | 补充后台调查和引用文档定位 |
| `code-review` | 已介绍双轴评审 | 正式毕业，增加 Fowler Code Smell 基线 |
| `grilling` | 已介绍需求访谈 | 增加 Confirmation Gate 和 Facts / Decisions 区分 |
| `prototype` | 已列入清单 | 改为 model-invoked |
| `tdd` | 已介绍 Seam 和 Tautological Test | 删除 Refactor 阶段，收缩为参考型 Skill |
| `triage` | 主要处理 Issues | 增加外部 PR 支持 |
| `writing-great-skills` | 已介绍主要概念 | 增加 Negation 和 Negative Space |
| `ask-matt` | 已介绍路由作用 | 补全遗漏的技能和 Wayfinder 路由 |

v1.1.0 最终注册了 21 个正式技能。上一篇文章列出的清单中已经包含 `research` 和 `code-review`，但仍然使用 `to-prd`、`to-issues`，并且没有 `wayfinder`。

## 十二、升级后的使用方式

旧版用户首先需要记住两个名称变化：

```text
/to-prd     → /to-spec
/to-issues  → /to-tickets
```

然后根据任务选择入口：

| 当前任务 | 推荐入口 |
| --- | --- |
| 不知道应该使用哪个 Skill | `/ask-matt` |
| 想法还没有讨论清楚 | `/grill-with-docs` |
| 已经讨论清楚，需要生成 Spec | `/to-spec` |
| 需要把 Plan、Spec 或对话拆成 Tickets | `/to-tickets` |
| 项目很大，一个 Agent 会话无法规划清楚 | `/wayfinder` |
| 需要调查官方资料或源码 | `research` |
| 需要用可丢弃代码验证设计 | `prototype` |
| 已经有明确 Ticket，需要实现 | `/implement` |
| 遇到 Bug 或性能回归 | `diagnosing-bugs` |
| 实现完成，需要检查代码 | `code-review` |

普通功能可以使用：

```text
/grill-with-docs
  → 用户确认理解一致
  → /to-spec
  → /to-tickets
  → /implement
  → /code-review
```

超大型工作可以使用：

```text
/wayfinder
  → research / prototype / grilling
  → 解决关键未知问题
  → /to-spec
  → /to-tickets
  → /implement
```

如果升级后需要使用 Wayfinder、外部 PR Triage 或新的 Tracker 能力，建议重新运行：

```text
/setup-matt-pocock-skills
```

检查项目中的 Issue Tracker、Wayfinding operations 和 PR Triage 配置。

## 参考资料

- [mattpocock/skills v1.1.0 Release](https://github.com/mattpocock/skills/releases/tag/v1.1.0)
- [mattpocock/skills v1.1.0 README](https://github.com/mattpocock/skills/blob/v1.1.0/README.md)
- [v1.1.0 插件技能清单](https://github.com/mattpocock/skills/blob/v1.1.0/.claude-plugin/plugin.json)
- [MattPocock Skills：给真实工程师的 AI Agent 工作流](/2026/07/06/matt-pocock-skills/)
