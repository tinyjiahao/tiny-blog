# Cloudflare Pages 部署指南

本博客通过 **Git 集成** 部署到 Cloudflare Pages，每次 push 到默认分支即自动构建发布。

## 一、前置准备

1. 将本项目推送到 GitHub（或 GitLab）远程仓库：
   ```bash
   # 在 GitHub 上新建一个空仓库（例如 tiny-blog），然后：
   git remote add origin git@github.com:<your-name>/tiny-blog.git
   git branch -M main
   git push -u origin main
   ```
2. 登录 Cloudflare Dashboard → **Workers & Pages** → **创建** → **Pages** → **连接到 Git**。
3. 授权并选中刚才的仓库。

## 二、构建配置

在 Cloudflare Pages 的「构建部署」中填写：

| 配置项 | 值 |
| --- | --- |
| **Framework preset** | `None`（或 Hexo，如有该选项） |
| **Build command** | `npm run build` |
| **Build output directory** | `public` |
| **Root directory** | （留空，使用仓库根） |

### 环境变量（建议设置）

| 变量名 | 值 | 说明 |
| --- | --- | --- |
| `NODE_VERSION` | `22` | 与本地 `.nvmrc` 一致，避免构建时 Node 版本不符报错 |
| `NPM_FLAGS` | `--no-audit --no-fund` | （可选）加速安装，输出更干净 |

> 在 **Settings → Variables and Secrets** 中添加环境变量。

## 三、自定义域名

部署成功后绑定 `blog.searchdiff.com`：

1. 进入 Pages 项目 → **自定义域** → **设置自定义域**。
2. 输入 `blog.searchdiff.com`。
3. 若 `searchdiff.com` 的 DNS 已托管在 Cloudflare，会自动添加 CNAME 记录；否则按提示在域名商处添加：
   ```
   blog  CNAME  <your-project>.pages.dev
   ```
4. 等待证书签发，几分钟后即可通过 `https://blog.searchdiff.com` 访问。

## 四、常用命令（本地）

```bash
npm run server     # 本地预览 http://localhost:4000
npm run build      # 生成静态文件到 public/
npm run clean      # 清理缓存与 public/
hexo new "文章标题" # 新建文章 source/_posts/<标题>.md
```

## 五、部署流程

完成后只需：

```bash
git add -A && git commit -m "new post" && git push
```

Cloudflare 会自动拉取、构建并发布到生产环境。
