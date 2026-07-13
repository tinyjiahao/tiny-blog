---
title: web-access Skill 使用指南：让 AI Agent 操作你的真实浏览器
date: 2026-07-12 19:41:13
description: '「web-access Skill 使用指南」—— 介绍 web-access 适合解决什么问题、什么时候不该用、如何通过本地 CDP Proxy 连接 Chrome/Edge，以及在 Codex 中进行页面读取、点击、截图、文件上传、浏览器历史查询和安全收尾。'
cover: /images/web-access-skill-hero.svg
categories:
  - AI 工程
tags:
  - web-access
  - AI Agent
  - Skills
  - Chrome
  - CDP
---

![web-access Skill 使用指南](/images/web-access-skill-hero.svg)

> **web-access** 不是“再多一个搜索工具”。它解决的是另一类问题：当 Agent 必须使用你的真实浏览器环境，带着登录态打开动态页面、点击按钮、截屏取证、读取浏览器历史或处理反爬页面时，普通网页抓取就不够了。
>
> 换句话说，web-access 是把 Agent 接到 Chrome / Edge 的真实页面上。它让 Agent 不只“读网页”，还可以像一个谨慎的助手那样“看页面、点页面、验证页面”。

**本文脉络：**

- 一、web-access 到底解决什么问题
- 二、什么时候该用，什么时候不要用
- 三、它的工作原理：Codex、CDP Proxy 与真实浏览器
- 四、使用前的预检：先确认浏览器和代理可用
- 五、一次最小可用流程：打开页面、读取、截图、关闭
- 六、常用能力：点击、滚动、上传、提取媒体
- 七、读取浏览器历史和书签
- 八、登录态与账号安全
- 九、站点经验沉淀：site patterns
- 十、常见问题

<!-- more -->

## 一、web-access 到底解决什么问题

普通网页访问分两种：一种是“拿到网页内容”，一种是“真的在浏览器里看到页面”。

前者适合搜索公开资料、读取文档、抓一段 HTML、请求一个 JSON 接口。后者就复杂了：页面可能需要登录，内容可能由 JavaScript 动态渲染，站点可能对脚本请求很敏感，按钮点击后还会触发一串前端状态变化。

web-access 主要处理第二类问题。

典型场景包括：

| 场景 | 为什么普通抓取不够 |
| --- | --- |
| 登录态页面 | `curl` 没有你的浏览器 Cookie 和会话状态 |
| 私有系统 / 内网页面 | 公网搜索搜不到，接口也未必能直接访问 |
| 动态渲染页面 | 首屏 HTML 里没有真正内容，要等前端加载 |
| 反爬或风控较强的站点 | 直接 HTTP 请求容易拿到空内容、验证码或错误页 |
| 页面 UI 操作 | 需要点击、输入、上传文件、切换标签、滚动 |
| 截图和视频帧 | 结果是视觉状态，不是纯文本 |
| 浏览器历史 / 书签 | 信息在本地浏览器 profile 里，不在网页上 |

如果你让 Agent “帮我看一下我刚打开的后台页面里这个报错是什么”，这时 web-access 就很合适。因为问题的答案不在公开互联网，而在你当前浏览器能看到的真实页面里。

## 二、什么时候该用，什么时候不要用

web-access 很强，但它不是默认选择。越贴近真实浏览器，权限越大，成本也越高。正确做法是先选最轻的可靠路径。

![什么时候使用 web-access](/images/web-access-routing.svg)

可以按这个顺序判断：

| 需求 | 优先选择 |
| --- | --- |
| 查公开的最新事实、新闻、价格、官方文档 | Codex 内置 `web.run` |
| 已知 URL，读取原始 HTML、元数据、JSON-LD 或简单 API | `curl` 或 `web.run.open` |
| 文章页只需要抽取正文 Markdown | 必要时用 Jina Reader |
| 本地开发页面预览，比如 `localhost:4000` | Codex Browser 插件 |
| 需要登录态、动态页面、反爬页面、浏览器历史、截图、UI 操作 | web-access |

这张表背后的原则很简单：**能不用真实浏览器，就先不用真实浏览器；必须像用户本人一样打开页面时，再用 web-access。**

比如查询“OpenAI 最新模型文档”，不该上 web-access，应该直接查官方文档。因为公开资料用搜索和官方页面更稳，也更容易引用来源。

但如果你说“我在公司后台看到一个订单详情页，帮我点开异常日志并截图”，那就不是搜索问题了。Agent 需要使用你浏览器里的登录态和真实 UI，这才是 web-access 的主场。

## 三、它的工作原理：Codex、CDP Proxy 与真实浏览器

web-access 在 Codex 里的核心机制是一个本地 CDP Proxy。

CDP 是 Chrome DevTools Protocol，也就是 Chrome / Edge 暴露给开发者工具的一套浏览器控制协议。web-access 在本机启动一个代理服务，Codex 通过 HTTP 请求这个代理，代理再去控制真实浏览器。

整体链路是这样：

![web-access CDP 调用链路](/images/web-access-cdp-flow.svg)

默认代理地址是：

```bash
http://127.0.0.1:3456
```

这意味着它不是把任务交给一个无状态的云端浏览器，而是操作你本机的 Chrome、Edge 或 Chromium。好处是明显的：你的登录态、浏览器扩展、页面渲染环境、历史记录都在。

但这也带来一个要求：使用前必须做预检，确认浏览器支持远程调试，代理能正常连上。

## 四、使用前的预检：先确认浏览器和代理可用

在 Codex 中使用 web-access 前，先设置 skill 目录：

```bash
SKILL_DIR="$HOME/.codex/skills/web-access"
```

然后跑预检脚本：

```bash
node "$SKILL_DIR/scripts/check-deps.mjs"
```

这个脚本会检查 Node 版本、浏览器状态、远程调试开关和本地代理。

常见结果有三种：

| 退出码 | 含义 | 处理方式 |
| --- | --- | --- |
| `0` | 代理可用 | 可以继续调用 CDP API |
| `2` | 浏览器选择不明确，或没有保存偏好 | 指定 `--browser chrome` / `--browser edge`，或写入配置 |
| `1` | 环境不满足 | 按输出提示打开浏览器、启用远程调试或修复依赖 |

如果机器上同时有 Chrome 和 Edge，可以临时指定浏览器：

```bash
node "$SKILL_DIR/scripts/check-deps.mjs" --browser chrome
```

也可以把偏好写进配置：

```bash
WEB_ACCESS_BROWSER=chrome
```

如果切换浏览器，建议先停掉旧的代理进程：

```bash
pkill -f cdp-proxy.mjs
```

远程调试开关通常在浏览器的 inspect 页面：

| 浏览器 | 页面 |
| --- | --- |
| Chrome | `chrome://inspect/#remote-debugging` |
| Edge | `edge://inspect/#remote-debugging` |

这里最容易踩的坑是：浏览器没开、远程调试没开、或者开的是另一个浏览器。预检脚本的价值就在于先把这些低级问题排掉，免得后面误判成“网站打不开”。

## 五、一次最小可用流程：打开页面、读取、截图、关闭

预检通过后，可以先看代理健康状态：

```bash
curl -s http://127.0.0.1:3456/health
```

再列出当前浏览器目标：

```bash
curl -s http://127.0.0.1:3456/targets
```

打开一个新页面：

```bash
curl -s -X POST \
  --data-raw 'https://example.com' \
  http://127.0.0.1:3456/new
```

注意这里有个细节：`/new` 的目标 URL 放在 POST body 里，不是老式的 `GET /new?url=...`。如果你在旧笔记里看到 `?url=` 写法，应该改掉。

拿到 `target` 之后，可以读取页面信息：

```bash
curl -s "http://127.0.0.1:3456/info?target=TARGET_ID"
```

也可以在页面上下文里执行一段 JavaScript：

```bash
curl -s -X POST \
  "http://127.0.0.1:3456/eval?target=TARGET_ID" \
  -d 'document.title'
```

如果要截屏：

```bash
curl -s \
  "http://127.0.0.1:3456/screenshot?target=TARGET_ID&file=/tmp/web-access-shot.png"
```

最后关闭自己打开的页面：

```bash
curl -s "http://127.0.0.1:3456/close?target=TARGET_ID"
```

这里要强调“自己打开的页面”。不要随手关闭用户原本已经打开的标签页。web-access 能操作真实浏览器，所以边界感很重要。

## 六、常用能力：点击、滚动、上传、提取媒体

真正有用的场景，通常不是只读取标题，而是要和页面互动。

点击按钮可以用 CSS selector：

```bash
curl -s -X POST \
  "http://127.0.0.1:3456/click?target=TARGET_ID" \
  -d 'button.submit'
```

如果普通点击不稳定，也可以用 `clickAt` 让代理根据元素位置点击：

```bash
curl -s -X POST \
  "http://127.0.0.1:3456/clickAt?target=TARGET_ID" \
  -d 'button.upload'
```

滚动页面：

```bash
curl -s \
  "http://127.0.0.1:3456/scroll?target=TARGET_ID&direction=bottom"
```

上传文件：

```bash
curl -s -X POST \
  "http://127.0.0.1:3456/setFiles?target=TARGET_ID" \
  -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'
```

遇到陌生页面时，不要直接猜 selector。先把可交互元素扫出来：

```bash
curl -s -X POST \
  "http://127.0.0.1:3456/eval?target=TARGET_ID" \
  -d '(() => [...document.querySelectorAll("a,button,input,textarea,select")].slice(0,80).map((el,i)=>({i,tag:el.tagName,text:(el.innerText||el.value||el.ariaLabel||el.placeholder||"").trim().slice(0,120),href:el.href||null,type:el.type||null})))()'
```

这段代码的作用是列出页面前 80 个链接、按钮、输入框和下拉框。它不优雅，但很好用。Agent 可以根据输出判断哪个按钮是真正要点的，避免在页面上乱试。

提取媒体也适合用 `eval`。比如找页面里的图片：

```bash
curl -s -X POST \
  "http://127.0.0.1:3456/eval?target=TARGET_ID" \
  -d '(() => [...document.images].map(img => ({src: img.currentSrc || img.src, alt: img.alt, width: img.naturalWidth, height: img.naturalHeight})))()'
```

如果目标是视频帧、Canvas 或视觉排版，截图通常比 DOM 文本更可靠。很多页面“数据在 DOM 里”和“用户实际看到的样子”并不一致，尤其是图表、弹窗、验证码、复杂后台系统。

## 七、读取浏览器历史和书签

web-access 还有一个很实用的能力：查本地浏览器历史和书签。

这适合用户说不清 URL，但描述得出页面的情况。比如：

> 我上周打开过一个关于 MCP 调试的页面，帮我找一下。

可以这样查：

```bash
SKILL_DIR="$HOME/.codex/skills/web-access"
node "$SKILL_DIR/scripts/find-url.mjs" MCP 调试 --browser chrome --limit 10 --since 7d
```

只查书签：

```bash
node "$SKILL_DIR/scripts/find-url.mjs" Codex --only bookmarks --browser chrome --limit 20
```

按最近访问排序：

```bash
node "$SKILL_DIR/scripts/find-url.mjs" dashboard --only history --browser chrome --sort recent
```

这类能力要克制使用。浏览器历史属于用户本地隐私数据，只有当用户的问题明确依赖“我以前访问过的页面”“我收藏过的地址”“公司内部系统入口”时，才应该查。

## 八、登录态与账号安全

web-access 最大的优势是能使用你的真实登录态，但这也是最大的风险点。

在操作用户账号之前，应该先提醒一句：

```text
温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。
```

这不是走形式。真实浏览器自动化有几个风险：

| 风险 | 说明 |
| --- | --- |
| 账号风控 | 一些站点会检测自动化点击、频繁访问、异常滚动 |
| 误操作 | Agent 可能点到提交、删除、付款、发布等高风险按钮 |
| 隐私暴露 | 页面里可能有手机号、地址、订单、公司内部数据 |
| 状态污染 | 测试点击可能改变筛选条件、草稿内容或后台配置 |

实际使用时建议遵守几条规则：

- 先读页面，再决定是否操作。
- 点击前确认按钮含义，尤其是“提交、删除、支付、发布、授权”这类动作。
- 能截图核对就截图，别只看一段 DOM 文本。
- 只关闭自己新开的标签页，不动用户原本的页面。
- 不向用户索要密码、验证码、Cookie、Token。
- 如果页面要求登录，让用户自己在浏览器里完成登录，然后再继续。

如果页面当前未登录，可以这样提示：

```text
当前页面在未登录状态下无法获取订单详情，请在你的浏览器中登录该系统，完成后告诉我继续。
```

边界很清楚：Agent 可以等用户登录后的页面状态，但不应该接触用户凭证。

## 九、站点经验沉淀：site patterns

很多站点的页面结构很稳定。第一次摸清楚后，下一次就不应该重新踩坑。

web-access 支持把站点经验写到：

```bash
$HOME/.codex/skills/web-access/references/site-patterns/{domain}.md
```

一个 site pattern 通常记录三类信息：

| 模块 | 写什么 |
| --- | --- |
| Platform Facts | 登录、渲染、反爬、加载方式等已验证事实 |
| Working Patterns | 可用 URL 模式、selector、导航路径、提取脚本 |
| Pitfalls | 哪些方法失败过，为什么失败 |

示例结构：

```markdown
---
domain: example.com
aliases: [Example]
updated: 2026-07-12
---

## Platform Facts

页面主要由前端渲染，列表数据在滚动后才加载。

## Working Patterns

订单详情入口可以通过 `a[href*="/orders/"]` 提取。

## Pitfalls

直接请求 HTML 只能拿到空壳，必须走真实浏览器。
```

这里要注意：site pattern 是经验，不是事实本身。站点随时可能改版，所以每次仍然要以当前页面证据为准。如果旧经验失效，就更新它。

## 十、常见问题

| 问题 | 回答要点 |
| --- | --- |
| web-access 和 `web.run` 有什么区别？ | `web.run` 适合公开网页检索和资料引用；web-access 适合需要真实浏览器、登录态、动态渲染和 UI 操作的任务。 |
| 为什么不默认所有网页都用 web-access？ | 成本更高、权限更大、风险更高。公开资料用搜索和官方文档更稳，只有需要浏览器上下文时才用 web-access。 |
| `/new` 为什么要用 POST body？ | 当前版本要求 URL 放在 POST body 中，旧的 `GET /new?url=...` 写法容易失效，也可能破坏带 `?`、`&`、`#` 的复杂 URL。 |
| 可以让 Agent 帮我登录吗？ | 不应该。Agent 不应索要或处理密码、验证码、Cookie、Token。需要登录时，由用户在浏览器里完成。 |
| 能不能操作后台系统？ | 可以，但要谨慎。读取和截图风险较低；提交、删除、发布、付款、授权等动作必须额外确认。 |
| 为什么页面 DOM 里有内容，但截图看不到？ | 可能是元素隐藏、被遮罩、虚拟列表、响应式布局或前端状态不同。遇到视觉问题时，以截图为准。 |
| 什么时候需要写 site pattern？ | 当一个站点会反复访问，且你已经验证了可靠的 selector、URL 模式或避坑经验时，就值得沉淀。 |

最后记住一句话：**web-access 的价值不是“帮 Agent 上网”，而是“让 Agent 在必要时使用用户真实浏览器完成证据驱动的操作”。**

用得好，它能补上普通抓取和真实页面之间的断层；用得太随意，它也会把 Agent 带进账号风险和误操作风险里。把这个边界守住，web-access 就会非常好用。
