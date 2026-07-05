---
title: MCP Server 实战：给 AI Agent 接入一个只读数据库工具
date: 2026-07-05 17:45:00
description: '「MCP Server 实战：给 AI Agent 接入一个只读数据库工具」—— 从为什么不能让 Agent 直接连库讲起，用 TypeScript、MCP SDK 和 mysql2 实现一个本地 stdio MCP Server，暴露表结构查看与只读 SQL 查询工具，并补齐账号权限、SQL 校验、超时、行数限制和审计日志等安全护栏。'
categories:
  - AI 工程
tags:
  - MCP
  - AI Agent
  - 数据库
  - MySQL
  - 工具调用
---

> 上一篇文章讲了 MCP 的协议定位：它让 AI 应用能用统一方式连接外部工具和上下文。但真正落地时，最常见的问题不是“协议怎么定义”，而是“我到底该把什么能力接给 Agent”。
>
> 数据库是一个很好的起点。它足够真实，能明显提升 Agent 的分析能力；同时也足够危险，稍不注意就会把生产数据、写权限、慢查询和敏感信息一起暴露出去。本文用一个只读数据库 MCP Server，把“能用”和“安全”放在同一个示例里讲清楚。

**本文脉络：**

- 一、为什么先做只读数据库工具
- 二、目标架构：Host、MCP Server、MySQL 怎么配合
- 三、准备一个只读数据库账号
- 四、初始化 TypeScript MCP Server 项目
- 五、实现两个工具：查看表结构与只读查询
- 六、在 AI Agent 中配置 stdio MCP Server
- 七、实际对话效果：Agent 怎么用这个工具
- 八、安全护栏：不要只靠“提示词禁止写库”
- 九、从本地 stdio 进阶到远程服务
- 十、常见问题

<!-- more -->

## 一、为什么先做只读数据库工具

AI Agent 想分析业务问题，最缺的往往不是推理能力，而是真实上下文。

比如你问：

> 最近订单支付成功率为什么下降了？

如果 Agent 只能靠聊天上下文，它最多给你一套排查思路：

- 看支付渠道是否异常
- 看失败码分布
- 看最近是否发布了支付链路改动
- 看不同端、不同地区、不同渠道的差异

这些建议没有错，但它并不知道你系统里的真实数据。真正有用的回答，通常需要它能查到：

| 数据 | 例子 |
| --- | --- |
| 表结构 | `orders`、`payments`、`payment_channels` 有哪些字段 |
| 指标数据 | 最近 24 小时支付成功率、失败码 Top N |
| 分组维度 | 按渠道、端类型、地区、版本号拆分 |
| 时间窗口 | 异常开始前后数据对比 |

这就是数据库 MCP Server 的价值：把数据库变成 Agent 可发现、可调用、可审计的工具。

但数据库又是高风险系统。最危险的做法是把数据库连接串直接丢给 Agent，然后在提示词里写一句“只能查询，不能修改”。这不够，因为模型不是权限系统，提示词也不是安全边界。

所以本文从一开始就限定目标：

```
只做只读
只接本地 stdio
只暴露少量工具
只允许有限 SQL
只返回有限行数
```

这个边界很克制，但足以跑通一个真实可用的闭环。

## 二、目标架构：Host、MCP Server、MySQL 怎么配合

这次要做的不是让模型直接连接 MySQL，而是让 AI 应用通过 MCP Server 间接访问数据库：

![只读数据库 MCP Server 架构](/images/mcp-readonly-db-architecture.svg)

换成一次真实调用来看，链路会更清楚：

![一次 MCP 数据库查询调用链](/images/mcp-readonly-db-call-flow.svg)

这里有三个关键点：

| 层次 | 责任 |
| --- | --- |
| MCP Host | 决定何时把工具暴露给模型，是否需要用户确认 |
| MCP Server | 暴露受控工具，校验参数，执行查询，返回结构化结果 |
| MySQL | 用数据库账号权限兜底，确保即使 Server 写错也不能写库 |

也就是说，安全不是某一层单独完成的，而是多层叠加：

![数据库 MCP 工具的安全边界层级](/images/mcp-readonly-db-security-boundary.svg)

越靠右，越像真正的安全边界。

## 三、准备一个只读数据库账号

先在 MySQL 里创建一个专用账号。不要复用应用的主账号，也不要给 `INSERT`、`UPDATE`、`DELETE` 权限。

假设业务库叫 `shop`：

```sql
CREATE USER 'mcp_reader'@'%' IDENTIFIED BY 'replace-with-strong-password';

GRANT SELECT, SHOW VIEW
ON shop.*
TO 'mcp_reader'@'%';

FLUSH PRIVILEGES;
```

如果是生产环境，建议再收紧：

| 项目 | 建议 |
| --- | --- |
| 网络来源 | 只允许 MCP Server 所在机器或内网网段访问 |
| 数据库范围 | 只授权必要库，不要 `*.*` |
| 表范围 | 敏感表单独排除，必要时只建脱敏视图 |
| 字段范围 | 身份证、手机号、邮箱、地址等字段不要直接暴露 |
| 查询资源 | 配置 MySQL 侧超时、连接数、只读副本 |

权限这一步很重要。后面代码里还会做 SQL 校验，但那只是第二层防护。真正的底线是：即使 MCP Server 有 bug，这个账号也不能写库。

## 四、初始化 TypeScript MCP Server 项目

新建一个独立项目，不要放进博客仓库，也不要和业务应用混在一起：

```bash
mkdir readonly-db-mcp-server
cd readonly-db-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk@^1 mysql2 zod
npm install -D typescript tsx @types/node
mkdir src
touch src/index.ts tsconfig.json .env.example
```

截至 2026-07-05，`@modelcontextprotocol/sdk` 的稳定版本仍是 v1 主版本。npm 上也能看到 `@modelcontextprotocol/server` v2 beta 包，但本文为了让示例更稳定，使用官方稳定 SDK 包。

`package.json` 可以改成这样：

```json
{
  "name": "readonly-db-mcp-server",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "mysql2": "^3.11.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.6.0"
  }
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

`.env.example`：

```bash
DATABASE_URL=mysql://mcp_reader:replace-with-strong-password@127.0.0.1:3306/shop
QUERY_TIMEOUT_MS=5000
MAX_ROWS=100
```

注意：stdio MCP Server 的日志不要随便写到标准输出。标准输出是 MCP 协议消息通道，业务日志建议写到标准错误，避免污染 JSON-RPC 消息。

## 五、实现两个工具：查看表结构与只读查询

这次只暴露两个 tool：

| Tool | 作用 | 风险 |
| --- | --- | --- |
| `describe_table` | 查看某张表的字段结构 | 较低 |
| `query_readonly_database` | 执行只读 SQL | 较高，需要严格限制 |

两个工具的分工可以理解成“先认路，再行动”：

![MCP 数据库工具调用决策流程](/images/mcp-readonly-db-tool-flow.svg)

完整代码如下。

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mysql from "mysql2/promise";
import * as z from "zod/v4";

const databaseUrl = process.env.DATABASE_URL;
const maxRows = Number(process.env.MAX_ROWS ?? "100");
const queryTimeoutMs = Number(process.env.QUERY_TIMEOUT_MS ?? "5000");

if (!databaseUrl) {
  throw new Error("Missing DATABASE_URL");
}

const pool = mysql.createPool({
  uri: databaseUrl,
  waitForConnections: true,
  connectionLimit: 4,
  maxIdle: 2,
  idleTimeout: 30_000,
  enableKeepAlive: true
});

const server = new McpServer({
  name: "readonly-db-mcp-server",
  version: "1.0.0"
});

function removeSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .trim();
}

function assertSafeIdentifier(identifier: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
    throw new Error("Only letters, numbers, and underscore are allowed");
  }

  return identifier;
}

function assertReadOnlySql(sql: string): string {
  const normalized = removeSqlComments(sql);

  if (!/^(select|show|describe|desc|explain)\b/i.test(normalized)) {
    throw new Error("Only SELECT, SHOW, DESCRIBE, DESC, and EXPLAIN are allowed");
  }

  if (normalized.includes(";")) {
    throw new Error("Multiple statements are not allowed");
  }

  const forbiddenPattern =
    /\b(insert|update|delete|replace|drop|alter|create|truncate|grant|revoke|call|set|load|outfile|infile|lock|unlock)\b/i;

  if (forbiddenPattern.test(normalized)) {
    throw new Error("Write or administrative SQL keywords are not allowed");
  }

  return normalized;
}

function withLimit(sql: string, limit: number): string {
  if (/\blimit\s+\d+/i.test(sql)) {
    return sql;
  }

  return `${sql} LIMIT ${limit}`;
}

async function runReadOnlyQuery(sql: string, params: unknown[] = []) {
  const connection = await pool.getConnection();

  try {
    await connection.query(`SET SESSION max_execution_time = ${queryTimeoutMs}`);
    const [rows] = await connection.query({
      sql,
      values: params,
      timeout: queryTimeoutMs
    });

    return rows;
  } finally {
    connection.release();
  }
}

server.registerTool(
  "describe_table",
  {
    title: "Describe table",
    description: "Read column metadata for one table in the configured database.",
    inputSchema: {
      table: z.string().min(1).max(64).describe("Table name, without database prefix")
    }
  },
  async ({ table }) => {
    const safeTable = assertSafeIdentifier(table);
    const rows = await runReadOnlyQuery(`DESCRIBE \`${safeTable}\``);

    console.error(
      JSON.stringify({
        event: "mcp_db_describe_table",
        table: safeTable,
        at: new Date().toISOString()
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(rows, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "query_readonly_database",
  {
    title: "Query read-only database",
    description:
      "Execute a read-only SQL query against the configured database. Use this for analytics and troubleshooting only.",
    inputSchema: {
      sql: z.string().min(1).max(4000).describe("A single read-only SQL statement"),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
      limit: z.number().int().min(1).max(maxRows).optional()
    }
  },
  async ({ sql, params = [], limit = maxRows }) => {
    const checkedSql = assertReadOnlySql(sql);
    const limitedSql = withLimit(checkedSql, limit);
    const rows = await runReadOnlyQuery(limitedSql, params);

    console.error(
      JSON.stringify({
        event: "mcp_db_query",
        sql: limitedSql,
        rowCount: Array.isArray(rows) ? rows.length : 0,
        at: new Date().toISOString()
      })
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sql: limitedSql,
              rows
            },
            null,
            2
          )
        }
      ]
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("readonly-db-mcp-server is running");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
```

这个 Server 做了几件事：

| 机制 | 作用 |
| --- | --- |
| `registerTool` | 向 MCP Host 暴露工具名称、描述、输入参数和处理函数 |
| `zod` schema | 校验模型传入的参数格式 |
| `assertReadOnlySql` | 限制 SQL 类型，拒绝写操作和多语句 |
| `withLimit` | 防止模型一次查出过多数据 |
| `max_execution_time` | 限制 MySQL 查询执行时间 |
| `console.error` | 把审计日志写到 stderr，避免污染 stdio 协议 |

这里有一个细节：`describe_table` 不让模型拼 `DESCRIBE ${table}`，而是先检查表名只包含字母、数字和下划线，再加反引号。这是为了避免把表名参数变成注入入口。

## 六、在 AI Agent 中配置 stdio MCP Server

先构建项目：

```bash
npm run build
```

然后在支持 MCP 的 AI 应用中添加本地 stdio Server。不同 Host 的配置文件位置不一样，但形态大致类似：

```json
{
  "mcpServers": {
    "readonly-db": {
      "command": "node",
      "args": ["/absolute/path/to/readonly-db-mcp-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "mysql://mcp_reader:replace-with-strong-password@127.0.0.1:3306/shop",
        "QUERY_TIMEOUT_MS": "5000",
        "MAX_ROWS": "100"
      }
    }
  }
}
```

如果开发阶段想直接用 `tsx` 跑，也可以：

```json
{
  "mcpServers": {
    "readonly-db": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/readonly-db-mcp-server/src/index.ts"],
      "env": {
        "DATABASE_URL": "mysql://mcp_reader:replace-with-strong-password@127.0.0.1:3306/shop"
      }
    }
  }
}
```

生产或长期使用时，建议用 `npm run build` 后的 `dist/index.js`，依赖版本也要锁住。

## 七、实际对话效果：Agent 怎么用这个工具

配置好以后，可以这样问 Agent：

```text
帮我看一下最近 24 小时支付失败最多的错误码，按错误码统计数量。
```

一个比较理想的过程是：

```text
1. Agent 先调用 describe_table，查看 payments 表结构
2. 发现有 status、error_code、created_at 等字段
3. 调用 query_readonly_database，执行聚合 SQL
4. 拿到结果后解释 Top 错误码及占比
5. 如果需要，再按渠道或端类型继续拆分
```

把这次对话展开成时序图，大概是这样：

![Agent 通过 MCP 查询数据库的时序图](/images/mcp-readonly-db-sequence.svg)

可能生成的 SQL 类似：

```sql
SELECT
  error_code,
  COUNT(*) AS failed_count
FROM payments
WHERE status = 'FAILED'
  AND created_at >= NOW() - INTERVAL 24 HOUR
GROUP BY error_code
ORDER BY failed_count DESC
LIMIT 20
```

这时 Agent 的回答就不再是泛泛建议，而是基于真实查询结果：

```text
最近 24 小时支付失败主要集中在三个错误码：

1. CHANNEL_TIMEOUT：占失败请求的 43.2%，主要来自 wxpay
2. INSUFFICIENT_BALANCE：占 18.5%，属于正常业务失败
3. SIGN_INVALID：占 12.7%，从 14:20 开始明显上升

建议优先排查 14:20 左右 wxpay 渠道签名配置或网关发布记录。
```

这就是 MCP 工具的体验变化：模型不是“猜一个排查方向”，而是“先查上下文，再做判断”。

## 八、安全护栏：不要只靠“提示词禁止写库”

数据库 MCP Server 最大的坑，是把“只读”写在工具描述里，然后以为安全了。

工具描述当然有用，它会影响模型选择工具和构造参数。但它不是权限系统，不能作为唯一防线。

建议至少做五层限制：

| 层次 | 做法 |
| --- | --- |
| 数据库账号 | 专用只读账号，只授 `SELECT` 和必要的 `SHOW VIEW` |
| 网络边界 | 只允许内网或本机访问数据库，不暴露公网 |
| SQL 校验 | 只允许单条 `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` |
| 资源限制 | 限制 `LIMIT`、超时时间、连接数、结果大小 |
| 审计日志 | 记录 SQL、时间、行数、调用来源，方便追踪 |

可以把这五层看成一条“逐层拦截”的流水线：

![只读数据库工具的安全校验流水线](/images/mcp-readonly-db-safety-pipeline.svg)

如果要上生产，还应该继续加：

- 只连只读副本，不连主库
- 敏感表只提供脱敏视图
- 对大表强制要求时间范围
- 禁止 `SELECT *`
- 对返回结果做字段级脱敏
- 给慢查询、错误率、调用次数加监控告警

尤其要注意，SQL 关键字正则只能做基础拦截，不能代替数据库权限和 SQL parser。更稳的生产方案是：

```text
模型生成 SQL
  ↓
SQL parser 解析 AST
  ↓
校验只包含允许的语句类型、表、字段、函数
  ↓
改写并强制追加 LIMIT / 时间范围
  ↓
用只读账号在只读副本执行
```

这比“看起来像 SELECT 就放行”可靠得多。

## 九、从本地 stdio 进阶到远程服务

本文用的是 stdio，因为它最适合本地开发和个人工具：

| 传输方式 | 适合场景 |
| --- | --- |
| stdio | 本机开发工具、个人数据库、只给一个 Host 使用 |
| Streamable HTTP | 团队共享工具、远程服务、需要鉴权和审计的平台 |

如果要把这个工具提供给团队使用，下一步通常不是“把 stdio 暴露出去”，而是改成 Streamable HTTP，并补上：

- OAuth 或内部 SSO
- 用户身份透传
- 租户和权限隔离
- 查询审计后台
- 限流和配额
- 多实例部署
- 统一网关和 TLS

这时 MCP Server 就从“本地小工具”变成了“企业内部 AI 工具平台的一部分”。

不过不要一开始就把事情做重。一个可靠的演进路径是：

![只读数据库 MCP Server 的演进路径](/images/mcp-readonly-db-evolution-path.svg)

对应到架构形态，可以分成两个阶段：

![数据库 MCP Server 从本地到团队平台的架构演进](/images/mcp-readonly-db-deployment-stages.svg)

每一步都先确认工具真的有价值，再增加复杂度。

## 十、常见问题

### 1. 为什么不用 Function Calling 直接调数据库？

Function Calling 解决的是“模型怎么调用某个函数”的问题，MCP 解决的是“AI 应用怎么标准化发现、连接和调用外部能力”的问题。

如果只有一个应用、一个函数，Function Calling 足够。如果希望多个 Agent、多个客户端复用同一个数据库工具，MCP 更合适。

### 2. 能不能让 Agent 自己写任意 SQL？

开发库可以放宽一些，生产库不建议。更稳的方式是限制可查询表、字段和时间范围，并用 SQL parser 做结构化校验。

如果业务问题比较固定，也可以不开放自由 SQL，而是暴露更窄的工具，例如：

```text
get_payment_error_summary
get_order_count_by_status
get_user_growth_by_day
```

工具越窄，灵活性越低，但安全性和稳定性越高。

### 3. 为什么要提供 `describe_table`？

因为 Agent 不知道你的表结构。没有表结构时，它很容易编造字段名。

`describe_table` 给它一个低风险入口：先读 schema，再生成 SQL。后续也可以增加 `list_tables`、`get_table_indexes`、`get_column_stats` 等只读工具。

### 4. 这个示例能直接上生产吗？

不建议直接上生产。它适合作为本地和测试环境的起点。

生产环境至少要补齐：

- SQL parser 级别校验
- 表和字段白名单
- 敏感字段脱敏
- 查询成本控制
- 审计日志落库
- 监控告警
- 用户身份和权限体系

## 参考资料

- [Model Context Protocol Documentation](https://modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
