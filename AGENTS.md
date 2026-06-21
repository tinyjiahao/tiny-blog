# AGENTS.md

本文件为 AI 编码代理（如 Claude Code、Cursor、ZCode 等）在此仓库中工作时的指引。请在动手前完整阅读。

## 项目概述

**Tiny Blog** —— 基于 Hexo 的个人技术博客，主题 NexT（Gemini scheme），部署于 Cloudflare Pages。

- 线上地址：<https://blog.searchdiff.com>
- 内容来源：作者个人的 Obsidian 笔记，转换后作为文章发布
- 语言：中文为主

## 技术栈与版本

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Hexo | 8.1.2 | 静态站点生成框架 |
| hexo-theme-next | 8.27.0 | 通过 npm 安装（**非** themes 目录） |
| NexT Scheme | Gemini | 在 `_config.next.yml` 中配置 |
| Node | 22 | 见 `.nvmrc` |

## 常用命令

```bash
npm run server     # 本地预览 http://localhost:4000
npm run build      # 生成静态文件到 public/（= hexo generate）
npm run clean      # 清理缓存 db.json 与 public/
npx hexo new "标题" # 新建文章 source/_posts/<标题>.md
```

**任何内容或配置改动后，务必先 `npm run clean && npm run build` 验证构建无报错。**

## 目录结构与改写边界

```
tiny-blog/
├── _config.yml          # ✅ 站点主配置（标题/URL/主题/永久链接）
├── _config.next.yml     # ✅ NexT 主题配置（覆盖主题包默认值）
├── package.json         # ✅ 依赖与脚本
├── .nvmrc               # ✅ Node 版本锁定（22）
├── source/_posts/       # ✅ 博文目录（Markdown，唯一的内容来源）
├── scaffolds/           # ⚠️ 文章模板（new 命令的骨架）
├── DEPLOY.md            # 部署指南
├── README.md            # 项目说明
├── AGENTS.md            # 本文件
├── node_modules/        # ❌ 依赖产物，勿改（含 hexo-theme-next）
├── public/              # ❌ 构建产物，gitignore，勿提交勿手改
└── db.json              # ❌ Hexo 缓存，gitignore
```

**关键边界（务必遵守）：**

- ❌ **不要修改 `node_modules/hexo-theme-next/` 下的任何文件**。主题通过 npm 管理，所有主题定制一律在项目根目录的 `_config.next.yml` 中进行（Hexo 会用它覆盖主题包内的 `_config.yml`）。
- ❌ 不要把主题文件复制进 `themes/` 目录（本仓库用 npm 主题方案，无 `themes/` 目录是正确的）。
- ❌ 不要手动编辑或提交 `public/`、`db.json`。
- ✅ 站点级配置改 `_config.yml`；主题外观改 `_config.next.yml`；文章放 `source/_posts/`。

## 关键配置项速查

### `_config.yml`（站点）

- `title: Tiny Blog`、`author: searchdiff`
- `url: https://blog.searchdiff.com`
- `theme: next`
- `permalink: :year/:month/:day/:title/`

### `_config.next.yml`（主题）

- `scheme: Gemini`
- darkmode、菜单、侧栏、评论、SEO 等所有主题开关均在此文件，详见 <https://theme-next.js.org/docs/>

## 文章写作约定

### Front-matter（必需）

```yaml
---
title: 文章标题
date: YYYY-MM-DD HH:mm:ss
categories:
  - 分类名          # 如：数据库
tags:
  - 标签1
  - 标签2
---
```

- `date` 建议保留 `hexo new` 生成的创建时间。
- `categories` 与 `tags` 在 NexT 中会自动生成 `/categories`、`/tags` 页面（需在 `_config.next.yml` 的 `menu` 中开启对应菜单项才会显示入口）。

### 从 Obsidian 笔记转换时的注意事项

文章内容常从 Obsidian 笔记搬运，转换时需检查并处理：

1. **移除原文件的 front-matter**：Obsidian 笔记顶部的 `---` YAML 块要替换为 Hexo 的 front-matter（补 `categories`/`tags`）。
2. **内部锚点链接**：Obsidian 的 `[文本](#)` 或 `[[wikilink]]` 在 Hexo 中会失效，需改为纯文本或正确的相对路径。
3. **代码块语言标注**：保留 ``` 后的语言标识（`bash`/`json`/`python`/`java`），highlight.js 据此高亮。
4. **图片资源**：Obsidian 的 `![[xxx.png]]` 语法不被 Hexo 支持；如需图片，改用 Hexo 资源文件夹或外链，并开启 `post_asset_folder: true`。

## 部署流程

通过 **Git 集成** 部署到 Cloudflare Pages：

1. `git push` 到 `main` 分支
2. Cloudflare 自动拉取 → `npm run build` → 输出 `public/`
3. 环境变量：`NODE_VERSION=22`
4. 详细步骤见 `DEPLOY.md`

**部署相关改动（如构建命令、Node 版本、`.gitignore`）需同步检查 `DEPLOY.md` 是否需要更新。**

## Git 约定

- 提交邮箱（本仓库级）：`me@blog.searchdiff.com`（已通过 `git config user.email` 设为仓库级，勿改全局配置）
- 提交信息建议带前缀：`post:`（新文章）、`docs:`（文档）、`config:`（配置）、`chore:`（杂项）
- 提交前确认 `git status` 不含 `public/`、`db.json`、`node_modules/`

## 工作 checklist

每次完成任务前自检：

- [ ] 改动是否落在允许修改的文件/目录内？
- [ ] 是否误碰了 `node_modules/`、`public/`、`db.json`？
- [ ] 是否跑过 `npm run clean && npm run build` 且无报错？
- [ ] 若涉及部署配置，`DEPLOY.md` 是否同步？
- [ ] 若新增文章，front-matter 是否含 `categories` 与 `tags`？
