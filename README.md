# PodStarter

专为播客创作者打造的静态网站模板。它能直接从小宇宙 RSS 同步你的节目，不仅自带全局音频播放器和内容搜索功能，还能接入 AI，自动帮你提炼节目标签和分类。

## 在线演示

- **示例网站**: https://xzsj.netlify.app/
- **默认 RSS 订阅**: 详见 `src/data/site.json` 中的 `podcast.rssUrl` 节点

## 核心功能

- **🚀 自动更新**：一条命令就能从小宇宙拉取最新节目，还能帮你把文字稿的骨架搭好。
- **🧠 AI 自动打标（可选）**：根据节目摘要自动总结出合适的主题分类和内容标签。
- **🔍 毫秒级搜索**：内置了轻量级的静态搜索引擎，方便快速查找内容。
- **🎵 跨页面播放**：自带全局播放器，方便听众在网站内对照文字稿收听。
- **🤖 搜索引擎与 AI 友好**：自动生成 `sitemap` 和 `llms.txt` 。

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 18.x 或更高版本
- npm（随 Node.js 一起安装）

### 第一步：克隆项目

```bash
git clone https://github.com/Eyozy/podstarter.git
cd podstarter
```

### 第二步：安装依赖

```bash
npm install
```

### 第三步：修改站点配置（必需）

打开 `src/data/site.json`，替换为你的播客信息（RSS、品牌名、文案、成员等）。

> **注意**：如果你后续更换了站点的域名，请务必同步修改 `public/llms.txt` 中的各个页面 URL，以及 `astro.config.mjs` 中的 `site` 配置，确保 AI 代理和搜索引擎能够正确爬取。

### 第四步：配置环境变量（可选）

如果你需要使用 AI 智能打标功能：

1. 首先在 `src/data/site.json` 中启用 AI 功能：
   ```json
   {
     "features": {
       "aiTagging": true
     }
   }
   ```

2. 在项目根目录创建 `.env` 文件，添加以下内容：

```bash
# 选择提供商：deepseek | openrouter | xai | zhipu | openai-compatible（必填）
AI_PROVIDER=deepseek

# DeepSeek（示例）
DEEPSEEK_API_KEY=sk-你的密钥
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions
DEEPSEEK_MODEL=deepseek-chat
```

如果你使用的是 OpenAI 兼容接口地址，也可以这样配置：

```bash
AI_PROVIDER=openai-compatible

OPENAI_COMPATIBLE_API_KEY=sk-你的密钥
OPENAI_COMPATIBLE_API_URL=https://your-host/v1/chat/completions
OPENAI_COMPATIBLE_MODEL=你的模型名
```

> **不需要 AI 功能？** 将 `features.aiTagging` 设为 `false` 即可，无需配置任何环境变量。网站的基础功能（同步、构建、预览）都能正常使用。
>
> 其他提供商（OpenRouter / xAI / 智谱 / 通用 OpenAI 兼容）的环境变量示例请参考 `.env.example`。

### 第五步：获取节目数据

```bash
npm run sync
```

这会从小宇宙 RSS 源拉取节目信息，保存到 `src/data/episodes.json`，并生成文字稿模板。

### 第六步：启动开发服务器

```bash
npm run dev
```

打开浏览器访问 http://localhost:4321，就能看到网站了。

## 搜索说明

- 开发环境不会生成 `Pagefind` 索引，所以节目搜索会自动降级为标题与简介的原生字符匹配
- `npm run build` 会生成 `dist/pagefind/`，生产环境自动启用全文检索和高亮摘要
- 如果你本地查看构建产物，请使用静态文件服务器，例如 `python3 -m http.server 4321 -d dist`

## 常用命令

| 命令                  | 说明                                           |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | 启动本地开发服务器                             |
| `npm run build`       | 构建生产版本（包含搜索索引）                   |
| `npm run test`        | 运行当前仓库内的 Node 原生单元测试             |
| `npm run sync`        | 完整同步：拉取数据 + 生成文字稿模板 + 自动打标 |
| `npm run reset`       | 重置所有播客数据（切换播客时使用）             |
| `npm run tag`         | 为未分类的节目添加主题和标签（需要 API 密钥）  |
| `npm run analyze`     | 重新分析所有节目，生成主题分类（慎用）         |
| `npm run analyze:full`| 使用全部节目重建主题分类（更完整，也更贵）     |
| `npm run smart-build` | 一键完成：同步数据 + 构建网站                  |

> `@astrojs/netlify` 适配器不支持 `npm run preview`。如需预览构建产物，请直接对 `dist` 起静态文件服务。

## AI 内容管理

本项目集成了基于 AI 的内容管理系统，让节目的分类和标签管理变得轻松自动。

### 工作原理

```
小宇宙 RSS
    ↓ npm run sync
episodes.json（原始数据）
    ↓ npm run analyze
themes.json（5 个主题分类）
    ↓ npm run tag
episodes.json（添加主题和标签）
    ↓ npm run build
静态网站 + 搜索索引
```

更准确地说，AI 部分分成两步：

1. `npm run analyze` / `npm run analyze:full`
作用：生成或重建 `src/data/themes.json`

2. `npm run tag`
作用：基于现有 `themes.json`，给 `src/data/episodes.json` 中的节目写入 `themeId` 和 `tags`

而 `npm run sync` 是自动流程入口：
- 同步 RSS 数据
- 必要时自动生成 `themes.json`
- 自动给新节目打标签
- 生成文字稿模板

### 日常更新流程

有新节目发布时，只需运行：

```bash
npm run smart-build
```

这一条命令会自动完成数据同步和网站构建。

### 常见 AI 命令场景

**初始化 AI 分类体系**

```bash
npm run analyze
npm run tag
```

适用场景：
- 第一次给播客建立主题分类和标签体系
- `themes.json` 还不存在

**使用全部节目重建主题分类**

```bash
npm run analyze:full
```

适用场景：
- 节目数量不算太大
- 希望主题分类尽量基于全部节目内容

注意：
- 会覆盖现有 `src/data/themes.json`
- 比默认的 `npm run analyze` 更慢、花费更高

**日常同步新节目并自动打标**

```bash
npm run sync
```

适用场景：
- 平时更新节目
- 想自动完成“同步 + 必要时分析主题 + 给新节目打标签”

**只给未打标节目补标签**

```bash
npm run tag
```

适用场景：
- 已有 `themes.json`
- 只想补 `themeId` 和 `tags`

**批量处理更多未打标节目**

```bash
node scripts/tag-episodes.js --limit 20
node scripts/tag-episodes.js --limit 100
node scripts/tag-episodes.js --limit 9999
```

适用场景：
- 默认 `npm run tag` 一次只处理 5 期
- 你想一次性处理更多未打标节目

**只重打指定节目**

```bash
node scripts/tag-episodes.js --ids 节目ID1,节目ID2
```

示例：

```bash
node scripts/tag-episodes.js --ids 6989f7eca22480add65e2fc5,685bbdcc50e8c269ca790278
```

### 脚本详解

**`npm run sync`**

同步 RSS 数据，为新节目生成文字稿模板。

如果启用了 AI 且配置有效，它还会自动：
- 检查 `themes.json` 是否存在
- 若不存在，先执行主题分析
- 再对本次新增/更新的节目执行 AI 打标

**`npm run tag`**

检查所有未分类的节目，根据现有 `themes.json` 进行归类，并生成相关标签。

默认行为：
- 一次只处理 5 期未打标节目

可选参数：
- `--limit N`：一次处理更多节目
- `--ids id1,id2`：只处理指定节目

示例：

```bash
node scripts/tag-episodes.js --limit 20
node scripts/tag-episodes.js --ids 6989f7eca22480add65e2fc5
```

**`npm run analyze`**

使用“均匀抽样模式”分析节目内容，重新生成主题分类体系。

特点：
- 默认抽样约 30 期节目，而不是把全部节目发给 AI
- 会覆盖现有的 `themes.json`
- 更适合初始化或日常重建分类体系

**`npm run analyze:full`**

使用全部节目摘要重建主题分类体系。

特点：
- 比 `npm run analyze` 更完整
- 也更慢、更贵
- 同样会覆盖现有的 `themes.json`

## 项目结构

```
xzsj/
├── scripts/                   # 数据处理脚本
│   ├── ai-client.js           # AI 请求封装（支持多提供商 / OpenAI 兼容）
│   ├── ai-provider-config.js  # AI 提供商配置解析
│   ├── analyze-themes.js      # AI 主题分类生成
│   ├── normalize-tags.js      # 标签规范化
│   ├── reset-data.js          # 数据重置脚本
│   ├── site-config.js         # 读取 site.json 的共享脚本
│   ├── sync-content.js        # 内容同步 + 自动 AI 流程入口
│   ├── tag-episodes.js        # AI 节目归类与标签打标
│   └── utils.js               # 脚本层共享工具函数
├── src/
│   ├── components/            # UI 组件
│   │   ├── EpisodeCard.astro  # 节目卡片
│   │   ├── Player.astro       # 全局播放器
│   │   └── ...
│   ├── data/                  # 数据文件
│   │   ├── site.json          # 站点配置入口（模板修改这里）
│   │   ├── episodes.json      # 节目元数据
│   │   └── themes.json        # 主题分类
│   ├── layouts/               # 页面布局
│   ├── pages/                 # 路由页面
│   ├── styles/                # 样式文件
│   └── utils/                 # 测试复用的纯函数工具
├── public/                    # 静态资源（OG 图 / robots.txt / llms.txt）
├── tests/                     # Node 原生测试
├── astro.config.mjs           # Astro 配置
└── package.json
```

## 部署

本项目默认配置为部署到 Netlify，你也可以部署到任何支持静态网站的平台。

### Netlify 部署

1. 将代码推送到 GitHub
2. 在 Netlify 中导入项目
3. 设置构建命令为 `npm run build`（推荐，RSS 同步交给 GitHub Actions）
4. 设置发布目录为 `dist`
5. 如需 AI 功能，在 GitHub Secrets 中添加 `AI_PROVIDER` + 对应提供商的 `*_API_KEY/_API_URL/_MODEL`（例如 DeepSeek 或 OpenRouter）：
   - 打开 GitHub 仓库页面，点击顶部的 **Settings** ⚙️
   - 在左侧导航栏找到 **Security** 区域，点击 **Secrets and variables**，展开后选择 **Actions**
   - 点击右侧绿色的 **New repository secret** 按钮
   - **Name** 输入变量名（例如 `AI_PROVIDER` / `DEEPSEEK_API_KEY` / `DEEPSEEK_API_URL` / `DEEPSEEK_MODEL`），**Secret** 输入对应值
   - 点击 **Add secret** 保存

> 如果你不使用 GitHub Actions，同步和构建可以改用 `npm run smart-build`。

### 其他平台

构建完成后，`dist` 目录包含所有静态文件，可以部署到任何静态托管服务。

## 常见问题

**Q: 没有 AI API 密钥可以使用吗？**

可以。网站的核心功能都能正常使用，只是节目不会自动获得主题分类和标签。你可以手动编辑 `episodes.json` 来添加这些信息。

**Q: 如何获取 AI API 密钥？**

根据你选择的提供商去对应控制台创建 API Key（DeepSeek / OpenRouter / xAI / 智谱 / OpenAI 兼容接口），并把 `AI_PROVIDER` 与对应的 `*_API_KEY/_API_URL/_MODEL` 配好即可。

**Q: 切换到新播客后，旧数据还在怎么办？**

运行 `npm run reset` 可以一键清空所有播客数据。或者在运行 `npm run sync` 时，脚本会自动检测到已有数据并询问是否清空。

**Q: 构建时搜索功能报错怎么办？**

确保已正确安装依赖。如果问题持续，尝试删除 `node_modules` 后重新安装：

```bash
rm -rf node_modules
npm install
```

## 许可证

MIT
