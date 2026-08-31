# AIQB — 可自托管的 AI 情报聚合与管理系统

> 开源、可自托管的一站式 AI 情报平台：自动采集、校验、去重、分类和长期保存公开信息，并提供中英文内容网站、文章与 SEO、数据统计及完整管理后台。

AIQB 面向个人站长、开发者、团队和内容运营者，把分散在 JSON、RSS、Atom 与其他公开信息源中的内容，转化为属于自己的、可持续更新的 AI 情报库。系统覆盖从采集、质量核实和多标识去重，到人工管理、前台发布、搜索引擎收录和运营分析的完整流程。

所有情报、快照、配置和统计均保存在部署者自己的服务器中。即使外部接口失效，已经归档的内容仍可继续阅读、检索和管理；采集源、站点品牌及展示方式也可以在后台自由扩展。

[在线演示](https://chenqiyuan.cn/) | [English Overview](#english-overview) | [快速开始](#快速开始) | [功能详解](#功能详解) | [部署说明](#部署与升级) | [贡献指南](./CONTRIBUTING.md) | [安全策略](./SECURITY.md) | [行为准则](./CODE_OF_CONDUCT.md) | [开源协议](#开源协议)

---

## English Overview

AIQB is an open-source, self-hosted AI intelligence platform for individuals, teams, developers, and content publishers. It continuously collects public JSON, RSS, and Atom feeds, validates and deduplicates incoming items, classifies and archives them locally, and publishes the results through a bilingual website with article pages, SEO, analytics, health monitoring, and a complete administration console.

Your intelligence library, snapshots, settings, and analytics remain on your own server. Previously archived content stays searchable even when an upstream feed becomes unavailable, while new sources, branding, and publishing options can be managed and extended from the backend.

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
| 多源采集 | 支持 JSON、RSS、Atom 与后台自定义 HTTPS 接口，带超时、重试、质量门禁和 URL/DNS 安全校验 |
| 情报仓库 | 多标识去重、分类与层级、发布/草稿/归档/回收站、人工覆盖优先和批量管理 |
| 历史保存 | SQLite WAL、不可变数据索引、历史快照与长期访问统计，接口失效后仍可读取旧数据 |
| 阅读前台 | 首页精选、完整情报流、热点、日报、时间线、搜索、深浅主题与中英文界面 |
| 文章与 SEO | 服务端文章/分类页、canonical、JSON-LD、RSS、Sitemap、robots.txt 与多语言索引 |
| 完整后台 | 概览、情报、接口、SEO、统计、健康、邮箱、友链、设置、在线更新和关于系统 |
| 性能架构 | 公共索引、LRU、预压缩、ETag、静态缓存、多 Web 实例和独立采集 Worker |
| 安全边界 | scrypt、会话哈希、同源写保护、登录限流、请求限制、URL/DNS 校验、签名更新和数据目录隔离 |

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
- 首次账号：运行 `npm run admin:bootstrap`，在本机终端一次性设置密码（不回显、不落明文）

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
用户浏览器 ──HTTPS──▶ 可选 CDN ──HTTPS──▶ 源站 Nginx
                                                         │
                                                         反向代理
                                                      → 127.0.0.1:3001
                                                               │
                                                               ▼
                                                       PM2 Web 双实例
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
| 权限 | 独立 `aiqb` 系统账号，Node 仅监听回环地址 |
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
- **多源接口管理**：采集完全由后台「接口管理」驱动——新安装仅预置 AI圈报 RSS，可随时添加公开 HTTPS JSON、RSS 或 Atom 接口（字段映射支持 `links.original` 等嵌套点路径）。自定义来源最多 50 条、响应传输体与解压体均不超过 2 MB、并发不超过 3；每次请求和重定向都会重新解析并校验全部 DNS 结果，再把实际连接固定到已验证公网 IP，阻止 DNS 重绑定与内网访问；full 预设预置 arXiv、DEV Community、AI Insight 三个公开外部源
- **采集核实与情报库**：校验响应结构、标题有效性和数据量异常下降；按来源 ID、规范化原文链接、标题+信源多标识核实合并；人工编辑和回收站状态不会被后续采集覆盖
- **历史留档**：每次采集保留快照索引；内容哈希排除采集时间，真正相同的快照用 `sameAs` 引用而不重复写文件；接口失效时继续提供最近有效数据
- **永久分区访问统计**：前台页面、后台管理、公开 API/点击、静态资源与其他请求分别记录 PV、按日 UV、按日独立 IP 和请求数；保留总计、逐路径排行、7 天至 10 年趋势与全部月度历史。流水 jsonl 和日聚合均不自动删除；仅保存用于日级去重的哈希、脱敏 IP 网段及地域，不保存完整 IP 明文
- **管理后台 API**：登录会话（httpOnly cookie + 滑动续期）、账号管理、数据概览、统计查询、快照管理、采集控制、日志、运行设置、GitHub/Gitee 在线更新与系统信息
- **性能**：`/api/data` 预序列化 + 预压缩缓冲（热路径零压缩开销）、全站 gzip、ETag 304、静态文件内存缓存、统计批量异步落盘（请求路径零磁盘 IO）
- **安全**：scrypt 密码哈希、首次口令不落明文、SQLite 共享会话与登录限流、可信反代 IP 边界、所有管理写操作同源校验、统一 SSRF/DNS 重绑定防护、有界流式响应、签名更新与目录穿越防护；采集只能在登录后台或独立 Worker 中触发

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
| 在线更新 | 从 GitHub 或 Gitee 检查版本；绑定不可变提交并验证 Ed25519 签名与逐文件 SHA-256，备份后安装、平滑重载并执行健康检查，失败自动恢复旧代码 |
| 关于系统 | 显示当前系统版本、作者 chenfeng、运行环境、GitHub/Gitee、哔哩哔哩主页及 CPAL-1.0 协议说明 |

**首次登录**：先在服务器本机运行 `npm run admin:bootstrap` 设置 12–128 位管理员密码，再以用户名 `admin` 登录。系统只保存 scrypt 哈希，不会生成明文密码文件或把密码写入日志。

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
│   ├── sessions.json      会话回滚副本（仅存 token 哈希）
│   └── users.json         管理账号回滚副本（仅存 scrypt 哈希）
└── logs/
    └── collect-*.log      采集日志（按天滚动，含登录审计）
```

## 本地启动与测试

```bash
cd server
cd ..
npm run setup
npm run admin:bootstrap    # 密码在本机终端安全输入，不回显、不落明文
npm start                  # 默认仅监听 http://127.0.0.1:3001

# 全部测试（临时数据目录，不污染真实数据）
npm test

# 接口注册、DNS 固定与 SSRF 防护、日期解析、配置/状态/日志持久化
node scripts/endpoint_registry_test.js

# 快照去重引用、多标识去重、人工覆盖、公开历史分页和跨重启持久化（13 项）
node scripts/intelligence_store_test.js

# 前端语法检查（index.html + admin.html）
node scripts/check_frontend.js
```

打开 http://localhost:3001/ 即完整看板；http://localhost:3001/chenfengadmin 为管理后台。

环境变量：`AIQB_PORT` / `AIQB_HOST` / `AIQB_DATA_DIR`（默认 `server/data`）。生产默认只监听 `127.0.0.1`；仅在容器网络等明确隔离场景中显式改为 `0.0.0.0`。`AIQB_TRUSTED_PROXIES` 只应填写直接连接 Node 的本机反向代理，CDN 真实 IP 必须先由 Nginx 按厂商官方 CIDR 校验并覆盖为 `X-Real-IP`。使用自定义数据目录时必须把它放在应用目录之外，在线更新会拒绝任何与应用目录重叠的自定义路径，以防源码替换覆盖运行数据。

## 部署与升级

- **全新部署与升级**统一用一键脚本（重复执行会自动备份旧版本并保留 `server/data/` 运行数据）：

  ```bash
  sudo bash install.sh your-domain.com [email]
  ```

  安装器会创建独立 `aiqb` 系统账号、让 Node 仅监听回环地址、要求 HTTPS 成功后才保持服务运行，并在本机终端一次性设置管理员密码。生产安全组/主机防火墙仍应只向公网开放 80/443，禁止访问 3000、3001、3002 等 Node 原始端口；CDN 回源也应使用 HTTPS。曾经出现在聊天、日志、脚本或明文 HTTP 请求中的 SSH 私钥、后台密码和百度推送 Token 必须在对应平台轮换，代码更新无法代替凭据撤销。

- **旧版手动升级**（已部署旧版 server.js + data.json）：在仓库根目录执行

  ```bash
  cp server/server.js /opt/ai-dashboard/server/
  cp -r server/lib /opt/ai-dashboard/server/
  cp -r frontend/. /opt/ai-dashboard/frontend/
  sudo -u aiqb pm2 reload aiqb-web
  ```

  旧 `data.json` 首次启动自动迁移为第一份历史快照；`server/data/` 运行数据不会被覆盖。

## 文档与社区

| 文档 | 说明 |
|---|---|
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 开发环境、代码约定、测试、采集源要求和 Pull Request 清单 |
| [`SECURITY.md`](./SECURITY.md) | 支持版本、私密漏洞报告、响应时限、威胁边界和安全测试规则 |
| [`RELEASING.md`](./RELEASING.md) | 版本检查、Ed25519 发布签名、校验、打包和密钥轮换流程 |
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
