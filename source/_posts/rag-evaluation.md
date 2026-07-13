---
title: RAG 系统如何评估：Recall、Faithfulness、RAGAS 与 LLM-as-Judge
date: 2026-07-10 20:32:34
description: '「RAG 系统如何评估」—— 从检索与生成两段拆解 RAG 质量，讲清 Recall、Precision、Faithfulness、Response Relevancy、RAGAS 与 LLM-as-Judge 的作用、实现方式、常见误区和落地流程。'
cover: /images/rag-evaluation-cover.png
categories:
  - AI 工程
tags:
  - RAG
  - RAGAS
  - LLM-as-Judge
  - Faithfulness
  - Recall
  - LLM
---

![RAG 系统评估](/images/rag-evaluation-cover.png)

> RAG 系统最容易出现一种错觉：Demo 里问几个问题都答得不错，就觉得可以上线了。真正上线后才发现，用户问法一变、文档一更新、召回一抖，答案就开始漏、偏、编。
>
> 评估 RAG 不能只问“答案看起来对不对”。要拆开看：**检索有没有找到关键证据，生成有没有忠于证据，答案有没有回应问题，评审本身是否稳定。**

**本文脉络：**

- 一、为什么 RAG 必须单独评估
- 二、先把 RAG 拆成两段：检索与生成
- 三、Recall：关键证据有没有找回来
- 四、Precision：检索结果是不是混进太多噪声
- 五、Faithfulness：回答有没有基于证据
- 六、Response Relevancy：回答有没有答到点上
- 七、RAGAS：把 RAG 评估流程自动化
- 八、LLM-as-Judge：用模型做裁判，但别迷信裁判
- 九、如何构建一套 RAG 评估集
- 十、怎么把评估接入研发流程
- 十一、常见误区与调优方向
- 十二、参考资料
- 十三、常见问题

<!-- more -->

## 一、为什么 RAG 必须单独评估

RAG（Retrieval-Augmented Generation）看起来是一条链路：

> 用户问题 → 检索相关文档 → 拼进 Prompt → LLM 生成答案

但出了问题时，它不是一个问题，而是至少四类问题：

| 现象 | 可能原因 |
| --- | --- |
| 答案缺关键事实 | 检索没召回相关文档 |
| 答案引用了很多无关内容 | 检索结果噪声太多 |
| 答案看起来流畅但事实错 | 模型没有忠于 context |
| 答案事实都对但没回答用户问题 | 生成阶段跑题或漏答 |

所以 RAG 评估不能只看最终答案。最终答案错了，可能是 Retriever 的锅，也可能是 Generator 的锅，还可能是问题改写、Rerank、Prompt 或知识库版本的锅。

这就是 RAG 评估的第一条原则：

> **先定位问题在哪一段，再谈怎么优化。**

不拆段评估，很容易乱调。比如 Recall 很低时，你去改 Prompt，效果不会稳定；Faithfulness 很低时，你去换向量库，也未必解决幻觉。

## 二、先把 RAG 拆成两段：检索与生成

![RAG 评估流水线](/images/rag-evaluation-pipeline.svg)

RAG 至少要拆成两段看。

第一段是 **检索评估**：

- 用户问了什么；
- 系统检索回哪些 context；
- 关键证据有没有被检索出来；
- 排在前面的 context 是否真的相关。

第二段是 **生成评估**：

- 模型是否使用了检索到的证据；
- 回答是否和 context 一致；
- 回答是否完整回应用户问题；
- 是否有编造、过度推断、漏答。

这两段对应不同指标：

| 阶段 | 关注问题 | 常用指标 |
| --- | --- | --- |
| 检索 | 证据有没有找回来 | Context Recall |
| 检索 | 证据是不是排得靠前、噪声多不多 | Context Precision |
| 生成 | 回答是否被 context 支撑 | Faithfulness |
| 生成 | 回答是否回应用户问题 | Response Relevancy |

别被指标名吓到。它们其实就在问四句人话：

1. 该找的找到了吗？
2. 找回来的东西干净吗？
3. 回答有没有编？
4. 回答有没有答到点上？

## 三、Recall：关键证据有没有找回来

Recall 在 RAG 里通常指 **Context Recall**：相关证据有没有被检索回来。

它关心的是“别漏”。比如标准答案需要三条证据：

1. 退款需要订单完成后才能申请；
2. 生鲜商品不支持无理由退货；
3. 退款到账时间是 1～3 个工作日。

如果检索结果只找回了第 1 条和第 3 条，漏掉了第 2 条，模型就很可能回答错。

可以粗略理解为：

```text
Context Recall = 被检索回来的关键证据数 / 标准答案需要的关键证据数
```

Ragas 官方文档里也把 Context Recall 解释为：相关文档或信息有多少被成功检索出来，重点是不要漏掉重要结果。它通常需要一个 reference 或 reference contexts 作为对照。

### Recall 低时怎么调

Recall 低，说明关键证据没进上下文。优先看这些地方：

| 调整点 | 说明 |
| --- | --- |
| chunking | 是否把关键事实切碎、切断、混进无关段落 |
| query rewrite | 用户问题是否被改写错了 |
| Top-K | K 太小可能召回不够 |
| hybrid search | 专有名词、编号、日期要结合关键词检索 |
| metadata filter | 过滤条件是否把正确文档过滤掉了 |
| embedding model | 模型是否适合当前语言和领域 |

一个经验：**Recall 低时，先别急着调生成 Prompt。** 模型没看到证据，再会写也没用。

## 四、Precision：检索结果是不是混进太多噪声

Recall 追求“别漏”，Precision 追求“别脏”。

如果 Top-K 里塞了很多无关 context，模型会被干扰。轻则回答啰嗦，重则被无关内容带偏。

可以粗略理解为：

```text
Context Precision = 检索结果中真正相关的片段数 / 检索回来的片段总数
```

Precision 的问题常出现在这些地方：

| 症状 | 可能原因 |
| --- | --- |
| Top-K 里有很多语义相近但业务不相关的片段 | 只做向量检索，没有 Rerank |
| 搜到旧政策、旧文档 | 缺少版本和生效时间过滤 |
| 查具体型号、订单号、日期时结果漂移 | 缺少关键词检索或字段过滤 |
| context 太长，模型抓不住重点 | chunk 太大或拼接策略太粗 |

Precision 低时，优先考虑：

- 加 Rerank；
- 做 metadata 过滤；
- 提升文档版本管理；
- 控制 Top-K 和上下文长度；
- 把“事实片段”和“背景描述”分开索引。

Recall 和 Precision 经常互相拉扯。Top-K 拉大，Recall 可能变高，但 Precision 可能下降。好的 RAG 系统不是把 K 无限调大，而是用“多路召回 + 重排 + 过滤”让关键证据排到前面。

## 五、Faithfulness：回答有没有基于证据

Faithfulness 是 RAG 评估里最重要的生成侧指标之一。

它问的是：

> 模型回答里的每个事实，能不能被检索到的 context 支撑？

Ragas 官方文档对 Faithfulness 的定义也很直接：衡量 response 与 retrieved context 的事实一致性，回答中的所有 claims 都能被 context 支持时，才算 faithful。

比如 context 里写：

> 退款通常在 1～3 个工作日内原路退回。

模型回答：

> 退款会在 1～3 个工作日内原路退回。

这是 faithful。

但如果模型回答：

> 退款会在 24 小时内到账。

这就不 faithful。它可能听起来合理，但 context 没这么说。

Ragas 计算 Faithfulness 的思路可以理解为三步：

1. 把模型回答拆成多个 claim；
2. 检查每个 claim 是否能从 retrieved context 推出；
3. 用“被支持的 claim 数 / 总 claim 数”得到分数。

### Faithfulness 低时怎么调

Faithfulness 低，通常说明模型在越界发挥。

| 调整点 | 说明 |
| --- | --- |
| Prompt | 明确要求只基于 context 回答，不知道就说不知道 |
| 引用机制 | 要求每个关键结论附引用 |
| context 清洗 | 去掉相互冲突、过期、重复的资料 |
| 答案格式 | 让模型先列依据，再给结论 |
| 拒答策略 | context 不足时不要硬答 |
| 后置校验 | 对生成答案再做一次 claim-level 检查 |

一句话：**Faithfulness 不是让答案更好听，而是让答案别编。**

## 六、Response Relevancy：回答有没有答到点上

有些回答是 faithful 的，但仍然不好。

比如用户问：

> 生鲜商品能不能 7 天无理由退货？

context 里有生鲜政策，模型回答：

> 平台支持部分商品在 7 天内申请售后，退款会在 1～3 个工作日内处理。

这句话可能没编，但没答到“生鲜能不能无理由退货”这个点。

Response Relevancy 关注的就是：回答是否真正回应了用户问题，是否完整、直接、少废话。

低 Relevancy 常见原因：

- 问题改写丢了重点；
- Prompt 要求太宽泛；
- context 太多，模型被带偏；
- 答案模板太机械；
- 模型为了“完整”加入大量用户没问的背景。

调优方向通常是：

- 改 query rewrite；
- 在 Prompt 里要求先直接回答，再解释；
- 控制答案长度；
- 对不同意图使用不同回答模板；
- 在评估集里加入“边界问题”和“反问式问题”。

## 七、RAGAS：把 RAG 评估流程自动化

RAGAS（Retrieval Augmented Generation Assessment）是一套面向 RAG 的自动化评估思路和工具。它的核心价值不是“给你一个神奇总分”，而是把 RAG 的不同质量维度拆开评估。

Ragas 官方文档目前把它定位为帮助 LLM 应用从 “vibe checks” 走向系统化评估循环的库，并提供 RAG、Agentic workflow 等场景的指标。

RAG 场景里常见的 Ragas 指标包括：

| 指标 | 看什么 | 是否通常需要参考答案 |
| --- | --- | --- |
| Context Recall | 关键证据有没有召回 | 通常需要 reference 或 reference_contexts |
| Context Precision | 检索结果是否相关、排序是否靠前 | 可有 reference 或无 reference 版本 |
| Faithfulness | 回答是否被 context 支撑 | 不一定需要标准答案，但需要 context |
| Response Relevancy | 回答是否回应用户问题 | 通常基于问题与回答评估 |

一段示意代码大概长这样，具体 API 以你使用的 Ragas 版本为准：

```python
from openai import AsyncOpenAI
from ragas.llms import llm_factory
from ragas.metrics.collections import Faithfulness, ContextRecall

client = AsyncOpenAI()
judge_llm = llm_factory("gpt-4o-mini", client=client)

faithfulness = Faithfulness(llm=judge_llm)
context_recall = ContextRecall(llm=judge_llm)

sample = {
    "user_input": "公司报销发票需要在多久内提交？",
    "retrieved_contexts": [
        "员工应在费用发生后 30 天内提交发票和报销单。"
    ],
    "response": "发票和报销单需要在费用发生后 30 天内提交。",
    "reference": "费用发生后 30 天内需要提交发票和报销单。"
}

faithfulness_score = await faithfulness.ascore(
    user_input=sample["user_input"],
    response=sample["response"],
    retrieved_contexts=sample["retrieved_contexts"],
)

recall_score = await context_recall.ascore(
    user_input=sample["user_input"],
    retrieved_contexts=sample["retrieved_contexts"],
    reference=sample["reference"],
)
```

不要把 RAGAS 当成最终裁判。它更像一个自动化体检仪：能帮你快速发现趋势和问题分布，但关键样本仍然需要人工抽检。

## 八、LLM-as-Judge：用模型做裁判，但别迷信裁判

![LLM-as-Judge 评估流程](/images/rag-llm-as-judge.svg)

LLM-as-Judge 的意思是：用另一个 LLM 来评价 RAG 的输出。

这件事听起来有点“让模型评价模型”，但在 RAG 场景里很实用，因为很多质量问题不是简单字符串匹配能判断的：

- 答案是否被 context 支撑；
- 是否漏掉关键约束；
- 是否过度推断；
- 是否答非所问；
- 是否包含无法验证的承诺。

但 LLM-as-Judge 不能随便写一句“请给这个回答打分”。要做得可靠，至少要有四件东西：

| 组件 | 作用 |
| --- | --- |
| Rubric | 明确评分标准，例如 Faithfulness、Completeness、Conciseness |
| 结构化输出 | 要求输出 JSON：score、label、reason、evidence |
| 少量标注样本 | 用人工标注样本校准 Judge |
| 稳定性监控 | 监控 Judge 模型变更、温度、提示词版本带来的漂移 |

一个 Judge Prompt 可以这样设计：

```text
你是 RAG 评估员。请判断 answer 是否完全由 context 支撑。

评分规则：
- 1.0：所有事实都能从 context 推出
- 0.5：部分事实能推出，部分事实缺少依据
- 0.0：关键结论无法从 context 推出，或与 context 冲突

只输出 JSON：
{
  "score": 0.0,
  "label": "faithful | partially_faithful | unfaithful",
  "reason": "...",
  "unsupported_claims": ["..."]
}
```

LLM-as-Judge 最大的问题是：Judge 自己也会犯错。

所以生产里要做三件事：

1. **人工抽检**：定期抽样看 Judge 判得准不准。
2. **分桶分析**：按问题类型、文档类型、语言、长度看分数。
3. **版本固定**：记录 Judge 模型、Prompt 版本、温度和输出解析逻辑。

Judge 不是上帝，只是一个便宜、快速、可规模化的初筛员。

## 九、如何构建一套 RAG 评估集

没有评估集，指标就没有地基。

一套实用的 RAG 评估集至少包含这些字段：

| 字段 | 说明 |
| --- | --- |
| `question` | 用户问题，最好来自真实日志 |
| `reference_answer` | 人工整理的标准答案 |
| `reference_contexts` | 支撑答案的文档片段或文档 ID |
| `metadata` | 业务线、语言、问题类型、难度 |
| `expected_behavior` | 应回答、应拒答、应追问、应转人工 |

样本来源可以有四类：

| 来源 | 价值 |
| --- | --- |
| 真实用户日志 | 覆盖真实问法和长尾问题 |
| 高频问题 | 保证最常见问题稳定 |
| 失败案例 | 专门覆盖已知坑 |
| 人工构造边界样本 | 测试权限、过期政策、冲突文档、无答案场景 |

这里有个容易踩的坑：只做“有答案”的评估集。

RAG 系统还必须学会拒答。比如用户问内部文档里没有的信息，正确行为不是编一个答案，而是说明“当前资料里没有找到依据”。所以评估集里要放一部分无答案样本。

## 十、怎么把评估接入研发流程

RAG 评估最好不要只在上线前跑一次。它应该进入日常研发流程。

### 1. 本地调试

开发者改 chunking、Embedding、Rerank、Prompt 时，先跑一个小评估集。目标不是追求完整覆盖，而是快速判断有没有明显退化。

### 2. CI 回归

维护一套稳定的核心评估集，每次改动都跑：

- Context Recall 不能明显下降；
- Faithfulness 不能下降；
- 无答案问题不能被硬答；
- 高风险业务问题不能越权回答。

### 3. 线上监控

线上不要只看平均分，要看分桶：

| 分桶 | 为什么重要 |
| --- | --- |
| 问题类型 | 退款、报销、技术文档、政策问答问题不同 |
| 文档来源 | 不同知识库质量差别很大 |
| 用户语言 | 中文、英文、混合语言表现可能不同 |
| 答案长度 | 长答案更容易出现 unsupported claims |
| 检索命中数 | 命中太少或太多都可能出问题 |

### 4. 人工抽检闭环

评估指标只能告诉你“哪里可能有问题”，最后还要回到样本。

建议固定做一个失败样本池：

- Faithfulness 低的样本；
- Recall 低的样本；
- 用户点踩的样本；
- 人工客服纠错的样本；
- Judge 和人工不一致的样本。

这些样本才是 RAG 系统持续进化的燃料。

## 十一、常见误区与调优方向

![RAG 常用评估指标矩阵](/images/rag-evaluation-metrics.svg)

### 误区 1：只看最终答案准确率

最终答案错了，你不知道该调哪里。

更好的做法是拆开：

- Recall 低：先调检索；
- Precision 低：调 Rerank 和过滤；
- Faithfulness 低：调 Prompt、引用和拒答；
- Relevancy 低：调问题改写和答案格式。

### 误区 2：只看平均分

平均分会掩盖长尾。

比如整体 Faithfulness 0.92，看起来不错，但“退款政策”这一类只有 0.62，就可能已经是线上事故。RAG 评估一定要分桶看。

### 误区 3：把 LLM Judge 当绝对真理

LLM Judge 是工具，不是裁判长。

它会受 Prompt、模型版本、输出格式、语言、样本长度影响。必须用人工标注样本校准，尤其是你要用它做上线门禁时。

### 误区 4：没有评估无答案问题

RAG 最危险的不是答错，而是不知道自己不知道。

评估集里一定要放：

- 知识库没有答案的问题；
- 权限不足的问题；
- context 冲突的问题；
- 过期政策问题；
- 用户要求模型猜的问题。

正确行为可能是拒答、追问或转人工，而不是生成一个漂亮答案。

## 十二、参考资料

- [Ragas 官方文档：Introduction](https://docs.ragas.io/en/stable/)
- [Ragas 官方文档：Available Metrics](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/)
- [Ragas 官方文档：Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)
- [Ragas 官方文档：Faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/)
- [RAGAS 论文：Automated Evaluation of Retrieval Augmented Generation](https://arxiv.org/abs/2309.15217)

## 十三、常见问题

| 问题 | 回答要点 |
| --- | --- |
| RAG 评估最先看哪个指标？ | 先看 Context Recall。关键证据没召回，后面生成再好也没用。 |
| Faithfulness 和准确率有什么区别？ | Faithfulness 看回答是否被 context 支撑；准确率还要看最终答案是否符合真实世界或标准答案。 |
| Recall 高是不是就够了？ | 不够。Recall 高说明证据没漏，但如果 Precision 低，模型仍会被大量噪声干扰。 |
| RAGAS 是不是一个总分？ | 不是。更应该把它看成一组评估维度，用来定位检索和生成各自的问题。 |
| LLM-as-Judge 靠谱吗？ | 可以用，但要有 Rubric、结构化输出、人工抽检和版本控制。不要把 Judge 当绝对真理。 |
| 没有人工标准答案能评估吗？ | 可以做部分 reference-free 评估，比如 Faithfulness；但要评估 Recall 和真实准确性，最好还是有 reference 或 reference contexts。 |
| 评估集应该多大？ | 初期几十到几百条就能发现很多问题；生产门禁可以维护一套核心集，再持续从线上失败样本扩充。 |

最后用一句话收束：

> RAG 评估不是为了追一个漂亮分数，而是为了知道系统到底卡在检索、生成、知识库，还是评审标准本身。
