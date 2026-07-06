---
title: MattPocock Skills：给真实工程师的 AI Agent 工作流
date: 2026-07-06 09:30:00
description: '「MattPocock Skills」—— 介绍 mattpocock/skills 这个面向真实工程工作的 AI Agent 技能仓库：它如何用 grill、domain modeling、TDD、diagnosing bugs、code review 等小而可组合的技能，修复 AI 编码代理常见的需求错位、上下文混乱、反馈不足和架构退化问题。'
categories:
  - AI 工程
tags:
  - AI Agent
  - Skill
  - Claude Code
  - Codex
  - 工程实践
---

> Matt Pocock 开源的 [`mattpocock/skills`](https://github.com/mattpocock/skills) 是一套面向真实工程工作的 AI Agent 技能库。
>
> 它把需求澄清、领域建模、TDD、Bug 诊断、代码评审、任务拆分、PRD 编写等工程动作，拆成一组可以被 Claude Code / Codex 等 Agent 调用的 skills。使用它的重点，是让 Agent 按一套清晰流程协助工程工作。

![Matt Pocock Skills](/images/matt-pocock-skills-cover.png)

**本文脉络：**

- 一、mattpocock-skills 提供了什么
- 二、skills结构：它是怎么组织起来的
- 三、如何安装和初始化
- 四、两类技能：用户主动调用与模型自动触发
- 五、核心使用流程：从想法到交付
- 六、几个代表性 Skill 解析
- 七、按场景怎么使用
- 八、一个简单示例
- 九、使用建议
- 十、总结

<!-- more -->

## 一、mattpocock-skills 提供了什么

[`mattpocock/skills`](https://github.com/mattpocock/skills) 是 Matt Pocock 维护的一组 AI Agent Skills，面向 Claude Code、Codex 等编码代理。

它围绕工程工作流提供了一组互相配合的技能：

| 能力方向 | 代表技能 | 用途 |
| --- | --- | --- |
| 选择流程 | `ask-matt` | 根据当前任务判断该走哪条 skill flow |
| 需求澄清 | `grill-me`、`grill-with-docs`、`grilling` | 通过连续提问把想法问清楚 |
| 项目初始化 | `setup-matt-pocock-skills` | 配置 issue tracker、triage labels、domain docs |
| 领域建模 | `domain-modeling` | 维护项目术语、`CONTEXT.md` 和 ADR |
| 任务拆分 | `to-prd`、`to-issues` | 把对话变成 PRD，再拆成可执行 issue |
| 实现 | `implement`、`tdd` | 按 issue/PRD 实现，并用 TDD 推进 |
| Bug 诊断 | `diagnosing-bugs` | 建立反馈循环、复现、最小化、修复 |
| 架构改进 | `codebase-design`、`improve-codebase-architecture` | 发现深模块机会，改善代码结构 |
| 评审 | `code-review` | 从 Standards 和 Spec 两条轴检查改动 |
| 上下文交接 | `handoff` | 把当前会话整理成可延续的交接文档 |
| 学习与写作 | `teach`、`writing-great-skills` | 用 Agent 辅助学习，或编写更好的 skills |

从使用者视角看，它提供的是一个工程协作工具箱：当你要澄清需求、拆任务、实现功能、排查问题、评审代码时，都能找到对应的 skill。

## 二、skills结构：它是怎么组织起来的

mattpocock-skills 提供了一套清晰的插件结构，不只是把 `SKILL.md` 放在目录里。

核心目录大致是这样：

```text
mattpocock-skills/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── engineering/
│   ├── productivity/
│   ├── deprecated/
│   ├── in-progress/
│   ├── misc/
│   └── personal/
├── docs/
│   ├── engineering/
│   └── productivity/
├── .agents/
├── scripts/
├── CONTEXT.md
├── README.md
└── package.json
```

真正作为插件暴露给 Claude Code 的，是 `.claude-plugin/plugin.json` 里列出的技能。本地这份配置注册了 20 个正式技能：

| 分类 | 技能 |
| --- | --- |
| Engineering | `ask-matt`、`diagnosing-bugs`、`grill-with-docs`、`triage`、`improve-codebase-architecture`、`setup-matt-pocock-skills`、`tdd`、`to-issues`、`to-prd`、`implement`、`prototype`、`research`、`domain-modeling`、`codebase-design`、`code-review` |
| Productivity | `grill-me`、`grilling`、`handoff`、`teach`、`writing-great-skills` |

这点很重要：`skills/` 目录里还有 `deprecated`、`in-progress`、`misc`、`personal` 等目录，但它们不一定属于默认暴露面。真正应该被用户稳定依赖的，是插件清单里注册的正式技能。

另外，还有几类支撑文件：

| 文件/目录 | 作用 |
| --- | --- |
| `CONTEXT.md` | 记录这个技能仓库自己的领域语言，比如 Issue tracker、Issue、Triage role |
| `docs/engineering/`、`docs/productivity/` | 为每个正式 skill 生成或维护说明文档 |
| `.agents/` | Agent 写文档、调用规则、ADR 等协作约定 |
| `scripts/list-skills.sh` | 列出仓库里的所有 `SKILL.md` |
| `scripts/link-skills.sh` | 维护者本地开发用，把技能软链到 `~/.claude/skills` 和 `~/.agents/skills` |
| `.changeset/` | 记录技能变更，用于版本发布 |

从实现上看，它把 Skill 当作一个可发布、可演进、可维护的软件包来组织。

## 三、如何安装和初始化

安装方式很直接：

```bash
npx skills@latest add mattpocock/skills
```

安装时需要选择要安装到哪些 coding agents，并确保选中：

```text
/setup-matt-pocock-skills
```

安装后，在 Agent 里运行：

```text
/setup-matt-pocock-skills
```

这个初始化技能会配置其它 engineering skills 依赖的项目级信息：

| 配置项 | 用途 |
| --- | --- |
| Issue tracker | 告诉 `to-issues`、`to-prd`、`triage` 等技能应该把 issue 写到 GitHub、GitLab、本地 markdown，还是其它系统 |
| Triage labels | 告诉 `triage` 技能每个状态角色对应哪个真实 label |
| Domain docs | 告诉 `domain-modeling`、`tdd`、`diagnosing-bugs` 等技能项目的 `CONTEXT.md` 和 ADR 在哪里 |

初始化技能会生成或更新几类文档：

| 文件 | 作用 |
| --- | --- |
| `docs/agents/issue-tracker.md` | 记录 issue tracker 工作方式 |
| `docs/agents/triage-labels.md` | 记录 triage role 到真实 label 的映射 |
| `docs/agents/domain.md` | 记录领域文档布局，是单上下文还是多上下文 |
| `AGENTS.md` 或 `CLAUDE.md` 的 Agent skills 区块 | 告诉 Agent 这些配置在哪里 |

完成这一步后，其它技能才知道该从哪里读 issue、写文档、查领域语言、应用 triage 标签。

## 四、两类技能：用户主动调用与模型自动触发

mattpocock-skills把技能分成两类：

| 类型 | 谁来触发 | 作用 |
| --- | --- | --- |
| User-invoked | 用户手动输入，例如 `/grill-me` | 编排流程，启动一段明确的工作 |
| Model-invoked | 用户或模型都可以触发 | 承载可复用纪律，例如 TDD、调试、代码评审 |

这个分类很关键。

如果所有 skill 都让模型自动触发，系统提示会变重，Agent 每一轮都要带着一大堆触发描述，增加上下文负担。

如果所有 skill 都只能用户手动触发，又会增加用户记忆成本：你得记得什么时候该输入哪个命令。

所以 Matt Pocock 的做法是：

- 编排型 skill 多数由用户主动触发
- 纪律型 skill 可以被模型自动调用
- 用户主动触发的 skill 可以组合模型触发型 skill
- 用户主动触发的 skill 不再互相调用，避免编排层层嵌套

比如 `/grill-with-docs` 是用户主动调用的技能，它会启动一次需求拷问，并结合 domain modeling 去沉淀术语和架构决策。

而 `tdd`、`diagnosing-bugs`、`codebase-design` 这类技能，则更像工程纪律，可以被其它流程引用。

## 五、核心使用流程：从想法到交付

在这套skills里，`ask-matt` 把主要工作流描述成一条 **idea → ship** 的路线。可以把它理解成这套 skills 的推荐用法：

```text
1. /ask-matt
   不知道该用哪个 skill 时，先让它路由。

2. /grill-with-docs
   对一个功能想法进行需求澄清，同时沉淀领域语言和 ADR。

3. 必要时 /prototype
   如果某个设计问题靠讨论说不清，用一个可丢弃原型回答。

4. /to-prd
   把已经讨论清楚的需求整理成 PRD。

5. /to-issues
   把 PRD 拆成可独立执行的垂直切片 issue。

6. /implement
   每个 issue 单独实现，内部尽量走 /tdd。

7. /code-review
   完成后从 Standards 和 Spec 两条轴检查改动。
```

如果当前任务只覆盖其中一部分，也可以直接从中间进入：

| 当前任务 | 推荐入口 |
| --- | --- |
| 不知道该用哪个技能 | `/ask-matt` |
| 有一个模糊想法 | `/grill-with-docs` |
| 没有代码仓库，只想澄清一个计划 | `/grill-me` |
| 已经有 PRD，要拆 issue | `/to-issues` |
| 已经有一个明确 issue，要实现 | `/implement` |
| 只想 test-first 做一个小功能 | `/tdd` |
| 遇到难排 bug | `/diagnosing-bugs` |
| 代码库结构越来越难改 | `/improve-codebase-architecture` |
| 要评审一个分支或 PR | `/code-review` |
| 会话太长，需要交接 | `/handoff` |

## 六、几个代表性 Skill 解析

### 1. `ask-matt`：技能路由器

在这套skills里，`ask-matt` 是一个很关键但容易被忽略的 skill。

它不直接写代码，而是回答一个问题：

> 我现在应该用哪条 skill flow？

它把主要工作流描述成一条 **idea → ship** 的路线：

```text
grill-with-docs
  -> 必要时 handoff 到 prototype
  -> 多 session 时 to-prd
  -> to-issues 拆成垂直切片
  -> 每个 issue 用 implement
  -> implement 内部尽量走 tdd
  -> 最后 code-review
```

这相当于给整套技能库加了一个“路由层”。当用户不记得具体命令时，可以先问 `/ask-matt`，让它根据当前任务判断应该进入哪条流程。

这也解释了为什么仓库要区分 user-invoked 和 model-invoked：`ask-matt`、`grill-with-docs`、`to-prd`、`to-issues`、`implement` 更像编排型入口，而 `tdd`、`domain-modeling`、`codebase-design` 更像被流程复用的底层纪律。

### 2. `/grill-me` 与 `/grill-with-docs`：先拷问，再开工

AI 编码最常见的问题，是用户以为自己说清楚了，Agent 也以为自己听懂了。

结果开工后才发现：边界没定、异常没问、业务语言没统一、非目标场景没排除。

`/grill-me` 和 `/grill-with-docs` 的作用，就是在动手前先进行一轮高密度提问。

它们会把 Agent 带入一轮更细的需求追问：

- 这个功能到底服务谁？
- 哪些场景必须支持？
- 哪些场景明确不做？
- 失败时应该怎样表现？
- 和现有系统的边界在哪里？
- 有没有必须遵守的业务术语？

`/grill-with-docs` 更进一步：它不只问问题，还会把形成共识的术语和决策写进文档，例如 `CONTEXT.md` 和 ADR。

这让一次对话里的理解，不会只停留在当前上下文窗口里，而是沉淀为项目资产。

### 3. `domain-modeling`：给 Agent 建立共同语言

很多 Agent 回复啰嗦，不只是因为模型爱啰嗦，而是因为它没有项目里的“短词”。

人类团队里，一个成熟项目会有自己的领域语言。例如：

- “物化”
- “履约单”
- “冻结库存”
- “素材发布”
- “结算周期”

这些词背后压缩了大量业务含义。Agent 如果不懂，就只能用一整段自然语言绕过去。

`domain-modeling` 的目标，是在项目里维护这种共同语言。它会做几件事：

- 当用户使用模糊词时，逼近精确定义
- 当用户说法和已有 glossary 冲突时，指出冲突
- 用具体场景测试术语边界
- 在术语确定时更新 `CONTEXT.md`
- 对真正重要、难回滚、有取舍的决定，建议写 ADR

这和领域驱动设计里的 ubiquitous language 很像。这里的共同语言同时服务人和 Agent。

### 4. `tdd`：把“代码能跑”变成反馈循环

Agent 最大的弱点之一，是它能写出看起来合理、实际上没跑通的代码。

`tdd` skill 用红绿循环来解决这个问题：

```text
先写一个失败测试
  -> 写最少代码让它通过
  -> 一个垂直切片一个垂直切片推进
```

它强调几个点：

| 原则 | 含义 |
| --- | --- |
| red before green | 先看到测试失败，再写实现 |
| one slice at a time | 一次只推进一个垂直切片 |
| test at seams | 测公共边界，不测内部细节 |
| avoid tautological tests | 预期值必须来自独立来源，不要重复实现逻辑 |

这里最重要的是“seam”。测试会先确认公共边界，再围绕这个边界验证行为。

这能有效降低 Agent 常见的两种坏习惯：

- 写一堆贴着实现细节的脆弱测试
- 一口气写完所有代码，最后再试图补测试

### 5. `diagnosing-bugs`：先建立红灯，再猜原因

很多调试失败，是因为一开始就猜原因。

`diagnosing-bugs` 的第一步是建立反馈循环：必须有一个能稳定复现问题、能变红也能变绿的信号。

它建议的反馈循环包括：

- failing test
- curl / HTTP script
- CLI fixture
- Playwright / Puppeteer 脚本
- 重放真实请求或 trace
- 最小化 harness
- fuzz loop
- git bisect harness

只有当这个 loop 存在以后，后面的假设、插桩、修复才有意义。

这对 Agent 特别重要。因为 Agent 很容易在没有证据时写出“看似合理”的解释，然后顺手改代码。这个 skill 把它拉回工程纪律：**没有红灯，就别急着修。**

### 6. `implement`：把实现流程收束成一条工程闭环

本地实现里还有一个正式暴露的 `/implement` skill。它的正文很短，但位置很关键。

它负责把一个 PRD 或 issue 真正落到代码上，并约束实现过程：

- 尽可能使用 `/tdd`
- 在预先确认的 seam 上写测试
- 经常跑 typecheck
- 经常跑单个测试文件
- 最后跑完整测试套件
- 完成后用 `/code-review` 检查改动
- 最后提交当前分支

这个 skill 的特点是“短”。它不重复解释 TDD 和 code review 的所有规则，而是把这些规则交给专门的 skill。

这正是可组合设计的体现：编排型 skill 只负责调用顺序，工程纪律放在独立 skill 里维护。

### 7. `code-review`：把评审拆成 Standards 和 Spec 两条轴

代码评审很容易混在一起：

- 这段代码是否有风格问题？
- 它是否满足需求？
- 它是否引入了未要求的范围？
- 它是否有架构味道？

`code-review` skill 的做法是把评审拆成两条方向：

| 方向 | 关注点 |
| --- | --- |
| Standards | 是否符合项目编码标准和代码味道基线 |
| Spec | 是否忠实实现了 issue、PRD 或 spec |

这很有价值。因为一段代码可能：

- 写得很漂亮，但做错了需求
- 功能实现对了，但严重违反项目约定

把两个方向分开，可以避免一个问题遮住另一个问题。

### 8. `writing-great-skills`：Skill 本身也需要工程设计

还有一个很有意思的 productivity skill：`writing-great-skills`。

它教你怎么写好 skill。

里面有几个概念很值得借鉴：

| 概念 | 含义 |
| --- | --- |
| context load | skill 描述长期占用上下文的成本 |
| cognitive load | 用户必须记住某个 skill 存在的成本 |
| progressive disclosure | 把低频使用的细节下沉到外部文件 |
| completion criterion | 每一步必须有可检查的完成条件 |
| no-op | 不改变模型行为的废话规则 |
| leading word | 用一个强概念锚定一整套行为 |

这说明 Matt Pocock 把 skill 当成一种可以设计、拆分、维护和重构的工程对象。

## 七、按场景怎么使用

可以按任务场景来选择 skill：

| 场景 | 使用方式 |
| --- | --- |
| 开始一个新功能 | 先用 `/grill-with-docs` 澄清需求；如果是大功能，再用 `/to-prd` 和 `/to-issues` 拆解 |
| 实现一个明确 issue | 用 `/implement`，让它按 issue 执行、跑测试、最后 code review |
| 想 test-first 开发 | 直接用 `/tdd`，先确认 seam，再红绿循环 |
| 处理线上 bug 或复杂回归 | 用 `/diagnosing-bugs`，先建立可复现、可变红的反馈循环 |
| 整理一堆未处理 issue | 用 `/triage`，按状态机把 issue 归类、补充信息、写 agent brief |
| 代码库不好改 | 用 `/improve-codebase-architecture` 找 deepening opportunities |
| 分支完成后想检查 | 用 `/code-review`，分别检查 standards 和 spec |
| 需要跨会话继续 | 用 `/handoff` 输出交接文档，再开新会话继续 |
| 想学习某个概念 | 用 `/teach`，把当前目录当作状态化学习空间 |

## 八、一个简单示例

假设你想给一个博客项目增加“本地搜索页”，但还没有想清楚搜索范围、交互和验收方式，可以这样使用：

```text
用户：
/ask-matt
我想给博客增加一个本地搜索页，应该走哪个流程？

Agent：
建议先用 /grill-with-docs 澄清需求，因为这是一个新功能，
需要确认搜索数据来源、页面入口、移动端体验和验收标准。
```

接着进入需求澄清：

```text
用户：
/grill-with-docs
我要给博客增加一个本地搜索页。

Agent 可能会追问：
- 搜索范围是标题、摘要、正文，还是 tags/categories？
- 搜索结果要展示哪些字段？
- 是否需要高亮命中词？
- 搜索页入口放在哪里？
- 没有结果时怎么展示？
- 是否要兼容移动端？
```

需求问清楚后，可以把讨论整理成 PRD：

```text
用户：
/to-prd
把刚才讨论的本地搜索页整理成 PRD。
```

如果功能不小，再拆成 issue：

```text
用户：
/to-issues
把这个 PRD 拆成可以独立实现的垂直切片。
```

可能会得到这样的 issue：

| Issue | 内容 |
| --- | --- |
| 1 | 生成搜索索引数据，并在构建时输出 |
| 2 | 新增搜索页面和入口 |
| 3 | 实现搜索结果展示、空状态和移动端样式 |

最后，每个 issue 可以单独开一个新会话执行：

```text
用户：
/implement
请根据 PRD 和 issue #1 实现搜索索引数据生成。
```

`implement` 会尽量调用 `/tdd`，在确认测试 seam 后小步实现；完成后再用 `/code-review` 检查这次改动是否满足 spec 和项目标准。

## 九、使用建议

### 1. 先跑 setup

首次使用时先运行：

```text
/setup-matt-pocock-skills
```

它会把 issue tracker、triage labels、domain docs 这些基础信息写清楚。没有这些配置，`to-issues`、`triage`、`domain-modeling` 等技能就很难稳定工作。

### 2. 不确定时先问 ask-matt

如果你只记一个入口，可以记：

```text
/ask-matt
```

它会告诉你当前场景应该走哪条 flow。对新用户来说，这是降低记忆成本的最好入口。

### 3. 大任务不要直接 implement

如果任务还很模糊，先 `/grill-with-docs`。如果任务很大，先 `/to-prd` 和 `/to-issues`。等 issue 足够独立、足够清楚，再交给 `/implement`。

这样做的好处是：每个 Agent 会话只处理一个清晰的垂直切片，不需要在一个上下文里吞下整个大项目。

### 4. 把上下文写进项目

这套 skills 很重视把理解沉淀到项目文件里：

- `CONTEXT.md`：项目领域语言
- `docs/adr/`：重要架构决策
- `docs/agents/`：Agent 协作配置
- issue tracker：PRD、任务切片、triage brief

这些文件会让下一次 Agent 进来时更快进入状态。

### 5. 用 code-review 做收口

`implement` 会在完成后使用 `/code-review`。如果你手动完成了一段工作，也可以单独调用 `/code-review`。

它会把检查拆成两条轴：

- Standards：是否符合项目标准和代码味道
- Spec：是否实现了原始 issue / PRD

这个收口动作很适合放在提交前。

## 十、总结

`mattpocock/skills` 提供的是一组面向工程工作的 Agent skills：

- 用 `ask-matt` 选择流程
- 用 `grill-with-docs` 澄清需求并沉淀文档
- 用 `to-prd` / `to-issues` 拆解工作
- 用 `implement` / `tdd` 推进实现
- 用 `diagnosing-bugs` 处理复杂问题
- 用 `code-review` 收口质量
- 用 `domain-modeling` 和 ADR 保持长期上下文

它的使用方式也很清楚：先安装，运行 `/setup-matt-pocock-skills` 初始化项目配置；日常不确定怎么走时先 `/ask-matt`；遇到具体任务时选择对应 skill。对真实项目来说，这种“按任务类型调用明确 skill”的方式，比把所有要求塞进一次对话更容易维护。

## 参考资料

- [mattpocock/skills](https://github.com/mattpocock/skills)
- [skills.sh 上的 mattpocock/skills](https://skills.sh/mattpocock/skills)
- [grill-with-docs](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/SKILL.md)
- [tdd](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md)
- [diagnosing-bugs](https://github.com/mattpocock/skills/blob/main/skills/engineering/diagnosing-bugs/SKILL.md)
- [domain-modeling](https://github.com/mattpocock/skills/blob/main/skills/engineering/domain-modeling/SKILL.md)
- [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md)
- [writing-great-skills](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-great-skills/SKILL.md)
