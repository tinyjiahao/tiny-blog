---
title: 短信发送系统设计
date: 2026-06-21 09:30:00
description: '从面试题「设计短信发送系统」出发，由单机并发限流逐步演进到分布式限流、异步削峰、幂等、多通道路由及生产级安全合规设计。'
categories:
  - 系统设计
tags:
  - 短信系统
  - 限流
  - 幂等
  - 分布式
  - 后端
---

面试题「设计一个短信发送系统」看似简单——实现频率限制，但往深处挖可以涉及并发安全、分布式限流、消息队列削峰、幂等性、多通道路由、安全合规与监控成本等一整套后端系统设计能力。

本文从最初有缺陷的实现出发，逐步分析并发竞态、内存泄漏等问题，给出单机与分布式两套完整解法，最终演进到生产级短信系统的完整架构。

<!-- more -->

> **面试题背景**：设计一个短信发送系统。核心约束：同一手机号每 60s 最多发送一次、每天最多发送 10 条。
>
> 本题从"实现一个限流方法"切入，可一路深挖到并发、分布式限流、异步削峰、幂等、多通道路由、容灾、安全合规、监控成本等。下面按**由浅入深**展开：先解决单机并发限流，再演进到生产级短信系统设计。

```
本文脉络：
  一~五  从 0 到 1：并发问题 → 限流方案（单机/分布式）→ 内存治理 → 方案对比
  六~十三 由点到面：系统架构 → 异步削峰 → 幂等 → 多通道路由 → 重试补偿 → 安全合规 → 监控 → 成本
  十四    生产就绪 Checklist + 面试追问速答
```

---

## 一、初始实现与问题分析

### 原始实现
下面是最容易想到的实现方案，通过两个map记录上次发送时间和当天的发送次数，每次发送时做下对比即可判断是否要发送，

```java
private Map<String, Long> lastSendTimeMap = new ConcurrentHashMap<>();
private Map<String, Integer> sendCountMap = new ConcurrentHashMap<>();

public boolean sendMessage(String phoneNo, String message) {
    Long lastSendTime = lastSendTimeMap.get(phoneNo);
    if (lastSendTime != null && System.currentTimeMillis() - lastSendTime < 60000) {
        return false;
    }

    SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd");
    String today = sdf.format(new java.util.Date());

    Integer sendCount = sendCountMap.get(phoneNo + "#" + today);
    if (sendCount == null) sendCount = 0;
    if (sendCount >= 10) return false;

    // 发送短信（未实现）

    lastSendTimeMap.put(phoneNo, System.currentTimeMillis());
    sendCountMap.put(phoneNo + "#" + today, sendCount + 1);
    return true;
}
```

### 问题清单
上面的实现对于单机串行发送情况下是可以作为原型实现的，但是在多线程、高流量、集群等场景下是存在很多问题的：

| 优先级 | 问题 | 说明 |
|--------|------|------|
| P0 | **并发竞态** | check-then-act 非原子，多线程下限流失效 |
| P0 | **发送逻辑缺失** | 实际短信发送代码为空，状态与结果不一致 |
| P1 | **单机限制** | Map 存 JVM 内存，多实例部署时限流形同虚设 |
| P1 | **内存泄漏** | `phoneNo#date` key 永不清理，长期运行 OOM |
| P2 | **参数校验缺失** | phoneNo/message 为 null 时直接 NPE |
| P2 | **SimpleDateFormat 非线程安全** | 应改用 `java.time.LocalDate` |
| P2 | **时区问题** | `new Date()` 依赖 JVM 默认时区，跨时区部署有风险 |

---

## 二、并发问题深入分析

### 竞态条件复现

```
时间轴：
T1: get(phoneNo) → null（通过60s检查）
T2: get(phoneNo) → null（通过60s检查）  ← 同时进入
T1: get(count) → 9（通过日限检查）
T2: get(count) → 9（通过日限检查）  ← 都读到9
T1: put(count, 10)  ← 发送第10条
T2: put(count, 10)  ← 发送第11条！超限
```

**根因**：`ConcurrentHashMap` 只保证单个操作的原子性，跨操作的"读-判断-写"三步组合不是原子的。

---

## 三、解决方案

### 方案一：合并状态 + compute 原子操作（单机推荐）

**核心思路**：将两个 Map 合并为一个，利用 `ConcurrentHashMap.compute()` 对同一 key 的操作加分段锁，保证原子性。

```java
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.concurrent.ConcurrentHashMap;

public class SendMessage {

    private static class PhoneState {
        long lastSendTime = 0;       // 最近一次预占/发送的时间戳
        int dailyCount = 0;          // 当日已发送（含预占）计数
        String lastSendDate = "";    // 最近一次的日期，用于跨天重置
        long pendingTimestamp = 0;   // 正在发送中的那次预占时间戳（用于安全回滚）
    }

    private final ConcurrentHashMap<String, PhoneState> stateMap = new ConcurrentHashMap<>();

    public boolean sendMessage(String phoneNo, String message) {
        // 参数校验
        if (phoneNo == null || !phoneNo.matches("^1[3-9]\\d{9}$")) return false;
        if (message == null || message.isEmpty() || message.length() > 500) return false;

        String today = LocalDate.now(ZoneId.of("Asia/Shanghai")).toString();
        long now = System.currentTimeMillis();
        boolean[] allowed = {false};

        // compute 保证对同一 phoneNo 的操作原子执行
        stateMap.compute(phoneNo, (k, state) -> {
            if (state == null) state = new PhoneState();

            // 60s 间隔检查
            if (now - state.lastSendTime < 60_000) return state;

            // 跨天重置日计数
            if (!today.equals(state.lastSendDate)) {
                state.dailyCount = 0;
                state.lastSendDate = today;
            }

            // 日限 10 条
            if (state.dailyCount >= 10) return state;

            // 预占状态（乐观：先占位，发送失败再回滚）
            state.lastSendTime = now;
            state.pendingTimestamp = now;   // 记下"我这次预占的时间戳"
            state.dailyCount++;
            allowed[0] = true;
            return state;
        });

        if (!allowed[0]) return false;

        // 实际发送
        try {
            doSend(phoneNo, message);
            return true;
        } catch (Exception e) {
            // 发送失败，【条件回滚】：仅当状态未被他人覆盖时才撤销
            // 关键：doSend 耗时（几百 ms~秒），期间别的线程可能已合法修改此 key
            final long myTimestamp = now;
            stateMap.compute(phoneNo, (k, state) -> {
                if (state != null && state.pendingTimestamp == myTimestamp) {
                    // 中间没人改过，安全回滚我这次的预占
                    state.lastSendTime = 0;
                    state.dailyCount = Math.max(0, state.dailyCount - 1);
                    state.pendingTimestamp = 0;
                }
                // 否则：期间已有他人成功发送（pendingTimestamp 已变），我的预占已被
                // "自然消化"，不能再回滚，否则会误清他人合法的 lastSendTime
                return state;
            });
            return false;
        }
    }

    private void doSend(String phoneNo, String message) {
        // 调用短信服务商 API（阿里云/腾讯云等）
    }
}
```

**为什么 `compute` 能解决并发**：
- `compute` 在执行期间对该 key 持有分段锁
- 不同 phoneNo 哈希到不同 segment，互不阻塞，并发性能好
- 同一 phoneNo 的多个并发请求串行执行，竞态消除

> ### ⚠️ 隐蔽竞态：无条件回滚会破坏 60s 限制（重要！）
>
> 上面代码用了**条件回滚**（`state.pendingTimestamp == myTimestamp` 才撤销）。如果写成**无条件回滚**（很多人第一反应会这么写），会引入一个隐蔽且严重的 bug：
>
> ```java
> // ❌ 错误写法：无条件清零
> stateMap.compute(phoneNo, (k, state) -> {
>     state.lastSendTime = 0;                          // 无脑清零
>     state.dailyCount = Math.max(0, state.dailyCount - 1);
>     return state;
> });
> ```
>
> **根因**：预占的 `compute` 和回滚的 `compute` 是**两个独立的临界区**，中间隔着耗时的 `doSend`（调短信通道，几百 ms~秒）。在这两次 `compute` 之间，**别的线程可以合法地修改同一个 key 的状态**。回滚时假设"状态还是我预占时的样子"，但实际早被改过。
>
> ```
> 时间轴复现：
> T1 预占 → lastSendTime=t1, dailyCount=1
> T1 doSend 卡住（通道超时 5s）
>     ┊ 60 秒过去 ┊
> T2 预占（同号，t1 已过 60s，合法）→ lastSendTime=t2, dailyCount=2
> T2 doSend 成功 ✓
> T1 终于失败，无条件回滚 → lastSendTime=0   💥 把 T2 合法的 t2 清零！
>
> 后果：T3 立刻请求，now-0 巨大 → 通过 → T2 刚发完 T3 立刻发
>      → 违反"同号 60s 一次" ❌
> ```
>
> **修复思路（CAS 思想）**：回滚时带条件判断，只有"状态没被他人覆盖"才撤销——即上面的 `pendingTimestamp == myTimestamp`。这等价于一个版本号/时间戳的 Compare-And-Swap：
> - 预占时记下自己的时间戳 `pendingTimestamp = now`
> - 回滚时若 `pendingTimestamp` 还是自己的值 → 中间没人改过 → 安全回滚
> - 若已变 → 期间已有他人成功发送 → 我的预占已被自然消化 → **不回滚**
>
> **生产实践更推荐**：直接**失败不回滚**（60s 冷却也保留）。理由：短信失败多为号码/通道问题，立即重试大概率还失败、徒增成本；保留冷却还能防"失败→立即重试"的刷量风暴，且彻底消除回滚竞态。本例的条件回滚适用于"失败必须让用户立即可重试"的强需求场景。
>
> 顺带一提：下面的 **Redis 方案也存在同样的回滚竞态**（`decrement` 减的是当前值），见其对应警告。

---

### 方案二：Striped 细粒度锁（逻辑更清晰）

适合判断逻辑复杂、不适合塞进 lambda 的场景。

```java
// 依赖：com.google.guava:guava
import com.google.common.util.concurrent.Striped;
import java.util.concurrent.locks.Lock;

public class SendMessage {

    // 256 个锁条带，不同 phoneNo 大概率使用不同锁，冲突概率低
    private final Striped<Lock> striped = Striped.lock(256);
    private final ConcurrentHashMap<String, PhoneState> stateMap = new ConcurrentHashMap<>();

    public boolean sendMessage(String phoneNo, String message) {
        if (phoneNo == null || message == null) return false;

        Lock lock = striped.get(phoneNo);
        lock.lock();
        try {
            String today = LocalDate.now(ZoneId.of("Asia/Shanghai")).toString();
            long now = System.currentTimeMillis();

            PhoneState state = stateMap.computeIfAbsent(phoneNo, k -> new PhoneState());

            if (now - state.lastSendTime < 60_000) return false;

            if (!today.equals(state.lastSendDate)) {
                state.dailyCount = 0;
                state.lastSendDate = today;
            }

            if (state.dailyCount >= 10) return false;

            state.lastSendTime = now;
            state.dailyCount++;

            doSend(phoneNo, message);
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            lock.unlock();
        }
    }
}
```

> ⚠️ 不要用 `synchronized(phoneNo.intern())`：`intern()` 会将字符串放入常量池，大量手机号会导致常量池膨胀，且 intern 本身有锁竞争。

---

### 方案三：Redis 原子操作（分布式/生产必选）

**单机方案的根本缺陷**：多实例部署时每台机器独立计数，无法跨实例限流。

#### 3.1 Redis 数据结构设计

```
sms:last:{phoneNo}       →  String，值为最后发送时间戳，TTL=60s
sms:count:{phoneNo}:{date} →  String，值为当日发送次数，TTL到当天结束
```

#### 3.2 Lua 脚本（保证原子性）

Redis 单线程执行 Lua，脚本内的多步操作等价于原子事务：

```lua
-- KEYS[1] = sms:last:{phoneNo}
-- KEYS[2] = sms:count:{phoneNo}:{today}
-- ARGV[1] = 当前时间戳(ms)
-- ARGV[2] = 今日结束时间戳(s)，用于 EXPIREAT

local now = tonumber(ARGV[1])
local expireAt = tonumber(ARGV[2])

-- 检查 60s 间隔
local lastTime = tonumber(redis.call('GET', KEYS[1]) or 0)
if now - lastTime < 60000 then
    return {0, "rate_limit_60s"}
end

-- 检查日计数
local count = tonumber(redis.call('GET', KEYS[2]) or 0)
if count >= 10 then
    return {0, "rate_limit_daily"}
end

-- 原子更新
redis.call('SET', KEYS[1], now, 'PX', 60000)
local newCount = redis.call('INCR', KEYS[2])
if newCount == 1 then
    redis.call('EXPIREAT', KEYS[2], expireAt)
end

return {1, "ok"}
```

#### 3.3 Java 调用

```java
import org.springframework.data.redis.core.RedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import java.time.*;

@Service
public class SendMessage {

    @Autowired
    private RedisTemplate<String, String> redisTemplate;

    private static final String LUA_SCRIPT =
        "local now = tonumber(ARGV[1])\n" +
        "local expireAt = tonumber(ARGV[2])\n" +
        "local lastTime = tonumber(redis.call('GET', KEYS[1]) or 0)\n" +
        "if now - lastTime < 60000 then return {0, 'rate_limit_60s'} end\n" +
        "local count = tonumber(redis.call('GET', KEYS[2]) or 0)\n" +
        "if count >= 10 then return {0, 'rate_limit_daily'} end\n" +
        "redis.call('SET', KEYS[1], now, 'PX', 60000)\n" +
        "local newCount = redis.call('INCR', KEYS[2])\n" +
        "if newCount == 1 then redis.call('EXPIREAT', KEYS[2], expireAt) end\n" +
        "return {1, 'ok'}";

    private static final DefaultRedisScript<List> SCRIPT =
        new DefaultRedisScript<>(LUA_SCRIPT, List.class);

    public boolean sendMessage(String phoneNo, String message) {
        if (phoneNo == null || message == null) return false;

        ZoneId zone = ZoneId.of("Asia/Shanghai");
        LocalDate today = LocalDate.now(zone);
        long now = System.currentTimeMillis();
        // 今日 23:59:59 的 Unix 时间戳（秒）
        long expireAt = today.atTime(LocalTime.MAX).atZone(zone).toEpochSecond();

        String lastKey  = "sms:last:" + phoneNo;
        String countKey = "sms:count:" + phoneNo + ":" + today;

        List result = redisTemplate.execute(SCRIPT,
            Arrays.asList(lastKey, countKey),
            String.valueOf(now),
            String.valueOf(expireAt));

        if (result == null || ((Number) result.get(0)).intValue() == 0) {
            return false;
        }

        try {
            doSend(phoneNo, message);
            return true;
        } catch (Exception e) {
            // 【条件回滚】（用 Lua 保证原子 + 条件判断，避免误清他人状态）
            // 只在 lastKey 的值仍等于本次预占时间戳时才撤销，详见下方警告。
            String rollbackScript =
                "if redis.call('GET', KEYS[1]) == ARGV[1] then\n" +  // lastKey 仍是我的时间戳？
                "    redis.call('DEL', KEYS[1])\n" +                  // 才删 lastKey
                "    redis.call('DECR', KEYS[2])\n" +                 // 才减日计数
                "    return 1\n" +
                "end\n" +
                "return 0";                                           // 否则不回滚
            DefaultRedisScript<Long> rollback = new DefaultRedisScript<>(rollbackScript, Long.class);
            redisTemplate.execute(rollback,
                Arrays.asList(lastKey, countKey),
                String.valueOf(now));
            return false;
        }
    }

    private void doSend(String phoneNo, String message) {
        // 调用短信服务商 SDK
    }
}
```

> ### ⚠️ Redis 回滚同样有竞态（与方案一同源）
>
> 很多人写 Redis 方案的回滚会直接这样：
>
> ```java
> // ❌ 错误写法：delete + decrement 两步，既非原子也不判断
> redisTemplate.delete(lastKey);
> redisTemplate.opsForValue().decrement(countKey);
> ```
>
> **两个问题**：
> 1. **非原子**：`delete` 和 `decrement` 是两条命令，中间别的线程可以插入。
> 2. **无条件**：`decrement` 减的是"当前值"而非"我那次加的值"。
>
> 竞态场景：T1 预占 lastKey=t1；T1 发送卡住；60s 后 T2 合法预占 lastKey=t2；T1 失败回滚 `delete(lastKey)` → 把 T2 合法的 t2 也删了 → 60s 限制被破坏（与方案一的危害完全一致）。
>
> **修复**：把回滚逻辑也写进 **Lua 脚本**，Redis 单线程执行 Lua 保证原子，并在脚本内加条件判断（`lastKey` 值仍等于本次预占时间戳才撤销）——即上面代码中的 `rollbackScript`。这同样是一种 CAS：只有"状态没被他人覆盖"时才回滚。
>
> **生产推荐**：与方案一一致，更简单的做法是**失败不回滚**（保留 60s 冷却），既消除竞态又防刷量。只有业务强要求"失败立即可重试"时才用条件回滚。

---

## 四、内存泄漏问题

单机方案中 stateMap 长期运行会积累大量手机号 entry，需定期清理：

```java
// 方式一：Caffeine 缓存（推荐）
// 依赖：com.github.ben-manes.caffeine:caffeine
private final Cache<String, PhoneState> stateMap = Caffeine.newBuilder()
    .expireAfterAccess(25, TimeUnit.HOURS)  // 超过1天未访问自动淘汰
    .maximumSize(100_000)                   // 最多缓存10万个号码
    .build();

// 方式二：定时清理过期 key
ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();
scheduler.scheduleAtFixedRate(() -> {
    String yesterday = LocalDate.now().minusDays(1).toString();
    stateMap.entrySet().removeIf(e ->
        e.getValue().lastSendDate.compareTo(yesterday) < 0);
}, 1, 1, TimeUnit.HOURS);
```

Redis 方案中 TTL 自动过期，无需额外处理。

---

## 五、方案对比

| 维度 | compute 方案 | Striped Lock | Redis Lua |
|------|-------------|--------------|-----------|
| 并发安全 | ✅ | ✅ | ✅ |
| 多实例支持 | ❌ | ❌ | ✅ |
| 内存泄漏 | 需手动清理 | 需手动清理 | TTL 自动过期 |
| 实现复杂度 | 低 | 低 | 中 |
| 外部依赖 | 无 | Guava | Redis |
| 适用场景 | 单机/测试 | 单机/逻辑复杂 | **生产环境** |

---

## 六、生产级系统整体架构

前面解决的是"单接口限流"，但一个真实的短信系统远不止于此。

### 6.1 整体架构图

```
┌──────────────┐   ┌─────────────────────────────────────────────────────┐   ┌──────────────┐
│ 业务系统      │   │                    短信服务                          │   │  短信通道     │
│ (下单/注册/  │──►│                                                      │   │              │
│  营销/通知)  │   │  ┌─────────┐  限流   ┌─────────┐  MQ   ┌─────────┐  │   │ 阿里云短信   │
└──────────────┘   │  │  API    │ ──────► │ 发送    │ ────► │ 消费者  │──┼──►│ 腾讯云短信   │
                   │  │  网关   │         │  校验   │       │ Worker │  │   │ 华为云短信   │
                   │  └─────────┘         └─────────┘       └─────────┘  │   │ 容联云/梦网  │
                   │       │                  │                 │        │   └──────────────┘
                   │       │                  │                 │        │
                   │  ┌────▼──────┐  ┌────────▼─────┐  ┌────────▼──────┐ │
                   │  │ Redis     │  │ 黑名单/签名   │  │ 回执/状态报告 │ │
                   │  │ 限流计数  │  │ 模板/风控     │  │ 回调处理      │ │
                   │  └───────────┘  └──────────────┘  └───────────────┘ │
                   │                                                      │
                   │  ┌───────────────────────────────────────────────┐  │
                   │  │  监控：发送量 / 成功率 / 限流率 / 延迟 / 成本   │  │
                   │  └───────────────────────────────────────────────┘  │
                   └─────────────────────────────────────────────────────┘
```

### 6.2 核心组件职责

| 组件 | 职责 | 关键点 |
|------|------|--------|
| **API 网关** | 接收发送请求、鉴权、入参校验 | 限流前置、防刷 |
| **限流服务** | 60s / 日 10 条约束 | Redis Lua 原子操作（见方案三）|
| **MQ** | 削峰填谷、异步解耦 | 业务快速返回，发送异步进行 |
| **消费者 Worker** | 拉取消息、调用通道 | 幂等消费、失败重试 |
| **通道路由** | 选择通道、故障转移 | 多通道、负载均衡、熔断 |
| **回执处理** | 接收运营商送达状态 | 补全最终状态、触发重试 |
| **风控/黑名单** | 防刷、防恶意 | 频次/内容/黑名单 |
| **监控** | 黄金四信号 + 成本 | 见第十二节 |

### 6.3 同步 vs 异步

```
同步发送（简单业务、低 QPS）：
  业务 → 限流 → [阻塞] 调通道 → 拿到回执 → 返回
  缺点：通道慢则业务卡住；通道抖动影响业务可用性

异步发送（推荐，生产标配）：
  业务 → 限流 → 写 MQ → 立即返回"已受理"
                │
                ▼
        Worker 消费 → 调通道 → 记录结果 → 回执回调更新
  优点：业务不阻塞；可削峰；通道故障不影响业务；可重试
```

---

## 七、异步化与削峰（MQ）

### 7.1 为什么要 MQ

```
大促/营销场景：瞬间几十万条短信请求
  无 MQ：同步调通道 → 通道限流 → 业务超时堆积 → 雪崩
  有 MQ：请求先入队 → Worker 按通道能力匀速消费 → 平滑发送

MQ 的作用：
  ① 削峰填谷：瞬时洪峰进队列，消费端按节奏处理
  ② 解耦：业务方只管"投递"，不关心通道细节
  ③ 异步：业务快速响应，不等通道返回
  ④ 缓冲重试：消费失败可重新入队/进重试队列
```

### 7.2 消息设计

```json
// 投递到 MQ 的消息
{
  "msgId": "sms-uuid-唯一",      // 用于幂等
  "phoneNo": "13800138000",
  "templateCode": "SMS_LOGIN",
  "params": {"code": "123456"},
  "bizType": "LOGIN",            // 业务类型，影响通道/优先级
  "timestamp": 1718000000000,
  "traceId": "xxx"               // 链路追踪
}
```

### 7.3 消费幂等（防重复发送）

**问题**：MQ 保证 at-least-once（至少一次），消费者可能收到重复消息 → 用户收到两条。

```
幂等方案：msgId 去重
  消费前：SETNX sms:msgid:{msgId} 1 EX 86400
    ├─ 返回 1（首次）→ 继续发送
    └─ 返回 0（重复）→ 直接 ACK 丢弃，不再发送

注意幂等窗口：>= 短信允许的最大重试周期（如 24h）
```

```java
public void consume(SmsMessage msg) {
    String idKey = "sms:msgid:" + msg.getMsgId();
    // 原子占位：只有首个消费者能成功
    Boolean first = redisTemplate.opsForValue()
        .setIfAbsent(idKey, "1", Duration.ofHours(24));
    if (Boolean.FALSE.equals(first)) {
        return;  // 重复消息，幂等丢弃
    }
    try {
        sendViaChannel(msg);
    } catch (Exception e) {
        redisTemplate.delete(idKey);  // 失败则释放，允许重试
        throw e;  // 抛出让 MQ 重投
    }
}
```

### 7.4 消费速率控制

```
Worker 并发数 = 通道允许的 QPS / 单 Worker 处理速率
  例：通道允许 1000 QPS，单 Worker 处理 100 QPS → 起步 10 个 Worker

弹性扩缩容：MQ 堆积量超阈值 → 自动扩 Worker
  → 避免堆积过多导致短信严重延迟
```

---

## 八、幂等性设计

除了 MQ 消费幂等，整个链路有多处需要幂等，否则会出现重复发送。

### 8.1 重复发送的来源

```
┌────────────────────────────────────────────────────────────┐
│                    重复发送的几种来源                        │
├────────────────────────────────────────────────────────────┤
│  ① MQ 重投递   消费超时/失败，MQ 重新投递同一消息            │
│  ② 用户重试    用户点"获取验证码"连点多次                    │
│  ③ 网络重试    调通道超时，重试时通道其实已收到              │
│  ④ 主从切换    Redis 主从切换瞬间，限流计数未同步            │
│  ⑤ 回执延迟    通道已发但回执未到，补偿任务误以为失败重发    │
└────────────────────────────────────────────────────────────┘
```

### 8.2 分层幂等

| 层次 | 幂等键 | 实现 |
|------|--------|------|
| 业务请求 | 业务幂等号（如 `bizId+phone`） | 业务层去重 |
| MQ 消费 | `msgId` | Redis SETNX 去重（见 7.3）|
| 通道调用 | 短信平台 `outId` | 平台侧去重（提交时带唯一 outId）|

```
最可靠：通道调用带上唯一 outId，短信平台对相同 outId 只发一次
  → 即使我方重试，平台也会识别为重复而拒发
```

### 8.3 幂等与限流的协同

```
限流（60s/日10条）：面向"用户行为"，防止恶意刷
幂等（msgId/outId）：面向"系统重复"，防止技术故障导致重发

二者互补：限流挡不住 MQ 重投递，幂等挡不住用户连点。
```

---

## 九、多通道路由与故障转移

### 9.1 为什么要多通道

```
单通道的风险：
  ① 通道故障/限流 → 短信全部发不出
  ② 通道运营商跑路/调价 → 被绑定
  ③ 通道被监管关停 → 业务中断
  ④ 单通道并发上限低 → 撑不住大促

→ 必须接入多个通道（阿里云、腾讯云、华为云、梦网、容联云等）
```

### 9.2 路由策略

| 策略 | 说明 | 适用 |
|------|------|------|
| **主备** | 优先主通道，主故障切备 | 简单，但主通道平时闲置浪费 |
| **权重轮询** | 按权重分配流量到各通道 | 平衡负载、压测新通道 |
| **按类型分流** | 验证码走 A、营销走 B | 不同通道擅长的场景不同 |
| **按地域/运营商** | 移动号走移动通道 | 提升到达率、降成本 |
| **最低成本优先** | 同等质量选最便宜 | 降本 |

### 9.3 故障转移（Failover）

```
通道调用失败时的转移流程：

  调通道 A → 失败（超时/返回错误/熔断器打开）
    │
    ├─ 是否可重试错误？
    │    ├─ 否（号码空号/内容违规）→ 直接标记失败，不转移
    │    └─ 是（超时/限流/网络）→ 切换到通道 B 重试
    │
    └─ 记录通道 A 故障次数 → 触发熔断 → 后续请求跳过 A

熔断保护通道：
  对每个通道维护熔断器（见 「熔断详解」）
  A 连续失败 → 熔断 A → 流量自动切到 B/C → A 恢复后探测放回
```

### 9.4 通道质量评分

```
动态评估每个通道的质量，影响路由权重：

  到达率   = 成功送达数 / 提交成功数      （最重要）
  延迟     = 提交到送达的平均耗时
  成本     = 单条价格
  限流率   = 被通道限流的比例

质量评分 = f(到达率, 延迟, 成本, 限流率)
权重随评分动态调整 → 差的通道自动降权，好的通道多分配
```

---

## 十、重试与补偿机制

### 10.1 重试策略

```
重试要解决"瞬时故障"（网络抖动、通道限流），但不能放大问题。

  ① 区分错误类型：
     可重试：超时、5xx、通道限流（429）
     不重试：号码格式错误、内容违规、余额不足

  ② 退避策略：指数退避 + 抖动，避免恢复瞬间被重试打挂
     第1次：1s 后
     第2次：2s 后
     第3次：4s 后
     第3次：8s 后
     +随机抖动 ±20%

  ③ 重试上限：3 次，超过进死信队列人工介入
```

### 10.2 死信队列（DLQ）

```
重试耗尽的消息进入 DLQ：
  - 原因：多次重试失败 / 消息本身有毒（格式错误等）
  - 处理：告警 + 人工排查 + 补发或丢弃
  - 监控：DLQ 堆积量是核心告警指标
```

### 10.3 回执补偿

```
问题：通道"提交成功"≠"送达用户"。可能：
  - 提交成功但实际未送达（号码停机/被拦截）
  - 提交成功但回执丢失

补偿机制：
  ① 短期：依赖通道异步回执（运营商→通道→我方回调）
  ② 兜底：定时任务查询"提交成功但无回执且超时"的消息
            → 主动查询通道接口补全状态
  ③ 超时：超过 N 分钟仍无回执 → 标记"状态未知"，不重发
            （避免幂等失效导致的重发）
```

---

## 十一、安全与合规

短信涉及用户隐私和资费，合规要求严格（尤其国内有《通信短消息服务规定》等法规）。

### 11.1 防刷与风控

| 手段 | 说明 |
|------|------|
| **频次限制** | 60s/日10条（本题核心）+ 业务层更细（如同一 IP 限频）|
| **IP 限频** | 同一 IP 短时间大量请求不同号码 → 疑似撞库/轰炸 |
| **图形/滑块验证码** | 触发风控后要求人机校验 |
| **设备指纹** | 同设备频繁换号 → 可疑 |
| **内容风控** | 敏感词过滤、变量内容审核（防止营销内容违规）|

### 11.2 黑名单管理

```
三类黑名单：
  ① 平台黑名单    用户主动退订的号码（法规要求，必须支持）
  ② 投诉黑名单    多次投诉/举报的号码
  ③ 运营商黑名单  通道侧返回的黑名单号码

发送前统一查黑名单，命中则拒绝（不计费、不发）。
```

### 11.3 签名与模板

```
国内短信强制要求：
  ① 签名：【公司名】或【产品名】，需在通道侧报备审核
  ② 模板：内容必须用审核通过的模板，变量占位
     例：【XX商城】您的验证码是${code}，5分钟内有效。

  ✗ 不能任意发文本内容（会被通道拒绝/封号）
  ✓ 业务方只能选模板 + 填变量
```

### 11.4 营销短信合规

```
法规红线（国内）：
  ① 必须用户明确授权同意接收营销短信
  ② 必须提供退订方式（回 T 退订）
  ③ 发送时间段限制（通常 8:00-21:00，避免扰民）
  ④ 退订用户 24h 内不能再发

→ 系统需支持退订指令处理（回 T、回 TD 等）
```

### 11.5 数据脱敏

```
手机号是个人隐私信息，全链路需脱敏：
  日志：13800138000 → 138****8000
  监控/报表：不展示完整号码
  存储：明细表中号段哈希化处理
```

---

## 十二、监控与告警

短信系统是最容易被业务感知的系统之一（用户收不到验证码 = 登录不了 = 流失），监控必须到位。落地**黄金四信号**（见 「后端服务稳定性建设总览 3 5 可观测性（发现故障的前提）」）：

### 12.1 核心监控指标

| 信号 | 短信系统的具体指标 |
|------|------------------|
| **延迟 Latency** | 接口响应 P99；从入队到发出的端到端延迟；验证码类要求 < 10s |
| **流量 Traffic** | 提交 QPS；分业务类型（验证码/通知/营销）；MQ 堆积量 |
| **错误 Errors** | 限流拒绝率；发送失败率；通道错误率；DLQ 堆积量 |
| **饱和度 Saturation** | Worker 消费滞后；Redis 连接数；通道并发使用率 |

### 12.2 业务特有指标

```
送达率 = 实际送达数 / 提交成功数     （核心质量指标，应 > 95%）
通道到达率 = 各通道单独的到达率      （用于路由权重调整）
到达延迟 = 提交 → 用户收到 的耗时    （验证码场景关键，影响转化）
成本 = 当日累计花费 / 预算           （防超支）
退订率 = 退订数 / 发送数             （营销短信健康度）
```

### 12.3 告警分级

| 级别 | 触发条件 | 动作 |
|------|---------|------|
| P0 电话 | 发送失败率 > 5% 持续 3min；核心通道全挂 | 立即值班 |
| P1 短信 | MQ 堆积 > 10万 持续 5min；送达率 < 90% | 值班跟进 |
| P2 IM | 单通道错误率 > 10%；DLQ 增长异常 | 工作时间处理 |

---

## 十三、成本与容量

### 13.1 成本构成

```
短信是按条收费的，成本敏感：
  ① 通道单价     验证码 0.045/条、营销 0.04/条（各家不同）
  ② 长短信计费   超 70 字按多条计（每 67 字一条）
  ③ 失败重发     重试也计费（即使最终失败，通道可能已扣费）
  ④ 通道保底     部分通道有月度保底消费

降本手段：
  - 多通道比价，按成本动态路由（见 9.2）
  - 控制重试次数，避免无效重发
  - 营销短信精准投放，提升转化（少发但有效）
  - 内容合规，避免被拒产生无效计费
```

### 13.2 容量规划

```
压测要点：
  ① 压通道真实 QPS 上限（通道有限流，超出被拒）
  ② 压 Redis 限流 QPS（瓶颈通常在 Redis）
  ③ 压 Worker 消费速率（决定最大吞吐）

容量评估公式：
  系统最大吞吐 = min(通道总 QPS, Redis 处理能力, Worker 处理能力)

  大促预估：峰值 QPS × 3 倍 buffer = 需要支撑的能力
  → 不足则扩 Worker / 增通道 / 提前预发（错峰发送营销短信）
```

---

## 十四、生产就绪 Checklist

- [x] **并发安全**：compute / Striped / Redis Lua 三选一
- [x] **分布式限流**：Redis 方案
- [x] **内存泄漏**：TTL 过期 / Caffeine 淘汰策略
- [x] **参数校验**：phoneNo 格式、message 长度
- [x] **状态一致性**：发送失败后回滚计数
- [x] **时区明确**：`ZoneId.of("Asia/Shanghai")`
- [x] **线程安全日期**：`java.time.LocalDate` 替代 `SimpleDateFormat`
- [x] **异步削峰**：MQ 解耦 + Worker 消费
- [x] **幂等保证**：msgId / outId 去重
- [x] **多通道路由**：主备/权重/故障转移
- [x] **熔断保护**：通道级熔断（参考 「熔断详解」）
- [x] **重试补偿**：指数退避 + 死信队列 + 回执兜底
- [x] **安全合规**：黑名单、签名模板、退订、脱敏
- [x] **监控告警**：黄金四信号 + 送达率/成本
- [x] **容量规划**：压测出系统最大吞吐

---

## 十五、面试追问速答

| 问题 | 速答要点 |
|------|---------|
| 并发下怎么保证 60s 限制？ | 单机用 `ConcurrentHashMap.compute`（分段锁）；分布式用 Redis Lua 脚本原子执行 check-then-act |
| 多实例部署怎么办？ | 单机 Map 不行，必须用 Redis 集中计数，Lua 保证原子 |
| 为什么用 Lua 不用 Redis 事务？ | WATCH/MULTI 是乐观锁，高并发下冲突重试多；Lua 在 Redis 单线程内原子执行，更可靠 |
| 发送失败怎么回滚计数？ | catch 异常后，单独再发一次命令把计数 -1 / 删除 last key。注意回滚本身也要防并发 |
| 怎么防止用户重复收到验证码？ | MQ 至少一次投递会重复 → 消费端用 msgId 去重（SETNX）；通道调用带 outId 让平台侧也去重 |
| 通道挂了怎么办？ | 多通道路由 + 故障转移：A 失败切 B；对每个通道配熔断器，熔断后自动切走，恢复后探测放回 |
| 怎么削峰？ | 业务请求先写 MQ 立即返回，Worker 按通道能力匀速消费；堆积超阈值扩 Worker |
| 怎么保证短信真的送达？ | 不能只看"提交成功"，要靠异步回执；对超时无回执的做兜底查询；送达率是核心监控指标 |
| 成本怎么控制？ | 多通道比价动态路由；控制重试次数；长短信拆条计费注意；营销精准投放 |
| 营销短信合规要点？ | 用户授权、可退订（回 T）、时段限制（8-21 点）、退订 24h 不再发 |
| 跨天怎么重置日计数？ | 单机：compute 内比较 `lastSendDate`；Redis：key 带日期后缀 + EXPIREAT 到当天结束 |

---

## 十六、延伸阅读

- 「限流详解」 —— 限流算法（固定窗口/滑动窗口/漏桶/令牌桶）
- 「熔断详解」 —— 通道熔断、故障转移
- 「降级详解」 —— Redis 不可用时降级单机限流
- 《通信短消息服务规定》（工信部）—— 国内短信合规依据
- 各通道官方文档：阿里云/腾讯云/华为云短信服务
