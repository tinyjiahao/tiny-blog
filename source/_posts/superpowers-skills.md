---
title: Superpowers：给编码 Agent 装上一套开发方法论
date: 2026-07-07 10:00:00
description: '「Superpowers 实战解析」 —— 一套用 Skills 构建的开发方法论，让编码 Agent 从「你说一句它写一段」升级到「自动走完头脑风暴→设计→计划→TDD→代码审查→交付」的全流程。覆盖 14 个核心 Skills、7 步工作流、设计哲学与跨 Agent 工具适配。'
categories:
  - AI 工程
tags:
  - AI Agent
  - Skills
  - TDD
  - Claude Code
  - 开发方法论
---

> **Superpowers** 是一套「装在编码 Agent 上的软件开发方法论」，由一组可组合的 Skills 构成。它解决的不是「让 Agent 写代码更快」，而是「让 Agent 像一个靠谱的工程师那样工作」——先想清楚需求、再设计方案、然后写测试、按计划实现、互相 review、最后干净交付。
>
> 本文拆解它的 14 个核心 Skills、7 步工作流，以及它为什么能跨 Claude Code、Codex、Cursor、Antigravity 等十余种 Agent 工具运行。如果你已经读过本博客的「AI Agent 技能实战解析」，这篇是它的进阶——看一个真实、完整、生产级的 Skills 体系长什么样。

```
本文脉络：
  一    Superpowers 是什么：不是工具，是方法论
  二    核心工作流：从想法到交付的 7 步
  三    14 个 Skills 全景：按职责分类
  四    设计哲学：TDD、系统化、证据驱动
  五    它是怎么「自动生效」的：session-start 注入
  六    跨 Agent 适配：一份 Skills，十种工具
  七    和单兵 Skill 的区别：为什么是「体系」
  八    上手与踩坑
  九    速查表
```

<!-- more -->

## 一、Superpowers 是什么：不是工具，是方法论

先纠正一个常见误解：**Superpowers 不是一个「让 Agent 多几个功能」的工具集，而是一套强制约束 Agent 工作方式的方法论**。

普通的 Agent 用法是「你说一句，它写一段」：

```
你：帮我加个登录接口
Agent：（直接开始写代码，写完丢给你）
  → 需求理解对不对？不知道
  → 有没有测试？大概率没有
  → 代码质量？看运气
  → 怎么 review？自己看
```

装了 Superpowers 之后，Agent 会**主动按流程走**：

```
你：帮我加个登录接口
Agent：（不急着写代码）
  → 先用 brainstorming 技能问你：登录方式？鉴权方案？错误处理？
  → 整理成设计文档，分块给你确认
  → 你确认后，用 writing-plans 拆成 5 个小任务，每个 2~5 分钟
  → 你说 go，用 subagent-driven-development 派子 Agent 逐个实现
  → 每个任务强制 TDD：先写测试 → 看它红 → 写实现 → 看它绿
  → 任务间用 requesting-code-review 互相 review
  → 全部完成后，用 finishing-a-development-branch 收尾（合并/PR/清理）
```

**关键区别**：Superpowers 把「软件工程的最佳实践」固化成 Agent 会**自动触发**的 Skills，让 Agent 从「打字员」升级成「按流程办事的工程师」。

```
作者 Jesse Vincent 在发布文章里说得很直白：
  强调严格的 red/green TDD、YAGNI、DRY。
  实现计划要清晰到「一个热情但没品味、没判断力、没项目上下文、
  还讨厌写测试的初级工程师」都能照着做。
```

---

## 二、核心工作流：从想法到交付的 7 步

这是 Superpowers 的主干。一个完整的开发任务，会按这 7 步走：

```
┌─────────────────────────────────────────────────────────────┐
│  ① brainstorming（头脑风暴）                                 │
│     写代码前激活。通过提问把模糊想法变成清晰需求，            │
│     分块呈现设计让你确认，最后落盘成设计文档                  │
├─────────────────────────────────────────────────────────────┤
│  ② using-git-worktrees（git 工作树隔离）                     │
│     设计批准后激活。在新分支上创建隔离工作区，                │
│     跑项目初始化、确认测试基线是干净的                        │
├─────────────────────────────────────────────────────────────┤
│  ③ writing-plans（写实现计划）                               │
│     把工作拆成 2~5 分钟一个的小任务，                         │
│     每个任务都有精确文件路径、完整代码、验证步骤              │
├─────────────────────────────────────────────────────────────┤
│  ④ subagent-driven-development（子 Agent 驱动开发）          │
│     每个任务派一个全新子 Agent 实现，                        │
│     两阶段 review：先查是否符合规格，再查代码质量             │
│     （也可以用 executing-plans：人工检查点批执行）            │
├─────────────────────────────────────────────────────────────┤
│  ⑤ test-driven-development（测试驱动）                       │
│     实现期间强制 RED-GREEN-REFACTOR：                         │
│     写失败的测试 → 看它失败 → 写最小实现 → 看它通过 → 提交    │
│     先于测试写的代码会被删掉                                  │
├─────────────────────────────────────────────────────────────┤
│  ⑥ requesting-code-review（代码审查）                        │
│     任务之间激活，对照计划检查，按严重程度报告问题            │
│     严重问题会阻塞后续进展                                    │
├─────────────────────────────────────────────────────────────┤
│  ⑦ finishing-a-development-branch（收尾）                    │
│     所有任务完成后激活。验证测试，                            │
│     给出选项（合并 / PR / 保留 / 丢弃），清理 worktree        │
└─────────────────────────────────────────────────────────────┘
```

**为什么强调「2~5 分钟一个任务」**：子 Agent 的上下文有限，任务太大会跑偏、会漏边界条件。切成小块，每个子 Agent 聚焦一件事，做完被 review，问题能在早期暴露。

**为什么用子 Agent 而不是主 Agent 直接写**：主 Agent 负责调度和 review，保持「全局视野」；子 Agent 只管「实现这个具体任务」，上下文干净、不被前面的对话污染。Jesse Vincent 说，这套流程下 Agent 经常能**自主工作两小时不偏离计划**。

---

## 三、14 个 Skills 全景：按职责分类

Superpowers 内置 14 个 Skills，按职责分成五类：

### 测试类

| Skill | 作用 |
|-------|------|
| **test-driven-development** | 强制 RED-GREEN-REFACTOR 循环，附「测试反模式」参考资料 |

### 调试类

| Skill | 作用 |
|-------|------|
| **systematic-debugging** | 4 阶段根因定位流程，含 root-cause-tracing、defense-in-depth、condition-based-waiting 等技巧 |
| **verification-before-completion** | 声称「修好了」之前，必须运行验证命令确认 |

### 协作类（工作流主干）

| Skill | 作用 |
|-------|------|
| **brainstorming** | 苏格拉底式设计推演，把模糊需求变成清晰规格 |
| **writing-plans** | 把设计拆成可执行的细粒度任务清单 |
| **executing-plans** | 带人工检查点的批次执行（subagent-driven 的轻量替代） |
| **dispatching-parallel-agents** | 并发派发多个子 Agent 处理独立任务 |
| **requesting-code-review** | 主动发起 review，按计划核对 |
| **receiving-code-review** | 接到 review 反馈后怎么处理（不盲从，也不对抗） |
| **using-git-worktrees** | 用 git worktree 做并行开发的隔离工作区 |
| **finishing-a-development-branch** | 开发完成后的合并/PR/清理决策 |
| **subagent-driven-development** | 子 Agent 快速迭代 + 两阶段 review（规格符合性 + 代码质量）|

### 元类

| Skill | 作用 |
|-------|------|
| **writing-skills** | 怎么按规范创建和测试新 Skill |
| **using-superpowers** | 整个 Skills 系统的入口介绍 |

```
注意这 14 个不是「平级」的：
  using-superpowers    是入口（每次启动注入）
  brainstorming → writing-plans → subagent-driven-development
                      是主干（串起完整流程）
  其余是配套（在主干的特定节点触发）
```

---

## 四、设计哲学：TDD、系统化、证据驱动

Superpowers 的 Skills 不是随意拼凑的，背后有四条统一哲学：

```
① 测试驱动（Test-Driven Development）
   写测试在前，永远。先于测试写的代码会被删掉重来。
   理由：Agent 写代码容易「看起来对」，测试是唯一可靠的判据。

② 系统化优于即兴（Systematic over ad-hoc）
   任何任务都走流程，而不是「拍脑袋猜」。
   流程的意义是：让结果可复现、可审查、可改进。

③ 复杂度消减（Complexity reduction）
   简单是首要目标。YAGNI（你不会需要它）、DRY 是硬约束。
   Agent 天然有「过度设计」的倾向，这两个原则是反制。

④ 证据优于声明（Evidence over claims）
   说「修好了」之前，必须跑验证命令、看输出。
   不允许「应该可以了」「理论上对了」这种含糊声明。
```

**为什么这四条重要**：Agent（LLM）有几个天然弱点——容易过度自信、容易跳过验证、容易过度设计。Superpowers 的哲学**针对性反制**这些弱点，本质是用流程约束 LLM 的不可靠性。

```
对比普通 Agent 和 Superpowers Agent：

普通 Agent：
  「我加好了登录接口，应该能用。」（声明，无证据）
Superpowers Agent：
  「登录接口实现完成。测试 LoginTest.test_password_login 通过（5/5），
   边界用例 test_wrong_password 通过，未覆盖记住登录功能，
   建议下一轮补。」（证据 + 自报遗漏）
```

---

## 五、它是怎么「自动生效」的：session-start 注入

很多人好奇：装了 Superpowers，Agent 怎么就「自动按流程走」了？答案在它的 session-start hook。

```
普通 Skills 的触发：
  Agent 看到所有 Skills 的 description，
  匹配到才加载正文（按需触发）

Superpowers 的特殊之处：
  它有一个 session-start hook，每次会话启动时
  强制把 using-superpowers 这个 Skill 的全文
  注入到 Agent 上下文里

  → Agent 一睁眼就「知道自己有 Superpowers」
  → using-superpowers 里写了「每个任务前先检查相关 Skill」
  → 于是后续每个环节都会主动触发对应 Skill
```

```
hooks/session-start 的核心逻辑（简化）：

  #!/usr/bin/env bash
  # 读取 using-superpowers 的 SKILL.md 全文
  content=$(cat skills/using-superpowers/SKILL.md)

  # 包裹成「极其重要」的上下文，注入会话
  context="<EXTREMELY_IMPORTANT>
           You have superpowers.
           下面是 using-superpowers 技能的全文……
           </EXTREMELY_IMPORTANT>"

  # 输出给 Agent 作为开场上下文
  echo "$context"
```

**这个设计的巧妙之处**：它不依赖你「记得用 Superpowers」，而是**让 Agent 一启动就处于 Superpowers 模式**。这就是 README 里说的「Your coding agent just has Superpowers」——你不需要做任何特殊操作，方法论自动生效。

```
对比两种「让方法论生效」的方式：

方式 A：靠人记得
  文档告诉用户「写代码前先跑 brainstorming 技能」
  → 人会忘、会偷懒、会跳过

方式 B：靠 Agent 自己触发（Superpowers 的做法）
  会话启动注入 using-superpowers
  → Agent 知道有这套技能
  → 每个任务前主动检查「有没有相关 Skill」
  → 人不用记，Agent 自己走流程
```

---

## 六、跨 Agent 适配：一份 Skills，十种工具

Superpowers 支持的 Agent 工具多得有点夸张：

```
Claude Code、Codex App、Codex CLI、Cursor、Antigravity、
Factory Droid、GitHub Copilot CLI、Kimi Code、OpenCode、Pi
```

它是怎么做到「一份 Skills 适配这么多工具」的？核心是**两件事**：

### 1. Skills 本身是工具无关的 Markdown

```
skills/brainstorming/SKILL.md
  就是一份普通 Markdown，描述「怎么做头脑风暴」

它不调用任何具体工具的 API，
只是告诉 Agent「这个环节该做什么、该问什么」
→ 任何能读 Markdown 指令的 Agent 都能用
```

### 2. 每个 Agent 有一个适配层（plugin.json / 扩展）

```
以 Kimi Code 的 plugin.json 为例，有一个 skillInstructions 字段：

  "skillInstructions": "
    当 Skill 说『问用户』时，调用 Kimi 的 AskUserQuestion 工具；
    当 Skill 说『TodoWrite』时，用 Kimi 的 TodoList 工具；
    当 Skill 说『派子 Agent』时，用 Kimi 的 Agent 工具……
  "

→ 把 Skill 里的「抽象动作」映射到具体工具的 API
→ 同一份 Skill，不同工具各自配一个适配层
```

```
Claude Code：用 plugin 系统的 sessionStart hook 注入
Cursor：用 add-plugin 命令安装
Codex：有官方 plugin marketplace
Pi：作为 Pi package 加载，原生支持 skills
OpenCode：自己的 plugin install 机制

底层都是同一份 skills/ 目录，差异只在「怎么装、怎么注入」
```

**这套设计给我们的启发**：写 Skill 时**不要绑定具体工具的 API**，用「问用户」「派子 Agent」「写待办」这种抽象动作描述，让 Skill 可移植。具体的工具映射交给适配层处理。

---

## 七、和单兵 Skill 的区别：为什么是「体系」

本博客之前的「AI Agent 技能实战解析」讲的是**怎么写一个独立的 Skill**。Superpowers 给出的进阶认知是：**单个 Skill 的价值有限，Skills 组成体系才能质变**。

```
单个 Skill（如 tech-writer）：
  解决一类任务（写技术文章）
  独立触发，互不关联
  适合：单一场景的效率工具

Skills 体系（如 Superpowers）：
  覆盖一个完整领域（软件开发全流程）
  Skills 之间有调用关系、有顺序、有交接
  适合：把一套方法论固化下来
```

```
Superpowers 里 Skills 是怎么协作的：

  brainstorming（设计阶段）
    → 产出设计文档，交给 writing-plans
  writing-plans（计划阶段）
    → 读设计文档，产出任务清单，交给 subagent-driven-development
  subagent-driven-development（实现阶段）
    → 每个任务派子 Agent，过程中触发 test-driven-development
    → 任务间触发 requesting-code-review
    → 全部完成触发 finishing-a-development-branch

  → Skills 不是孤立工具，是一条流水线
```

**判断你要的是「单兵 Skill」还是「Skills 体系」**：

| 你的需求 | 该用什么 |
|---------|---------|
| 反复做某一类事（写文章、生成 commit） | 单个 Skill |
| 想让 Agent 在某个完整领域里像专家一样工作 | Skills 体系（参考 Superpowers 的结构）|
| 想固化团队的开发流程/规范 | Skills 体系（流程节点都做成 Skill）|

---

## 八、上手与踩坑

### 安装

以 Claude Code 为例（最主流）：

```bash
# 方式一：Anthropic 官方 marketplace
/plugin install superpowers@claude-plugins-official

# 方式二：Superpowers 自己的 marketplace
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```

其他工具见项目的 [README](https://github.com/obra/superpowers)。

### 踩坑提示

| 坑 | 后果 | 对策 |
|----|------|------|
| **不信任流程，急着让 Agent 写代码** | Superpowers 会被架空，退化回普通 Agent | 至少完整走一次 brainstorming → plan → 实现，体会差异 |
| **跳过 brainstorming 直接给详细需求** | 后续 plan 可能和你预期不符 | 即使需求清楚，也走一遍设计确认，能补盲点 |
| **任务拆太大** | 子 Agent 跑偏、上下文溢出 | writing-plans 阶段盯紧任务粒度，坚持 2~5 分钟一个 |
| **review 反馈不当真** | 问题积累到后期爆炸 | 严重问题会阻塞流程，别手动绕过 |
| **在错误的项目上用** | 强行 TDD 会让脚本类项目变累 | 工具脚本、一次性代码可以不开 Superpowers |

### 什么时候**不适合**用

```
Superpowers 的设计假设是「正经软件项目」。
以下场景可能 overkill：

  - 写一次性脚本（数据分析、临时工具）
  - 做探索性 prototype（需求天天变）
  - 改一两个 typo / 文案
  - 学习用的 demo 项目

这些场景强行走完整流程，反而比直接写更慢。
```

---

## 九、速查表

| 你可能想问 | 一句话答案 |
|----------|----------|
| Superpowers 是什么？ | 一套用 Skills 构建的开发方法论，让 Agent 按流程做事而非即兴发挥 |
| 和单个 Skill 有什么区别？ | 单个 Skill 解决一类任务；Superpowers 是覆盖开发全流程的 Skills 体系 |
| 核心工作流几步？ | 7 步：头脑风暴→worktree→计划→子 Agent 实现→TDD→review→收尾 |
| 几个内置 Skill？ | 14 个，分测试/调试/协作/元类四类 |
| 它怎么自动生效的？ | session-start hook 把 using-superpowers 全文注入会话开场 |
| 怎么支持这么多 Agent 工具？ | Skills 本身工具无关（纯 Markdown），每个工具有适配层 |
| 怎么体现「证据驱动」？ | 声称完成前必须跑验证命令；不允许「应该可以了」 |
| 适合什么场景？ | 正经软件项目；不适合一次性脚本和探索性 prototype |
| 怎么装？ | `/plugin install superpowers@claude-plugins-official`（Claude Code）|

---

**一句话总结**：Superpowers 把「靠谱工程师的工作方式」——先想清楚、再拆细、TDD、互相 review、用证据说话——固化成 Agent 自动触发的 Skills。它的核心价值不是「让 Agent 多会几件事」，而是「让 Agent 按方法论做事，而不是即兴发挥」。

如果你正在用 Claude Code / Codex / Cursor 这类工具做正经开发，装上试一次完整流程，会真切感受到「Agent 从打字员变成工程师」的差别。

> 项目地址：[github.com/obra/superpowers](https://github.com/obra/superpowers) · 作者：Jesse Vincent · [原始发布文章](https://blog.fsck.com/2025/10/09/superpowers/)
