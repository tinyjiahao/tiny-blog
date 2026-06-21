# Tiny Blog

基于 [Hexo](https://hexo.io/) 与 [NexT](https://theme-next.js.org/) 主题（Gemini scheme）搭建的个人博客，部署于 Cloudflare Pages。

🌐 线上地址：<https://blog.searchdiff.com>

## 技术栈

| 项目 | 说明 |
| --- | --- |
| Hexo | 8.1.2，静态站点生成框架 |
| NexT | 8.27.0，主题（npm 包 `hexo-theme-next`） |
| Scheme | Gemini |
| Node | 22（见 `.nvmrc`） |
| 部署 | Cloudflare Pages（Git 集成，自动构建） |

## 本地开发

```bash
npm install          # 安装依赖
npm run server       # 本地预览 http://localhost:4000
npm run build        # 生成静态文件到 public/
npm run clean        # 清理缓存与 public/
```

新建文章：

```bash
npx hexo new "文章标题"   # 生成 source/_posts/<标题>.md
```

## 目录结构

```
tiny-blog/
├── _config.yml          # 站点主配置（标题 / URL / 主题）
├── _config.next.yml     # NexT 主题配置（scheme: Gemini）
├── package.json         # 依赖与脚本
├── .nvmrc               # Node 版本锁定（22）
├── scaffolds/           # 文章模板（post / page / draft）
├── source/
│   └── _posts/          # 博文目录（Markdown）
├── DEPLOY.md            # Cloudflare Pages 部署指南
└── README.md            # 本文档
```

> `public/`、`node_modules/`、`db.json` 等构建产物已由 `.gitignore` 排除，不入库。

## 部署

通过 Git 集成部署到 Cloudflare Pages，`push` 到 `main` 即自动构建发布。

构建配置：`npm run build` → 输出目录 `public`。

详细步骤见 [DEPLOY.md](./DEPLOY.md)。

## License

本仓库源码（配置、脚本、自定义内容）按 MIT 协议开源；文章内容（`source/_posts/`）版权归作者所有，转载请联系。
