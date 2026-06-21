---
title: 在 Cloudflare Pages 上部署 Hexo 博客全记录
date: 2026-06-21
categories:
  - 建站
tags:
  - Hexo
  - Cloudflare Pages
  - NexT
  - 部署
---

本文记录从零搭建 Hexo 博客并部署到 Cloudflare Pages 的完整过程，包含踩坑记录和最终可用配置。

<!-- more -->

## 一、技术选型

| 组件 | 选择 | 理由 |
| --- | --- | --- |
| 静态站点生成器 | [Hexo](https://hexo.io/) | 生态成熟，中文友好 |
| 主题 | [NexT.Gemini](https://theme-next.js.org/) | 简洁、功能丰富、维护活跃 |
| 托管平台 | [Cloudflare Pages](https://pages.cloudflare.com/) | 免费、全球 CDN、自定义域名含 SSL |

---

## 二、本地初始化

```bash
npm install -g hexo-cli
hexo init tiny-blog
cd tiny-blog
npm install

# 安装 NexT 主题
npm install hexo-theme-next
```

`_config.yml` 指定主题：

```yaml
theme: next
```

新建 `_config.next.yml` 覆盖主题配置（Hexo 5+ 支持独立主题配置文件，不修改 node_modules 内文件）。

---

## 三、功能配置

### 3.1 本地搜索

```bash
npm install hexo-generator-searchdb
```

`_config.yml`：

```yaml
search:
  path: search.xml
  field: post
  content: true
  format: striptags   # 去除 HTML 标签，搜索更准确
```

`_config.next.yml`：

```yaml
local_search:
  enable: true
  trigger: auto
  top_n_per_article: 3
  unescape: false
  preload: false
```

> `format: striptags` 比 `html` 更干净，避免搜索结果中夹杂 HTML 标签。

### 3.2 RSS 订阅

```bash
npm install hexo-generator-feed
```

`_config.yml`：

```yaml
feed:
  enable: true
  type: atom
  path: atom.xml
  limit: 20
```

### 3.3 深色模式手动切换

NexT 的 `darkmode` 默认跟随系统，但无法手动切换。通过自定义 CSS + 注入脚本实现：

**`source/_data/styles.styl`** — 定义深色变量和过渡动画：

```stylus
:root {
  --bg-color: #fff;
  --text-color: #333;
  /* ... 其他变量 */
}

[data-theme="dark"] {
  --bg-color: #1a1a2e;
  --text-color: #e0e0e0;
  /* ... */
}

body {
  transition: background-color 0.3s, color 0.3s;
}
```

**`source/_data/body-end.njk`** — 在 `</body>` 前注入切换按钮和逻辑：

```html
<button id="theme-toggle" aria-label="切换深色模式">🌙</button>
<script>
  const btn = document.getElementById('theme-toggle');
  const apply = (dark) => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    btn.textContent = dark ? '☀️' : '🌙';
  };
  // 优先读 localStorage，其次跟随系统
  const stored = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  apply(stored ? stored === 'dark' : prefersDark);
  btn.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    localStorage.setItem('theme', isDark ? 'light' : 'dark');
    apply(!isDark);
  });
</script>
```

### 3.4 中文界面 & 站点信息

`_config.yml`：

```yaml
language: zh-CN
author: 小加号笔记
```

### 3.5 社交链接

`_config.next.yml`：

```yaml
social:
  GitHub: https://github.com/<your-name> || fab fa-github
  E-Mail: mailto:your@email.com || fa fa-envelope
  RSS: /atom.xml || fa fa-rss
```

---

## 四、部署到 Cloudflare Pages

### 4.1 推送到 GitHub

```bash
git remote add origin git@github.com:<your-name>/tiny-blog.git
git branch -M main
git push -u origin main
```

### 4.2 创建 Pages 项目

1. Cloudflare Dashboard → **Workers & Pages** → **创建** → **Pages** → **连接到 Git**
2. 授权并选中仓库

### 4.3 构建配置

| 配置项 | 值 |
| --- | --- |
| **Framework preset** | `None` |
| **Build command** | `npm install --no-fund --no-audit && npx hexo generate` |
| **Build output directory** | `public` |
| **Root directory** | （留空） |

### 4.4 环境变量

在 **Settings → Variables and Secrets** 中添加：

| 变量名 | 值 | 说明 |
| --- | --- | --- |
| `NODE_VERSION` | `22` | 指定 Node 版本，与本地一致 |

---

## 五、踩坑：npm ci "Exit handler never called!" Bug

### 问题现象

Cloudflare Pages 构建日志报错：

```
npm error Exit handler never called!
npm error This is an error with npm itself. Please report this issue at:
npm error   https://github.com/npm/cli/issues
```

构建失败，无法部署。

### 根因

Cloudflare Pages 检测到仓库中存在 `package-lock.json` 时，会**自动执行 `npm ci`** 而非 `npm install`。
`npm ci` 在 **Node 22 + npm 10.x** 组合下存在已知 bug（[npm/cli#8404](https://github.com/npm/cli/issues/8404)），会触发上述错误。

### 排查过程

**尝试一：重新生成 package-lock.json + 添加 engines 字段**

```bash
rm package-lock.json && npm install
```

同时在 `package.json` 添加：

```json
"engines": { "node": ">=18" }
```

结果：仍然失败。`npm ci` 本身有 bug，版本声明无法绕过。

**尝试二：添加 `build:ci` 脚本，设置 `SKIP_DEPENDENCIES_INSTALL=true`**

在 `package.json` 添加：

```json
"scripts": {
  "build:ci": "npm install && hexo generate"
}
```

Build command 改为 `npm run build:ci`，并设置环境变量 `SKIP_DEPENDENCIES_INSTALL=true` 跳过 Cloudflare 的自动安装步骤。

结果：仍然失败。Cloudflare 的环境变量文档不明确，行为不一致。

**最终方案：将 `package-lock.json` 加入 `.gitignore`**

```gitignore
package-lock.json
```

不提交 lockfile → Cloudflare 检测不到 lockfile → 不触发 `npm ci` → 回退到 `npm install` → 构建成功。

Build command 最终定为：

```
npm install --no-fund --no-audit && npx hexo generate
```

`--no-fund --no-audit` 减少无关日志输出，加速构建。

---

## 六、自定义域名

1. Pages 项目 → **自定义域** → **设置自定义域**
2. 输入域名（如 `blog.searchdiff.com`）
3. 若域名 DNS 已托管在 Cloudflare → 自动添加 CNAME；否则手动在域名商处添加：
   ```
   blog  CNAME  <your-project>.pages.dev
   ```
4. 等待几分钟证书签发，HTTPS 自动生效

---

## 七、日常发布流程

本地写完文章后：

```bash
git add -A && git commit -m "new post: 文章标题" && git push
```

Cloudflare Pages 自动拉取、构建、发布，约 1-2 分钟上线。

### 常用命令

```bash
hexo new "文章标题"   # 新建文章
npm run server       # 本地预览 http://localhost:4000
npm run build        # 本地生成静态文件
npm run clean        # 清理缓存
```

---

## 总结

Hexo + NexT + Cloudflare Pages 是一套低成本、高可用的静态博客方案。主要坑点是 Cloudflare 的 `npm ci` 自动行为与 npm 10 的兼容性问题——移除 `package-lock.json` 是最简洁的绕过方式。
