# AIQB — 可自托管的 AI 情报聚合与管理系统

> AIQB 是一套面向个人、团队与内容运营者的 AI 情报基础设施。它把分散在 JSON、RSS、Atom 和公开信息源中的内容持续采集回来，经过校验、规范化、去重、分类和持久化后，生成适合阅读、检索、归档与搜索引擎收录的中文/英文网站，并提供情报、接口、文章、SEO、统计、健康、邮件和在线更新等完整后台能力。它不是一个临时资讯页面，而是一条可长期运行、数据归自己、能够持续扩展的 AI 信息流水线。

中文 | [在线演示](https://chenqiyuan.cn/) | [快速开始](#快速开始) | [功能详解](#功能详解) | [部署说明](#部署与升级) | [贡献指南](./CONTRIBUTING.md) | [安全策略](./SECURITY.md) | [行为准则](./CODE_OF_CONDUCT.md) | [开源协议](#开源协议)

---

## 项目仓库

- GitHub：<https://github.com/chenfengyimei/AIQB>
- Gitee：<https://gitee.com/chenfengloveyuri/aiqb>
- 作者哔哩哔哩主页：<https://space.bilibili.com/508302628>

---

## AI 情报闭环

一套可用的情报系统不只是“抓取一个接口”，而是从发现到沉淀、再到分发和复盘的完整闭环：

```text
公开 JSON / RSS / Atom / 自定义接口
                 │
                 ▼
      校验 → 规范化 → 多标识去重
                 │
                 ▼
       分类 / 层级 / 人工审核与编辑
                 │
                 ▼
     SQLite WAL + 历史快照长期保存
                 │
        ┌────────┼────────┐
        ▼        ▼        ▼
   前台情报流   文章与 SEO   RSS / Sitemap
        │        │        │
        └────────┼────────┘
                 ▼
      访问统计 / 健康监控 / 运营复盘
```

| 传统做法 | AIQB 的做法 |
|---|---|
| 浏览器临时查看，接口失效后内容消失 | 每次采集写入本地数据库与历史快照，旧内容持续可查 |
| 多个来源反复收录同一条信息 | 使用来源 ID、规范化原文链接和标题信源组合进行去重 |
| 热点、日报、普通资讯混在一起 | 首页、情报、热点、日报分区展示，并区分精选与普通层级 |
| 网站内容有了，但搜索引擎难以发现 | 自动生成文章页、分类页、RSS、Sitemap、结构化数据和多语言 SEO |
| 只能改代码维护站点 | 后台集中管理情报、接口、SEO、统计、健康、邮件、友链和站点设置 |

## 这是什么

AIQB 是一个可独立部署的 Node.js Web 应用。最小形态下，它可以作为个人 AI 资讯站运行：安装后默认只接入 AI圈报 RSS，也可以在后台添加自己的公开接口。完整形态下，它使用两个无状态 Web 实例和一个独立采集器，借助 SQLite WAL 共享会话、统计和运行状态，让采集任务不会阻塞前台访问。

所有情报、快照、统计、账号和配置都保存在部署者自己的 `server/data/` 中。升级程序会在替换代码前备份运行数据，代码与数据分离，不需要通过删除历史数据换取性能。

## 适合谁

- AI 资讯站和内容运营者：希望建立可持续更新、可检索、可被搜索引擎发现的内容站点。
- 独立开发者和团队：需要统一跟踪模型、产品、行业、论文、教程和热点变化。
- 自托管用户：希望数据、统计、采集配置和访问日志保存在自己的服务器中。
- 二次开发者：需要一个原生 Node.js、少依赖、接口清晰、可继续扩展的情报系统底座。
- 商业运营者：希望在遵守 CPAL-1.0 和项目来源署名要求的前提下免费部署、运营或盈利。

## 核心能力

| 能力 | 说明 |
|---|---|
| 多源采集 | 支持 JSON、RSS、Atom 与后台自定义 HTTPS 接口，带超时、重试、质量门禁和 SSRF 防护 |
| 情报仓库 | 多标识去重、分类与层级、发布/草稿/归档/回收站、人工覆盖优先和批量管理 |
| 历史保存 | SQLite WAL、不可变数据索引、历史快照与长期访问统计，接口失效后仍可读取旧数据 |
| 阅读前台 | 首页精选、完整情报流、热点、日报、时间线、搜索、深浅主题与中英文界面 |
| 文章与 SEO | 服务端文章/分类页、canonical、JSON-LD、RSS、Sitemap、robots.txt 与多语言索引 |
| 完整后台 | 概览、情报、接口、SEO、统计、健康、邮箱、友链、设置、在线更新和关于系统 |
| 性能架构 | 公共索引、LRU、预压缩、ETag、静态缓存、多 Web 实例和独立采集 Worker |
| 安全边界 | scrypt、会话哈希、同源写保护、登录限流、请求限制、URL/DNS 校验和数据目录隔离 |

---

## 快速开始

### 本地体验（Windows / macOS / Linux）

需要 Node.js 20–25：

```bash
npm ci
npm run setup
npm start
```

安装向导会询问站点地址、名称、数据目录和接口预设。完成后访问：

- 前台：`http://127.0.0.1:3001/`
- 后台：`http://127.0.0.1:3001/chenfengadmin`
- 初始密码：`server/data/auth/initial-password.txt`（首次改密后自动删除）

### Linux 服务器一键安装

域名解析到服务器并放行 80/443 后运行：

```bash
sudo bash install.sh ai.example.com admin@example.com
```

脚本支持 Ubuntu 22.04/24.04、Debian 12、OpenCloudOS/Rocky Linux 9，自动完成依赖、PM2、Nginx、HTTPS、首次配置、健康检查和开机自启。重复执行会先备份旧版本，并保留运行数据。

### 默认采集源

全新安装的接口管理列表仅预置一个启用项：

- `AI圈报 RSS` — `https://chenqiyuan.cn/rss.xml`

它只用于让新站点开箱即可看到内容，采集结果按普通情报发布并在本地数据库去重保存。管理员可在后台停用它，也可添加自己的公网 HTTPS JSON、RSS 或 Atom。项目不会在后台隐藏调用未列出的采集接口。

已有旧版安装会继续沿用原来的完整接口配置，不会因升级自动切换或删除数据源。完整生产预设保留分区采集、热点、日报、精选增量同步与全量池滚动；全新开源安装仍默认使用最小化的 AI圈报 RSS。

> 安装程序、示例环境变量和默认数据源均不包含服务器密码、API 密钥或私有地址；`server/data/` 已排除在版本控制之外。法律条款以仓库中的 [`LICENSE`](./LICENSE) 和 [`NOTICE`](./NOTICE) 为准。

## 项目结构

```
AIQB/
├── README.md                  # 本文件（项目总说明）
├── LICENSE / NOTICE           # CPAL-1.0 法律文本与归属信息
├── LICENSE.zh-CN.md           # 开源协议中文理解说明（非法律文本）
├── CONTRIBUTING.md            # 开发、测试和 Pull Request 规范
├── SECURITY.md                # 漏洞私密报告与安全边界
├── CODE_OF_CONDUCT.md         # 社区参与和执行准则
├── install.sh                 # Linux 一键安装入口（转发到 deploy.sh）
├── deploy.sh                  # Ubuntu/Debian/OpenCloudOS 一键安装/升级脚本
├── package.json               # 项目元数据与测试命令
├── server/                    # 后端服务（Node.js 20–25 + SQLite）
│   ├── server.js              # 主程序：HTTP 服务 + 路由 + 定时采集
│   ├── lib/                   # 功能模块
│   │   ├── store.js           #   历史快照持久化（全量留档/去重/保留策略）
│   │   ├── intelligence-store.js # 单条情报仓库（核实去重/编辑/回收站）
│   │   ├── endpoint-registry.js # 接口注册、配置、状态、检测与审计日志
│   │   ├── seo.js             #   文章/分类服务端渲染、站点地图、RSS
│   │   ├── stats.js           #   永久访问统计（前台/后台/API/资源分区）
│   │   ├── auth.js            #   登录认证（scrypt 哈希/会话/限流）
│   │   ├── config.js          #   运行配置（后台可改）
│   │   └── http-util.js       #   HTTP 工具（gzip/ETag/Cookie/限流器）
│   └── data.json              # 旧版单文件缓存（首次启动自动迁移为历史快照）
├── frontend/                  # 前端页面（纯原生，无框架无构建）
│   ├── index.html             # 公开看板（fetch 后端 /api/data 渲染）
│   └── admin.html             # 管理后台（登录 + 侧边栏多视图）
└── scripts/                   # 测试与辅助脚本
    ├── setup.js               #   跨平台首次安装向导
    ├── smoke_test.js          #   后端完整冒烟测试
    ├── intelligence_store_test.js # 情报持久化与去重专项测试
    ├── check_frontend.js      #   前端 JS 语法检查
    └── ...                    # 其它测试脚本
```

## 架构

```
用户浏览器 ──HTTPS──▶ 可选 CDN ──HTTPS/HTTP──▶ 源站 Nginx
                                                         │
                                              ┌──────────┴──────────┐
                                              │                     │
                                      静态 root            反代 /api/
                                      /opt/ai-dashboard/   → 127.0.0.1:3001
                                      frontend/                │
                                                               ▼
                                                       PM2 后端进程
                                                       server/server.js
                                                       │        │
                                              ┌────────┘        └────────┐
                                              ▼                          ▼
                                                公开 RSS/Atom/JSON               server/data/
                                       （定时采集，默认 12h）      （情报库/快照/统计/账号/日志）
```

## 参考生产配置

| 项 | 值 |
|---|---|
| 运行时 | Node.js 20+ |
| Web | PM2 cluster 2 实例 |
| 采集 | 独立 PM2 worker |
| 代理 | Nginx + HTTPS，可选 CDN |
| 推荐目录 | `/opt/ai-dashboard/` |
| 运行数据 | `/opt/ai-dashboard/server/data/` |

## 功能详解

### 公开看板（frontend/index.html）

- 页面加载时 fetch 后端 `/api/data` 与分页历史接口 `/api/history`；支持近 24 小时、近 7 天、近 30 天、全部历史，分类/时间线双视图及关键词筛选高亮
- 5 分类 + 热点 + 日报；全局连续编号、≤160 字摘要、外链 `target="_blank" rel="noopener noreferrer"`
- 每条标题进入可索引的站内情报详情页，保留原始来源入口；页脚提供五个 AI 专题与 RSS 的静态抓取入口
- 深色 / 浅色模式（自动跟随系统 + 手动切换记忆）；URL 状态同步（`?w=&q=`）；`/` 快捷聚焦搜索
- 渲染性能：`content-visibility: auto` 卡片懒渲染、骨架屏、吸顶工具栏、回到顶部、30 分钟静默校验

### 后端（server/，Node.js 20–25）

- **定时采集**：默认每 12 小时（后台可改 1–168h），带超时、指数退避和状态码感知重试；按接口独立采集，任一外部源成功即生成完整公开快照，全部失败时保留旧数据不生成伪成功快照
- **多源接口管理**：采集完全由后台「接口管理」驱动——新安装仅预置 AI圈报 RSS，可随时添加公开 HTTPS JSON、RSS 或 Atom 接口（字段映射支持 `links.original` 等嵌套点路径）。自定义来源最多 50 条、响应不超过 2 MB、并发不超过 3，并阻止内网 DNS、保留 IP 与未校验重定向；full 预设预置 arXiv、DEV Community、AI Insight 三个公开外部源
- **采集核实与情报库**：校验响应结构、标题有效性和数据量异常下降；按来源 ID、规范化原文链接、标题+信源多标识核实合并；人工编辑和回收站状态不会被后续采集覆盖
- **历史留档**：每次采集保留快照索引；内容哈希排除采集时间，真正相同的快照用 `sameAs` 引用而不重复写文件；接口失效时继续提供最近有效数据
- **永久分区访问统计**：前台页面、后台管理、公开 API/点击、静态资源与其他请求分别记录 PV、按日 UV、按日独立 IP 和请求数；保留总计、逐路径排行、7 天至 10 年趋势与全部月度历史。流水 jsonl 和 v2 日聚合均不自动删除，旧流水启动时自动补建分类明细；IP 仅哈希化存储
- **管理后台 API**：登录会话（httpOnly cookie + 滑动续期）、账号管理、数据概览、统计查询、快照管理、采集控制、日志、运行设置、GitHub/Gitee 在线更新与系统信息
- **性能**：`/api/data` 预序列化 + 预压缩缓冲（热路径零压缩开销）、全站 gzip、ETag 304、静态文件内存缓存、统计批量异步落盘（请求路径零磁盘 IO）
- **安全**：scrypt 密码哈希、timingSafeEqual、会话 token 哈希存储、登录限流（15 分钟 10 次）、跨域写防护、公开刷新限流（10 分钟 1 次）、目录穿越防护

### SEO 与文章展示

- 后台独立「SEO 管理」可编辑网站完整标题、短标题、描述、关键词、HTTPS 根域名和索引开关
- 首页、文章页、分类页、RSS、Sitemap、robots.txt 和 JSON-LD 会同步使用当前配置；`/rss.xml` 保持标准 XML，浏览器访问会进入服务端渲染的 `/rss` 阅读页，不再依赖逐步淘汰的 XSLT
- 后台展示搜索结果预览、已发布文章数、Sitemap URL 数、RSS 条目、关键词出现次数及分类覆盖统计

- `/article/:id` 服务端渲染情报详情，展示摘要、分类、信源、日期、原始信息入口与同类推荐
- `/category/:slug` 提供模型、产品、行业、论文、技巧五类可索引专题页
- 首页、文章页和分类页均带 canonical、description、keywords、robots、Open Graph、Twitter Card 和 Schema.org JSON-LD
- `/sitemap.xml` 自动包含首页、分类与所有已发布情报；`/rss.xml` 输出最近 50 条内容；`robots.txt` 明确站点地图位置

### 管理后台（frontend/admin.html，`/chenfengadmin`）

| 视图 | 功能 |
|---|---|
| 数据概览 | 完整访问、情报库存、今日新增、累计去重、独立信源、近 14 天访问/库存/新增/去重精确曲线、最近采集记录 |
| 访问统计 | 7 天至 10 年趋势；前台/后台/API/资源/其他分区 PV·UV·IP·请求；永久月度汇总、页面与全部路径排行、实时访问流水 |
| 情报管理 | 搜索和分类/状态筛选，快速查看摘要和原文，手工新增、编辑、发布/草稿/归档、删除到回收站及恢复 |
| 接口管理 | 默认 AI圈报 RSS、自定义 JSON/RSS/Atom 增删改查、字段映射、发布策略、真实检测、响应预览和独立日志 |
| SEO 管理 | 标题、描述、关键词、域名、索引开关，搜索结果预览、关键词与分类覆盖、Sitemap/RSS/robots 快捷查看 |
| 数据快照 | 全部历史快照分页列表（条数/大小/SHA/耗时/成败）、快照详情弹层、手动采集、删除快照 |
| 采集日志 | 按天查看采集日志（成功/失败/登录审计），最近 100–1000 行 |
| 系统设置 | 修改账号、采集/保留/会话参数、自定义前台 Header 横幅或弹窗（安全 HTML、可留空）、服务信息 |
| 在线更新 | 从 GitHub 或 Gitee 检查版本；确认后备份完整运行数据与代码、校验安装包、安装依赖并平滑重载，失败自动恢复旧代码 |
| 关于系统 | 显示当前系统版本、作者 chenfeng、运行环境、GitHub/Gitee、哔哩哔哩主页及 CPAL-1.0 协议说明 |

**首次登录**：用户名 `admin`，初始密码在启动日志或 `server/data/auth/initial-password.txt`，登录后请立即修改。

## API 一览

| 端点 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/` `/chenfengadmin` | GET | 无 | 公开看板 / 管理后台页面（旧 `/admin` 返回 404） |
| `/api/data`（或 `/api/d`） | GET | 无 | 最新快照 JSON（gzip + ETag 304） |
| `/api/history` | GET | 无 | 永久情报库；支持 `range=24h|7d|30d|all`、搜索、分类与分页 |
| `/api/site-settings` | GET | 无 | 公开页面扩展配置（自定义 Header 内容经过安全过滤） |
| `/article/:id` `/category/:slug` | GET | 无 | 服务端渲染的情报详情 / 分类专题页 |
| `/sitemap.xml` `/rss.xml` `/rss` | GET | 无 | 搜索引擎站点地图 / 标准 RSS 订阅源 / 浏览器阅读页 |
| `/health` | GET | 无 | 健康检查（快照数 / 下次采集 / 运行时长） |
| `/api/refresh` | GET | 限流 | 手动触发采集（每 IP 10 分钟 1 次） |
| `/api/admin/login` | POST | 限流 | 登录（15 分钟 10 次） |
| `/api/admin/logout` `me` | POST/GET | 会话 | 登出 / 当前用户信息 |
| `/api/admin/password` `username` | POST | 会话 | 修改密码 / 用户名 |
| `/api/admin/overview` | GET | 会话 | 概览（快照/统计/采集/内存/配置） |
| `/api/admin/stats?days=` | GET | 会话 | 访问统计（日序列/月度/Top/最近） |
| `/api/admin/intelligence` | GET/POST | 会话 | 情报搜索分页 / 手工新增 |
| `/api/admin/intelligence/:id` | GET/PATCH/DELETE | 会话 | 查看 / 编辑 / 移入回收站（`/restore` 恢复） |
| `/api/admin/intelligence/trend` | GET | 会话 | 情报库存、新增、更新、去重、无效数据日序列 |
| `/api/admin/endpoints` | GET/POST | 会话 | 多源配置概览 / 新增自定义 JSON、RSS、Atom 接口 |
| `/api/admin/endpoints/:id` | GET/PATCH/DELETE | 会话 | 接口详情 / 编辑 / 删除自定义接口 |
| `/api/admin/endpoints/:id/test` | POST | 会话 | 真实调用并记录状态、响应预览与缓存头 |
| `/api/admin/endpoints/logs` | GET | 会话 | 全部或指定接口的调用审计日志 |
| `/api/admin/seo` | GET/POST | 会话 | SEO 设置、关键词与分类覆盖统计 / 保存并即时生效 |
| `/api/admin/snapshots` `/snapshots/:id` | GET/DELETE | 会话 | 快照列表 / 详情 / 删除 |
| `/api/admin/collect` | POST | 会话 | 立即采集一次 |
| `/api/admin/logs?date=&lines=` | GET | 会话 | 采集日志（按天） |
| `/api/admin/settings` | GET/POST | 会话 | 运行参数查看 / 修改 |
| `/api/admin/about` | GET | 会话 | 系统版本、作者、运行环境和开源项目链接 |
| `/api/admin/update` | GET | 会话 | 在线更新源、运行状态与安全机制概览 |
| `/api/admin/update/check` | POST | 会话 | 从指定 GitHub/Gitee 仓库检查最新版本 |
| `/api/admin/update/apply` | POST | 会话 | 确认版本后异步备份、安装并平滑重载 |

## 数据目录结构（server/data/）

```
data/
├── latest.json            当前快照（/api/data 消费；旧版 data.json 自动迁移）
├── config.json            运行配置（采集/保留/会话 / 自定义 Header）
├── intelligence/
│   └── items.json         去重后的单条情报库、人工编辑、状态和采集质量趋势
├── endpoints/
│   ├── config.json        接口名称、启停、URL、超时与重试配置
│   ├── state.json         接口健康状态、累计指标与最近 2000 条调用日志
│   └── cache/             日报归档及后台检测响应的安全预览
├── history/
│   ├── index.json         快照索引（时间/条数/大小/sha256/耗时/成败）
│   └── snap-*.json        全量快照文件（内容相同自动去重复用）
├── stats/
│   ├── daily.json         日聚合（pv/uv/ips/api/hits）
│   └── visits-*.jsonl     当日访问流水（IP 已哈希）
├── auth/
│   ├── users.json         管理账号（scrypt 哈希，不存明文）
│   ├── sessions.json      会话（仅存 token 哈希）
│   └── initial-password.txt  首次启动的初始密码（改密后自动删除）
└── logs/
    └── collect-*.log      采集日志（按天滚动，含登录审计）
```

## 本地启动与测试

```bash
cd server
node server.js 3001        # 默认 http://localhost:3001（端口被占用时换一个）

# 全部测试（临时数据目录，不污染真实数据）
npm test

# 接口注册、SSRF 白名单、日期解析、配置/状态/日志持久化（16 项）
node scripts/endpoint_registry_test.js

# 快照去重引用、多标识去重、人工覆盖、公开历史分页和跨重启持久化（13 项）
node scripts/intelligence_store_test.js

# 前端语法检查（index.html + admin.html）
node scripts/check_frontend.js
```

打开 http://localhost:3001/ 即完整看板；http://localhost:3001/chenfengadmin 为管理后台（首次启动控制台会打印初始密码）。

环境变量：`AIQB_PORT` / `AIQB_HOST` / `AIQB_DATA_DIR`（默认 `server/data`）。

## 部署与升级

- **全新部署与升级**统一用一键脚本（重复执行会自动备份旧版本并保留 `server/data/` 运行数据）：

  ```bash
  sudo bash install.sh your-domain.com [email]
  ```

- **旧版手动升级**（已部署旧版 server.js + data.json）：在仓库根目录执行

  ```bash
  cp server/server.js /opt/ai-dashboard/server/
  cp -r server/lib /opt/ai-dashboard/server/
  cp -r frontend/. /opt/ai-dashboard/frontend/
  pm2 restart aiqb-web
  pm2 logs aiqb-web --lines 30 | grep 初始密码   # 获取后台初始密码
  ```

  旧 `data.json` 首次启动自动迁移为第一份历史快照；`server/data/` 运行数据不会被覆盖。

## 文档与社区

| 文档 | 说明 |
|---|---|
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 开发环境、代码约定、测试、采集源要求和 Pull Request 清单 |
| [`SECURITY.md`](./SECURITY.md) | 支持版本、私密漏洞报告、响应时限、威胁边界和安全测试规则 |
| [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) | 社区行为标准、投诉方式和分级处理原则 |
| [`LICENSE`](./LICENSE) | CPAL-1.0 完整英文法律文本及 AIQB Exhibit A/B |
| [`LICENSE.zh-CN.md`](./LICENSE.zh-CN.md) | 商业使用、来源署名和网络部署义务的中文理解说明 |
| [`NOTICE`](./NOTICE) | 作者、官方仓库和前端归属信息 |

普通缺陷和功能建议可以使用 GitHub/Gitee Issue；未修复漏洞和包含个人信息的社区投诉必须使用相应文档中的私密邮箱，不要公开披露。

## 开源协议

AIQB 采用 [Common Public Attribution License 1.0](./LICENSE)，SPDX 标识为 `CPAL-1.0`。在遵守完整协议的前提下，可以免费用于个人、组织和商业场景，包括部署收费服务或通过系统运营盈利。

| 场景 | 要求摘要 |
|---|---|
| 直接部署原版 | 保留许可证、NOTICE，以及前端项目来源署名 |
| 修改后自己使用 | 保留修改记录和适用的源代码通知 |
| 修改后提供网络服务 | 按 CPAL-1.0 第 15 条把 External Deployment 视为分发，并提供对应源码 |
| 再分发或集成到 Larger Work | 保留协议赋予的源码权利和 Exhibit B 归属信息 |
| 收费运营、支持或维护 | 允许，但额外承诺只能由提供者自己承担，不能代表原作者或贡献者 |

前端必须以合理可见、可以正常点击的方式保留：

```text
设计与开发由 AIQB
https://github.com/chenfengyimei/AIQB
```

不得删除、隐藏、遮挡或使链接失效。后台的版权和备案设置不影响这项固定来源署名。中文摘要请阅读 [`LICENSE.zh-CN.md`](./LICENSE.zh-CN.md)；法律权利和义务以 [`LICENSE`](./LICENSE) 为准。

## 部署历史

- 2026-08-31 v2.25.0：补全关于系统的 GitHub/Gitee、作者哔哩哔哩主页和协议说明；项目改用 CPAL-1.0，允许商业运营并固定保留前端项目来源署名
- 2026-08-31 v2.24.0：后台新增 GitHub/Gitee 在线更新与关于系统；更新前校验版本和包结构，备份完整数据与代码，保留 `server/data`，失败自动回滚
- 2026-08-31 v2.23.1：恢复完整生产采集、热点、日报与双池同步兼容；增加采集器心跳、短租约锁、忙锁/失败自动重试、核心失败不覆盖健康快照，以及升级前完整数据压缩包和 SQLite 事务一致备份
- 2026-08-31 v2.23.0：新增跨平台首次安装向导与 Linux 一键安装/升级流程；新安装接口列表仅预置 AI圈报 RSS，支持纯 RSS 首次采集、旧版接口预设无损兼容与安装专项验证
- 2026-08-28 21:00 起开始部署
- 2026-08-28 23:30 完成首次部署到 CloudStudio（静态版）
- 2026-08-29 01:00 改为前后端分离架构
- 2026-08-29 03:18 部署到自有服务器（OpenCloudOS 9.4 + 宝塔）
- 2026-08-29 04:30 CDN 改 HTTP 回源，线上完全打通
- 2026-08-29 05:00 v2.0：模块化后端 + 历史快照留档 + 访问统计 + 管理后台
- 2026-08-29 19:36 v2.1：今日日报前置、前端按需渲染、后台体验升级，入口迁移至 `/chenfengadmin`
- 2026-08-29 20:30 v2.2：内容级快照去重、单条情报仓库与 CRUD、精确情报曲线、自定义前台 Header
- 2026-08-29 v2.3：采集分区容错与质量门禁、多标识去重、情报详情/专题页、站点地图、RSS 和结构化 SEO
- 2026-08-29 v2.4：核实上游 OpenAPI 规范，新增日报归档采集与 9 项接口后台注册中心、编辑、检测、响应预览及独立日志
- 2026-08-29 v2.5：接入 arXiv 与 DEV/Forem，支持安全自定义 JSON/RSS/Atom；新增完整 SEO 管理与统计，优化系统设置表单布局
- 2026-08-29 v2.6：RSS 增加浏览器阅读界面；访问统计升级为永久分区数据、逐路径 PV/UV/IP、10 年趋势与旧流水自动迁移
- 2026-08-29 v2.7：公开看板增加 24h/7d/30d/全部历史、分类/时间线双视图和分页历史接口；文章、分类、RSS、Sitemap 改为读取永久情报库
- 2026-08-30 v2.10.0：接入全量情报池（`mode=all` 7 天滚动窗口分页同步，新增 `itemsAll7d` 端点与 `sync/allpool-state.json` 状态）——普通情报（每天约 200-350 条）直接发布进入时间线，看板历史视图标注「精选/普通」，补齐此前只采集精选导致的每日数据缺口；归档条目被上游重新收录时自动恢复
- 2026-08-30 v2.9.0：优化前端信息密度与响应式布局；时间窗改为对称、不可截断的起止时间组件；情报卡片新增模型/品牌自动识别标签和一键筛选，来源链接改为简洁域名展示，并减少重复吸顶和面板嵌套
- 2026-08-30 v2.8.4：修复新版本浏览器停用 XSLT 后 RSS 显示为原始文本的问题；`/rss.xml` 改用浏览器继续支持的 XML+CSS 卡片样式，并保留 `/rss` 服务端阅读页与 `/feed.xml` 订阅别名
- 2026-08-30 v2.8：启用精选池全量同步（`/selected/snapshot` 引导 + `/selected/changes` 增量）——首轮采集自动分页引导数千条全量精选入库，此后每轮按 cursor 增量（upsert/remove），409 自动重新引导；新增 `sync/state.json` 状态、后台同步状态/手动触发接口与同步专项测试

## 关键踩坑记录

要点：
1. 部分上游 API 屏蔽浏览器 UA → 后端用服务端 UA 采集
2. nginx 重载：`systemctl` 失败 → 用 `kill -HUP $(cat nginx.pid)`
3. 端口冲突：3000 被占用 → 后端换 3001
4. CDN「协议跟随」HTTPS 回源到 443，443 server block 配置错误返回 403 → CDN 改 HTTP 回源解决
5. CDN 节点缓存旧 403 → 前端 fetch 加 `?_t=时间戳` + `cache: 'no-store'` 绕过

## 运维速查

```bash
# 查看后端状态
pm2 status
pm2 logs aiqb-web --lines 50

# 手动触发采集（限流：每 IP 10 分钟 1 次；后台页面不受限）
curl http://127.0.0.1:3001/api/refresh

# 重启后端
pm2 reload aiqb-web && pm2 restart aiqb-collector

# 重载 nginx（不重启服务）
kill -HUP $(cat /www/server/nginx/logs/nginx.pid)

# 查看实时数据
curl http://127.0.0.1:3001/api/d | head -c 300

# 备份全部运行数据（快照历史/统计/账号/日志）
tar czf aiqb-data-backup.tar.gz /opt/ai-dashboard/server/data/

# 一键升级会自动写入 /opt/ai-dashboard-backups/<时间>/
# 其中 server-data.tar.gz 是完整目录备份，
# aiqb.sqlite.consistent-backup 是可直接恢复的 SQLite 事务一致副本。

# 忘记后台密码：删除账号目录后重启，会重新生成 admin + 初始密码
rm -rf /opt/ai-dashboard/server/data/auth && pm2 reload aiqb-web && pm2 restart aiqb-collector
```
