---
title: ElasticSearch基础知识
date: 2026-06-21 09:11:51
categories:
  - 数据库
tags:
  - Elasticsearch
  - 搜索引擎
  - 搜索
---

## 一、基础概念

### 1. ES 是什么？核心概念

**定义**：基于 **Lucene** 的分布式搜索和分析引擎，用 RESTful API 进行数据写入和查询。

#### 1.1 核心能力

```
1. 全文搜索 — 倒排索引 + BM25 评分，毫秒级返回
2. 近实时 — 默认 1s 延迟可见（NRT, Near Real Time）
3. 聚合分析 — 类似 GROUP BY + 统函数，支持嵌套聚合
4. 分布式 — 自动分片 + 副本，线性扩展
5. 地理位置 — 支持 geo_distance / geo_bounding_box 查询
6. 向量检索 — 8.0+ 支持 kNN 语义搜索
```

<!-- more -->

#### 1.2 概念对应

| ES | 关系型数据库 | 说明 |
|----|-----------|------|
| Index | Database | 逻辑命名空间，创建后不可改名 |
| Type（7.x 已废弃） | Table | 8.0 已完全移除，一个 Index 只有一个 Type |
| Document | Row | JSON 格式，每个 doc 有唯一的 `_id` |
| Field | Column | 字段类型在 Mapping 中定义 |
| Mapping | Schema | 支持动态 Mapping（自动推断类型） |
| Shard | 分片 | Lucene 实例，物理存储单元 |
| Replica | 副本 | 主分片的完整拷贝，提供高可用和读负载均衡 |

#### 1.3 ES vs 数据库选场景

| 场景 | ES | 关系型数据库 |
|------|-----|-----------|
| 全文搜索（模糊/相关性） | ✅ 首选 | ❌ LIKE 极慢 |
| ACID 事务 | ❌ 不完全支持 | ✅ 首选 |
| JOINs | ❌ 有限（nested/parent-child） | ✅ 首选 |
| 聚合分析 | ✅ 适合大数据集 | 小数据集 OK |
| 实时 OLTP 写入 | ❌ 1s 延迟 | ✅ 实时 |

#### 1.4 基本架构

```
┌────────────── Cluster ──────────────────┐
│                                          │
│  ┌── Node 1 ────┐  ┌── Node 2 ────┐     │
│  │ P0 │ P1 │ R2 │  │ P2 │ R0 │ R1 │     │
│  └───────────────┘  └───────────────┘     │
│         ▲                                  │
│         └── Node 3 (Client Node)           │
│              └── 协调节点：分发请求、合并结果 │
└──────────────────────────────────────────┘

每个 Index 由多个 Shard 组成，每个 Shard = 一个完整的 Lucene 实例
P = Primary Shard（写入主分片）
R = Replica Shard（副本分片，从 P 复制）
```

### 2. 倒排索引详解

#### 2.1 什么是倒排索引

**正排索引**（传统数据库）：文档 ID → 文档内容。

```
doc1 → "北京烤鸭很好吃"
doc2 → "北京的烤鸭店推荐"
doc3 → "今天天气很好"
```

**倒排索引**：词条（Term）→ 包含该词条的文档列表。搜索时以词条为入口定位文档。

```
"北京"    → [doc1, doc2]
"烤鸭"    → [doc1, doc2]
"好吃"    → [doc1]
"推荐"    → [doc2]
"天气"    → [doc3]
```

**为什么叫"倒排"**？因为数据组织方向与正排相反——正排是"文档→词"，倒排是"词→文档"。

#### 2.2 完整数据结构

Lucene 中一个倒排索引由四层组成：

```
┌─────────────────────────────────────────────────────┐
│               倒排索引四层结构                          │
├─────────────────────────────────────────────────────┤
│  ① Term Index (FST)         ← 内存常驻，快速定位 Term    │
│     [前缀树，压缩存储，~1MB/数亿 Term]                   │
├─────────────────────────────────────────────────────┤
│  ② Term Dictionary          ← 磁盘，Term 到 Posting 的映射│
│     [有序 Term 列表，二分查找]                          │
├─────────────────────────────────────────────────────┤
│  ③ Posting List              ← 磁盘，文档 ID 列表 + 位置  │
│     [docID | position | payload] 用跳表加速             │
├─────────────────────────────────────────────────────┤
│  ④ DocValues                 ← 磁盘列存，排序/聚合用      │
│     [docID → value，不需要从倒排索引反推]                │
└─────────────────────────────────────────────────────┘
```

##### ① Term Index：FST（Finite State Transducer）

**解决的问题**：Term Dictionary 很大（磁盘），不能在内存中全量加载。Term Index 压缩到内存，快速定位 Term 在 Term Dictionary 中的位置。

```
词典：["cat", "cats", "catty", "deep", "deeper", "depth"]

FST 压缩后：
  c → a → t → s (cats)
          ↓
          t → y (catty)
  d → e → e → p (deep, 共享 de 路径)
          ↓
          e → r (deeper)
          p → t → h (depth)
```

**关键特点**：
- 公共前缀只存一次（如 `ca` 被所有 ca 开头的 term 共享）
- 每个节点存的是一个字符（或字节），边存的是输出的 payload（如文件中的偏移量）
- 内存占用极低：1MB 内存可索引数亿 term
- 查找复杂度 O(len(term))，与 term 总数无关

##### ② Term Dictionary

有序列表，每个 entry = `Term → (doc_freq, file_pointer_to_posting)`。

```
"cat"      → freq=10,  offset=0x00A0
"cats"     → freq=5,   offset=0x0110
"catty"    → freq=2,   offset=0x0150
...
"depth"    → freq=15,  offset=0x2000
```

有了 FST 知道 Term 在 Dictionary 中的位置后，从磁盘加载 Term 的 Posting List。

##### ③ Posting List（倒排表）

**最小结构**：只存文档 ID 列表。

```
"北京" → [doc1, doc2, doc5, doc8, doc10, ...]
```

**完整结构**：每个文档 ID 后面附加了多项信息：

```
"北京" → [
    docId=1:  freq=2, pos=[5, 12], offsets=[(0,2), (15,17)]
    docId=2:  freq=1, pos=[3],      offsets=[(8,10)]
    docId=5:  freq=3, pos=[0,7,15], offsets=[...]
    ...
]
```

每条记录共包含五层信息：

| 信息 | 含义 | 是否默认存储 | 用途 |
|------|------|:----------:|------|
| **docId** | 文档 ID（Delta 编码 + 分块压缩） | ✅ 必须 | 定位到具体文档 |
| **termFreq** | 该 term 在此文档中出现的次数 | ✅ 默认 | BM25 评分需要词频 |
| **positions** | term 每次出现的位置（token 序号，第几个词） | ✅ 默认 | **短语查询**（match_phrase）、**临近查询**（slop） |
| **offsets** | term 的起止字符偏移量（startOffset, endOffset） | ❌ 默认关闭 | 高亮（fast vector highlighter）、前缀匹配 |
| **payloads** | 自定义二进制数据（每个 position 可附加） | ❌ 默认关闭 | 自定义评分（如给标题中的 term 更高权重） |

**index_options 控制存储粒度**：

在 Mapping 中通过 `index_options` 控制 Posting List 存哪些信息：

```json
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "index_options": "positions"   // 控制存储粒度
      }
    }
  }
}
```

| index_options | 存储内容 | 适用场景 |
|-------------|---------|---------|
| **docs** | 仅 docId | 不需要评分、不需要短语匹配（等同于设置 `norms: false`） |
| **freqs** | docId + termFreq | 需要 BM25 评分但不需要短语匹配 |
| **positions**（默认） | docId + freq + positions | 全文搜索（match、match_phrase、高亮） |
| **offsets** | docId + freq + positions + offsets | 需要字符级高亮定位（fast vector highlighter） |

**positions 和 offsets 的区别**：

```
文档: "北京烤鸭很好吃"
分词: ["北京"(0,2), "烤鸭"(2,4), "很"(4,5), "好吃"(5,7)]
             ↑            ↑          ↑          ↑
          offsets     offsets    offsets    offsets

position:  position=0  position=1  position=2  position=3
           (第0个token) (第1个token)           (第3个token)
```

- **position**：token 的序号（第几个词），用于判断词之间是否相邻。match_phrase 检查 `position_word_a + 1 == position_word_b`
- **offset**：在原文字中的字符起止位置，用于高亮时精确标记原文 `<em>北京</em>烤鸭`

**存储开销对比**：

```
仅 docId（docs 模式）：      ~8-10 字节/doc（Delta + 压缩）
docId + freq + positions：  ~12-20 字节/doc（默认）
+ offsets：                 额外 ~4-8 字节/position
```

**Posting List 的编码优化（Frame of Reference）**：

```python
# 原始 Posting List（递增文档 ID）
docs = [1, 5, 12, 18, 25, 32]

# 差值编码（Delta Encoding）后
deltas = [1, 4, 7, 6, 7, 7]   # 相邻差值更小

# 分块压缩（每块 128 个文档）
# 块内最大值只需更少的 bit 表示，大块用更多 bit
```

**跳表加速**：Posting List 用跳表实现，做交集（AND）时快速跳过不匹配的文档。

```
跳表（示例）：
  [1] ────────────────────── [18] ────────── [32]  ← 高层（skip pointer）
    ↓                          ↓
  [1] ───── [5] ───── [12] ── [18] ── [25] ── [32]  ← 底层（全量）
```

##### ④ DocValues

**解决的问题**：倒排索引是从 Term 找 Doc，但排序和聚合需要从 Doc 找 Field 值（正排）。如果每行数据都从 _source 里解析，性能极差。

```
DocValues 是列式存储（类似列数据库）：

  doc:   0      1      2      3      4      5
  price: 12     45     23     67     34     89

  → 内存连续数组，可直接按 docID 随机访问
  → 排序时直接读 DocValues，不需要打开 _source
```

#### 2.3 完整查找过程

```
搜索 "北京烤鸭"

Step 1: FST → 查找 Term "北京" 的偏移量
        路径: b-e-i-j-i-n-g → 输出: 0x00A0（Term Dictionary 中位置）

Step 2: Term Dictionary → 在偏移 0x00A0 读取 "北京" 的元信息
        doc_freq=1000, posting_offset=0x1000

Step 3: Posting List → 读取 docID 列表（用跳表快速定位）
        [doc1, doc2, doc5, doc8, ...]

Step 4: 对 "烤鸭" 同样操作，用跳表做交集
        "北京": [doc1, doc2, doc5, doc8, doc10, ...]
        "烤鸭": [doc1, doc2, doc5, doc9, doc10, ...]
        AND  : [doc1, doc2, doc5, doc10, ...]

Step 5: BM25 打分，排序，返回 Top N
```

#### 2.4 倒排链合并机制（核心：AND/OR/NOT 怎么算）

上面的 Step 4 "用跳表做交集" 是 ES 查询的内核心脏，但一笔带过了。这里展开讲清楚 **多条倒排链到底怎么合并**。这是面试高频追问点。

##### 2.4.1 前置条件：倒排链是有序的

```
每个 term 的 Posting List（倒排链）是【按 docId 严格升序】排列的。

  "elasticsearch" → [1, 3, 7, 9, 15, 22, 30]
  "query"         → [2, 3, 5, 9, 12, 15, 22, 28]

这个"有序"特性是后面所有合并算法的前提。
```

##### 2.4.2 基础算法：拉链合并（Zipper Merge）

求两条有序链的交集（AND），就像拉拉链——两个指针各指一条链头部，谁小谁前进，相等即命中。

```
求 "elasticsearch" AND "query"：

链A: [1, 3, 7, 9, 15, 22, 30]      指针 i
链B: [2, 3, 5, 9, 12, 15, 22, 28]  指针 j

i=0(A=1), j=0(B=2): 1<2 → i++（A 小，A 前进）
i=1(A=3), j=0(B=2): 3>2 → j++（B 小，B 前进）
i=1(A=3), j=1(B=3): 相等！命中 docId=3，i++, j++
i=2(A=7), j=2(B=5): 7>5 → j++
... 依此类推 ...

最终交集：[3, 9, 15, 22]
```

伪代码（求交 / 求并）：

```java
// AND 求交
List<Integer> intersect(List<Integer> a, List<Integer> b) {
    List<Integer> result = new ArrayList<>();
    int i = 0, j = 0;
    while (i < a.size() && j < b.size()) {
        if (a.get(i).equals(b.get(j))) { result.add(a.get(i)); i++; j++; }
        else if (a.get(i) < b.get(j)) i++;
        else j++;
    }
    return result;
}

// OR 求并（任一链耗尽即可结束，剩余全部加入）
List<Integer> union(List<Integer> a, List<Integer> b) {
    List<Integer> result = new ArrayList<>();
    int i = 0, j = 0;
    while (i < a.size() && j < b.size()) {
        if (a.get(i).equals(b.get(j))) { result.add(a.get(i)); i++; j++; }
        else if (a.get(i) < b.get(j)) result.add(a.get(i++));
        else result.add(b.get(j++));
    }
    while (i < a.size()) result.add(a.get(i++));
    while (j < b.size()) result.add(b.get(j++));
    return result;
}
```

**复杂度**：两条链长 m、n，求交最坏 `O(m+n)`。短链高效，但长链（百万级 docId）仍慢——所以 Lucene 在此基础上加了跳表。

##### 2.4.3 关键优化：跳表（Skip List）让合并提速

光有归并不够。`O(m+n)` 在大数据量下仍慢，Lucene 在倒排链上构建了**跳表**，支持 **skipTo(target)** 跳跃式前进。

```
带跳表的倒排链（示意，实际 Lucene 用分块 + skip pointer）：

链A docId: 1   3   7   9   15  22  30  45  67  89 ...
skip指针:  └─────►15         └─────►30         ...

合并时，另一条链当前值是 28，链A 当前在 7：
  普通归并：7→9→15→22→30（前进 4 步）
  带跳表：  7 --skipTo(28)--> 30（1 步跳跃，中间 9/15/22 全跳过）
```

带跳表的合并（Lucene 实际做法）：

```java
int i = 0, j = 0;
while (i < a.size() && j < b.size()) {
    if (a.docId(i) == b.docId(j)) {
        collect(a.docId(i));
        i++; j++;
    } else if (a.docId(i) < b.docId(j)) {
        i = a.skipTo(b.docId(j));   // 关键：不是 i++，而是跳表直接跳到 >= 目标的位置
    } else {
        j = b.skipTo(a.docId(i));
    }
}
```

**复杂度**：从 `O(m+n)` 降到接近 `O(min(m,n)·log(max))`。**两条链长度悬殊时收益最大**——短链的每个元素用 skipTo 在长链里二分跳跃。

> Lucene 实际的 postings 格式（默认 Lucene90）：docId 列表切成固定大小的块（如每 128 个 docId 一块），每块记录起始 docId 作为 skip pointer，块内用 PForDelta 压缩，解压后才能精确比较。

##### 2.4.4 AND / OR / NOT 的不同合并策略

| 查询语义 | 合并方式 | 何时结束 | 特点 |
|---------|---------|---------|------|
| **AND（must）** | 求交 intersect | 任一链耗尽 | 短链主导，越长越快收敛 |
| **OR（should）** | 求并 union | 所有链耗尽 | 必须遍历所有链，慢 |
| **NOT（must_not）** | 求差 subtract | 遍历主链 | 从主链剔除 NOT 链的 docId |

```
bool query: A AND B AND NOT C

执行顺序优化（Lucene 的 BooleanQuery 会做启发式重排）：
  1. 先求最短的两条链 A ∩ B（交集快速缩小结果集）
  2. 再用 (A∩B) - C（在缩小的集合上做差，C 的开销变小）

经验：AND 查询中【先合并最短的两条链】，结果集快速缩小，后续越来越快。
      这也是为什么高频词（长链）单独用 query 慢——应转成 filter 缓存。
```

##### 2.4.5 短语查询的特殊合并：docId 求交 + position 验证

`match_phrase "北京烤鸭"` 不能简单求 docId 交集，还要验证"北京"和"烤鸭"在文档中**位置连续**。所以短语查询 = **先按 docId 求交 + 再按 position 验证相邻关系**。这正是 Posting List 要存 `positions` 的原因，详见 2.5 节。

```
"北京": doc3 → positions [5, 20]
"烤鸭": doc3 → positions [6, 21]

短语匹配（连续）：北京@5 → 期望烤鸭在 5+1=6 → 烤鸭确实@6 ✓ 命中
```

##### 2.4.6 跨 Segment 与跨分片的合并

倒排链合并在 ES 中是**两层归并**：

```
第 1 层：单分片内，跨多个 Segment 合并
  一个 term 的倒排链分散在每个 Segment 里（见 7.5 节）
  → 遍历所有 Segment 的同 term 倒排链，归并（同时过滤 .del 标记）
  → 这就是为什么 Segment 太多会拖慢查询（每个 Segment 的 FST 都要查一遍）

第 2 层：协调节点跨分片合并
  各分片本地做完上述合并 + BM25 打分 → 返回 TopN 的 {docId, score}
  → 协调节点用堆（优先队列）归并各分片的 TopN，取全局 TopN
  → 注意：分片返回的不是完整倒排链，而是 TopN，所以协调节点的归并是
         N 个有序小数组的归并，开销可控（见第 9 节 Query/Fetch 两阶段）
```

##### 2.4.7 加速合并的工程手段

| 手段 | 原理 | 适用 |
|------|------|------|
| **filter 缓存** | filter 结果缓存为 bitset（位图），下次用位运算合并，比 postings 合并快得多 | 重复过滤条件（status=1）|
| **高频词用 filter** | 长链求交慢，缓存成 bitset 后变成位与运算 | 高频 term |
| **控制 Segment 数** | Segment 越少，第 1 层跨 Segment 合并的开销越小 | 定期 force_merge |
| **控制分片数** | 分片越多并行度越高，但协调节点归并 + fetch 开销增大 | 不是越多越好 |
| **routing 路由** | 查询带 routing 只命中单分片，跳过跨分片归并 | 按用户维度查询 |

```
filter 缓存 vs postings 合并（性能量级差异）：
  postings 合并：解压 docId 块 + 跳表跳跃 → 微秒~毫秒
  bitset 位运算：AND/OR 就是 CPU 位与/位或 → 纳秒级，且命中缓存零开销

→ 这就是"能用 filter 就别用 query"的底层原因（见第 8 节 Query vs Filter）
```

##### 2.4.8 一张图总结三层合并机制

```
┌─────────────────────────────────────────────────────┐
│  第 1 层：分片内 postings 合并                       │
│    带 skip list 的拉链归并（求交/并/差）              │
│    Lucene 的 DocIdStream + 跳表实现                 │
├─────────────────────────────────────────────────────┤
│  第 2 层：filter 缓存的位图合并（可选加速）           │
│    filter 结果缓存为 bitset，用位运算合并            │
│    适合重复过滤条件（如 status=1）                   │
├─────────────────────────────────────────────────────┤
│  第 3 层：跨分片结果归并（协调节点）                 │
│    各分片返回 TopN，协调节点用堆归并取全局 TopN      │
│    Query Then Fetch 两阶段                          │
└─────────────────────────────────────────────────────┘
```

#### 2.5 短语查询（Phrase Query）原理

**问题**：搜索 `"北京烤鸭"`（带引号的精确短语），要求"北京"和"烤鸭"在文档中**连续出现、顺序一致**。

**普通 match 查询**：只要文档同时包含"北京"和"烤鸭"就返回，不管相对位置。

```
文档："北京的烤鸭很有名"
普通 match → ✅ 匹配（同时包含"北京"和"烤鸭"）
短语 match → ❌ 不匹配（"北京"和"烤鸭"中间隔了"的"）
```

**短语查询的实现**：利用 Posting List 中存储的**position 信息**。

```
doc1 的分词结果（每个 token 有 position 和 offset）：
  doc1: [北京(0:0-2), 的(1:2-3), 烤鸭(2:3-5), 很(3:5-6), 有名(4:6-8)]
         ↑           ↑         ↑           ↑          ↑
      position=0   pos=1     pos=2       pos=3      pos=4

Posting List 存储：
  "北京" → [doc1: freq=1, pos=[0]]
  "烤鸭" → [doc1: freq=1, pos=[2]]

match_phrase 查询 "北京烤鸭"：
  Step 1: 分别查"北京"和"烤鸭"的 Posting List
  Step 2: 找到同时包含两个 term 的文档 → doc1
  Step 3: 检查位置关系：
           "北京" 在位置 1
           "烤鸭" 在位置 3
           期望偏移 = "北京"的位置 + 1 = 2
           实际偏移 = 3
           2 ≠ 3 → ❌ 不匹配
```

**算法本质**：短语查询就是 Posting List 按文档 ID 做交集，再按位置判断偏移量是否连续。

```python
def match_phrase(term1_posting, term2_posting):
    """
    term1_posting: {"doc1": [1], "doc2": [3, 5]}
    term2_posting: {"doc1": [2], "doc2": [4, 8]}
    """
    result = []
    for doc_id in intersect(term1_posting.keys(), term2_posting.keys()):
        pos1 = term1_posting[doc_id]  # [1]
        pos2 = term2_posting[doc_id]  # [2]

        # 检查是否存在连续的两个位置
        for p1 in pos1:
            if p1 + 1 in pos2:  # position 连续，且顺序一致
                result.append(doc_id)
                break  # 找到一个就够
    return result

# doc1: term1_pos=1, term2_pos=2 → 1+1=2 → ✅
# doc2: p1=3,p2=4 → 3+1=4 → ✅; p1=5,p2=8 → ❌（但已有匹配）
```

#### 2.6 临近查询（Proximity Query）原理

**问题**：搜索 `"北京 烤鸭"~3`，要求"北京"和"烤鸭"之间**最多间隔 3 个词**。

**match_phrase 的限制**：
- `match_phrase: "北京烤鸭"` → 必须严格连续（slop=0）
- 文档"北京的烤鸭" → ❌ 不匹配

**match_phrase 带 slop 参数**：
```json
GET /_search
{
  "query": {
    "match_phrase": {
      "title": {
        "query": "北京 烤鸭",
        "slop": 2       // 允许最多移动 2 步来对齐
      }
    }
  }
}
```

**slop 的计算方式（Wagner-Fischer 编辑距离）**：

```
文档：    "北京"  "的"    "烤鸭"  "很"    "好吃"
位置：      1      2       3      4       5

查询： "北京" "烤鸭"
目标位置：  pos=1   pos=2（期望连续）

实际位置：  pos=1   pos=3（"烤鸭"在位置3）

需要移动"烤鸭"从 3 到 2 → 移动 1 步
slop 至少需要 1 才能匹配 → match_phrase 默认 slop=0，所以不匹配
                           → 设置 slop=2，则匹配
```

**slop 越大性能越差**，因为需要检查更多的位置组合。

**实际应用**：
```
slop=0  → 精确短语匹配（"北京烤鸭"）
slop=1  → 允许一个虚词插入（"北京的烤鸭"）
slop=2  → 更宽松的语序（"北京 烤鸭店"）
slop=10 → 宽松匹配（"北京 好吃 的 烤鸭"）
```

#### 2.7 多词短语与 Wave 算法

对于超过 2 个词的短语，Lucene 使用 **Wagner-Fischer 算法**（本质是动态规划 + 滑动窗口）来计算多词之间的编辑距离，保证短语内所有词的位置关系满足 slop 约束。

```
查询："北京" "地道" "烤鸭"
位置：   1       2       3

文档："北京" "烤鸭" "很" "地道"
        1       2      3      4

Wagner-Fischer 矩阵：
  初始化: 每位置期望是 1, 2, 3
  实际:   北京=1, 烤鸭=2, 很=3, 地道=4

  计算将查询词映射到文档位置的最小编辑代价：
    "北京" 在1 → 0
    "地道" 在4 → 需要从4移到2 → 2步
    "烤鸭" 在2 → 需要从2移到3 → 1步
  总 slop = 2 + 1 = 3
```

### 3. 数据类型 → 存储结构 → 查询方式对照表

#### 3.1 存储方式速查

| 底层结构 | 用途 | 存储位置 |
|---------|------|---------|
| **FST（倒排索引）** | 分词后的 term → docID 映射 | FST 常驻内存，Posting List 在磁盘 |
| **BKD Tree** | 数值/日期/地理的多维范围索引 | 索引在内存，数据块在磁盘 |
| **DocValues** | 正排列存（排序/聚合/脚本） | 磁盘（列式，按 docID 连续存储） |
| **Stored Fields** | 原始字段值（`_source`） | 磁盘 |
| **HNSW 图** | 向量 ANN 索引 | 内存 + 磁盘 |

#### 3.2 完整对照表

| 类型 | 索引结构 | DocValues | 支持哪些查询（Query） | 支持聚合/排序 |
|------|---------|-----------|---------------------|:------------:|
| **text** | **FST 倒排索引**（分词） | 仅 norms（评分用） | `match`、`match_phrase`、`match_phrase_prefix`、`query_string`、`simple_query_string`、`fuzzy`、`exist`、`prefix`、`regexp`、`wildcard`、`term`（精确词查找但效率低） | ❌（用 `fields` 转 keyword） |
| **keyword** | **FST 倒排索引**（不分词） | ✅ 默认开启 | `term`、`terms`、`prefix`、`wildcard`、`regexp`、`fuzzy`、`exists`、`range` | ✅ |
| **long / integer / short / byte** | **BKD Tree** | ✅ 默认开启 | `term`、`terms`、`range`、`exists` | ✅ |
| **double / float / half_float / scaled_float** | **BKD Tree** | ✅ 默认开启 | `term`、`terms`、`range`、`exists` | ✅ |
| **boolean** | FST 倒排索引（存 `true`/`false` 两个 term） | ✅ 默认开启 | `term`、`terms`、`exists` | ✅ |
| **binary** | ❌ 不索引 | ❌ 默认关闭 | 仅 `exists`（查是否有值） | ❌ |
| **date** | **BKD Tree** | ✅ 默认开启 | `term`、`terms`、`range`、`exists`（支持日期数学，如 `now-7d`） | ✅ |
| **date_nanos** | **BKD Tree** | ✅ 默认开启 | 同上（纳秒精度） | ✅ |
| **integer_range / float_range / long_range / double_range / date_range** | **BKD Tree** | ✅ 默认开启 | `term`（精确匹配区间）、`range`（判断重叠）、`exists` | ❌ |
| **ip** | **BKD Tree** | ✅ 默认开启 | `term`、`terms`、`range`、`exists`、`CIDR`（`ip_range` 匹配，如 `192.168.1.0/24`） | ✅ |
| **version** | **BKD Tree** | ✅ 默认开启 | `term`、`range`、`exists`（按语义版本比较，如 `"1.2.3" > "1.2.10"` 正确） | ✅ 排序 |
| **murmur3** | ❌ 不索引 | ✅ 开启（存哈希值） | ❌ | 仅加速 `cardinality` 聚合 |
| **geo_point** | **BKD Tree**（经纬度二维索引） | ✅ 默认开启 | `geo_distance`、`geo_bounding_box`、`geo_polygon`、`exists` | ✅ `_geo_distance` 排序 |
| **geo_shape** | **BKD Tree**（图形顶点索引） | ❌ | `geo_shape`（`intersects`/`within`/`contains`/`disjoint`） | ❌ |
| **object** | 无独立索引，子字段各自按类型索引 | 按子字段 | 点号访问子字段（如 `user.name`） | 按子字段 |
| **nested** | 每个对象存为独立隐藏文档（Lucene 层） | ✅ | `nested` 查询（`path` + 内部 query，确保数组内边界正确） | `nested` 聚合 |
| **flattened** | 整个 JSON 当 keyword-like 存储 | ✅ | `term`、`terms`、`exists` | ✅（但精度有限） |
| **join** | 父/子 doc 关系编码 | ✅ | `has_child`、`has_parent`、`parent_id` | ❌ |
| **dense_vector** | **HNSW**（8.0+）/ **IVF**（7.x）图索引 | ❌（向量数据独立存储） | `knn`（近似最近邻）、`script_score`（`cosineSimilarity`/`l1`/`l2`/`dotProduct`） | ❌ |
| **sparse_vector** | 类似倒排索引（稀疏高维向量） | ❌ | `knn`（稀疏向量 ANN 搜索） | ❌ |
| **completion** | **FST**（Trie 前缀树，常驻内存） | ❌ | `suggest`（`prefix` 自动补全，毫秒级返回） | ❌ |
| **search_as_you_type** | 多子字段（`_2gram`/`_3gram`/`_index_prefix`）均存为 FST 倒排索引 | 同 text | `match_bool_prefix`、`match_phrase_prefix` | ❌ |
| **token_count** | ❌ 不索引 | ✅ 存 token 数量 | `term`、`range`、`exists`（如 `match 至少 3 个词`） | ✅ |
| **alias** | 无存储，指向目标字段 | 无 | 任何目标字段支持的查询 | 同目标字段 |
| **histogram** | ❌ 不索引 | ✅ | 仅聚合（`percentiles`、`min`、`max`） | ✅ 仅限直方图聚合 |

#### 3.3 关键设计原则

1. **FST 倒排索引**只服务于文本类字段（text/keyword）和 completion。数值/日期/地理用 **BKD Tree**，不做 FST，因为连续值不适合分词倒排。
2. **DocValues** 是排序/聚合/脚本的执行基础，默认为 keyword/数值/日期/ip/布尔开启。text 类型不开 DocValues（norms 除外），所以 text 不能直接排序聚合——需要 `fields` 配一个 keyword 子字段。
3. **dense_vector** 不走 FST 也不走 DocValues，它有自己独立的向量存储和 HNSW 图索引。
4. **nested** 和 **join** 是为了解决 object 类型数组的"边界丢失"问题，但代价不同：nested 查询慢（隐藏文档反规范化），join 更慢（父子文档分离查询）。

---

## 二、写入流程

### 4. 写入流程

```
客户端 → Coordination Node → Primary Shard → Replica Shard

1. 请求路由到 Primary Shard（通过 _id hash）
2. Primary 写入 Lucene 内存 Buffer
3. 同时写入 Translog（防止宕机丢数据）
4. Primary 转发给 Replica
5. Replica 确认写入后 → Primary 确认客户端

写入过程：
  Buffer → refresh（1s 间隔）→ Segment（可见，但未 fsync）
                                        → flush（30min/512MB）→ 落盘 + commit point + translog 清空
```

### 5. 近实时（NRT）原理

```
ES 写入后默认 1s 才可见。

流程：
  Index → Buffer（不可见）
         → refresh（默认 1s 自动触发）→ 生成 Segment（打开搜索可见）
         → flush（~30min/512MB）→ 写入磁盘

为什么不是实时？
  每次 refresh 生成一个新 Segment，高频 refresh 会导致
  小 Segment 过多，影响查询性能和合并效率。

调优：
  PUT /index/_settings
  { "refresh_interval": "30s" }    -- 写入吞吐优先
  { "refresh_interval": "-1"  }    -- 批量导入时关闭 refresh
```

### 6. Translog

**作用**：防止 refresh 到 flush 之间宕机丢数据。

```
每次写入：写 Lucene Buffer + 写 Translog（落盘）
宕机恢复：重放 Translog 恢复未 flush 的数据

问题：Translog 太大 → 恢复慢
解决：flush 后清空 Translog
```

---

### 7. 增量索引原理（Segment Immutability）

**核心原则**：Lucene 的 Segment 是**不可变的（immutable）**，FST 一旦构建就不会被修改。增量索引通过**不断创建新 Segment** 实现，而不是在已有 FST 上追加或修改。

#### 7.1 为什么 Segment 不可变？

```
Lucene 的设计铁律：
  Segment = 最小的独立搜索单元
  Segment 一旦写入磁盘（或 refresh 后开放搜索），内容永不修改

为什么不直接修改内存中的 FST？
  1. 并发控制简单：读不阻塞写，写不阻塞读（天然的 MVCC）
  2. 缓存友好：Segment 不变 → 文件系统缓存（page cache）不会失效
  3. 崩溃恢复简单：Segment 要么完整可用，要么直接丢弃，没有"写了一半"的状态
  4. FST 增量修改成本极高：FST 是有向无环图，插入新 term 需要重建整条路径
```

#### 7.2 增量索引的完整流程

```
写入请求
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ ① Buffer（内存，不可搜索）                            │
│   写入 Lucene In-Memory Buffer                       │
│   同时写入 Translog（磁盘，防宕机丢失）                │
└─────────────────────────────────────────────────────┘
  │  ← refresh（默认 1s）
  ▼
┌─────────────────────────────────────────────────────┐
│ ② 生成新 Segment（内存中构建，开放搜索）              │
│   在内存中为 buffer 内的数据单独构建：                 │
│     - FST（Term Index）                             │
│     - Term Dictionary                               │
│     - Posting List（含 position）                    │
│     - DocValues                                     │
│   → 这个新 Segment 现在可被搜索                       │
│   → 旧的 Segment 不受任何影响                         │
└─────────────────────────────────────────────────────┘
  │  ← flush（默认 30min 或 translog 达 512MB）
  ▼
┌─────────────────────────────────────────────────────┐
│ ③ fsync 到磁盘 + 写 commit point                    │
│   新 Segment 持久化到磁盘                            │
│   Translog 清空（数据已安全落盘）                     │
└─────────────────────────────────────────────────────┘
```

#### 7.3 时间线视角：每次 refresh 创建一个全新 Segment

```
时间线：每秒 refresh 一次，每次创建一个新 Segment

t=0s    写入 doc1, doc2
        Buffer: [doc1, doc2]
        Segments: (空)

t=1s    refresh →
        创建 Segment_1 { FST, TermDict, Posting, DocValues }
        包含: doc1, doc2
        Buffer: (清空)
        Segments: [Segment_1]

t=1.5s  写入 doc3, doc4
        Buffer: [doc3, doc4]
        Segments: [Segment_1]        ← Segment_1 不变

t=2s    refresh →
        创建 Segment_2 { FST, TermDict, Posting, DocValues }
        包含: doc3, doc4
        Segments: [Segment_1, Segment_2]

t=2.3s  写入 doc5
        Buffer: [doc5]
        Segments: [Segment_1, Segment_2]  ← 两个都不变

t=3s    refresh →
        创建 Segment_3 { ... }
        包含: doc5
        Segments: [Segment_1, Segment_2, Segment_3]
```

**关键点**：
- 每次 refresh 创建一个**全新的 Segment**，包含该时间段内写入的所有文档
- 旧 Segment 的 FST / Posting / DocValues **完全不动**
- 搜索时需要遍历**所有 Segment**，合并结果

#### 7.4 更新和删除怎么处理？

Lucene 中没有原地更新，更新和删除通过 **标记删除 + 新写入** 实现：

```
更新文档（实际是"删除旧版本 + 写入新版本"）：
  UPDATE doc1 →
    1. 在 .del 文件中标记 old_doc1 为"已删除"（bitmap）
    2. 写入新版本 new_doc1 到 Buffer
    3. 下次 refresh 时，new_doc1 出现在新 Segment 中
    4. 旧 doc1 还在旧 Segment 中，但搜索时被 .del 过滤掉

删除文档：
  DELETE doc1 →
    在 .del 文件中标记 doc1 为"已删除"
    不修改任何 Segment
    搜索时跳过已标记的 doc

搜索时过滤：
  遍历每个 Segment → 查 .del 文件的 bitmap → 跳过已标记的 doc
```

##### 7.4.1 增量更新端到端示例（以商户改名为例）

上面的描述偏抽象，这里用一个**具体场景**把整条链路串起来，回答两个核心问题：
1. **改了 name 后，检索怎么搜到新名字的词？**
2. **旧名字的词什么时候物理消失？**

**场景**：商户 doc1，name 原本是 `"北京烤鸭店"`，现改成 `"上海小笼包"`。

```
初始状态（T0）：doc1 已在 Segment_1 中，分词后 FST 含 term：
  "北京"(→[doc1]), "烤鸭"(→[doc1]), "店"(→[doc1])

━━━ T1: UPDATE merchant/_doc/1 { "name": "上海小笼包" } ━━━

  Step 1【路由】协调节点按 _id=1 hash → 定位到 Primary Shard
  Step 2【标记删除】在 Segment_1 的 .del 位图把 doc1 置 1（旧文档物理不动）
  Step 3【写新文档】把新内容写入 Lucene Buffer，同时写 Translog 防丢
  Step 4【分词】对 name="上海小笼包" 走 analyzer(ik_max_word)：
               → "上海", "小笼包", "小笼", "笼包"
  Step 5【refresh，默认 1s】为这批 buffer 构建全新的 Segment_2：
               Segment_2 的 FST 含 term：
               "上海"(→[doc1']), "小笼包"(→[doc1']), "小笼"(→[doc1']), ...
  Step 6【可见】Segment_2 开放搜索 → 新名字立即能被搜到（1s 近实时延迟）

此刻磁盘真实状态（搜索视角）：
  Segment_1:  "北京"→[doc1], "烤鸭"→[doc1]   （doc1 已被 .del 标记）
  Segment_2:  "上海"→[doc1], "小笼包"→[doc1] （新版本，活的）
```

**核心：检索是如何搜到新词的？**

```
查询 match name:"上海"

  1. 协调节点分发到各分片
  2. 每个分片遍历所有 Segment 的 FST：
       Segment_1.FST → 查 "上海" → 不存在（旧文档没有这个词）
       Segment_2.FST → 查 "上海" → 命中，倒排链 [doc1]
  3. 对倒排链做 .del 过滤：
       doc1 在 Segment_2 是新版本，.del=0 → 保留 ✅
  4. BM25 打分、排序、返回 doc1

→ 用户成功搜到新名字 "上海"

本质：更新 = 写入新文档 → 新文档在 refresh 时被分词器重新切分
      → 新词进入新 Segment 的倒排索引（FST + Posting List）
      → 检索时遍历所有 Segment，新 Segment 里自然有新词的倒排链
```

**旧词 "北京" 什么时候物理消失？**（容易被忽略的关键点）

```
更新后立即查 "北京"：
  Segment_1.FST → "北京"→[doc1]
  → 倒排链 [doc1] → 查 Segment_1 的 .del → doc1=1（已删）→ 过滤掉
  → 结果为空 ✅（逻辑上旧词立刻"搜不到"了）

但物理上：
  "北京"→[doc1] 这条倒排项还躺在 Segment_1 的磁盘上！
  只是 .del 把 doc1 屏蔽了，FST 里的 term 仍在

物理清除要等 Segment Merge（见 7.6 节）：
  后台把 Segment_1 等小段合并成大段时，重读数据、丢弃 .del 标记的 doc
  → "北京"→[doc1] 这条记录才真正从磁盘消失

→ 这解释了一个常见困惑：为什么文档改了名字，磁盘空间不降反涨？
  因为新旧两份数据并存，旧版本赖在旧 Segment 里没被回收，要等 merge。
```

**端到端时序图**：

```
时间 ──────────────────────────────────────────────────►

T0     doc1="北京烤鸭店" 已在 Segment_1
         │
T1      UPDATE name="上海小笼包"
         │ ├─ 标记 Segment_1 的 doc1 为 deleted（.del）
         │ └─ 新内容入 Buffer + Translog
         │
T1+1s   refresh → Segment_2 生成（含新 doc1）
         │   ★ 此刻起：搜"上海"命中，搜"北京"被 .del 过滤为空
         │
T1+30m  flush → Segment 落盘，Translog 清空（持久化，但不回收旧数据）
         │
T?      后台 Segment Merge
         │   合并 Segment_1 + ... → 新大段，doc1 旧版本被彻底丢弃
         │   "北京"→[doc1] 物理删除，磁盘释放
         ▼
```

**实战要点**：

| 问题 | 说明 |
|------|------|
| **改一个字段为什么要重建整篇文档？** | Lucene 文档不可变，只能整条删除+重写。哪怕只改一个字段，ES 也会把完整 `_source` 重新索引。Update API 支持部分字段的 doc 合并，但底层仍是整条重建。 |
| **`_update_by_query` 为什么慢？** | 本质是对每条命中文档做"删旧+写新"，逐条重建代价高。大批量更新建议直接 `_reindex` 到新索引。 |
| **更新后立刻搜不到？** | 1s 近实时延迟。需要强实时可手动 `POST /_refresh`，但频繁 refresh 会产生大量小 Segment，拖慢查询。 |
| **副本也要同步更新** | Primary 处理后，同样的"删旧+写新"会转发到 Replica，保证主副本一致。 |
| **高频更新导致 Segment 爆炸？** | 频繁更新 → 大量带 .del 的 Segment → 查询要遍历更多 Segment + 过滤更多已删 doc。解法：低峰期 `force_merge` 合并小段。 |

#### 7.5 多个 Segment 如何搜索？

```
搜索 "北京" 时：

  Segment_1 的 FST → "北京" 的 Posting List → [doc1, doc2]
  Segment_2 的 FST → "北京" 的 Posting List → [doc3]
  Segment_3 的 FST → "北京" 的 Posting List → [doc5]

  合并 → [doc1, doc2, doc3, doc5]
  ↓ (过滤各 Segment 的 .del 标记)
  最终结果 → [doc1, doc3, doc5]   （doc2 可能已被标记删除）
```

这就是为什么 Segment 太多会影响性能——**每个 Segment 的 FST 都要查一遍**。

#### 7.6 Segment Merge（合并）— 解决 Segment 过多

```
后台线程定期合并小 Segment 为一个大的：

Segments: [S1(2 docs), S2(3 docs), S3(1 doc), S4(5 docs), S5(2 docs)]
                        ↓ merge
Segments: [S_merged(10 docs), S4(5 docs)]

合并时：
  1. 读取小 Segment 的全部数据
  2. 在内存中为合并后的数据集重新构建一套完整的 FST + Posting + DocValues
  3. 写入一个新的 Segment
  4. 删除旧的小 Segment

合并后的新 Segment：
  - FST 是全新构建的（合并了多个 Segment 的 Term 信息）
  - 被标记删除的 doc 在合并时彻底丢弃（释放空间）
  - Posting List 更紧凑，跳表更高效
```

**合并不是增量修改 FST，而是完全重建**。只是这个重建过程复用旧 Segment 的数据。

#### 7.7 不可变 Segment vs 可变索引

| 对比 | 不可变 Segment（Lucene） | 可变索引（假设存在） |
|------|------------------------|-------------------|
| 并发 | 读不阻塞写，不需要锁 | 需要复杂的读写锁 |
| 缓存 | Page Cache 稳定，不会因修改而失效 | 频繁 Cache 失效 |
| 崩溃恢复 | 新 Segment 要么完整要么丢弃 | 需要考虑"写了一半"的恢复 |
| 事务 | 天然支持（旧 Segment 还在，读不受影响） | 需要 MVCC 机制 |
| FST 增量修改 | ❌ 不可能，FST 是有向无环图 | 需要重新平衡 FST 结构，开销极大 |

> 增量索引不是"修改内存中的 FST"，而是**不停地创建新的 Segment**（每个 Segment 有自己独立的 FST），搜索时遍历所有 Segment 合并结果，后台通过 Segment Merge 把多个小 Segment 合并成大 Segment（重建 FST，丢弃已删除的文档）。

---

## 三、查询流程

### 8. Query vs Filter

| 维度 | Query | Filter |
|------|-------|--------|
| 相关性打分 | ✅ 计算 _score | ❌ 不计算，只有 yes/no |
| 缓存 | 不缓存 | ✅ **结果可缓存**（bitset）|
| 性能 | 慢（打分） | 快 |
| 场景 | 搜索排序 | 精确过滤（时间、状态、范围） |

```json
// Query（打分）
GET /_search
{
  "query": {
    "match": { "title": "北京烤鸭" }
  }
}

// Filter（不打分，可缓存）
GET /_search
{
  "query": {
    "bool": {
      "filter": [
        { "term": { "status": "active" } },
        { "range": { "price": { "gte": 100 } } }
      ]
    }
  }
}
```

### 9. 查询流程（两阶段）

```
Query Phase（查询阶段）：
  1. 协调节点接收请求
  2. 转发到所有相关 shard（primary 或 replica）
  3. 各 shard 本地查询，返回 {_id, _score} 给协调节点

Fetch Phase（取回阶段）：
  4. 协调节点合并排序（取 Top N）
  5. 向各 shard 发送 GET 请求取回完整 _source
  6. 返回客户端

为什么分两阶段？
  查询结果不需要全量传输，先取文档 ID 排序，再取需要的文档内容，
  减少跨节点传输量。
```

### 10. 相关性评分（BM25）

```
ES 5.0+ 默认 BM25（之前 TF-IDF）。

BM25 核心公式：
  score = IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |d|/avgdl))

  关键参数：
    k1（默认 1.2）：控制词频饱和度（k1=0 → 只算 IDF）
    b（默认 0.75）：控制文档长度归一化（b=0 → 不考虑长度）

对比 TF-IDF：
  TF-IDF：词频线性增长，长文档天然有优势
  BM25：词频有上界（非线性），长度归一化更好
```

---

## 四、向量索引（dense_vector）

### 11. 什么是向量索引

ES 从 7.x 开始支持 `dense_vector` 类型，8.0+ 引入 HNSW 算法实现高效的近似最近邻（ANN）搜索。

```
传统倒排索引：精确匹配（词条 → 文档）
向量索引：    相似度匹配（向量 → 最近邻文档）

适用场景：
  语义搜索（"开心的饭馆" → 匹配"氛围好的餐厅"）
  图片搜索（图片 embedding → 找相似图片）
  推荐系统（用户 embedding → 找相似内容）
  多模态搜索（文本→向量 匹配 图片→向量）
```

### 12. Mapping 定义

```json
PUT /my_index
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "ik_smart"
      },
      "title_vector": {
        "type": "dense_vector",
        "dims": 768,             // 向量维度（BERT 768, OpenAI ada 1536）
        "index": true,
        "similarity": "cosine",  // 相似度度量：cosine / dot_product / l2_norm
        "index_options": {
          "type": "hnsw",
          "m": 16,               // HNSW 每层最大连接数（越大越准越耗内存）
          "ef_construction": 100 // 构建时候选集大小（越大越准越慢）
        }
      },
      "price": {
        "type": "integer"
      }
    }
  }
}
```

### 13. 向量检索（kNN）

```json
GET /my_index/_search
{
  "query": {
    "knn": {
      "field": "title_vector",
      "query_vector": [0.12, 0.45, ..., 0.78],  // 768 维向量
      "k": 10,            // 返回前 10 个最近邻
      "num_candidates": 100  // 候选集大小（越大越准越慢）
    }
  }
}
```

| 参数 | 作用 | 越大越 | 推荐 |
|------|------|-------|------|
| k | 返回结果数 | 返回更多 | 根据业务需求 |
| num_candidates | 每分片候选集 | 越准但越慢 | k 的 3-10 倍 |

### 14. 底层算法：NSW → HNSW 详解

#### 13.1 问题定义

向量检索的目标：给定查询向量 **q**，在 N 个向量构成的集合中找到最相似的 **k** 个。

```
暴力解法：计算 q 与所有 N 个向量的距离 → O(N × dim) → N=1000万 时不可行
ANN（近似最近邻）：用索引结构将复杂度降到 O(log N) 或 O(sqrt(N))
```

#### 13.2 NSW（Navigable Small World）— 可导航小世界图

###### 什么是小世界

社交网络中的"六度分隔"现象：**任意两个人之间平均只需 6 步就能建立联系**。

NSW 借鉴了这个思想：**给 N 个向量构建一张图，让任意两个向量之间通过少量跳转就能到达**。

###### NSW 的结构

```
NSW 图（每个点是一个向量）：

         A ───── B ───── C
        /│       │       │\
       D │       │       │ E
        ││       │       ││
       F─┼───────G───────┼─H
        ││       │       ││
       I │       │       │ J
        \│       │       │/
         K ───── L ───── M
```

**特点**：每个节点连接若干"邻居"，长程连接实现快速跳转，短程连接实现精细搜索。

###### NSW 构建过程

**核心思想：逐个插入新节点，每次插入时用贪婪搜索找到最近的 m 个节点，建立双向连接。**

```python
def insert_node(graph, new_node, m=5):
    """向 NSW 图中插入一个新节点"""
    # 1. 从随机入口点开始，贪婪搜索找到最近的 m 个节点
    entry_point = random.choice(graph.nodes)
    candidates = greedy_search(graph, entry_point, new_node, m)

    # 2. 将新节点连接到这 m 个候选（双向图）
    for candidate in candidates:
        graph.add_edge(new_node, candidate)
        graph.add_edge(candidate, new_node)

    # 3. 如果候选节点连接数 > M_max，剪枝保留最近的
    for candidate in candidates:
        if degree(candidate) > M_max:
            prune_connections(graph, candidate, M_max)
```

| 参数 | 作用 | 越大 | 越小 |
|------|------|------|------|
| m（每节点邻居数） | 图的稠密程度 | 召回率越高 | 可能断开 |
| M_max | 最大邻居数上限 | 内存越大 | 图可能断开 |

###### NSW 搜索过程

```python
def nsw_search(graph, entry_point, query_vector, k=10):
    """贪婪搜索：从入口点出发，每次走到比当前更近的点"""
    current = entry_point
    visited = set()

    while True:
        visited.add(current)
        nearest = None
        min_dist = distance(query_vector, current.vector)

        for neighbor in current.neighbors:
            if neighbor in visited:
                continue
            dist = distance(query_vector, neighbor.vector)
            if dist < min_dist:
                min_dist = dist
                nearest = neighbor

        if nearest is None:  # 到达局部最优
            break
        current = nearest

    return sorted(visited, key=lambda n: distance(query_vector, n.vector))[:k]
```

**为什么 NSW 能支持向量检索**：

核心在于**小世界特性**——在随机图中，两点之间的最短路径 ≈ O(log N) 跳。

```
时间复杂度的直观理解：
  暴力搜索：把所有 N 个点翻一遍 → O(N)
  NSW 搜索：从入口走 O(log N) 步到达目标区域 → O(log N)
         │
         ▼
    每步要检查邻居（平均 m 个）
    → 总复杂度 O(m × log N)
```

**贪婪搜索的局限性（NSW 的入口点问题）**：

```
搜索从 S 出发找离 Q 最近的点：

    S
    │  dist(S,Q) = 10      ← 当前最近
    │
    └──→ A  dist(A,Q) = 7  ← 更近，往前走
          │
          └──→ B  dist(B,Q) = 4  ← 更近
                │
                └──→ C  dist(C,Q) = 5  ← 不比 B 更近
                      │
                      └──→ D  dist(D,Q) = 6  ← 不比 B 更近

    → 到达局部最优 B，返回结果

问题：入口点 S 如果是随机的，S 离 Q 很远时，
      需要走很多步才能到达目标区域。
```

#### 13.3 HNSW（Hierarchical NSW）— 分层可导航小世界

**HNSW 是 NSW 的改进版，用分层结构解决入口点问题，灵感来自跳表（SkipList）。**

```
跳表：     3 ───────────────────── 9
            ───────── 5 ────────── 9
            ─── 3 ── 5 ── 7 ── 9  ← 底层全量

HNSW：    Layer 2（顶层）: 少量节点，长程连接
          Layer 1（中间层）: 更多节点
          Layer 0（底层）: 全量节点，精细连接
```

###### 层级分配

```python
import random, math

def random_level(level_lambda=1.0 / math.log(16)):
    """按指数衰减概率分配层数，~97% 在 layer 0"""
    level = -math.log(random.random()) * level_lambda
    return int(level)
```

```
N=10000 个向量：
  Layer 2（顶层）：~10 个节点（最有代表性的点，约 0.1%）
  Layer 1（中间层）：~300 个节点（约 3%）
  Layer 0（底层）：10000 个节点（全量 100%）

每个节点只在分配的层及以下出现。
层级越高的节点越"重要"——它们被选中作为多个节点的邻居，
自然成为图的"高速公路"节点。
```
    level = -math.log(random.random()) * level_lambda
    return int(level)
```

```
N=10000 个向量：
  Layer 2（顶层）：~10 个节点（最有代表性的点）
  Layer 1（中间层）：~300 个节点
  Layer 0（底层）：10000 个节点（全量）
```

###### HNSW 构建过程

```python
def hnsw_insert(graph_hierarchical, new_node, M=16, M_max=32):
    node_level = random_level()                # 1. 随机分配层数

    entry_point = graph_hierarchical.entry_point
    # 2. 从顶层逐层下到 node_level+1（每层找 1 个最近点做下一层入口）
    for layer in reversed(range(graph_hierarchical.max_level, node_level, -1)):
        entry_point = search_layer(graph_hierarchical, entry_point, new_node,
                                   ef=1, layer=layer)[0]

    # 3. 从 node_level 到 layer 0，逐层连接最近邻居
    for layer in reversed(range(0, node_level + 1)):
        candidates = search_layer(graph_hierarchical, entry_point,
                                  new_node, ef=ef_construction, layer=layer)
        neighbors = candidates[:M]
        for neighbor in neighbors:
            graph_hierarchical.add_edge(new_node, neighbor, layer)
            graph_hierarchical.add_edge(neighbor, new_node, layer)
        for neighbor in neighbors:
            if len(graph_hierarchical.get_edges(neighbor, layer)) > M_max:
                prune_connections(graph_hierarchical, neighbor, layer, M_max)
        entry_point = candidates[0]
```

###### HNSW 搜索过程

```python
def hnsw_search(graph_hierarchical, query_vector, k=10, ef=100):
    entry_point = graph_hierarchical.entry_point

    # 1. 从顶层逐层下探（每层 ef=1，只找入口）
    for layer in reversed(range(graph_hierarchical.max_level, 0, -1)):
        entry_point = search_layer(
            graph_hierarchical, entry_point, query_vector, ef=1, layer=layer
        )[0]

    # 2. 在底层用更大的 ef 做精细搜索
    candidates = search_layer(
        graph_hierarchical, entry_point, query_vector, ef=ef, layer=0
    )
    return candidates[:k]
```

###### 分层搜索的直观示意

```
搜索 Q 的最近邻：

Layer 2（~10 nodes）:  从入口进入顶层，找最近的点
Layer 1（~300 nodes）: 从上层的最近点进入本层，贪婪搜索到最近区域
Layer 0（10000 nodes, 全量）: 在底层精细搜索 ef 个候选，取 Top-k
```

###### HNSW 的参数

| 参数 | 默认 | 作用 | 越大 |
|------|------|------|------|
| **m** | 16 | 每层每个节点的最大邻居数 | 召回率 ↑、内存 ↑、构建慢 |
| **ef_construction** | 100 | 构建时候选集大小 | 构建质量 ↑、构建慢 |
| **ef_search** | (查询时指定) | 搜索时动态候选集大小 | 召回率 ↑、搜索慢 |

**ef 调优经验**：ef=k 刚好够返回；ef=3k 推荐平衡点（召回率 95%+）；ef=10k 接近暴力搜索。

###### 为什么 HNSW 比 NSW 快

```
NSW 的问题：
  插入第 10000 个点时，从随机入口出发
  需要先经过"长程连接"跳到目标区域附近
  → 如果入口点离目标很远，要走很多步

HNSW 的优化：
  顶层只含少量节点（最"有代表性"的点）
  从顶层开始搜索，只需走几步就进入目标区域
  → 不需要长程连接来"远跳"，分层结构本身就做到：
    顶层跳远距离 → 中层跳中距离 → 底层精细搜索
```

**复杂度对比**：

| 算法 | 搜索时间 | 构建时间 | 内存 |
|------|---------|---------|------|
| 暴力搜索 | O(N) | O(1) | O(N) |
| NSW | O(log² N) ~ O(sqrt(N)) | O(N log N) | O(N × M) |
| **HNSW** | **O(log N)** | **O(N log N)** | **O(N × M)** |

**HNSW vs NSW 关键区别**：

| 维度 | NSW | HNSW |
|------|-----|------|
| 层数 | 单层图 | 多层图（类似跳表） |
| 入口点 | 随机选 | **从顶层进入，逐层下探** |
| 长程连接 | 靠部分节点连接远距离邻居 | **靠高层节点天然实现"长程跳转"** |
| 搜索策略 | 单层贪婪搜索 | 顶层粗定位 → 底层精细搜索 |
| 搜索质量 | 依赖入口点选择 | **稳定（不依赖入口点）** |
| 复杂度 | O(log² N) | **O(log N)** |

#### 13.4 HNSW vs IVF（倒排文件索引）

IVF（Inverted File Index）是另一种主流的 ANN 算法（Faiss 的核心算法之一），和 HNSW 的思路完全不同。

**IVF 的核心思想**：把向量空间划分成多个区域（聚类），搜索时只在最近的几个区域里找。

```
IVF 结构：

┌──────────────────────────────────────────────┐
│               向量空间                         │
│                                                │
│      [C1] ● ● ●    [C2] ● ● ●                │
│            ● ● ●          ● ● ●               │
│      ──────────●────C1────●────────────────    │
│      [C3] ● ● ●    [C4] ● ● ●                │
│            ● ● ●          ● ● ●               │
│                  C3              C4            │
└──────────────────────────────────────────────┘

C1~C4 = 聚类中心（k-means 计算）
每个向量属于最近的聚类中心
搜索：计算 Q 到 C1~C4 的距离 → 找到最近的 2 个聚类 → 只在这 2 个聚类内搜索
```

**IVF 的搜索流程**：

```python
def ivf_search(ivf_index, query_vector, k=10, nprobe=2):
    """IVF 搜索：nprobe = 搜索时检查的聚类数"""
    # Step 1: 计算 query 到所有聚类中心的距离
    dist_to_centroids = [distance(query_vector, c) for c in ivf_index.centroids]
    # Step 2: 找到最近的 nprobe 个聚类
    nearest_clusters = argsort(dist_to_centroids)[:nprobe]
    # Step 3: 只在选中的聚类内搜索
    candidates = []
    for cluster_id in nearest_clusters:
        for vec in ivf_index.clusters[cluster_id]:
            candidates.append((vec, distance(query_vector, vec)))
    # Step 4: 排序返回 Top-k
    return sorted(candidates, key=lambda x: x[1])[:k]
```

**HNSW vs IVF 详细对比**：

| 维度 | HNSW | IVF |
|------|------|-----|
| **数据结构** | 多层图（节点连接） | 聚类 + 倒排列表 |
| **搜索方式** | 图遍历（逐节点跳转） | 先选聚类，再在聚类内搜索 |
| **召回率** | **高**（> 95%） | 中-高（依赖 nprobe） |
| **搜索速度** | O(log N) | O(nprobe × (N/nlist)) |
| **构建速度** | 慢（逐节点插入，图构建复杂） | **快**（k-means + 分配） |
| **内存** | 高（存邻接表，O(N × M)） | **低**（只存向量 + 倒排索引）|
| **插入新数据** | **动态插入**（增量构建） | ❌ 需要重建索引（聚类会变） |
| **删除** | 支持（标记删除） | ❌ 困难 |
| **精确度调优** | 调 ef / m | 调 nprobe / nlist |
| **适合场景** | 动态数据、高召回率要求 | 静态数据、内存受限 |

**HNSW 的优势逐条展开**：

**1. 召回率更高**
```
相同的搜索时间下，HNSW 的召回率通常比 IVF 高 3-10 个百分点。

原因：
  IVF 的聚类边界问题：Q 实际属于 C1，但距离 C2 更近
  → 只在 C2 内搜 → 错过 C1 里的真正最近邻

  HNSW 没有聚类边界问题：图结构天然覆盖整个空间，
  搜索可以跨区域连续跳转。
```

**2. 动态插入（HNSW 核心优势）**
```
IVF 的痛点：
  插入新向量 → k-means 聚类中心需要重新计算 → 整个索引要重建
  做不到"实时增量"

HNSW 的方案：
  新向量直接插入图结构，逐层找到最近邻居并连接
  → 增量构建，不影响已有索引
  → 适合流式数据、实时更新场景
```

**3. 搜索速度随数据量增长更稳定**
```
HNSW:   O(log N) → N 从 100 万到 1 亿，搜索步数从 ~10 增加到 ~15
IVF:    O(nprobe × (N/nlist)) → N 增加时要么增大 nlist（聚类变多）
          要么每个聚类内向量变多（搜索变慢），需要重新调整参数
```

**4. 扩展性：不需要重训练**
```
IVF 的问题：
  数据量增长后 k-means 聚类不再最优 → 需要重新聚类 → 重建索引
  需要保留全部原始数据用于重聚类（内存压力）

HNSW 没有这个问题：图结构随数据量自然扩展
```

**IVF 的优势**：

| IVF 优势 | 说明 | 适用场景 |
|---------|------|---------|
| **构建快** | k-means 比 HNSW 建图快 2-10x | 一次构建，多次查询 |
| **内存省** | 不存邻接表，内存少 30-50% | 内存受限的场景 |
| **适合批量** | 一次性全量构建，IVF 效率高 | 离线索引，定时重建 |
| **技术成熟** | Faiss 中优化充分（IVFPQ 等变体） | 成熟稳定 |

**选型建议**：

| 场景 | 推荐算法 | 原因 |
|------|---------|------|
| **ES 在线搜索** | **HNSW** | 动态更新、ES 默认、召回率高 |
| **离线推荐召回** | IVF + PQ | 内存省、召回率够用、Faiss 生态 |
| **亿级向量、实时写入** | **HNSW** | 动态增量插入是刚需 |
| **千万级、只读** | IVF | 构建快、内存省 |
| **高召回率要求（> 99%）** | **HNSW** | 图结构精度上限更高 |
| **内存受限（< 1GB）** | IVF + PQ | 量化后内存极低 |

> HNSW 适合**在线动态场景**——召回率高、支持增量插入、搜索速度稳定。
> IVF 适合**离线批量场景**——构建快、内存省、一次建好反复查。
> ES 选 HNSW 是对的：搜索索引需要动态更新，不能频繁重建。

**选型建议**：

| 场景 | 推荐 | 原因 |
|------|------|------|
| ES 在线搜索 | **HNSW** | 动态更新、ES 默认、召回率高 |
| 离线推荐召回 | IVF + PQ | 内存省、Faiss 生态 |
| 亿级向量、实时写入 | **HNSW** | 动态增量插入是刚需 |
| 高召回率要求（> 99%） | **HNSW** | 图结构精度上限更高 |
| 内存受限（< 1GB） | IVF + PQ | 量化后内存极低 |

> HNSW 适合**在线动态场景**——召回率高、支持增量插入、搜索速度稳定。
> IVF 适合**离线批量场景**——构建快、内存省、一次建好反复查。
> ES 选 HNSW 是对的：搜索索引需要动态更新，不能频繁重建。

### 15. 向量检索 + 普通查询混合（Hybrid Search）

**ES 8.0+ 原生支持，将向量检索和普通 filter 放在一起。**

```json
GET /my_index/_search
{
  "query": {
    "bool": {
      "must": [
        { "knn": { "field": "title_vector", "query_vector": [...], "k": 10, "num_candidates": 100 } },
        { "term": { "city": "北京" } },
        { "range": { "price": { "gte": 50 } } }
      ]
    }
  }
}
```

**执行流程**：
```
Step 1: HNSW 粗筛 → 每分片返回 num_candidates 个候选
Step 2: 精确过滤 → 对候选做 bool 过滤，剔除不符合条件的
Step 3: 打分合并 → 按向量相似度排序，返回 top k

注意：过滤是在 HNSW 召回之后做的！
如果过滤条件很严格，可能 100 条候选中都不满足条件 → 结果为空
```

### 16. 混合搜索的准确性问题：Post-Filter vs Pre-Filter

上面的做法是 **post-filter**（先 ANN 再过滤），有召回风险。**ES 8.12+ 支持 filtered HNSW（pre-filter）**：在 HNSW 图搜索时就跳过不符合 filter 的节点。

```json
// ES 8.12+ Pre-filter
GET /my_index/_search
{
  "query": {
    "knn": {
      "field": "title_vector", "query_vector": [...], "k": 10, "num_candidates": 100,
      "filter": {
        "bool": {
          "filter": [
            { "term": { "city": "北京" } },
            { "range": { "price": { "gte": 50 } } }
          ]
        }
      }
    }
  }
}
```

**Reciprocal Rank Fusion（RRF）** — 混合排名融合：

```json
GET /my_index/_search
{
  "query": { "bool": { "must": [{ "match": { "title": "北京烤鸭" } }],
                        "filter": [{ "term": { "city": "北京" } }] } },
  "knn": { "field": "title_vector", "query_vector": [...], "k": 10, "num_candidates": 100 },
  "rank": { "rrf": { "rank_constant": 60 } }
}
```

RRF 融合公式：`RRF score = 1/(rank_constant + rank_position)`，同时对 BM25 排名和向量排名加权融合。

### 17. 向量索引的内存问题

```
1000 万条 × 768 维 × 4 字节（float32） ≈ 30 GB（仅向量数据）
+HNSW 图结构（邻接表）≈ 额外 10-15 GB
= 总计 40-45 GB 内存

超过内存时走 mmap，性能下降 10-100 倍
```

**优化手段**：

| 手段 | 效果 | 代价 |
|------|------|------|
| 降维（768→256） | 内存减少 3x | 召回率降低 1-3% |
| PQ 量化 | 内存减少 4-8x | 召回率降低 2-5% |
| int8 量化 | 内存减少 4x | 召回率降低 1-2% |
| 分片到多节点 | 每节点负载降低 | 跨节点查询增加 |

### 18. 应用场景（与搜索背景关联）

```
搜索中的语义检索：
  用户搜索 "好吃不贵的川菜馆"
  → BERT/Transformer 编码为 768 维向量
  → ES 向量检索找到语义最相似的商品/商户
  → 配合传统 BM25 做混合搜索（RRF 融合排序）

  在传统倒排索引之外增加一路语义召回通道：
  倒排（词匹配）+ 向量（语义匹配）
  → 两路结果融合排序，提升召回率和相关性
```

---

## 五、聚合（Aggregation）

### 19. Bucket + Metric 聚合

```json
// 按城市分组，统计每个城市的平均价格
GET /restaurants/_search
{
  "size": 0,
  "aggs": {
    "by_city": {
      "terms": { "field": "city" },
      "aggs": {
        "avg_price": { "avg": { "field": "price" } }
      }
    }
  }
}
```

| 聚合类型 | 说明 | 示例 |
|---------|------|------|
| **Bucket** | 分桶分组 | terms、range、date_histogram |
| **Metric** | 计算指标 | avg、sum、max、min、cardinality |
| **Pipeline** | 聚合结果再聚合 | avg_bucket、cumulative_sum |

### 20. Cardinality 聚合（去重计数）

```json
{ "cardinality": { "field": "user_id" } }
```

**原理**：HyperLogLog（近似算法）
- 精度：默认 5% 误差
- 内存：100M 数据只需要 12KB

---

## 六、索引与 Mapping

### 21. Mapping 定义

```json
PUT /my_index
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "ik_max_word",
        "fields": {
          "keyword": { "type": "keyword" }   // 精确匹配用 .keyword
        }
      },
      "price": { "type": "integer" },
      "created_at": { "type": "date" },
      "tags": { "type": "keyword" },
      "description": {
        "type": "text",
        "index": false       // 不索引（只存不搜）
      }
    }
  }
}
```

### 22. keyword vs text

| 类型 | 分词 | 适用 | 排序/聚合 | 查询方式 |
|------|------|------|----------|---------|
| **text** | ✅ 分词 | 全文搜索（标题、内容） | ❌ 不能直接排序/聚合 | match 查询 |
| **keyword** | ❌ 不分词 | 精确匹配（状态、标签） | ✅ 可以 | term 查询 |

### 23. 动态 Mapping

```json
{
  "mappings": {
    "dynamic": "true",        // 新字段自动加入（默认）
    // "dynamic": "runtime",  // 新字段按 runtime 处理（7.11+）
    // "dynamic": "strict"    // 新字段拒绝写入
  }
}
```

### 24. Analyzer 分词

```
Analyzer = Character Filters + Tokenizer + Token Filters

常用 Analyzer：
  standard（默认）：按空格/标点切分，小写化
  ik_smart / ik_max_word（中文）：IK 分词器
  keyword：不分词（整个 field 作为一个 term）
  whitespace：按空格切分
  ngram：N-gram 分词（用于模糊匹配/搜索建议）

分词流程（以 "北京烤鸭" 为例）：
  input: "北京烤鸭"
  → ik_smart: ["北京", "烤鸭"]
  → ik_max_word: ["北京", "烤鸭", "北京烤鸭"]
```

---

## 七、集群与分片

### 25. 分片设计

| 决策 | 推荐 | 原因 |
|------|------|------|
| 分片数量 | 节点数的 1-3 倍 | 分片越多，查询并发越高，但协调成本也高 |
| 单分片大小 | 20-50GB | 过大 → 恢复慢；过小 → 分片太多 |
| 主分片 | **创建后不可修改** | 所以初期要有合理预估 |
| 副本数 | 1-2（生产环境） | 0（写入吞吐优先） |

### 26. 路由（Routing）

```json
// 按 user_id 路由：同一个用户的文档落到同一分片
PUT /my_index/_doc/1?routing=user123
GET /my_index/_search?routing=user123  // 避免广播到所有分片
```

### 27. 脑裂与集群健康

#### 27.1 集群健康状态

```
green：  所有主分片 + 副本分片都正常分配
yellow： 主分片正常，有副本未分配（常见原因：节点数不够）
red：    有主分片未分配（需要立即排查，部分数据不可用）
```

#### 27.2 脑裂的原因与 ES 的防护

脑裂的根本原因：**网络分区导致集群分裂为多个子集群，每个子集群都认为自己合法**。

```
ES 中的脑裂场景：
  3 节点集群，Node 1 是 active master
  网络抖动 → Node 1 与 Node 2、3 断开
  → Node 2、3 发现 master 失联 → 发起选举 → Node 2 当选新 master
  → Node 1 还不知道自己被"罢免"，仍在执行 master 任务
  → 两个 master 同时存在 = 脑裂
```

**ES 的防护**：**Quorum 多数派机制**

```
discovery.zen.minimum_master_nodes = N/2 + 1

  3 节点 → minimum_master_nodes = 2
  → 选举必须获得至少 2 个节点的同意
  → 出现网络分区时只有多数派能选出 master

  5 节点分区为 {A,B,C} 和 {D,E}：
  → {A,B,C} 3 票 ≥ 3，可以选举 → 继续服务
  → {D,E}   2 票 < 3，无法选举 → 拒绝服务，保护数据一致性
```

#### 27.3 分布式系统处理脑裂的四种通用策略

##### 策略一：Quorum 选举（多数派投票）

最通用的方案。选举/决策必须获得**半数以上**节点的同意才生效：

| 系统 | 机制 | 关键参数 |
|------|------|---------|
| **ES** | master-eligible 节点数 ≥ N/2+1 才选举 | `minimum_master_nodes` |
| **ZooKeeper** | Zab 协议，Leader 需获半数以上投票 | 节点数必须为奇数 |
| **etcd** | Raft 协议，Leader 需获多数票 | 同上 |
| **Redis Sentinel** | 多个哨兵协商，半数以上确认才判定客观下线 | `quorum = N/2+1` |
| **Kafka** | Controller 选举 + ISR 最小副本数 | `min.insync.replicas` |

##### 策略二：仲裁盘 / Witness 节点

偶数节点时引入**不存数据的轻量见证者**来打破平局：

```
2 节点集群 + 1 个 Witness：
  正常：A(1票) + B(1票) + Witness(1票) = 3 票
  脑裂时 A 能连通 Witness → 2 票 ≥ N/2+1 → A 胜出
         B 连不通 Witness → 1 票 → 拒绝服务

Witness 本身不存数据，只参与投票
典型实现：etcd learner 节点、Windows Server 仲裁盘
```

##### 策略三：Fencing（资源锁 / 隔离）

通过**共享资源的排他锁**确保只有一个 leader 能真正写：

```
Fencing Token 机制：
  1. Leader A 获得 token=100（单调递增版本号）
  2. 网络恢复后，旧 A 尝试继续写共享存储
  3. 共享存储检查 → 发现已经有 token=101 的 leader B
  4. 拒绝 A 的写入 → A 自杀或降级为 follower

典型实现：
  - etcd 的 lease + revision（key 带 lease，过期自动失效）
  - HDFS NameNode 的 edit log fencing
  - SAN/NFS 共享存储上的 lock file + 版本号
```

##### 策略四：STONITH（物理隔离）

最暴力的方案——**直接 kill 掉旧 master**：

```
两个子集群各自认为自己是主：
  → 集群管理器检测到脑裂
  → 向旧 master 物理机发送断电指令（BMC/IPMI）
  → 物理关机，强制确保旧 master 已死
  → 新 master 确认唯一后开始服务

典型实现：
  - Pacemaker + Corosync（Linux HA 集群）
  - AWS EC2 auto-recovery（detach ENI → attach 新实例）
  - Oracle RAC node eviction
```

#### 27.4 脑裂的三层防线

实际生产系统**组合多层防线**，不是只用一种：

```
第一层：奇数节点 + Quorum
  3/5/7 个节点，多数派选举，少数派自动停服

第二层：资源隔离（Fencing）
  旧 leader 持有的 lease/锁过期后自动失效
  → 即使旧 leader 还在运行也无法执行写操作

第三层：物理隔离（STONITH）
  超时后直接 kill -9 或关机
  → 兜底保障，确保不会有"僵尸 leader"
```

#### 27.5 面试追问：ES 真的脑裂了会怎样？

```
少数派子集群：
  → 无法满足 minimum_master_nodes → 拒绝选举
  → 所有 API 返回 503（master_not_discovered_exception）
  → 读操作：不可用（无法获取最新路由表）
  → 写操作：不可用

多数派子集群：
  → 成功选出新 master
  → 更新路由表，将少数派节点标记为 lost
  → 将丢失节点上的主分片对应的副本提升为主分片
  → 正常服务

网络恢复后：
  → 少数派重新加入集群
  → 发现自己数据落后 → 从多数派的节点同步数据
  → 恢复正常
```

### 28. 分布式系统故障分级

按影响范围和数据安全风险从轻到重排列：

| 级别 | 故障类型 | 数据丢失风险 | 可用性影响 | 检测难度 | 恢复难度 |
|:----:|---------|:----------:|:--------:|:------:|:------:|
| L1 | 瞬时网络抖动 | 无 | 秒级延迟 | 自愈 | 无需恢复 |
| L2 | 慢节点（GC/IO 打满） | 无 | 拖慢请求 | 中等 | 自动/手动踢出 |
| L3 | 单节点宕机 | 无（有副本时） | 秒~分钟级 | 容易（心跳超时） | **自动恢复** |
| L4 | 磁盘故障 | 可能（无其他副本时） | 分钟~小时 | 容易（IO 报错） | 从副本重建 |
| L5 | 静默数据损坏 | **有（读到错数据）** | 无感知 | **极难** | **需 checksum 修复** |
| L6 | 网络分区/脑裂 | 有（双写后丢弃） | 少数派不可用 | 中等 | 依赖 Quorum |
| L7 | 级联失败/雪崩 | 无 | **全面不可用** | 中等 | 需熔断/降级 |
| L8 | 人为误操作 | **高** | 不定 | 容易（操作记录） | **需备份/快照** |
| L9 | 机房级故障 | 有（单机房无容灾） | **长时间不可用** | 容易 | 多机房容灾 |

#### 28.1 L1 瞬时网络抖动

**症状**：节点间个别心跳超时、请求偶发 timeout，但很快自动恢复。

**影响**：瞬间的延迟升高或无响应，不影响数据安全，不影响可用性（重试即可）。

**恢复机制**：客户端重试 + 指数退避；心跳超时时间设置合理（不因短暂抖动触发选举）。ES 的 `zen.fd.ping_timeout` 默认 30s。

#### 28.2 L2 慢节点 / Straggler

**症状**：个别节点因 GC 停顿、磁盘 IO 打满、CPU 飙高而响应极慢，但未宕机。

**影响**：拖慢整个请求链路（分布式任务等最慢的那个节点），可能导致超时风暴。

**恢复机制**：
- **Hedged Read（对冲读）**：同时向两个副本发请求，谁先返回用谁的结果
- **Backup Request**：超时后立刻向另一个节点重发
- 慢节点连续慢多次后踢出集群（但慎用，可能引发连锁反应）

**真实案例**：ES Data 节点 Full GC → 30s+ 停顿 → master 探测超时 → 误判宕机 → 触发不必要选举。

#### 28.3 L3 单节点宕机

**症状**：进程崩溃 / OOM 被杀 / 机器重启，节点彻底死亡。

**影响**：**不丢数据**（有副本），短暂不可用（故障转移期间）。如果无副本，该节点上的主分片全部丢失 → red 状态 → 数据丢失。

```
无副本：主分片全部丢失 → red → 数据丢失
有副本：副本自动提升为主分片 → yellow（副本数不足）→ 自动重建副本 → green
```

**恢复机制**：
- ES：master 30s 后感知失联 → 副本提升 → 在其他节点重建缺失副本
- Redis Sentinel：哨兵检测主观下线 → 协商客观下线 → 故障转移
- Kafka：Broker 宕机 → Controller 重新分配 Leader Partition

#### 28.4 L4 磁盘故障

**症状**：磁盘坏道、读写错误、IO 彻底挂死（等级比 Node Crash 更高，数据可能永久丢失）。

**影响**：坏盘上所有分片数据全部损坏。如果有副本 → 自动从副本恢复；**所有副本恰好在这块坏盘上**（概率低但可能）→ 数据永久丢失。

**恢复机制**：多副本（至少 1 个 replica）；ES 检测到磁盘故障 → 自动 exclude 该节点 → 从副本在其他节点重建数据。

#### 28.5 L5 静默数据损坏

**症状**：磁盘返回**错误数据但没报错**（最隐蔽、最危险）。读出的数据是错的，但系统认为正常，错误会传播到下游。

**恢复机制**：
- **端到端校验**：写入时存 checksum，读取时验证，不匹配则从副本修复
- ES：Lucene 在 Segment 写入时写 CRC32 checksum，读取时验证
- HDFS：每个数据块存 MD5 checksum，定期校验
- MySQL InnoDB：page checksum，崩溃恢复时验证

#### 28.6 L6 网络分区 / 脑裂

详见前文「27. 脑裂与集群健康」（Quorum + Fencing + STONITH 三层防线）。

#### 28.7 L7 级联失败 / 雪崩

**症状**：一个服务挂掉 → 调用方超时等待 → 线程池耗尽 → 调用方也挂掉 → 继续向上传播。

```
服务 A 调用 ES → ES 慢 → A 的线程全在等 ES → A 的 health check 超时
→ 上游 B 调用 A 也超时 → B 挂掉 → ... → 整个链路全挂
```

**恢复机制（四件套）**：
- **熔断（Circuit Breaker）**：连续失败 N 次后直接快速失败
- **限流（Rate Limiting）**：超过 QPS 阈值直接拒绝
- **超时（Timeout）**：设置合理最大等待时间，不无限等待
- **降级（Degradation）**：ES 不可用时返回缓存数据或热门推荐兜底

#### 28.8 L8 人为误操作

**症状**：rm -rf / DROP TABLE / 错误的线上配置 / 批量删除脚本写错 where（比机器故障严重得多——机器宕机有自动化恢复，人为一次删除千万行不会自动回滚）。

**恢复机制**：
- **事前**：权限控制、操作审批、二次确认
- **事后**：快速回滚、快照恢复、binlog 回放
- ES 8.0 的 DELETE index 是软删除，有回收期可恢复

#### 28.9 L9 机房级故障

**症状**：交换机故障、光纤被挖断、整机房断电、地震洪水。**所有副本跟着一起挂**。

**恢复机制**：
- **多机房/多可用区部署**：副本分布在不同的物理机架/机房
- ES 的 rack awareness 配置：
```json
// bin/elasticsearch -Enode.attr.rack_id=rack1

PUT /_cluster/settings
{
  "transient": {
    "cluster.routing.allocation.awareness.attributes": "rack_id",
    "cluster.routing.allocation.awareness.force.rack_id.values": "rack1,rack2"
  }
}
// ES 确保同一个分片的主副本不在同一个 rack 上
```

### 29. 分布式协议

ES 没有用 ZK/Raft/Paxos，而是**自建协议组合**：

```
┌────────────────────────────────────────────────┐
│              ES 分布式协议栈                      │
├────────────────────────────────────────────────┤
│  节点发现    → Zen Discovery（基于单播/种子节点）   │
│  主节点选举  → Bully 算法变体（node ID 最小者胜出）│
│  状态同步    → Gossip 协议（定期交换集群元数据）    │
│  数据复制    → Primary-Backup（主分片写入 → 副本同步）│
└────────────────────────────────────────────────┘
```

#### 29.1 节点发现（Zen Discovery）

```
每个节点配置 discovery.seed_hosts（种子节点列表）：

discovery.seed_hosts: ["node1:9300", "node2:9300", "node3:9300"]

启动流程：
  Node 启动 → ping 种子节点 → 获取集群中所有节点列表
  → 选择主节点 → 加入集群 → 开始接收分片分配
```

#### 29.2 主节点选举（Bully 算法变体）

```
规则：node ID 最小的 master-eligible 节点当选

  节点发现阶段，所有 master-eligible 节点互发 ping
  → 各自收集到集群中所有符合资格的节点 ID
  → 比较 node ID，最小值者自我宣布为 master
  → 得票数 ≥ N/2+1（多数派）才正式当选

  如果当前 master 宕机：
  → 其他 master-eligible 节点 ping 不通 master（默认 30s 超时）
  → 发起新一轮选举，node ID 最小者胜出

为什么 node ID 最小者胜出？
  node ID 在节点启动时生成（持久化到磁盘），重启不变
  → 集群重启后同一个节点通常再次当选，减少不必要的 master 切换
```

#### 29.3 状态同步（Gossip 协议）

```
每个节点定期（默认 1s）向随机选中的另一个节点发送 Gossip 消息：

Gossip 消息内容：
  - 集群状态版本号
  - 已知的节点列表（含存活状态）
  - 分片路由表（哪个分片在哪个节点上）
  - 索引元数据（mapping、settings）

  版本号低的节点从版本号高的节点拉取最新状态
  → 最终一致性：数秒内所有节点状态一致
  → 无中心节点，任意节点宕机不影响信息传播
```

#### 29.4 为什么不依赖 ZK？

| 对比 | ES（自建） | 依赖 ZK（如 Solr/Kafka 旧版） |
|------|----------|---------------------------|
| 部署 | 零依赖，开箱即用 | 需要额外部署 ZK 集群 |
| 运维 | 不需要维护外部系统 | 需要维护 ZK 集群 |
| 故障域 | 单一系统 | 两个系统关联故障 |

### 30. 节点角色

```
ES 7.x+ 节点角色由 node.roles 配置：

node.roles: [master, data, ingest, ml, remote_cluster_client, transform]
```

| 角色 | 配置值 | 职责 | 资源需求 |
|------|--------|------|---------|
| **Master-eligible** | `master` | 集群管理（创建/删除索引、分片分配、节点增删） | CPU 轻，内存小 |
| **Data** | `data` | 存储数据、执行数据操作（CRUD、搜索、聚合） | **CPU 高、内存大、磁盘 IO 高** |
| **Ingest** | `ingest` | 预处理管道（字段修改、数据丰富、格式转换） | CPU 中，内存中 |
| **Coordinating** | （无特殊角色） | 请求路由、结果合并（默认所有节点都是） | CPU 中，内存小 |
| **ML** | `ml` | 机器学习作业（异常检测、预测） | CPU 极高，内存高 |
| **Transform** | `transform` | 数据转换（聚合后存到目标索引） | CPU 中 |
| **Remote-cluster-client** | `remote_cluster_client` | 跨集群搜索的连接出口 | 网络带宽 |

#### 常见角色组合

```
生产环境 3 节点小集群（每个节点都允许参与选举）：
  Node 1: [master, data, ingest]
  Node 2: [master, data, ingest]
  Node 3: [master, data, ingest]

  3 个节点都是 master-eligible，但同一时刻只有 1 个 active master
  → 挂 1 个节点仍可用，剩余 2 个足以选举出新 master（≥ N/2+1 = 2 票）

10+ 节点大集群专用角色：
  3 个 Master-only:  [master]       ← 只做集群管理，不存数据
  N 个 Data-only:    [data, ingest] ← 只存数据和预处理
  2 个 Coord-only:   []             ← 只做请求协调（负载均衡入口）
  1 个 ML-only:      [ml]           ← 只跑机器学习
```

**master-eligible vs active master**：

```
master-eligible：配置了 [master] 角色的节点，有资格参与选举（可以有多个）
active master：  当前真正执行集群管理的节点（同一时刻只有一个）

3 节点都配 [master] 不是为了"多个 master 同时干活"，
而是为了容错——挂 1 个后，剩余 2 个仍能选出新 master。

master 节点数的多数派规则：
  N=1 → 容忍 0 宕机（单点故障）
  N=2 → 容忍 0 宕机（挂 1 个后凑不出多数票 N/2+1=2）
  N=3 → 容忍 1 宕机 ✅
  N=5 → 容忍 2 宕机
```

**专用角色的好处**：
- Master 节点不存数据 → 不会因为 GC 停顿被误判为宕机，避免不必要的选举（小集群混合部署的风险正在于此）
- Data 节点专做数据处理 → 不受管理任务干扰
- Coordinating 节点做负载均衡入口 → 客户端连接分散，减少 Data 节点的 HTTP 连接压力

### 31. 扩容与缩容

#### 31.1 扩容（添加 Data 节点）

```
新节点 node-4 加入集群：

Step 1: 启动 node-4, 配置相同的 cluster.name 和 discovery.seed_hosts
Step 2: node-4 通过种子节点发现集群
        → 向 master 发送加入请求
Step 3: master 将 node-4 加入集群状态
        → Gossip 传播到所有节点（1-2 秒内全部感知）
Step 4: master 触发 rebalance（重新分片分配）
        → 从现有 Data 节点迁移部分分片到 node-4

━━━━ 分片迁移细节 ━━━━

  迁移单个分片（以 P0 从 node-1 迁到 node-4 为例）：
    1. master 向 node-1 发指令：将 P0 迁到 node-4
    2. node-1 在 Lucene 层创建 P0 的快照（不阻塞写入）
    3. node-4 从 node-1 拉取分片数据
    4. 拉取期间，P0 的写入同时发给 node-1 和 node-4（双写）
    5. 数据同步完成后，master 更新路由表 → P0 移到 node-4
    6. node-1 删除 P0 的本地数据
```

**迁移期间的读写**：旧节点继续服务直到新节点数据追上；迁移期间双写保证不丢数据。

**扩容感知时间**：

```
T+0s     node-4 启动，ping 种子节点
T+1s     master 感知新节点，更新集群状态
T+2s     Gossip 传播，全集群感知新节点
T+3s     master 开始 rebalance
T+N min  分片迁移完成（取决于数据量和带宽）
```

**控制迁移速度**：

```json
PUT /_cluster/settings
{
  "transient": {
    "cluster.routing.allocation.node_concurrent_recoveries": 2,
    "indices.recovery.max_bytes_per_sec": "40mb"
  }
}
// 过低 → 迁移慢；过高 → 占用 IO/网络，影响正常读写
```

#### 31.2 缩容（安全下线 Data 节点）

```
Step 1: 通知 master 该节点即将下线

PUT /_cluster/settings
{
  "transient": {
    "cluster.routing.allocation.exclude._ip": "10.0.0.5"
  }
}

Step 2: master 执行 decommission — 将该节点上的所有分片迁移到其他节点
Step 3: 监控迁移进度
        GET /_cat/shards?v      → 确认已排除节点上无分片
        GET /_cat/recovery?v    → 确认无进行中的迁移
Step 4: 停止节点进程（安全下线）
```

**直接 kill 的风险**：节点上如有主分片 → master 30s 后感知失联 → 副本提升为主分片 → 未复制完的新数据（还在 Translog）丢失。安全下线必须走上述流程，给 master 时间迁移数据。

#### 31.3 Master 节点变更

```
添加 Master-eligible 节点：启动后自动参与选举，不存数据无需迁移
移除 Master-eligible 节点：直接停进程即可，不存数据

重要：Master 节点数必须为奇数（3/5/7），避免脑裂时两派票数相等
```

#### 31.4 扩容缩容速查

| 操作 | 关键步骤 | 影响 | 时长 |
|------|---------|------|------|
| 加 Data 节点 | 启动 → 自动发现 → rebalance | 短暂 IO/网络升高 | 分钟~小时 |
| 减 Data 节点 | exclude IP → 迁移分片 → 停机 | 同上 | 分钟~小时 |
| 加 Master 节点 | 启动 → 加入选举 | 无数据迁移 | 秒级 |
| 减 Master 节点 | 停进程 | 无数据迁移 | 秒级 |
| 加 Coord 节点 | 启动 → 自动发现 | 零影响 | 秒级 |
| 强制 kill -9 | 直接杀进程 | **可能丢数据** | 立刻 |

---

## 八、地理位置查询

### 32. ES 地理位置索引原理

ES 支持两种地理字段类型：

```json
PUT /my_index
{
  "mappings": {
    "properties": {
      "location": { "type": "geo_point" },
      "area":     { "type": "geo_shape" }
    }
  }
}
```

```json
// geo_distance 查询（附近 5km 的商户）
GET /restaurant/_search
{
  "query": {
    "bool": {
      "filter": [{
        "geo_distance": {
          "distance": "5km",
          "location": { "lat": 39.9, "lon": 116.4 }
        }
      }]
    }
  }
}

// geo_bounding_box（矩形范围查询）
GET /restaurant/_search
{
  "query": {
    "geo_bounding_box": {
      "location": {
        "top_left":     { "lat": 40.0, "lon": 116.0 },
        "bottom_right": { "lat": 39.5, "lon": 116.8 }
      }
    }
  }
}
```

### 33. 地理位置不是存在 FST 里的

FST 存的是**倒排索引的 term**（分词后的词条），而经纬度是连续的数值，不适合做精确分词。

ES 用两种方式实现地理索引，都**不是 FST**：

| 索引方式 | ES 版本 | 数据结构 | 存储位置 |
|---------|---------|---------|---------|
| **Geohash** | 5.x+ | Trie 前缀树 | Lucene BKD Tree 之前的方案 |
| **BKD Tree（默认）** | 6.x+ | **BKD Tree（Block KD Tree）** | 列存（DocValues） |

#### 28.1 Geohash 编码

Geohash 将经纬度二维坐标编码为一维字符串，前缀越长精度越高。

```
北京天安门：lat=39.9, lon=116.4

Geohash 编码过程（base32，交替二分经纬度，5位一组）：
  Step 1: 纬度 [-90, 90] 二分 → 39.9 在右半区 → 1
  Step 2: 经度 [-180, 180] 二分 → 116.4 在右半区 → 1
  Step 3: 纬度 [0, 90] 二分 → 39.9 在右半区 → 1
  Step 4: 经度 [90, 180] 二分 → 116.4 在右半区 → 1
  ... 重复 20 次得 20 位二进制序列，再 base32 编码

  结果: wx4g0f（~1.2km 精度）
        wx4g0f8（~100m 精度）
        wx4g0f8d（~2m 精度）
        wx4g0f8d（~2m 精度）
```

```
// 索引时按多级精度拆分为多个 term（存入倒排索引的 FST）
"location" → [
    term: "w",       精度 ~5000km    (level 1)
    term: "wx",      精度 ~1000km    (level 2)
    term: "wx4",     精度 ~100km     (level 3)
    term: "wx4g",    精度 ~30km      (level 4)
    term: "wx4g0",   精度 ~5km       (level 5)
    term: "wx4g0f",  精度 ~1.2km    (level 6)
]

// geo_distance 查询 5km 内：
// → 用 level 5 的 geohash 前缀 "wx4g0" 去 FST 中匹配
```

**Geohash 的问题**：
- **边界问题**：两个很近的点如果在 geohash 边界上，前缀可能完全不同
- 精度不连续：从一个级别跳到下一个，精度变化不连续

#### 28.2 BKD Tree（ES 6.x+ 默认方案）

BKD Tree = **Block KD Tree**，是 KD Tree 的磁盘优化版本，专门处理**多维范围查询**。

```
KD Tree 分割示意（二维空间，交替按经纬度分割）：

第一次分割（经度）：
  116.0─┬──────106.0─────────────────125.0──
        │        │                      │
        │    A组 │                  B组  │
  39.0──┼────────┼──────────────────────┼──
        │    A组 │                  B组  │
  37.0──┴────────┴──────────────────────┴──

第二次分割（纬度），在 A/B 组内各自再分
```

**BKD Tree 的搜索过程**：

```
查询：geo_bounding_box, lat=[39.0, 40.0], lon=[116.0, 116.5]

Step 1: 检查根节点 → 有重叠 → 继续
Step 2: 左子树（经度 < 106）→ 查询范围经度 116.0+ → 不重叠 → 剪枝跳过
Step 3: 右子树（经度 >= 106）→ 重叠 → 继续
Step 4: 右子树的左子节点（纬度 < 38）→ 查询纬度 39.0+ → 不重叠 → 剪枝
Step 5: 右子树的右子节点（纬度 >= 38）→ 重叠 → 到达叶子
Step 6: 在 Leaf Block 中逐条检查经纬度是否在范围内
```

**坐标距离计算**：

```
小范围（< 1° 约 100km）：近似为平面 Euclidean 距离，快
中范围（< 10°）：Haversine 公式（球面三角）
大范围：Vincenty 公式（椭球体，最精确）

Haversine(lat1, lon1, lat2, lon2)：
  a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlon/2)
  c = 2 · atan2(√a, √(1-a))
  d = 6371 · c     // 地球半径 6371km
```

#### 28.3 BKD Tree vs FST

| 维度 | FST（倒排索引） | BKD Tree（数值/地理索引） |
|------|---------------|------------------------|
| 数据结构 | 有限状态转换器 | 块状 KD Tree |
| 存储位置 | Segment 的 Terms 索引 | **DocValues（列存）** |
| 适用类型 | **离散词条**（文本/关键词） | **连续数值**（int/long/float/geo） |
| 查询方式 | term 精确匹配 + 前缀匹配 | **范围剪枝**（range/bounding box）|
| 内存 | FST 常驻内存（~1MB） | BKD 索引在内存，数据块在磁盘 |

#### 28.4 DocValues 中的 Segment 全景

```
一个 Document 被索引到 Segment 时，不同 field 类型走不同的索引结构：

┌──────────────── Segment ─────────────────┐
│                                           │
│  FST（倒排索引 Term Index）                │
│    ├── text 字段的 term（分词后）            │
│    ├── keyword 字段的 term（整体作为 term）  │
│    └── geohash 的 term（如果启用）          │
│                                           │
│  BKD Tree（多维数值索引，DocValues 内）     │
│    ├── int/long 字段（范围查询）             │
│    ├── float/double 字段（范围查询）         │
│    └── geo_point（经纬度范围查询）           │
│                                           │
│  DocValues（列存，排序/聚合）               │
│    ├── 所有 fields 的列式存储               │
│    └── BKD Tree 作为 DocValues 的索引       │
│                                           │
│  Stored Fields（_source）                 │
│    └── 原始 JSON 数据                      │
└───────────────────────────────────────────┘
```

#### 28.5 geo_distance 完整执行流程

```
查询：附近 5km 内的商户，按距离排序

Step 1: BKD Tree 范围剪枝
        计算查询中心点 [39.9, 116.4] 的 5km 范围边界
        经纬度范围：lat=[39.85, 39.95], lon=[116.35, 116.45]
        用 BKD Tree 快速找到在此范围内的 docID 列表

Step 2: DocValues 读取精确位置
        对候选 docID 从 DocValues（列存）读取精确的经纬度

Step 3: Haversine 精确过滤
        对每个候选 doc 计算 Haversine 距离
        剔除 5km 边缘附近 BKD 范围模糊的文档

Step 4: 排序（_geo_distance sort）
        按实际距离升序排列

如果查询中带有其他条件（如 bool + term filter），
则在 Step 1 之前先做其他条件的过滤，再在过滤结果上做 geo 查询。
```

#### 28.6 地理位置查询的优化

| 优化手段 | 效果 | 说明 |
|---------|------|------|
| **优先 filter** | 用 filter 而非 query | geo 查询通常不需要打分，filter 结果可缓存 |
| **缩小 BKD 范围** | 范围小则 BKD 剪枝快 | 小范围（1km）比大范围（100km）快 N 倍 |
| **结合其他条件** | 先过滤非地理条件 | 先 term filter 缩小数据量，再 geo 查 |
| **调整精度** | 提高精度会慢 | `distance_type: arc`（精确球面）vs `plane`（近似平面）|

---

## 九、性能优化

### 34. 写入优化

| 优化手段 | 配置 | 效果 | 原理 |
|---------|------|------|------|
| 批量写入 | bulk API（每批 1-15MB/1000-5000 条） | 减少网络往返 | 一次网络请求处理多个 document，减少 RTT 开销 |
| 降低 refresh 间隔 | `refresh_interval: 30s` | 减少 Segment 数量 | 延长 refresh 周期，让更多数据积累在一个 Segment，减少合并开销 |
| 关闭副本 | `number_of_replicas: 0`（写入完成后再开启） | 减少数据复制 | 写入时不额外消耗副本同步的 IO/网络，批量导入后再开启 |
| 异步刷盘 | `translog.durability: async` | 减少 fsync 开销 | 默认每次写入都 fsync translog，改为异步可大幅提升吞吐（代价：宕机可能丢少量数据） |
| 多线程写入 | 每个节点 4-8 线程 | 充分利用 CPU | ES 的单索引写入是串行的，多线程批量写入不同文档 |

**批量导入的完整流程**：

```bash
# 1. 创建索引时关闭副本和 refresh
PUT /my_index
{
  "settings": {
    "number_of_replicas": 0,
    "refresh_interval": "-1"    # 关闭自动 refresh
  }
}

# 2. bulk 导入数据
POST /_bulk
{ "index": { "_index": "my_index" } }
{ "title": "...", ... }

# 3. 导入完成后手动 refresh + 开启副本
POST /my_index/_refresh
PUT /my_index/_settings
{
  "refresh_interval": "30s",
  "number_of_replicas": 1
}
```

### 35. 查询优化

| 问题 | 原因 | 解决 | 代码 |
|------|------|------|------|
| 查询慢 | 扫描数据多 | 加 filter 缩小范围，filter 结果可 bitSet 缓存 | `"filter": [{ "term": { "city": "北京" } }]` |
| 聚合慢 | fielddata/global ordinals 计算 | 用 DocValues（keyword 默认开启） | 避免对 text 字段做聚合 |
| 深度分页慢 | ES 需要从每个 shard 取 `from+size` 条再合并 | 用 search_after 替代 | 见下方详细说明 |
| 通配符查询慢 | 扫描大量 term（`*abc*` 扫描全部） | 用 ngram/edge_ngram 分词 | 在索引时预生成 ngram 子串 |
| 过大 `_source` | 传输全量数据 | `_source: { "excludes": [...] }` 或 `stored_fields` | 只返回需要的字段 |
| 无意义打分 | 不需要相关性时仍打分 | filter 上下文代替 query | bool 中用 filter 不用 must |
| 大 key 查询 | 单个 key 过大导致序列化/网络开销 | 拆分字段或用 `_source` filter | 避免单字段超过 10KB |

**通配符优化——用 ngram 替代通配符**：

```json
// ❌ 通配符：每次查询扫描全部 term
GET /_search
{ "query": { "wildcard": { "title": "*烤鸭*" } } }

// ✅ ngram 分词：索引时预生成词段，查询时 term 精确匹配
PUT /my_index
{
  "settings": {
    "analysis": {
      "filter": { "ngram_filter": { "type": "ngram", "min_gram": 2, "max_gram": 3 } },
      "analyzer": { "ngram_analyzer": { "tokenizer": "standard", "filter": ["ngram_filter"] } }
    }
  },
  "mappings": {
    "properties": {
      "title": { "type": "text", "analyzer": "ngram_analyzer" }
    }
  }
}
// 查询 "烤鸭"：在索引中已经存了 "烤鸭" 的 2-3gram 子串，直接 term 匹配
```

### 36. 深度分页

**为什么深度分页慢**？

```
查询 from=10000, size=20，3 个 shard：

协调节点向 3 个 shard 请求 top 10020 条（from + size）
  每个 shard 搜索 10020 条 → 总共 30060 条
  协调节点合并 30060 条，取 [10000-10020) → 只返回 20 条

问题：99.9% 的操作在内存合并中丢弃了！
      from 越大，浪费越严重。
     ES 默认 max_result_window = 10000，不允许超过。
```

```json
// ❌ 传统分页（越往后越慢）
GET /_search?from=10000&size=10
// ES 默认 max_result_window = 10000

// ✅ search_after（游标分页）
GET /_search
{
  "size": 10,
  "sort": [ { "id": "asc" } ],
  "search_after": [100]   // 上一页最后一个 id
}

// ✅ Scroll（批量导出，不适合实时查询）
POST /_search/scroll
{
  "scroll": "1m",
  "scroll_id": "..."
}
```

---

## 十、索引生命周期管理

### 37. 索引模板（Index Template）

```json
// 按日期自动创建索引，统一配置
PUT /_template/logs_template
{
  "index_patterns": ["logs-*"],
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "refresh_interval": "30s"
  },
  "mappings": {
    "properties": {
      "@timestamp": { "type": "date" },
      "message": { "type": "text" }
    }
  }
}
```

### 38. 索引生命周期管理（ILM）

```json
// 自动管理索引生命周期
PUT /_ilm/policy/logs_policy
{
  "policy": {
    "phases": {
      "hot": {
        "min_age": "0ms",
        "actions": { "rollover": { "max_size": "50GB" } }
      },
      "warm": {
        "min_age": "7d",
        "actions": { "forcemerge": { "max_num_segments": 1 } }
      },
      "cold": {
        "min_age": "30d",
        "actions": { "freeze": {} }
      },
      "delete": {
        "min_age": "90d",
        "actions": { "delete": {} }
      }
    }
  }
}
```

---

## 十一、搜索业务场景（与简历关联）

### 39. 搜索提示（SUG）

```json
// completion suggester（前缀搜索，基于 FST）
PUT /my_index
{
  "mappings": {
    "properties": {
      "suggest": {
        "type": "completion",
        "analyzer": "ik_smart"
      }
    }
  }
}

GET /my_index/_search
{
  "suggest": {
    "my_suggest": {
      "prefix": "北京",
      "completion": { "field": "suggest" }
    }
  }
}
```

### 40. 拼写纠错

```json
// term suggester（基于编辑距离）
GET /my_index/_search
{
  "suggest": {
    "spell_check": {
      "text": "beiign",
      "term": { "field": "title" }
    }
  }
}
```

### 41. 搜索高亮

```json
GET /my_index/_search
{
  "query": { "match": { "title": "北京烤鸭" } },
  "highlight": {
    "fields": { "title": {} },
    "pre_tags": ["<em>"],
    "post_tags": ["</em>"]
  }
}
```

---

## 十二、ES 与搜索引擎架构

### 42. ES 在搜索链路中的位置

```
用户输入 → Query Understanding → ES 召回 → 粗排 → 精排 → 重排 → 展示
                              ↓
                          ES 负责：
                          1. 倒排索引匹配（TF-IDF / BM25）
                          2. 词条级召回（match / match_phrase）
                          3. 向量语义召回（kNN）
                          4. 过滤（category/地理/价格/状态）
                          5. 基础排序（BM25 _score + 自定义 script）

                          不负责：
                          1. 深度学习排序（交给精排服务）
                          2. 多模态理解（交给 embedding 服务）
                          3. 个性化重排（交给重排服务）
```

**搜索链路各阶段职责**：

| 阶段 | 负责组件 | 输入 | 输出 | 量级 |
|------|---------|------|------|------|
| **QU** | Query Understanding 服务 | 原始 query "好吃的烤鸭" | 标准化的词条信号 | — |
| **召回** | **ES** | 词条信号 + 过滤条件 | 候选 docID 列表 | ~1000-5000 |
| **粗排** | 轻量级模型 | docID 列表 | 排序后的 docID | ~500-1000 |
| **精排** | 深度学习模型 | 粗排 topN | 打分排序结果 | ~100-200 |
| **重排** | 规则引擎/个性化 | 精排结果 | 最终展示列表 | ~20-50 |

**两阶段召回（现代搜索标配）**：

```
传统的单路倒排召回：
  ES 的普通 match 查询 → 只靠词匹配，可能漏掉语义相关的文档

现代的多路召回：
  ┌─ ES 倒排召回（词匹配，BM25）─────────┐
  │  查询 "好吃不贵的川菜馆"              │
  │  → 匹配到词 "川菜"、"馆" 的文档       │
  └────────────────────────────────────┘
  ┌─ ES 向量召回（语义匹配，kNN）─────────┐
  │  查询 → embedding → HNSW 搜索        │
  │  → 匹配到 "重庆火锅"、"成都小吃" 等     │
  │    语义相近但没有词重叠的文档          │
  └────────────────────────────────────┘
  → RRF 融合排序 → 返回融合后的 Top N
```

### 43. ES vs 其他搜索引擎

| 维度 | ES | Solr | 自研搜索引擎 |
|------|-----|------|------------|
| 部署 | 开箱即用，分布式原生 | 需配置 SolrCloud | 需要自建 |
| 实时性 | 近实时（1s refresh） | 类似 | 毫秒级 |
| 扩展性 | 自动分片 + rebalance | 类似 | 自建 |
| 聚合分析 | 强（支持嵌套聚合）| 较弱 | 自建 |
| 中文分词 | IK/阿里分词 | IK | 自建 |
| 维护成本 | 低 | 中 | 高 |
| 大数据量 | 百亿级 | 百亿级 | 千亿级 |

### 44. 搜索链路中的常见问题与 ES 解决方案

**问题 1：多路召回结果如何融合？**

```
方案一：RRF（Reciprocal Rank Fusion）
  ES 8.8+ 原生支持，无需应用层合并
  两路召回的结果通过 rank_position 融合打分

方案二：线性加和
  在应用层获取两路结果，加权求和
  score = w1 * BM25_score + w2 * cosine_similarity

方案三：瀑布流（cascade）
  先用倒排缩小范围，再在结果集上做向量检索（pre-filter）
  ES 8.12+ 原生支持 filtered kNN
```

**问题 2：搜索场景中 ES 怎么配合缓存？**

```
L1 缓存（本地 Caffeine）：
  热点 query 的结果直接缓存在服务内存
  TTL 1-2 分钟，命中率 30-50%

L2 缓存（Redis）：
  查询 → 先查 Redis（key = "search:query_hash"）
  命中 → 直接返回（TTL 5-10 分钟）
  未命中 → 查 ES → 写入 Redis

注意事项：
  只有高并发查询才需要缓存（头部 query）
  缓存失效要跟数据更新协调（监听 binlog 更新）
```

**问题 3：搜索服务怎么处理 ES 故障？**

```
降级策略（从轻到重）：
  1. ES 某个 shard 不可用 → 主副本自动提升，对终端透明
  2. ES 节点宕机 → 路由到其他节点，部分 shard 返回空结果
  3. ES 整个集群不可用 → 降级到 MySQL like 查询（慢但可用）
  4. 全部不可用 → 返回热门推荐 + 网络搜索结果兜底

熔断机制：
  连续 N 次超时 → 打开熔断器 → 请求快速失败 → 返回缓存/兜底
  半分钟后尝试恢复 → 自动关闭熔断器
```

---

## 面试常问（针对搜索方向）

1. **ES 写入流程** — Buffer → refresh(1s) → Segment → flush → commit point。写入时如何保证不丢数据（Translog）？
1b. **ES 增量更新** — 改了商户 name 后，检索是怎么搜到新词的？为什么旧词改完磁盘空间反而变大？（答案：更新=删旧+写新，新文档 refresh 时重新分词进新 Segment；旧词靠 .del 逻辑屏蔽，物理回收要等 Segment Merge，见 7.4.1）
2. **ES 查询流程** — Query Phase（取 ID+score）+ Fetch Phase（取 _source）。为什么分两阶段？
3. **倒排索引** — FST → Term Dictionary → Posting List → DocValues 四层结构，每层做什么？
4. **FST vs BKD Tree** — 文本用 FST（倒排），数值/地理用 BKD Tree（DocValues），为什么不同？
5. **BM25 vs TF-IDF** — BM25 词频饱和度（k1）+ 长度归一化（b），比 TF-IDF 好在哪？
6. **向量检索（HNSW）** — 为什么用 HNSW 而不是 IVF？HNSW 的分层结构和搜索过程是怎样的？
7. **混合搜索** — 倒排 + 向量怎么融合？RRF 公式是什么？post-filter 和 pre-filter 的区别？
8. **短语查询** — match_phrase 如何用 position 信息实现？slop 参数怎么计算？
9. **倒排链合并** — AND/OR/NOT 三条有序倒排链怎么合并？拉链归并 + 跳表 skipTo 如何提速？为什么高频词要用 filter 缓存成 bitset？（见 2.4 节）
10. **深度分页** — from+size 为什么越往后越慢？search_after 怎么解决？
10. **地理位置查询** — geo_point 用的是 BKD Tree 还是 FST？geo_distance 的完整执行流程？
11. **缓存问题** — 缓存穿透/击穿/雪崩在 ES 场景下怎么处理？ES filter 缓存是什么机制？
12. **ES 在你的搜索链路中怎么用的** — QU 后信号的召回（倒排 + 向量），多路融合，与精排的关系

---

## 常用运维命令

```bash
# 集群状态
GET _cluster/health

# 查看索引
GET _cat/indices?v

# 查看分片分配
GET _cat/shards?v

# 慢查询日志配置
PUT /my_index/_settings
{
  "index.search.slowlog.threshold.query.warn": "10s",
  "index.search.slowlog.threshold.query.info": "1s",
  "index.search.slowlog.threshold.query.debug": "500ms",
  "index.indexing.slowlog.threshold.index.info": "1s"
}

# Force Merge（段合并，减少 Segment 数量）
POST /my_index/_forcemerge?max_num_segments=1

# 重建索引
POST /_reindex
{
  "source": { "index": "old_index" },
  "dest": { "index": "new_index" }
}

# 查看集群资源
GET _nodes/stats
GET _cat/nodes?v
```
