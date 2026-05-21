# PodStarter 模板配置指南

本指南旨在帮助内容创作者（或协助你的 AI 代理）快速掌握项目的结构设计与核心配置项，以便在不改动底层逻辑的前提下，高效、平滑地完成个性化站点的搭建与定制。

## 核心设计理念

- **单源聚焦**：本模板专为通过「小宇宙 RSS」订阅源驱动的播客内容而设计。
- **静态化与自动化**：全站采用静态化构建机制，内容更新依赖于定时同步脚本（默认设置每日自动同步一次）。
- **配置即代码**：所有核心业务配置均附带严格的 JSON Schema 校验，确保在主流编辑器中拥有完善的代码补全与排错提示。
- **SEO 与 AI 友好**：每次构建均会自动生成 `sitemap-index.xml`，并对外暴露 `robots.txt` 和供 Agent 读取的站点结构文件 `llms.txt`。

## 零基础快速起步

只需简单的三步，即可将本模板转化为你专属的播客网站：

1. **更新配置**：修改 `src/data/site.json`，替换其中的品牌视觉、文案、团队成员以及各平台的订阅链接。
2. **拉取数据**：在终端执行 `npm run sync`，项目将自动从小宇宙拉取并处理你最新的 RSS 数据。
3. **本地预览与部署**：执行 `npm run dev` 在本地环境预览效果，或通过 `npm run build` 打包静态产物以便发布到各大静态托管平台。

## 环境变量与 AI 提供商

当前项目支持以下 AI 提供商：

- `deepseek`
- `openrouter`
- `xai`
- `zhipu`
- `openai-compatible`

请参考 `.env.example` 填写环境变量。若使用 `openai-compatible`，至少需要：

- `AI_PROVIDER=openai-compatible`
- `OPENAI_COMPATIBLE_API_KEY`
- `OPENAI_COMPATIBLE_API_URL`
- `OPENAI_COMPATIBLE_MODEL`

如果使用 GitHub Actions 自动同步，还需要在仓库 `Secrets and variables` 中同步配置上述密钥。工作流文件为 `.github/workflows/rss-sync.yml`。

## 定制化捷径：关键文件一览

- **「唯一」的配置中心**：`src/data/site.json`（受 `site.schema.json` 强校验保护，修改时请留意提示）。
  - **品牌与链接**：集中在 `brand`、`podcast`、`navigation`、`assets` 节点。
  - **全站文案**：覆盖 `hero`、`sections`（包含 `recentSubtitle`）、`pages`、`ui` 节点。
  - **关于页面**：独立在 `about` 与 `footer` 节点。
  - **播放控制与分享**：由 `player` 及 `shareCard` 节点掌控。
  - **文稿模板配置**：`transcripts.placeholderNotice` 用于定义尚未生成文字稿时的默认提示。
- **搜索引擎与 AI Agent 引流口**：如果需要调整抓取规则或更新站点导读，请修改 `public/robots.txt` 和 `public/llms.txt`。

## 配置入口（site.json）

所有站点内容集中在 `src/data/site.json`，你只需改这个文件即可完成大部分定制。

- `features`：功能开关配置
  - `aiTagging`：是否启用 AI 标签/主题功能（当前示例站点为 `true`，模板可手动关闭）
- `brand`：品牌名、站点元信息（SEO、作者、Twitter 等）
- `assets`：默认封面、OG 图、favicon
- `podcast`：RSS 与平台链接、二维码
- `navigation`：导航菜单标签与链接
- `hero`：首页主标题与按钮文案
- `sections`：首页/订阅区标题与说明
- `ui`：通用按钮/状态文案（播放、暂停、未知时长、期号前缀等）
- `pages`：页面级文案（列表页、详情页、空状态等）
- `about`：关于页完整文案、成员、联系方式、反馈渠道
- `footer`：页脚描述文案
- `player` / `shareCard`：播放器与分享卡片文案
- `transcripts`：文字稿模板占位文案

## 数据流（内容同步）

```
小宇宙 RSS
  ↓ scripts/sync-content.js
src/data/episodes.json + src/content/transcripts
  ↓ astro build
dist (静态站点)
```

注意：`src/data/episodes.json` 和 `src/content/transcripts` 是自动生成内容，不建议手改。

### AI 标签/主题功能

项目支持 AI 智能打标和主题分类功能，通过 `site.json` 中的 `features.aiTagging` 开关控制：

| 配置值 | 效果 |
|--------|------|
| `false` | 关闭 AI 功能，隐藏主题页面和标签筛选，无需配置环境变量 |
| `true` | 启用 AI 功能，需在 `.env` 中配置 AI 提供商 |

**关闭时的行为：**
- 导航栏不显示"探索主题"
- 首页不显示主题导航区块
- `/themes` 页面返回 404
- 节目列表页隐藏标签筛选
- `npm run sync` 跳过 AI 打标

**启用步骤：**
1. 将 `site.json` 中 `features.aiTagging` 设为 `true`
2. 在 `.env` 中配置 AI 提供商（参考 `.env.example`）
3. 运行 `npm run sync`（会自动生成 `themes.json` 并打标）

> 注意：`src/data/themes.json` 默认是空数组 `[]`，启用 AI 功能后会被自动填充。

### 标签规范化与约束 (tag-taxonomy.json)

**特别注意：** 当您启用了 AI 功能（`features.aiTagging: true`），在第一次执行分析或者运行 `npm run analyze` 时，AI 不仅会分析出 `themes.json`（主题大类），还会自动将高频标签提取并保存为 `src/data/tag-taxonomy.json`（标签白名单库）。

它的核心作用是用来**约束 AI 在单集打标时的发散行为**。系统强制 AI 只能从这个“白名单”里挑选标签，确保标签体系不会碎片化（例如防止同时出现“个人成长”、“自我探索”与“成长感悟”三个相近的标签）。

```json
{
  "tags": ["职场", "情感", "成长"], // AI 分析后生成的标签池
  "aliases": {}                     // 初始为空，您可以在这里手动添加别名规则
}
```

**手动干预：** 虽然它是 AI 自动生成的，但您可以随时进入此文件：
1. **删除**您觉得不够好的标签。
2. **在 `aliases` 中添加别名**（例如 `"工作": "职场"`），这样即便 AI 偶尔输出了“工作”，代码也会强制将其规整为“职场”。

如果您修改了这套分类学规则，只需运行 `node scripts/normalize-tags.js`，系统便会自动将所有已打好的节目标签根据新规则进行统一。

### AI 相关命令

- `npm run analyze`：基于当前节目数据生成或更新主题分类
- `npm run analyze:full`：使用全部节目重建主题分类，成本更高但更完整
- `npm run tag`：对节目执行 AI 标签打标
- `node scripts/tag-episodes.js --limit 20`：仅处理指定数量的节目
- `node scripts/tag-episodes.js --ids 节目ID1,节目ID2`：仅处理指定节目

`npm run sync` 在 `features.aiTagging=true` 且环境变量齐全时，也会自动串联主题/标签生成流程。

### 搜索能力

- 节目列表页优先使用 `Pagefind` 静态索引做全文检索
- 本地开发或索引缺失时，会自动降级为标题与简介的原生字符匹配
- 若命中出现在简介被截断的位置，卡片会替换为摘要片段并标注来源
- 若仅命中文字稿，也会显示文字稿摘要片段并标注来源

注意：`Pagefind` 索引只会在 `npm run build` 后生成；开发环境中看不到全文检索属于正常降级行为

### 分享卡片

- 每张节目卡支持生成分享图
- 分享图二维码默认指向小宇宙节目链接；若 RSS 条目缺失，则回退到 `episodeId` 拼接的标准小宇宙链接
- 分享图文案由 `site.json` 中的 `shareCard` 配置控制

### 探索 / SEO / AI 抓取接口 (Robots & LLMs)

- 系统已在 `astro.config.mjs` 中默认接入 `@astrojs/sitemap` 插件。
- 每次生产环境构建后，会在 `dist/` 下自动生成规范的 `sitemap-index.xml`。
- `public/robots.txt` 会对外公布 sitemap 文件的具体位置。
- `public/llms.txt` 为试图阅读你播客的各大 AI Agent 提供标准化的机器可读导读。
- **🚨 风险提示**：如果你部署后更改了**正式域名**或**RSS 订阅源**，请务必同步修改 `astro.config.mjs` 中的 `site` 字段，并**手动更新 `public/llms.txt` 中的各个硬编码链接**，否则搜索引擎与 AI 爬虫将会因为迷路而导致站点收录异常。

## 自动同步（定时更新）

GitHub Actions 每天运行一次同步任务：

- 配置文件：`.github/workflows/rss-sync.yml`
- 默认时间：北京时间 00:00（UTC 16:00）
- 如需调整频率，修改 `cron` 表达式即可

## 常见修改范式

- **启用 AI 标签/主题功能**：将 `site.json` 中 `features.aiTagging` 设为 `true`，并配置 `.env` 中的 AI 提供商
- **更换播客**：修改 `site.json` 中 `podcast.rssUrl` 与各平台链接
- **改品牌/文案**：修改 `site.json` 的 `brand`、`hero`、`about`、`footer`
- **改成员信息**：修改 `site.json` 的 `about.members`
- **改 OG/封面**：修改 `site.json` 的 `assets`
- **改导航**：修改 `site.json` 的 `navigation`
- **管理标签**：编辑 `tag-taxonomy.json` 添加/删除允许的标签或设置别名

## 给 AI 的工作提示

1. 先读取 `src/data/site.json`，这是唯一的"内容入口"（有 `site.schema.json` 提供结构校验）。
2. 不要直接编辑 `src/data/episodes.json`（它是同步脚本生成的）。
3. 需要新增页面时，优先在 `src/pages` 创建，并在 `site.json` 的 `navigation` 中增加入口。
4. 保持"静态构建 + 定时同步"的模式，除非用户明确要求实时更新。
5. 标签相关修改应编辑 `tag-taxonomy.json`，然后运行 `node scripts/normalize-tags.js`。
