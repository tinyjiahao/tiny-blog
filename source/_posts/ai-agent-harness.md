---
title: Harness  Engineering 工程详解：让 AI Agent 更稳定的执行
date: 2026-07-13 18:50:33
description: '「AI Agent Harness 详解」—— 参考“模型是大脑，Harness 是身体”的思路，用知乎点赞作为例子，讲清 Harness 如何通过工具注册表、上下文管理、Agent Loop、护栏、结果验证、确定性接管和可观测性，让 Agent 从会回答变成能稳定执行。'
cover: /images/ai-agent-harness-hero.svg
categories:
  - AI 工程
tags:
  - AI Agent
  - Harness
  - 工具调用
  - 浏览器自动化
  - 可观测性
---

![AI Agent Harness 详解](/images/ai-agent-harness-hero.svg)

> 很多 Agent 看起来“不靠谱”，不一定是模型太弱。更常见的问题是：模型外面没有一套足够稳的执行框架。它不知道什么时候该停，不知道结果怎么验证，不知道登录这种确定性流程该交给代码处理，也不知道失败后怎么收尾。
>
> 这套包在模型外面的执行框架，可以叫 **Harness**。一句话说，模型像大脑，Harness 像身体和神经系统：模型负责理解和判断，Harness 负责工具、状态、循环、护栏、验证和真实世界里的异常流程。

**本文脉络：**

- 一、为什么需要 Harness
- 二、什么是 Agent Harness
- 三、用“知乎点赞”看一个裸 Agent 会怎么失败
- 四、第一层：工具注册表，先让 Agent 有手
- 五、第二层：Agent Loop，让任务一轮轮推进
- 六、第三层：上下文管理，别让历史把 Agent 淹没
- 七、第四层：护栏，让失败在可控范围内结束
- 八、第五层：验证步骤，不要只听模型说“完成了”
- 九、第六层：确定性接管，不是什么都该让模型做
- 十、可观测性：每一步都要能复盘
- 十一、常见问题

<!-- more -->

## 一、为什么需要 Harness

我先说一个很容易误判的问题。

当 Agent 做错事时，我们第一反应通常是：

> 模型不够强，换个更强的模型试试。

这当然有时有效。但很多生产问题，换模型也解决不了。

比如让 Agent 做一个看起来很简单的浏览器任务：

> 打开某个知乎回答，如果我已经授权并登录，就帮我点一下“赞同”。

这个例子只用于授权测试账号和自有内容，不用于批量刷赞、绕过平台规则或操纵互动数据。我们关心的不是“怎么刷赞”，而是借这个动作理解 Agent 如何进入真实网页工作流。

这个任务在人看来很简单：

1. 打开页面。
2. 看是否登录。
3. 找到“赞同”按钮。
4. 如果还没赞同，就点一下。
5. 看按钮状态是否变化。

但对裸 Agent 来说，麻烦很多：

- 页面 DOM 很复杂。
- 登录态可能变化。
- 按钮文案和状态可能不同。
- 点击后可能没有立刻刷新。
- 任务失败时，模型可能仍然总结“已完成”。
- 几轮操作后，上下文里堆满 HTML 和工具日志。

这时问题不只是“模型会不会理解中文”。真正的问题是：**谁来管理它的执行过程？**

这就是 Harness 的位置。

## 二、什么是 Agent Harness

Harness 这个词本意有“安全带、马具、线束”的意思。放到 Agent 里，可以理解为：

> Harness 是包在模型外面的一整套工程系统，用来约束、支撑、验证和驱动 Agent 的执行。

它不是单个组件，而是一组控制层。

![Agent Harness 分层图](/images/harness-layers.svg)

一个实用的 Agent Harness 通常包含：

| 层次 | 解决什么问题 |
| --- | --- |
| 工具注册表 | 模型能调用哪些工具，参数是什么，权限在哪里 |
| Agent Loop | 如何观察、计划、执行、接收工具结果、继续下一步 |
| 上下文管理 | 哪些信息保留，哪些压缩，哪些丢弃 |
| 护栏 | 最多执行多少轮，哪些动作要确认，什么时候强制停止 |
| 验证步骤 | 任务是否真的完成，而不是模型声称完成 |
| 确定性接管 | 登录、权限判断、固定表单流程由代码接管 |
| 可观测性 | 记录每一步工具调用、状态变化、失败原因和成本 |

所以，Harness 不是 Prompt 的替代品，也不是 RAG 的替代品。它更像 Agent 的运行时。

Prompt 告诉模型“你要做什么”；Harness 决定模型“能怎么做、做到哪一步、怎么证明做成了”。

## 三、用“知乎点赞”看一个裸 Agent 会怎么失败

先想象一个最原始的 Agent。

它有一个浏览器工具，能打开网页、读取 DOM、点击元素。你给它一句话：

```text
打开这个知乎回答，如果还没赞同，就点击赞同按钮。
```

它可能会这样跑：

1. 打开知乎回答页。
2. 读取页面 DOM。
3. 找一个看起来像“赞同”的按钮。
4. 点击。
5. 总结“已完成”。

听起来没问题，但真实页面里会遇到一堆分叉。

| 分叉 | 裸 Agent 可能的问题 |
| --- | --- |
| 未登录 | 看到登录弹窗后不知道该继续还是停止 |
| 已经赞同 | 可能重复点击，反而取消赞同 |
| 页面加载慢 | DOM 还没出来就开始判断 |
| 按钮有多个 | 点到评论区、推荐卡片或其他回答 |
| 点击失败 | 工具返回异常，但模型仍然说成功 |
| 状态没变化 | 没有验证，无法确认任务真的完成 |

这里最危险的不是失败，而是**失败后自信地说成功**。

所以我们要给它加 Harness。

## 四、第一层：工具注册表，先让 Agent 有手

Agent 不能直接“操作世界”。它只能通过工具操作世界。

在知乎点赞这个例子里，工具可以设计得很克制：

| 工具 | 作用 | 权限 |
| --- | --- | --- |
| `open_page(url)` | 打开目标回答页 | read |
| `get_page_state()` | 读取当前 URL、登录态、按钮状态 | read |
| `click_upvote(answer_id)` | 点击指定回答的赞同按钮 | write |
| `take_screenshot()` | 截图用于验证 | read |
| `verify_upvoted(answer_id)` | 检查是否已赞同 | read |

注意这里不要只给一个万能的 `click(selector)`。

万能工具看起来灵活，但风险很高。模型可能点错按钮，也可能点到危险动作。更好的方式是把关键动作封装成语义工具：

```json
{
  "name": "click_upvote",
  "description": "点击指定知乎回答的赞同按钮，仅用于授权测试场景",
  "input_schema": {
    "answer_id": "string"
  },
  "permission": "write",
  "requires_confirmation": false
}
```

工具注册表的价值在于：它不是让模型“想点哪里点哪里”，而是把模型能做的动作收敛到一组可审计、可限制的接口里。

## 五、第二层：Agent Loop，让任务一轮轮推进

有了工具，还需要循环。

一次 Agent 执行通常不是“模型说一句，工具做一次”就结束，而是一个循环：

![知乎点赞 Harness 执行流](/images/zhihu-like-harness-flow.svg)

可以写成伪代码：

```ts
for (let step = 0; step < maxSteps; step++) {
  const observation = await observe(browser);
  const action = await model.plan(goal, observation, context);

  if (action.type === "finish") {
    break;
  }

  const result = await tools.call(action);
  context = updateContext(context, observation, action, result);
}
```

这个循环里最重要的是三件事：

- 每一轮都要观察真实页面状态。
- 每一次工具调用都要返回结构化结果。
- 每一步都要更新上下文，而不是把所有历史原样塞回去。

裸 Agent 常常失败在这里：它只会“一路往前说”，但没有一个外部循环帮它收集状态、驱动下一步、判断是否停止。

## 六、第三层：上下文管理，别让历史把 Agent 淹没

浏览器任务最容易污染上下文。

一次 `get_page_state()` 可能返回很多 DOM。几轮之后，上下文里会堆满：

- 页面 HTML
- 工具调用参数
- 工具返回结果
- 模型计划
- 错误信息
- 历史截图描述

如果不压缩，模型很快会被历史淹没。

知乎点赞任务其实只需要保留少量状态：

```json
{
  "goal": "对 answer_id=xxx 的回答执行一次赞同",
  "current_url": "https://www.zhihu.com/question/.../answer/...",
  "login_state": "logged_in",
  "upvote_state": "not_upvoted",
  "last_action": "click_upvote",
  "last_result": "click_sent",
  "step": 4
}
```

这比把整页 DOM 原样塞回模型有效得多。

上下文管理的原则是：**只带下一步决策需要的信息**。

如果下一步只是判断“要不要点击赞同”，它不需要完整 HTML；如果下一步是定位按钮，才需要局部 DOM 或截图描述。

## 七、第四层：护栏，让失败在可控范围内结束

Agent 最大的问题之一是失控。

比如它找不到按钮，可能反复读取页面；登录弹窗挡住按钮，可能反复点击同一个位置；工具返回超时，它可能不断重试。

Harness 必须给运行过程设边界。

| 护栏 | 示例 |
| --- | --- |
| 最大步数 | `maxSteps = 8` |
| 最大工具调用 | `maxToolCalls = 12` |
| 单工具超时 | `click_upvote` 超过 3 秒失败 |
| 重试上限 | 同一动作最多重试 2 次 |
| 风险动作确认 | 写操作、发布、删除等需要确认 |
| 状态异常停止 | 检测到账号异常、验证码、风控页面时停止 |

对于知乎点赞这个例子，一旦出现验证码、账号异常、频繁操作提示，就应该停止，而不是让 Agent 想办法绕过去。

这不是技术做不到，而是不该做。

好的 Harness 不只是让 Agent 更强，也要让 Agent 知道边界在哪里。

## 八、第五层：验证步骤，不要只听模型说“完成了”

这是整篇最关键的一节。

Agent 说“我已经点了赞同”，不代表真的点了。

必须验证。

知乎点赞可以有三种验证方式：

| 验证方式 | 说明 |
| --- | --- |
| DOM 验证 | 赞同按钮是否处于 selected / pressed 状态 |
| 接口验证 | 如果有授权 API，检查当前用户是否已赞同该回答 |
| 视觉验证 | 截图确认按钮状态变化 |

验证逻辑最好不要完全交给模型。

可以由确定性代码完成：

```ts
async function verifyUpvoted(page, answerId) {
  const state = await page.evaluate((id) => {
    const root = document.querySelector(`[data-answer-id="${id}"]`);
    const button = root?.querySelector('[aria-label*="赞同"]');

    return {
      exists: Boolean(button),
      pressed: button?.getAttribute("aria-pressed") === "true",
      text: button?.textContent?.trim()
    };
  }, answerId);

  return state.exists && state.pressed;
}
```

真实实现要按页面结构调整，这里只是说明思路。

关键点是：**结果判断权要从模型嘴里拿回来，交给可验证的状态变化。**

## 九、第六层：确定性接管，不是什么都该让模型做

登录就是典型例子。

如果打开知乎回答时发现未登录，很多人会让 Agent 自己处理登录。但登录这件事其实不适合交给模型自由发挥：

- 输入框位置确定。
- 提交流程确定。
- 账号密码敏感。
- 失败状态明确。
- 触发验证码或风控时必须停止。

所以更好的做法是 Harness 接管。

流程可以是：

1. 每轮循环先检查当前 URL 和页面状态。
2. 如果进入登录页或出现登录弹窗，暂停模型控制。
3. 触发预先写好的登录处理逻辑。
4. 登录成功后回到原回答页。
5. 再把控制权交还给 Agent。

这里要注意：不要把账号密码交给模型，也不要让模型决定如何绕过验证码。

登录接管的价值在于：识别出模型不擅长、也不应该自由处理的流程，用确定性代码完成，然后把页面恢复到模型能继续工作的状态。

这就是 Harness 的味道。

## 十、可观测性：每一步都要能复盘

如果 Agent 最后失败了，你要知道失败在哪一步。

至少记录：

| 记录项 | 示例 |
| --- | --- |
| `run_id` | 一次点赞任务的唯一 ID |
| `step` | 第几轮 Agent Loop |
| `observation` | 当前 URL、登录态、按钮状态 |
| `action` | 模型决定调用哪个工具 |
| `tool_result` | 工具成功、失败、超时、返回摘要 |
| `verification` | 验证是否通过 |
| `cost` | Token、工具调用次数、耗时 |
| `failure_type` | login_required / button_not_found / verify_failed |

失败不要只写：

```text
failed
```

要写清楚：

```json
{
  "failure_type": "verify_failed",
  "last_action": "click_upvote",
  "upvote_state_before": "not_upvoted",
  "upvote_state_after": "not_upvoted",
  "recovery_action": "stop_and_report"
}
```

这和前面「AI Agent 可观测性」那篇文章是一脉相承的。Harness 负责执行控制，可观测性负责让执行过程可解释、可调试、可优化。

## 十一、常见问题

| 问题 | 回答要点 |
| --- | --- |
| Harness 和 Prompt 有什么区别？ | Prompt 是任务说明；Harness 是执行框架。Prompt 告诉模型要做什么，Harness 管理模型怎么做、什么时候停、怎么验证。 |
| Harness 和 Tools 是一回事吗？ | 不是。Tools 只是 Harness 的一部分。Harness 还包括上下文、循环、护栏、验证、接管和观测。 |
| 为什么不让模型自己验证？ | 模型可以参与判断，但最终应该看真实状态变化，比如 DOM、接口、数据库或截图。模型说完成不等于真的完成。 |
| 知乎点赞这个例子会不会有风险？ | 有。真实平台互动必须遵守平台规则，只能用于授权测试账号、自有内容或内部演示，不应用于批量点赞、刷量或绕过风控。 |
| Harness 会不会让系统变复杂？ | 会，但这是 Agent 进入真实工作流必须付出的复杂度。没有 Harness，复杂性只是藏在模型幻觉和随机失败里。 |
| 什么时候最需要 Harness？ | 只要 Agent 要调用工具、操作网页、处理状态、执行多步任务或产生真实副作用，就需要 Harness。 |

最后用一句话收束：

> 模型决定 Agent 能不能“想明白”，Harness 决定 Agent 能不能“做稳定”。

很多 Agent 的上限不只在模型，也在模型外面的工程系统。把 Harness 做扎实，Agent 才能从一个会聊天的模型，变成一个能进入真实流程的执行者。

## 参考资料

- [讲 Harness 最透彻的一篇文章。](https://mp.weixin.qq.com/s/uORPqLLrht3p-H7gj4co0g)
- [Tejas Kumar: Harness Engineering 分享笔记来源](https://podwise.ai/dashboard/episodes/8013289)
