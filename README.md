# PodStarter

专为播客创作者打造的静态网站模板。支持从小宇宙、网易云音乐、喜马拉雅、Apple Podcasts 或标准 RSS 一键导入节目，自带可视化管理控制台、全局音频播放器、时间戳文字稿与全文检索，并可接入 AI 自动生成节目标签与主题分类。

## 核心功能

- **多平台一键导入**：支持小宇宙、网易云音乐、喜马拉雅、Apple Podcasts 及标准 RSS。
- **可视化控制台**：访问 `/admin` 在线导入播客、自定义首页与页脚文案、主播团队与执行 AI 流程。
- **全局常驻播放器**：全站跨页面连播，支持进度记忆、倍速调节、快进快退与移动端适配。
- **时间戳文字稿**：支持导入 SRT 或 VTT 字幕生成 Markdown，点击时间戳跳转至对应音频位置。
- **毫秒级全文检索**：内置 Pagefind 离线搜索引擎，支持静态全文检索与关键词高亮。
- **AI 主题与标签生成**：支持多并发（默认 5 并发）秒级打标，适配 DeepSeek、智谱、xAI 等 OpenAI 兼容接口。
- **定时自动更新**：内置 GitHub Actions 每日工作流，自动检测 RSS 更新并触发重新构建。
## 快速上手

### 环境要求

- [Node.js](https://nodejs.org/) 18.x 或更高版本
- npm（随 Node.js 一起安装）

### 安装与启动

克隆项目并安装依赖：

```bash
git clone https://github.com/Eyozy/podstarter.git
cd podstarter
npm install
```

复制环境配置：

```bash
cp .env.example .env
```

在 `.env` 中设置后台密码：

```bash
ADMIN_PASSWORD=your_password
```

启动本地服务：

```bash
npm run dev
```

浏览器打开 `http://localhost:4321` 即可访问网站。

### 导入播客数据

打开 `http://localhost:4321/admin`：

1. 输入在 `.env` 中设置的管理员密码登录；
2. 粘贴播客链接或 RSS 地址，点击一键解析导入；
3. 导入完成后点击右上角预览播客即可。

也可在终端运行 `npm run init` 使用交互向导完成配置。

## 模板配置

### 站点配置

可在 `/admin` 控制台直接修改并保存，也可以手动编辑 `src/data/site.json`：

```json
{
  "brand": {
    "name": "你的播客名称",
    "meta": {
      "description": "播客一句话简介",
      "author": "主理人姓名"
    }
  },
  "podcast": {
    "rssUrl": "https://feed.xyzfm.space/yourfeed",
    "appleUrl": "https://podcasts.apple.com/...",
    "xiaoyuzhouUrl": "https://www.xiaoyuzhoufm.com/...",
    "wechatQr": "/qr/wechat.png"
  },
  "features": {
    "transcripts": true,
    "aiTagging": true,
    "themes": true
  },
  "hero": {
    "titlePrefix": "用声音记录思考，打造你的",
    "titleHighlight": "独立播客主站",
    "titleSuffix": "。",
    "description": "不依赖单一商业平台，拥有属于创作者自己的独立播客网站、全平台内容聚合与交互式文字稿。"
  },
  "footer": {
    "descriptionLine1": "专为播客创作者打造的现代化独立站模板，",
    "descriptionLine2": "支持全文搜索、交互文字稿与多端适配播放器。"
  }
```

字段说明：
- `podcast.rssUrl`：播客 RSS 地址，用于后续自动更新。
- `features.transcripts`：是否开启文字稿功能。
- `features.aiTagging`：是否开启 AI 自动打标。
- `features.themes`：是否开启主题探索页。

### 环境变量

若需使用 AI 功能，在 `.env` 中配置服务商与密钥：

```bash
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-你的密钥
DEEPSEEK_MODEL=deepseek-chat
```

使用 OpenAI 兼容接口：

```bash
AI_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_KEY=sk-你的密钥
OPENAI_COMPATIBLE_API_URL=https://api.siliconflow.cn/v1/chat/completions
OPENAI_COMPATIBLE_MODEL=Qwen/Qwen2.5-7B-Instruct
```

不使用 AI 时，保持 `site.json` 中的 `features.aiTagging: false` 即可。

### 文字稿制作

方式一：在 `/admin` 后台选择对应单集，粘贴字幕文本一键生成。

方式二：使用本地命令行转换：

```bash
npm run transcript ./sample.srt <单集ID>
```

脚本将自动生成 `src/content/transcripts/<单集ID>.md`。

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动本地开发服务器，默认端口 4321 |
| `npm run build` | 构建生产版本并生成全文搜索索引 |
| `npm run smart-build` | 一键同步数据并构建整站 |
| `npm run sync` | 拉取 RSS 最新节目并生成文字稿骨架 |
| `npm run init` | 终端交互式项目配置向导 |
| `npm run reset` | 清空全站节目数据与主题配置 |
| `npm run transcript` | 将本地 SRT 或 VTT 字幕转为 Markdown 文字稿 |
| `npm run tag` | 调用 AI 为未分类单集打标 |
| `npm run analyze` | 抽样分析节目并生成主题大类 |
| `npm run analyze:full` | 基于全量节目深度聚类生成主题大类 |
| `npm run test:auth` | 验证控制台鉴权安全性 |

## AI 内容管理

### 工作原理

```text
播客 RSS 源
    ↓ npm run sync
episodes.json（原始数据）
    ↓ npm run analyze
themes.json（主题分类）
    ↓ npm run tag
episodes.json（写入主题与标签）
    ↓ npm run build
静态网站 + 搜索索引
```

### 日常更新流程

发布新节目后，运行一条命令即可完成同步与构建：

```bash
npm run smart-build
```

### 常用场景

初始化分类体系：
```bash
npm run analyze
npm run tag
```

同步新节目并自动打标：
```bash
npm run sync
```

补齐所有未打标节目（默认全量 + 5 并发极速处理）：
```bash
npm run tag
```

自定义并发数提速（如 8 并发）：
```bash
npm run tag -- --concurrency 8
```

限制单次处理批次：
```bash
npm run tag -- --limit 20
```

指定单集重新打标：
```bash
npm run tag -- --ids 节目ID1,节目ID2
```

### 主题分类与维护

- **自动生成**：运行 `npm run analyze` 时，AI 将基于分类学（MECE 原则）归纳 3~5 个互斥且互补的主题大类，并写入 `src/data/themes.json`，同时自动开启导航栏的「探索主题」入口。
- **手动调整**：所有主题数据直接保存在 `src/data/themes.json`。创作者可随时手动打开该文件修改主题标题（`title`）、业务介绍（`description`）或自由增删类目，前台 `/themes` 页面将即时动态响应。

使用全部节目深度聚类重建主题：
```bash
npm run analyze:full
```
## 部署上线

本项目默认配置为部署到 Netlify，你也可以部署到任何支持静态网站的平台。

### Netlify 部署

1. 将代码推送到 GitHub 仓库；
2. 登录 Netlify，导入该项目；
3. 设置构建命令为 `npm run build`，发布目录设为 `dist`；
4. 在 Netlify 站点的 Site configuration -> Environment variables 中添加后台管理密码：
   - Name 输入 `ADMIN_PASSWORD`，Secret 输入自定义密码；
5. 点击 Deploy 完成初始部署。

如果你不使用 GitHub Actions，日常同步和构建可以改用 `npm run smart-build`。

### 播客新节目自动同步

用于定时从小宇宙或 RSS 源拉取最新单集，并触发整站重新编译发布。

- **运行机制**  
  仓库预置了 `.github/workflows/rss-sync.yml` 工作流。每天定时运行 `npm run sync` 检查播客源，检测到新单集会自动提交数据至仓库，Netlify 感知代码提交后会自动重新构建发布。

- **开启仓库写权限**  
  工作流自动提交新节目数据需要写权限。进入仓库 Settings -> Actions -> General，在 Workflow permissions 区域勾选 Read and write permissions 并保存。

- **配置 AI 自动打标密钥**  
  若希望每次同步新节目时让 AI 自动生成标签，需在 GitHub Secrets 中配置密钥：
  1. 进入仓库 Settings -> Security -> Secrets and variables -> Actions；
  2. 点击 New repository secret 按钮；
  3. 添加 `AI_PROVIDER`（如 deepseek）以及对应模型密钥（如 `DEEPSEEK_API_KEY`、`DEEPSEEK_API_URL`、`DEEPSEEK_MODEL`）；
  4. 点击 Add secret 保存。

### 模板代码上游更新

用于当模板主仓库 `Eyozy/podstarter` 发布了功能升级或代码修复时，将最新程序合并至你自己的播客仓库。无需手动复制代码，提供两种方式：

- **方式一：自动化每日同步**  
  无需额外配置任何密钥。仓库预置了 `.github/workflows/upstream-sync.yml`。别人 Fork 本仓库并开启 Actions 后，每天会自动检测并拉取主仓库 `Eyozy/podstarter` 的最新提交，自动执行拉取与合并。亦可在 Actions 页面手动点击 Run workflow 立即同步。

- **方式二：命令行手动拉取**  
  在本地终端添加上游源并拉取合并：
  ```bash
  git remote add upstream https://github.com/Eyozy/podstarter.git
  git fetch upstream
  git merge upstream/main
  ```

## 常见问题

**Q: 访问后台提示未配置管理员密码或返回 503？**

请检查项目根目录是否存在 `.env` 文件并已配置 `ADMIN_PASSWORD`。若部署在 Netlify 等平台，需在平台环境变量中添加该字段。

**Q: 没有 AI API 密钥可以使用吗？**

可以。网站的基础功能（导入、播放器、文字稿、搜索）均可正常使用，保持 `features.aiTagging: false` 即可。

**Q: 运行 AI 脚本或测试时报 fetch failed / Connect Timeout？**

这是由于 Node.js 20+ 的 IPv6 双栈探测在特定本地网络环境下的并发超时问题。本项目的所有 npm scripts 已自动注入 `--no-network-family-autoselection` 优先走稳定 IPv4 连接。若手动通过 `node` 命令调用脚本，请优先使用 `npm run analyze`、`npm run tag` 或在命令前加上 `NODE_OPTIONS='--no-network-family-autoselection'`。

**Q: 切换到新播客后，旧数据还在怎么办？**

运行 `npm run reset` 可清空所有历史节目与主题数据。也可在 `/admin` 后台重新粘贴链接覆盖导入。

**Q: 构建时搜索功能报错怎么办？**

确保已安装依赖且 Node.js 版本在 18.x 以上。若依赖损坏，清理后重试：

```bash
rm -rf node_modules package-lock.json
npm install
npm run build
```
**Q: 如何提交反馈建议？**

在 `/admin` 控制台顶部点击反馈建议链接，或直接在 GitHub 仓库提交 Issue。

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
