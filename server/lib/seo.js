// seo.js — 无依赖的服务端 SEO 页面、站点地图与 RSS 生成器

'use strict';

const { isEnglishItem } = require('./intelligence-store');

let SITE_URL = String(process.env.AIQB_SITE_URL || 'https://chenqiyuan.cn').replace(/\/+$/, '');
let SITE_TITLE = 'AI圈报（AIQB）- 每日AI资讯、大模型动态、AI产品与行业热点';
let SITE_NAME = 'AI圈报';
let SITE_DESCRIPTION = 'AI圈报（AIQB）每天整理全球 AI 资讯，覆盖 OpenAI、DeepSeek、Qwen、Claude、Gemini 等大模型，以及 AI 产品、行业、论文、教程、热点与日报。';
let SITE_KEYWORDS = 'AIQB,AI圈报,AI资讯,人工智能资讯,AI新闻,大模型,大模型动态,AI产品,AI热点,AI日报,生成式AI,AI论文,AI教程,OpenAI,DeepSeek,Qwen,Claude,Gemini';
let ENGLISH_TITLE = 'AIQB - Daily AI News, Model Releases and Industry Intelligence';
let ENGLISH_DESCRIPTION = 'AIQB (AI圈报) tracks daily AI news, model releases, AI products, industry developments, research papers, practical tutorials and emerging technology trends from trusted sources worldwide.';
let ENGLISH_KEYWORDS = 'AIQB,AI圈报,AI news,artificial intelligence news,large language models,LLM news,AI model releases,AI products,AI research,AI papers,AI tutorials,OpenAI,DeepSeek,Qwen,Claude,Gemini';
let INDEXING_ENABLED = true;
let FOOTER_ENABLED = true;
let FOOTER_COPYRIGHT = '2025–2026 Copyright © AI圈报';
let FOOTER_ICP_NUMBER = '粤ICP备2025432484号';
let FOOTER_ICP_URL = 'https://beian.miit.gov.cn/';
let BRAND_ALIAS = 'AIQB';
let BRAND_TAGLINE = '每天看懂 AI 圈正在发生什么';
let BRAND_ENGLISH_TAGLINE = 'Understand what is happening in AI, every day';
let BRAND_LOGO_URL = '/favicon.svg';
let BRAND_FAVICON_URL = '/favicon.ico';
const CATEGORIES = [
  { slug: 'ai-models', label: 'AI 模型发布与更新', short: '模型发布 / 更新', description: '追踪 OpenAI、DeepSeek、Qwen、Claude、Gemini、GLM、Grok 等大模型的发布、能力升级、开源权重与 API 变化。' },
  { slug: 'ai-products', label: 'AI 产品发布与更新', short: '产品发布 / 更新', description: '发现 AI 应用、智能体、开发工具、生成式 AI 产品及重要功能升级，快速了解新产品能做什么。' },
  { slug: 'industry', label: '人工智能行业动态', short: '行业动态', description: '关注人工智能公司的融资、合作、政策、商业战略与全球 AI 产业变化。' },
  { slug: 'paper', label: 'AI 论文与研究', short: '论文研究', description: '整理大模型、智能体、多模态、机器学习与生成式 AI 的论文、基准和研究进展。' },
  { slug: 'tutorial', label: 'AI 教程与实战', short: '教程 / 实战', description: '收录 AI 工具教程、提示词、安装部署、配置指南、开发实战与可复现步骤。' },
  { slug: 'tip', label: 'AI 观点与方法', short: '观点 / 方法', description: '汇总 AI 使用技巧、实践方法、效率经验、行业观察与专业观点。' },
];
const CATEGORY_MAP = new Map(CATEGORIES.map((category) => [category.slug, category]));
const ENTITY_RULES = [
  ['OpenAI', /\bOpenAI\b/i], ['ChatGPT', /\bChatGPT\b/i], ['GPT', /\bGPT(?:[-\s]?\d+(?:\.\d+)?)?\b/i],
  ['DeepSeek', /\bDeepSeek\b/i], ['Qwen', /\bQwen(?:[-\s]?\d+(?:\.\d+)?)?\b|通义千问|千问/i],
  ['Claude', /\bClaude(?:[-\s]?\d+(?:\.\d+)?)?\b|Anthropic/i], ['Gemini', /\bGemini(?:[-\s]?\d+(?:\.\d+)?)?\b|Google DeepMind/i],
  ['GLM', /\b(?:Chat)?GLM(?:[-\s]?\d+(?:\.\d+)?)?\b|智谱/i], ['Grok', /\bGrok(?:[-\s]?\d+(?:\.\d+)?)?\b|\bxAI\b/i],
  ['Llama', /\bLlama(?:[-\s]?\d+(?:\.\d+)?)?\b|Meta AI/i], ['豆包', /豆包|Doubao/i],
  ['Kimi', /\bKimi\b|Moonshot|月之暗面/i], ['NVIDIA', /NVIDIA|英伟达/i], ['Hugging Face', /Hugging\s*Face/i],
  ['Cursor', /\bCursor\b/i], ['Ollama', /\bOllama\b/i], ['Mistral', /\bMistral\b/i],
];

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function plain(value, limit) {
  const result = String(value == null ? '' : value)
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return limit && result.length > limit ? result.slice(0, limit - 1) + '…' : result;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch (error) { return ''; }
}

function safeAssetUrl(value, fallback) {
  const input = String(value || '').trim();
  if (/^\/(?!\/)/.test(input) && !/[\\\r\n]/.test(input)) return input;
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : fallback;
  } catch (error) { return fallback; }
}

function absoluteAssetUrl(value) {
  return /^\/(?!\/)/.test(value) ? SITE_URL + value : value;
}

function renderFooterCopyright() {
  // CPAL-1.0 Exhibit B attribution: redistributed or hosted versions must not remove or hide this notice.
  const projectAttribution = '<span class="project-attribution">设计与开发由 <a href="https://github.com/chenfengyimei/AIQB" target="_blank" rel="noopener noreferrer">AIQB</a></span>';
  const filingUrl = safeUrl(FOOTER_ICP_URL);
  const filing = FOOTER_ENABLED && FOOTER_ICP_NUMBER
    ? (filingUrl ? '<a href="' + esc(filingUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(FOOTER_ICP_NUMBER) + '</a>' : '<span>' + esc(FOOTER_ICP_NUMBER) + '</span>') : '';
  const copyright = FOOTER_ENABLED && FOOTER_COPYRIGHT ? '<span>' + esc(FOOTER_COPYRIGHT) + '</span>' : '';
  const separator = copyright && filing ? '<span class="footer-dot" aria-hidden="true">·</span>' : '';
  return '<div class="footer-copy">' + projectAttribution + copyright + separator + filing + '</div>';
}

function itemTime(item, fallback) {
  const raw = item && (item.publishedAt || item.discoveredAt) || fallback;
  const date = new Date(raw || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function sourceName(item) {
  return plain(item && item.source && item.source.name || SITE_NAME, 120);
}

function entityKeywords(item) {
  const text = plain([item && item.title, item && item.originalTitle, item && item.summary, sourceName(item)].filter(Boolean).join(' '), 9000);
  return ENTITY_RULES.filter((entry) => entry[1].test(text)).map((entry) => entry[0]).slice(0, 8);
}

function articlePath(item) {
  return item && /^intel-[a-f0-9]{16,32}$/.test(String(item._intelId || ''))
    ? '/article/' + item._intelId : '';
}

function collectItems(data, language) {
  const indexed = data && data._seo && (language === 'en' ? data._seo.en : data._seo.all);
  if (indexed && Array.isArray(indexed.rows)) return indexed.rows;
  const result = [];
  const seen = new Set();
  const add = (item) => {
    const path = articlePath(item);
    if (!path || seen.has(item._intelId)) return;
    seen.add(item._intelId);
    result.push(item);
  };
  for (const item of (data && data.window7d || [])) add(item);
  for (const item of (data && data.window24h || [])) add(item);
  for (const item of (data && data.hot || [])) add(item);
  const sections = data && data.daily && data.daily.report && data.daily.report.sections;
  if (Array.isArray(sections)) for (const section of sections) for (const item of (section.items || [])) add(item);
  for (const item of (data && data.history || [])) add(item);
  result.sort((a, b) => itemTime(b, data && data.fetchedAt).localeCompare(itemTime(a, data && data.fetchedAt)));
  return language === 'en' ? result.filter(isEnglishItem) : result;
}

const ENGLISH_REPLACEMENTS = [
  ['每天看懂 AI 圈正在发生什么', 'Understand what is happening in AI, every day'],
  ['每天看懂 AI 圈', 'Understand AI, every day'],
  ['搜索模型、产品或公司，例如 DeepSeek / OpenAI', 'Search models, products or companies, e.g. DeepSeek / OpenAI'],
  ['先看精选，再读最新；模型、产品、行业与研究动态持续更新。', 'Start with selected stories, then scan the latest model, product, industry and research updates.'],
  ['按时间、重要程度和主题筛选，快速找到你想看的内容。', 'Filter by time, importance and topic to find the intelligence you need.'],
  ['追踪正在升温的模型、产品与行业话题。', 'Track models, products and industry topics gaining momentum.'],
  ['按日期回看每日重点，用章节快速定位关注方向。', 'Review daily highlights by date and jump between topics.'],
  ['近 24 小时最新动态，已过滤重复内容', 'Latest updates from the past 24 hours, with duplicates removed'],
  ['近 24 小时真实精选', 'Selected stories from the past 24 hours'],
  ['近 7 天真实精选', 'Selected stories from the past 7 days'],
  ['没有符合当前条件的情报，请尝试切换时间、层级、主题或关键词。', 'No intelligence matches these filters. Try another time range, tier, topic or keyword.'],
  ['点击日期可展开或收起当天内容', 'Select a date to expand or collapse its stories'],
  ['统计与内容均来自服务器保存的历史快照', 'Statistics and content come from saved server snapshots'],
  ['综合分类、实体标签与信息来源匹配', 'Matched by category, entity tags and source'],
  ['当前暂无已发布文章。', 'No published articles are available yet.'],
  ['当前暂无内容，请稍后再来。', 'No content is available yet. Please check back later.'],
  ['当前记录已保存标题、分类与来源，详细内容请通过原始信息链接查看。', 'This record preserves its title, category and source. Open the original source for full details.'],
  ['正在加载今天的 AI 动态…', 'Loading AI updates for today…'],
  ['正在准备近 7 天精选…', 'Preparing the 7-day selection…'],
  ['正在整理每日简报…', 'Preparing the daily brief…'],
  ['正在更新热点…', 'Updating trending stories…'],
  ['正在查找情报…', 'Finding intelligence…'],
  ['正在更新内容…', 'Refreshing content…'],
  ['每 10 分钟更新一次，仅展示概况', 'Updated every 10 minutes · overview only'],
  ['约每 10 分钟自动更新', 'Refreshes about every 10 minutes'],
  ['查看网站健康状态', 'View site health'], ['关闭健康状态', 'Close site health'],
  ['网站健康状态', 'Site health'], ['实时概况', 'Live overview'], ['整体状态', 'Overall status'],
  ['服务运行', 'Service availability'], ['访问响应', 'Response'], ['内容更新', 'Content freshness'], ['数据来源', 'Sources'],
  ['运行良好', 'All systems healthy'], ['需要关注', 'Some systems need attention'], ['状态波动', 'Service is degraded'],
  ['正在获取状态', 'Checking status'], ['状态暂不可用', 'Status temporarily unavailable'], ['最近更新：', 'Last updated: '],
  ['近 24 小时暂无精选，稍后再来看看。', 'No selected stories from the past 24 hours yet. Please check back later.'],
  ['近 7 天暂无精选。', 'No selected stories from the past 7 days.'],
  ['条重点已按主题整理，适合快速通读', ' highlights organized by topic for a quick read'],
  ['个正在关注的主题', ' trending topics'],
  ['暂未采集到日报。', 'No daily brief has been collected yet.'], ['暂无日报', 'No daily brief'],
  ['数据加载失败：', 'Unable to load data: '], ['加载失败', 'Load failed'], ['加载中…', 'Loading…'], ['继续加载', 'Load more'], ['重试', 'Retry'],
  ['未命名情报', 'Untitled intelligence'], ['未知来源', 'Unknown source'], ['稍后再来看看。', 'Please check back later.'],
  ['友情链接列表', 'Friend links'], ['友情链接', 'Friends'], ['RSS 阅读页', 'RSS Reader'],
  ['内容已更新', 'Content updated'],
  ['今天的 AI 圈，先看这些', 'Today in AI: start here'],
  ['AI圈报（AIQB）：每日 AI 资讯与大模型动态', 'AIQB: Daily AI News and Model Updates'],
  ['AI圈报：每日 AI 资讯与大模型动态', 'AIQB: Daily AI News and Model Updates'],
  ['热度上升中', 'Trending now'],
  ['按热度集中查看，不错过正在升温的模型、产品与行业话题。', 'Follow the model, product and industry topics gaining attention.'],
  ['最新情报', 'Latest intelligence'], ['今日精选', 'Today: selected stories'], ['近 7 天精选', '7-day selection'],
  ['查看近 7 天精选', 'View the 7-day selection'], ['查看今日精选', 'View today selection'],
  ['进入 AI 情报库', 'Open the AI intelligence library'], ['继续显示更多', 'Show more'],
  ['每日简报', 'Daily brief'], ['阅读简报', 'Read brief'], ['历史日期', 'Archive date'],
  ['热点事件', 'Trending stories'], ['当前暂无热点事件。', 'No trending stories right now.'],
  ['AI 情报文章归档', 'AI Intelligence Archive'], ['文章归档', 'Article archive'], ['文章系统', 'Article system'],
  ['已收录文章', 'Indexed articles'], ['正式分类', 'Categories'], ['精选内容', 'Selected stories'], ['全部文章', 'All articles'],
  ['分类文章', 'Category articles'], ['分类专题', 'Topic pages'], ['持续更新', 'Updates'], ['永久归档', 'Permanent archive'],
  ['内容摘要', 'Summary'], ['原始标题：', 'Original title: '], ['信息来源：', 'Source: '], ['信息来源', 'Source'],
  ['内容分类', 'Category'], ['内容层级', 'Tier'], ['发布时间（北京时间）', 'Published'], ['本站收录时间（北京时间）', 'Indexed by AIQB'], ['站内情报编号', 'AIQB record ID'],
  ['普通情报', 'Ordinary'], ['精选情报', 'Selected'], ['普通', 'Ordinary'], ['精选', 'Selected'],
  ['阅读原始信息', 'Read original source'], ['阅读原文', 'Read original'], ['查看数据来源', 'View data source'], ['分享文章', 'Share'], ['链接已复制', 'Link copied'],
  ['更多', 'More '], ['相关推荐', 'Related stories'], ['上一篇（更新）', 'Previous (newer)'], ['下一篇（更早）', 'Next (older)'],
  ['AI 模型发布与更新', 'AI Model Releases & Updates'], ['AI 产品发布与更新', 'AI Product Releases & Updates'], ['人工智能行业动态', 'AI Industry'], ['AI 论文与研究', 'AI Research & Papers'], ['AI 教程与实战', 'AI Tutorials & Practice'], ['AI 观点与方法', 'AI Perspectives & Methods'],
  ['模型发布 / 更新', 'Models'], ['产品发布 / 更新', 'Products'], ['行业动态', 'Industry'], ['论文研究', 'Research'], ['教程 / 实战', 'Tutorials'], ['观点 / 方法', 'Perspectives'],
  ['AI 模型', 'AI Models'], ['AI 产品', 'AI Products'], ['模型', 'Models'], ['产品', 'Products'], ['行业', 'Industry'], ['论文', 'Research'],
  ['AI 情报库', 'AI Intelligence'], ['AI 情报', 'AI intelligence'], ['AI 热点', 'AI Trends'], ['时间线', 'Timeline'], ['列表', 'List'],
  ['近 24 小时', 'Past 24 hours'], ['近 7 天', 'Past 7 days'], ['近 30 天', 'Past 30 days'], ['全部历史', 'All time'],
  ['时间', 'Time'], ['层级', 'Tier'], ['主题', 'Topic'], ['全部', 'All'], ['范围', 'Range'], ['内容', 'Stories'], ['来源', 'Sources'], ['更新', 'Updated'], ['当前栏目', 'Current section'], ['数据概览', 'Data overview'], ['已加载', 'Loaded'],
  ['相关标签：', 'Tags: '], ['相关标签', 'Tags'], ['时间未知', 'Unknown time'], ['刚刚', 'Just now'], ['分钟前', ' min ago'], ['小时前', ' hr ago'], ['天前', ' days ago'],
  ['首页', 'Home'], ['情报', 'Intelligence'], ['热点', 'Trending'], ['日报', 'Daily'], ['文章', 'Articles'], ['分类专题', 'Topics'], ['回到顶部', 'Back to top'],
  ['打开标准 RSS XML', 'Open RSS XML'], ['标准 RSS', 'Standard RSS'], ['RSS 订阅', 'RSS Feed'], ['RSS 阅读', 'RSS Reader'], ['最新订阅内容', 'Latest feed items'], ['返回 AI圈报', 'Back to AIQB'],
  ['请启用 JavaScript，或浏览', 'Enable JavaScript, or browse'], ['教程实战', 'Tutorials'], ['切换深色或浅色模式', 'Toggle dark or light mode'], ['刷新内容', 'Refresh'], ['清空搜索', 'Clear search'], ['搜索 AI 情报', 'Search AI intelligence'], ['主导航', 'Main navigation'], ['文章分类', 'Article categories'],
  ['按 /', 'Press /'], ['24 小时', '24 hours'], ['30 天', '30 days'], ['7 天', '7 days'], ['第 ', 'Section '], [' 节', ''], [' 条', ' stories'], ['最新', 'Latest'],
  ['AI圈报', 'AIQB']
].sort((a, b) => b[0].length - a[0].length);

function languagePath(path, language) {
  const clean = path || '/';
  return language === 'en' ? '/en' + (clean === '/' ? '/' : clean) : clean;
}

function addLanguageAlternates(html, path, language) {
  const zh = SITE_URL + (path || '/');
  const en = SITE_URL + languagePath(path || '/', 'en');
  const tags = '<link rel="alternate" hreflang="zh-CN" href="' + esc(zh) + '"><link rel="alternate" hreflang="en" href="' + esc(en) + '"><link rel="alternate" hreflang="x-default" href="' + esc(zh) + '">';
  return html.replace(/(<link rel="canonical"[^>]*>)/i, '$1' + tags);
}

function localizeEnglishDocument(input, path) {
  let html = String(input).replace(/<html lang="zh-CN"/i, '<html lang="en"').replace(/zh_CN/g, 'en_US').replace(/"inLanguage":"zh-CN"/g, '"inLanguage":"en"');
  const chineseBrandToken = '__AIQB_CHINESE_BRAND__';
  html = html
    .replace(/AIQB \(AI圈报\)/g, 'AIQB (' + chineseBrandToken + ')')
    .replace(/AIQB,AI圈报,/g, 'AIQB,' + chineseBrandToken + ',')
    .replace(/"alternateName":"AI圈报"/g, '"alternateName":"' + chineseBrandToken + '"');
  for (const pair of ENGLISH_REPLACEMENTS) html = html.split(pair[0]).join(pair[1]);
  html = html.split(chineseBrandToken).join('AI圈报');
  html = html.replace(/href="\/([^"#]*)"/g, (match, rest) => {
    if (/^(?:en(?:\/|$)|api\/|sitemap\.xml|favicon\.|icon-\d+\.png|apple-touch-icon\.png|site\.webmanifest|rss-style\.|(?:index|admin)\.[a-f0-9]{12}\.)/.test(rest)) return match;
    return 'href="/en/' + rest + '"';
  });
  html = html.replace(/href="\/en\/"([^>]*)data-lang-switch="en"/g, 'href="/"$1data-lang-switch="zh"');
  html = html.replace(/data-lang-switch="zh" hreflang="en" aria-label="Switch to English"/g, 'data-lang-switch="zh" hreflang="zh-CN" aria-label="切换到中文"');
  html = html.replace(/(<a[^>]*data-lang-switch="zh"[^>]*>)EN(<\/a>)/g, '$1中文$2');
  html = html.replace(/\?\'\/article\/\'\+/g, "?'/en/article/'+");
  const escapedSite = SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(escapedSite + '\\/(?!en(?:\\/|["<]))', 'g'), SITE_URL + '/en/');
  return addLanguageAlternates(html, path, 'en');
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function keywordText(extra) {
  const words = SITE_KEYWORDS.split(/[,，\n]+/).map((word) => plain(word, 80)).filter(Boolean);
  for (const word of (extra || [])) {
    const clean = plain(word, 80);
    if (clean && words.indexOf(clean) === -1) words.unshift(clean);
  }
  return words.slice(0, 12).join(',');
}

function displayTime(value) {
  const date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function categoryOf(item) {
  return CATEGORY_MAP.get(item && item.category) || { slug: 'industry', label: '人工智能行业动态', short: 'AI 情报' };
}

function categoryNavigation(items, currentSlug) {
  const counts = new Map(CATEGORIES.map((category) => [category.slug, 0]));
  for (const item of items) if (counts.has(item.category)) counts.set(item.category, counts.get(item.category) + 1);
  return '<nav class="category-nav" aria-label="文章分类"><a class="' + (!currentSlug ? 'on' : '') + '" href="/articles">全部文章 <b>' + items.length + '</b></a>' + CATEGORIES.map((category) =>
    '<a class="' + (currentSlug === category.slug ? 'on' : '') + '" href="/category/' + category.slug + '">' + esc(category.short) + ' <b>' + counts.get(category.slug) + '</b></a>').join('') + '</nav>';
}

function articleListItem(item, data) {
  const category = categoryOf(item);
  const summary = plain(item && item.summary, 240);
  const entities = entityKeywords(item).slice(0, 3);
  const tier = item && item.selected === false ? '普通' : '精选';
  return '<a class="list-item" href="' + articlePath(item) + '"><div class="list-top"><span class="tag">' + esc(category.short) + '</span><span class="tier">' + tier + '</span><time>' + esc(displayTime(itemTime(item, data && data.fetchedAt))) + '</time></div><div class="list-title">' + esc(plain(item && item.title, 180)) + '</div>' +
    (summary ? '<div class="list-summary">' + esc(summary) + '</div>' : '') + '<div class="list-meta">信息来源：' + esc(sourceName(item)) + (entities.length ? ' · ' + entities.map(esc).join(' / ') : '') + '</div></a>';
}

function normalizedPage(value, totalPages) {
  const parsed = Math.floor(Number(value) || 1);
  return Math.min(Math.max(parsed, 1), Math.max(totalPages, 1));
}

function pagePath(basePath, page) {
  return basePath + (page > 1 ? '?page=' + page : '');
}

function pagination(basePath, page, totalPages) {
  if (totalPages <= 1) return '';
  const pages = new Set([1, totalPages]);
  for (let value = page - 2; value <= page + 2; value++) if (value >= 1 && value <= totalPages) pages.add(value);
  const ordered = Array.from(pages).sort((a, b) => a - b);
  let previous = 0;
  const links = [];
  for (const value of ordered) {
    if (previous && value - previous > 1) links.push('<span class="page-gap">…</span>');
    links.push('<a class="page-link ' + (value === page ? 'on' : '') + '" href="' + pagePath(basePath, value) + '"' + (value === page ? ' aria-current="page"' : '') + '>' + value + '</a>');
    previous = value;
  }
  return '<nav class="pagination" aria-label="文章分页">' + (page > 1 ? '<a class="page-link wide" href="' + pagePath(basePath, page - 1) + '">← 上一页</a>' : '') + links.join('') + (page < totalPages ? '<a class="page-link wide" href="' + pagePath(basePath, page + 1) + '">下一页 →</a>' : '') + '</nav>';
}

function layout(options) {
  const o = options || {};
  const language = o.lang === 'en' ? 'en' : 'zh';
  const canonical = SITE_URL + languagePath(o.path, language);
  const schema = Array.isArray(o.schema) ? o.schema : [o.schema].filter(Boolean);
  let document = '<!DOCTYPE html>\n<html lang="zh-CN"><head>\n' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + esc(o.title) + '</title>\n' +
    '<meta name="description" content="' + esc(o.description) + '">\n' +
    '<meta name="keywords" content="' + esc(o.keywords || keywordText()) + '">\n' +
    '<meta name="robots" content="' + (INDEXING_ENABLED ? 'index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1' : 'noindex,nofollow') + '">\n' +
    '<link rel="canonical" href="' + esc(canonical) + '">' + (o.prevPath ? '<link rel="prev" href="' + esc(SITE_URL + o.prevPath) + '">' : '') + (o.nextPath ? '<link rel="next" href="' + esc(SITE_URL + o.nextPath) + '">' : '') + '<link rel="alternate" type="application/rss+xml" title="' + esc(SITE_NAME) + ' RSS" href="' + SITE_URL + '/rss.xml">\n' +
    '<meta property="og:locale" content="zh_CN"><meta property="og:site_name" content="' + esc(SITE_NAME) + '">\n' +
    '<meta property="og:type" content="' + (o.ogType || 'website') + '"><meta property="og:title" content="' + esc(o.title) + '">\n' +
    '<meta property="og:description" content="' + esc(o.description) + '"><meta property="og:url" content="' + esc(canonical) + '">\n' +
    '<meta name="twitter:card" content="summary"><meta name="twitter:title" content="' + esc(o.title) + '"><meta name="twitter:description" content="' + esc(o.description) + '">\n' +
    '<meta name="theme-color" content="#0b5cff"><meta name="application-name" content="' + esc(SITE_NAME + ' ' + BRAND_ALIAS) + '"><meta name="apple-mobile-web-app-title" content="' + esc(BRAND_ALIAS) + '">\n' +
    '<link rel="icon" href="' + esc(BRAND_FAVICON_URL) + '"><link rel="apple-touch-icon" href="' + esc(BRAND_LOGO_URL) + '"><link rel="manifest" href="/site.webmanifest">\n' +
    schema.map((entry) => '<script type="application/ld+json">' + jsonLd(entry) + '</script>').join('\n') +
    '<style>:root{color-scheme:light dark;--bg:#f4f6fb;--card:#fff;--surface2:#f7f9fd;--text:#111a31;--text2:#4b5870;--muted:#8490a8;--line:#e4e9f3;--line2:#d5ddec;--brand:#0b5cff;--brand2:#713cff;--soft:#edf3ff;--shadow:0 7px 24px rgba(20,34,72,.07)}*{box-sizing:border-box}body{margin:0;background:radial-gradient(900px 340px at 75% -180px,rgba(11,92,255,.1),transparent 65%),var(--bg);color:var(--text);font:15px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--brand);text-decoration:none}a:hover{text-decoration:underline}:focus-visible{outline:2px solid var(--brand);outline-offset:2px}.wrap{width:min(980px,calc(100% - 32px));margin:auto}.top{padding:16px 0;border-bottom:1px solid var(--line);background:rgba(255,255,255,.92);backdrop-filter:blur(12px)}.top .wrap,.crumb,.meta,.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.brand{font-weight:800;color:var(--text);font-size:18px}.top nav{margin-left:auto;display:flex;gap:18px}.top nav a{color:var(--text2);font-size:13px;font-weight:650;white-space:nowrap}.top nav a[href="/articles"]{color:var(--brand)}.crumb{padding:22px 0 12px;color:var(--muted);font-size:13px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:clamp(22px,5vw,42px);box-shadow:var(--shadow)}h1{font-size:clamp(25px,5vw,38px);line-height:1.32;margin:12px 0 16px;letter-spacing:-.02em}h2{font-size:20px;line-height:1.4;margin:34px 0 13px}.meta{color:var(--muted);font-size:13px}.summary-section{margin-top:28px;padding-top:24px;border-top:1px solid var(--line)}.summary-section h2{margin:0 0 10px}.summary{font-size:17px;line-height:1.95;margin:0;white-space:pre-wrap;color:var(--text2)}.original-title{margin:14px 0 0;padding:12px 14px;border-left:3px solid var(--brand2);background:var(--surface2);color:var(--text2);font-size:13px}.tag-row,.list-top{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.tag,.tier,.entity-tag{display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:12px}.tag{background:var(--soft);color:#175cd3;font-weight:700}.tier{background:#f4efff;color:#6531dc}.entity-tag{border:1px solid var(--line);background:var(--surface2);color:var(--text2)}.info-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin-top:24px;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:var(--line)}.info-item{min-width:0;padding:12px 14px;background:var(--surface2)}.info-item span{display:block;color:var(--muted);font-size:11px}.info-item strong{display:block;margin-top:2px;color:var(--text);font-size:13px;overflow-wrap:anywhere}.actions{margin-top:26px}.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:9px 17px;border:0;border-radius:10px;background:var(--brand);color:#fff!important;font:700 13px/1.4 inherit;cursor:pointer}.button.secondary{background:transparent;color:var(--brand)!important;border:1px solid #b2ccff}.category-nav{display:flex;gap:7px;overflow-x:auto;margin:0 0 16px;padding:10px;border:1px solid var(--line);border-radius:13px;background:var(--card);scrollbar-width:none}.category-nav::-webkit-scrollbar{display:none}.category-nav a{flex:0 0 auto;padding:6px 10px;border-radius:8px;color:var(--text2);font-size:12px;white-space:nowrap}.category-nav a b{margin-left:4px;color:var(--muted);font-size:10px}.category-nav a.on,.category-nav a:hover{background:var(--soft);color:var(--brand);text-decoration:none}.category-nav a.on b{color:var(--brand)}.related{margin:30px 0 56px}.section-head{display:flex;align-items:flex-end;gap:10px;margin:32px 2px 12px}.section-head h2{margin:0}.section-head p{margin:0;color:var(--muted);font-size:12px}.list{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}.list-item{display:block;padding:16px 18px;border-bottom:1px solid var(--line);color:inherit}.list-item:last-child{border-bottom:0}.list-item:hover{background:var(--surface2);text-decoration:none}.list-top time{margin-left:auto;color:var(--muted);font-size:11px}.list-title{margin-top:7px;font-weight:720;color:var(--text);line-height:1.5}.list-summary{margin-top:6px;color:var(--text2);font-size:13px;line-height:1.65}.list-meta{margin-top:7px;color:var(--muted);font-size:11.5px}.article-nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px}.article-nav a{padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--text2)}.article-nav a:last-child{text-align:right}.article-nav small{display:block;color:var(--muted)}.article-nav strong{display:block;margin-top:3px;color:var(--text);font-size:13px}.pagination{display:flex;align-items:center;justify-content:center;gap:7px;flex-wrap:wrap;margin:22px 0 54px}.page-link{display:grid;place-items:center;min-width:36px;height:36px;padding:0 10px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--text2)}.page-link.wide{padding:0 14px}.page-link.on,.page-link:hover{border-color:rgba(11,92,255,.28);background:var(--soft);color:var(--brand);text-decoration:none}.page-gap{color:var(--muted)}.stat-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:20px}.stat{padding:13px;border:1px solid var(--line);border-radius:11px;background:var(--surface2)}.stat span{display:block;color:var(--muted);font-size:11px}.stat strong{display:block;margin-top:2px;font-size:18px}.footer{padding:28px 0 44px;color:var(--muted);font-size:13px}.footer a{margin-left:8px}@media(prefers-color-scheme:dark){:root{--bg:#0a1022;--card:#131a34;--surface2:#0e162d;--text:#e8edfa;--text2:#adb8d3;--muted:#7d89aa;--line:#252e4e;--line2:#344066;--brand:#70a5ff;--brand2:#a78bfa;--soft:rgba(42,103,255,.14);--shadow:0 8px 28px rgba(0,0,0,.32)}.top{background:rgba(19,26,52,.92)}.tag{color:#8eb4ff}.tier{color:#b9a0ff}}@media(max-width:640px){.wrap{width:min(100% - 20px,980px)}.top{padding:12px 0}.top .wrap{align-items:flex-start}.top nav{width:100%;margin-left:0;gap:14px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}.top nav::-webkit-scrollbar{display:none}.crumb{padding-top:14px}.card{padding:19px 16px;border-radius:14px}h1{font-size:24px}.summary{font-size:15px}.info-grid{grid-template-columns:1fr}.article-nav{grid-template-columns:1fr}.article-nav a:last-child{text-align:left}.stat-row{grid-template-columns:1fr}.list-item{padding:14px}.section-head p{display:none}}</style>\n' +
    '<style>.footer>.wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.footer-copy{width:100%;display:flex;align-items:center;justify-content:center;gap:7px;margin-top:11px;padding-top:13px;border-top:1px solid var(--line);text-align:center;flex-wrap:wrap}.footer-copy a{margin-left:0;color:var(--text2)}@media(max-width:640px){.footer-copy{gap:4px}.footer-dot{display:none}.footer-copy span,.footer-copy a{width:100%}}</style>' +
    '</head><body><header class="top"><div class="wrap"><a class="brand" href="/"><img src="' + esc(BRAND_LOGO_URL) + '" width="28" height="28" alt="" style="vertical-align:middle;border-radius:8px;margin-right:7px">' + esc(SITE_NAME) + '</a><nav><a href="/">首页</a><a href="/?section=intel&amp;w=all">情报</a><a href="/articles">文章</a><a href="/?section=hot">热点</a><a href="/?section=daily">日报</a><a href="/rss">RSS</a></nav></div></header>' +
    o.body + '<footer class="footer"><div class="wrap"><span>' + esc(SITE_NAME) + ' · ' + esc(language === 'en' ? BRAND_ENGLISH_TAGLINE : BRAND_TAGLINE) + '</span><a href="/articles">文章归档</a><a href="/sitemap.xml">站点地图</a>' + renderFooterCopyright() + '</div></footer><script>(function(){document.addEventListener("click",function(event){var share=event.target.closest&&event.target.closest("[data-share]");if(share){var payload={title:document.title,text:document.querySelector("meta[name=description]")&&document.querySelector("meta[name=description]").content,url:location.href};var reportShare=function(){try{var shareBody=JSON.stringify({url:location.href,kind:"share",title:document.title,t:Date.now()});if(navigator.sendBeacon)navigator.sendBeacon("/api/track",new Blob([shareBody],{type:"application/json"}));else fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:shareBody,keepalive:true})}catch(error){}};if(navigator.share){navigator.share(payload).then(reportShare).catch(function(){})}else if(navigator.clipboard){navigator.clipboard.writeText(location.href).then(function(){reportShare();var old=share.textContent;share.textContent="链接已复制";setTimeout(function(){share.textContent=old},1600)})}return}var link=event.target.closest&&event.target.closest("a[data-track]");if(!link)return;try{var body=JSON.stringify({url:link.href,kind:link.dataset.track||"item",title:link.dataset.title||document.title,t:Date.now()});if(navigator.sendBeacon)navigator.sendBeacon("/api/track",new Blob([body],{type:"application/json"}));else fetch("/api/track",{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})}catch(error){}})})();</script></body></html>';
  document = language === 'en' ? localizeEnglishDocument(document, o.path) : addLanguageAlternates(document, o.path, 'zh');
  return document;
}

function renderArticle(data, id, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  const items = collectItems(data, lang);
  const indexed = data && data._seo && (lang === 'en' ? data._seo.en : data._seo.all);
  const item = indexed && indexed.byId ? indexed.byId.get(id) : items.find((entry) => entry._intelId === id);
  if (!item) return null;
  const category = categoryOf(item);
  const path = articlePath(item);
  const title = plain(item.title, 180);
  const description = plain(item.summary, 220) || title + '：查看事件摘要、来源与相关 AI 情报。';
  const summary = plain(item.summary, 12000) || '当前记录已保存标题、分类与来源，详细内容请通过原始信息链接查看。';
  const originalTitle = plain(item.originalTitle, 500);
  const entities = entityKeywords(item);
  const published = itemTime(item, data && data.fetchedAt);
  const discovered = itemTime({ publishedAt: item.discoveredAt }, published);
  const original = safeUrl(item.links && (item.links.original || item.links.upstream));
  const attribution = safeUrl(item.attribution && item.attribution.url || item.links && item.links.upstream);
  const sameCategory = indexed && indexed.byCategory
    ? (indexed.byCategory.get(item.category || 'uncategorized') || [])
    : items.filter((entry) => entry.category === item.category);
  const currentIndex = sameCategory.findIndex((entry) => entry._intelId === id);
  const newer = currentIndex > 0 ? sameCategory[currentIndex - 1] : null;
  const older = currentIndex >= 0 && currentIndex < sameCategory.length - 1 ? sameCategory[currentIndex + 1] : null;
  const entitySet = new Set(entities);
  const related = sameCategory.filter((entry) => entry._intelId !== id).map((entry) => {
    let score = entry.selected === false ? 0 : 1;
    for (const keyword of entityKeywords(entry)) if (entitySet.has(keyword)) score += 5;
    if (sourceName(entry) === sourceName(item)) score += 2;
    return { entry, score };
  }).sort((a, b) => b.score - a.score || itemTime(b.entry, data && data.fetchedAt).localeCompare(itemTime(a.entry, data && data.fetchedAt))).slice(0, 10).map((row) => row.entry);
  const schema = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: title, description, datePublished: published, dateModified: itemTime(item, data && data.fetchedAt),
    mainEntityOfPage: SITE_URL + path,
    author: { '@type': 'Organization', name: SITE_NAME, alternateName: BRAND_ALIAS, url: SITE_URL },
    publisher: { '@type': 'Organization', '@id': SITE_URL + '/#organization', name: SITE_NAME, alternateName: BRAND_ALIAS, url: SITE_URL, logo: { '@type': 'ImageObject', url: absoluteAssetUrl(BRAND_LOGO_URL) } },
    articleSection: category.label,
    keywords: keywordText(entities.concat([category.label, sourceName(item)])),
    inLanguage: 'zh-CN', isAccessibleForFree: true, wordCount: summary.length,
  };
  if (entities.length) schema.about = entities.map((name) => ({ '@type': 'Thing', name }));
  if (original) schema.isBasedOn = original;
  const breadcrumb = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: '首页', item: SITE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: category.label, item: SITE_URL + '/category/' + category.slug },
      { '@type': 'ListItem', position: 3, name: title, item: SITE_URL + path },
    ],
  };
  const entityHtml = entities.length ? '<div class="tag-row" aria-label="相关标签">' + entities.map((entity) => '<a class="entity-tag" href="/?section=intel&amp;w=all&amp;q=' + encodeURIComponent(entity) + '">' + esc(entity) + '</a>').join('') + '</div>' : '';
  const articleNav = newer || older ? '<nav class="article-nav" aria-label="同分类前后文章">' + (newer ? '<a href="' + articlePath(newer) + '"><small>上一篇（更新）</small><strong>' + esc(plain(newer.title, 80)) + '</strong></a>' : '<span></span>') + (older ? '<a href="' + articlePath(older) + '"><small>下一篇（更早）</small><strong>' + esc(plain(older.title, 80)) + '</strong></a>' : '') + '</nav>' : '';
  const relatedHtml = related.length ? '<section class="related"><div class="section-head"><h2>相关推荐</h2><p>综合分类、实体标签与信息来源匹配</p></div><div class="list">' + related.map((entry) => articleListItem(entry, data)).join('') + '</div></section>' : '';
  const infoGrid = '<div class="info-grid"><div class="info-item"><span>内容分类</span><strong><a href="/category/' + category.slug + '">' + esc(category.label) + '</a></strong></div><div class="info-item"><span>内容层级</span><strong>' + (item.selected === false ? '普通情报' : '精选情报') + '</strong></div><div class="info-item"><span>发布时间（北京时间）</span><strong><time datetime="' + esc(published) + '">' + esc(displayTime(published)) + '</time></strong></div><div class="info-item"><span>本站收录时间（北京时间）</span><strong><time datetime="' + esc(discovered) + '">' + esc(displayTime(discovered)) + '</time></strong></div><div class="info-item"><span>信息来源</span><strong>' + esc(sourceName(item)) + '</strong></div><div class="info-item"><span>站内情报编号</span><strong>' + esc(id) + '</strong></div></div>';
  const body = '<main class="wrap"><nav class="crumb" aria-label="面包屑"><a href="/">首页</a><span>›</span><a href="/articles">文章</a><span>›</span><a href="/category/' + category.slug + '">' + esc(category.short) + '</a><span>›</span><span>详情</span></nav>' + categoryNavigation(items, category.slug) +
    '<article class="card article-card"><div class="tag-row"><span class="tag">' + esc(category.short) + '</span><span class="tier">' + (item.selected === false ? '普通' : '精选') + '</span></div><h1>' + esc(title) + '</h1><div class="meta"><span>信息来源：' + esc(sourceName(item)) + '</span><span>·</span><time datetime="' + esc(published) + '">' + esc(displayTime(published)) + '</time></div>' + entityHtml + (originalTitle && originalTitle !== title ? '<div class="original-title"><strong>原始标题：</strong>' + esc(originalTitle) + '</div>' : '') + '<section class="summary-section"><h2>内容摘要</h2><div class="summary">' + esc(summary) + '</div></section>' + infoGrid + '<div class="actions">' + (original ? '<a class="button" href="' + esc(original) + '" target="_blank" rel="noopener noreferrer nofollow" data-track="item" data-title="' + esc(title) + '">阅读原始信息 ↗</a>' : '') + (attribution && attribution !== original ? '<a class="button secondary" href="' + esc(attribution) + '" target="_blank" rel="noopener noreferrer nofollow">查看数据来源</a>' : '') + '<a class="button secondary" href="/category/' + category.slug + '">更多' + esc(category.short) + '</a><button class="button secondary" type="button" data-share>分享文章</button></div></article>' + articleNav + relatedHtml + '</main>';
  return layout({ path, lang, title: title + ' - ' + SITE_NAME, description, keywords: lang === 'en' ? ENGLISH_KEYWORDS : keywordText(entities.concat([category.label, sourceName(item)])), ogType: 'article', schema: [schema, breadcrumb], body });
}

function renderArticles(data, requestedPage, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  const items = collectItems(data, lang);
  const pageSize = 40;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = normalizedPage(requestedPage, totalPages);
  const pageItems = items.slice((page - 1) * pageSize, page * pageSize);
  const path = pagePath('/articles', page);
  const description = '浏览 ' + SITE_NAME + ' 已保存的 ' + items.length + ' 条 AI 情报文章，覆盖模型、产品、行业、论文、教程与观点方法六大分类。';
  const schema = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: SITE_NAME + ' 文章归档' + (page > 1 ? ' - 第 ' + page + ' 页' : ''),
    description, url: SITE_URL + path, dateModified: itemTime(items[0], data && data.fetchedAt),
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: pageItems.map((item, index) => ({ '@type': 'ListItem', position: (page - 1) * pageSize + index + 1, url: SITE_URL + articlePath(item), name: plain(item.title, 180) })) },
  };
  const selectedCount = items.filter((item) => item.selected !== false).length;
  const rows = pageItems.map((item) => articleListItem(item, data)).join('');
  const body = '<main class="wrap"><nav class="crumb"><a href="/">首页</a><span>›</span><span>文章归档</span></nav>' + categoryNavigation(items, '') + '<section class="card"><span class="tag">文章系统</span><h1>AI 情报文章归档</h1><p class="summary">' + esc(description) + '</p><div class="stat-row"><div class="stat"><span>已收录文章</span><strong>' + items.length + '</strong></div><div class="stat"><span>正式分类</span><strong>' + CATEGORIES.length + '</strong></div><div class="stat"><span>精选内容</span><strong>' + selectedCount + '</strong></div></div></section><section class="related"><div class="section-head"><h2>全部文章</h2><p>第 ' + page + ' / ' + totalPages + ' 页 · 每页 ' + pageSize + ' 条</p></div><div class="list">' + (rows || '<div class="list-item">当前暂无已发布文章。</div>') + '</div></section>' + pagination('/articles', page, totalPages) + '</main>';
  return layout({ path, lang, title: 'AI 情报文章归档' + (page > 1 ? ' - 第 ' + page + ' 页' : '') + ' - ' + SITE_NAME, description, keywords: lang === 'en' ? ENGLISH_KEYWORDS : keywordText(['AI文章', 'AI情报归档']), schema, body, prevPath: page > 1 ? pagePath('/articles', page - 1) : '', nextPath: page < totalPages ? pagePath('/articles', page + 1) : '' });
}

function renderCategory(data, slug, requestedPage, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  const category = CATEGORY_MAP.get(slug);
  if (!category) return null;
  const allItems = collectItems(data, lang);
  const items = allItems.filter((item) => item.category === slug);
  const pageSize = 40;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = normalizedPage(requestedPage, totalPages);
  const pageItems = items.slice((page - 1) * pageSize, page * pageSize);
  const basePath = '/category/' + slug;
  const path = pagePath(basePath, page);
  const modified = itemTime(pageItems[0] || items[0], data && data.fetchedAt);
  const schema = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: category.label + (page > 1 ? ' - 第 ' + page + ' 页' : ''),
    description: category.description, url: SITE_URL + path, dateModified: modified,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: pageItems.map((item, index) => ({ '@type': 'ListItem', position: (page - 1) * pageSize + index + 1, url: SITE_URL + articlePath(item), name: plain(item.title, 180) })) },
  };
  const rows = pageItems.map((item) => articleListItem(item, data)).join('');
  const body = '<main class="wrap"><nav class="crumb"><a href="/">首页</a><span>›</span><a href="/articles">文章</a><span>›</span><span>' + esc(category.short) + '</span></nav>' + categoryNavigation(allItems, category.slug) + '<section class="card"><span class="tag">AI 专题</span><h1>' + esc(category.label) + '</h1><p class="summary">' + esc(category.description) + '</p><div class="stat-row"><div class="stat"><span>分类文章</span><strong>' + items.length + '</strong></div><div class="stat"><span>当前页</span><strong>' + page + ' / ' + totalPages + '</strong></div><div class="stat"><span>持续更新</span><strong>永久归档</strong></div></div></section><section class="related"><div class="section-head"><h2>分类文章</h2><p>按发布时间从新到旧 · 每页 ' + pageSize + ' 条</p></div><div class="list">' + (rows || '<div class="list-item">当前暂无内容，请稍后再来。</div>') + '</div></section>' + pagination(basePath, page, totalPages) + '</main>';
  return layout({ path, lang, title: category.label + (page > 1 ? ' - 第 ' + page + ' 页' : '') + ' - ' + SITE_NAME, description: category.description, keywords: lang === 'en' ? ENGLISH_KEYWORDS : keywordText([category.label, category.short]), schema, body, prevPath: page > 1 ? pagePath(basePath, page - 1) : '', nextPath: page < totalPages ? pagePath(basePath, page + 1) : '' });
}

function renderSitemap(data) {
  const fetchedAt = itemTime(null, data && data.fetchedAt).slice(0, 10);
  const urls = [
    { loc: SITE_URL + '/', lastmod: fetchedAt, priority: '1.0', changefreq: 'hourly' },
    { loc: SITE_URL + '/articles', lastmod: fetchedAt, priority: '0.9', changefreq: 'hourly' },
    { loc: SITE_URL + '/rss', lastmod: fetchedAt, priority: '0.6', changefreq: 'hourly' },
  ];
  for (const category of CATEGORIES) urls.push({ loc: SITE_URL + '/category/' + category.slug, lastmod: fetchedAt, priority: '0.8', changefreq: 'daily' });
  for (const item of collectItems(data)) urls.push({ loc: SITE_URL + articlePath(item), lastmod: itemTime(item, data && data.fetchedAt).slice(0, 10), priority: '0.7', changefreq: 'weekly' });
  const englishUrls = [
    { loc: SITE_URL + '/en/', lastmod: fetchedAt, priority: '0.9', changefreq: 'hourly' },
    { loc: SITE_URL + '/en/articles', lastmod: fetchedAt, priority: '0.8', changefreq: 'hourly' },
    { loc: SITE_URL + '/en/rss', lastmod: fetchedAt, priority: '0.5', changefreq: 'hourly' },
  ];
  for (const category of CATEGORIES) englishUrls.push({ loc: SITE_URL + '/en/category/' + category.slug, lastmod: fetchedAt, priority: '0.7', changefreq: 'daily' });
  for (const item of collectItems(data, 'en')) englishUrls.push({ loc: SITE_URL + '/en' + articlePath(item), lastmod: itemTime(item, data && data.fetchedAt).slice(0, 10), priority: '0.7', changefreq: 'weekly' });
  urls.push(...englishUrls);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map((entry) =>
    '  <url><loc>' + esc(entry.loc) + '</loc><lastmod>' + entry.lastmod + '</lastmod><changefreq>' + entry.changefreq + '</changefreq><priority>' + entry.priority + '</priority></url>').join('\n') + '\n</urlset>\n';
}

function renderRss(data, selfPath, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  const items = collectItems(data, lang).slice(0, 50);
  const built = new Date(data && data.fetchedAt || Date.now()).toUTCString();
  const feedPath = selfPath || '/feed.xml';
  const prefix = lang === 'en' ? '/en' : '';
  return '<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/css" href="/rss-style.css"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>' + esc(lang === 'en' ? 'AIQB' : SITE_NAME) + '</title><link>' + SITE_URL + prefix + '/</link><description>' + esc(lang === 'en' ? ENGLISH_DESCRIPTION : SITE_DESCRIPTION) + '</description><language>' + (lang === 'en' ? 'en' : 'zh-cn') + '</language><lastBuildDate>' + built + '</lastBuildDate><atom:link href="' + SITE_URL + prefix + feedPath + '" rel="self" type="application/rss+xml"/>' + items.map((item) => {
    const link = SITE_URL + prefix + articlePath(item);
    return '<item><title>' + esc(plain(item.title, 180)) + '</title><link>' + esc(link) + '</link><guid isPermaLink="true">' + esc(link) + '</guid><pubDate>' + new Date(itemTime(item, data && data.fetchedAt)).toUTCString() + '</pubDate><description>' + esc(plain(item.summary, 500)) + '</description><category>' + esc((CATEGORY_MAP.get(item.category) || {}).label || 'AI 情报') + '</category></item>';
  }).join('') + '</channel></rss>\n';
}

function renderRssPage(data, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  const items = collectItems(data, lang).slice(0, 50);
  const path = '/rss';
  const description = '订阅 ' + SITE_NAME + '，持续获取大模型、AI 产品、行业、论文、教程与热点的最新中文摘要。';
  const rows = items.map((item) => {
    const category = CATEGORY_MAP.get(item.category) || { label: 'AI 情报' };
    return '<a class="list-item" href="' + articlePath(item) + '"><div class="list-title">' + esc(plain(item.title, 180)) + '</div><div class="list-meta">' + esc(category.label) + ' · ' + esc(sourceName(item)) + ' · ' + esc(itemTime(item, data && data.fetchedAt).slice(0, 10)) + '</div><div style="margin-top:7px;color:var(--muted)">' + esc(plain(item.summary, 260)) + '</div></a>';
  }).join('');
  const schema = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    name: SITE_NAME + ' RSS 阅读页', description, url: SITE_URL + path,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: SITE_URL },
    mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, url: SITE_URL + articlePath(item), name: plain(item.title, 180) })) },
  };
  const body = '<main class="wrap"><nav class="crumb"><a href="/">首页</a><span>›</span><span>RSS 阅读</span></nav>' +
    '<section class="card"><span class="tag">标准 RSS</span><h1>' + esc(SITE_NAME) + ' · RSS 订阅</h1><p class="summary">' + esc(description) + '</p><div class="actions"><a class="button" href="/rss.xml">打开标准 RSS XML</a><a class="button secondary" href="/">返回 ' + esc(SITE_NAME) + '</a></div><div class="meta" style="margin-top:16px">订阅地址：' + esc(SITE_URL) + '/rss.xml · 最近 ' + items.length + ' 条</div></section>' +
    '<section class="related"><h2>最新订阅内容</h2><div class="list">' + (rows || '<div class="list-item">当前暂无内容，请稍后再来。</div>') + '</div></section></main>';
  return layout({ path, lang, title: 'RSS 订阅 - ' + SITE_NAME, description, keywords: lang === 'en' ? ENGLISH_KEYWORDS : keywordText(['RSS订阅', 'AI RSS', '人工智能资讯订阅']), schema, body });
}

function renderRobots() {
  return 'User-agent: *\n' + (INDEXING_ENABLED ? 'Allow: /' : 'Disallow: /') + '\nDisallow: /admin\nDisallow: /api/admin\nSitemap: ' + SITE_URL + '/sitemap.xml\nHost: ' + SITE_URL.replace(/^https?:\/\//, '') + '\n';
}

function configure(config) {
  const c = config || {};
  SITE_URL = String(c.seoSiteUrl || process.env.AIQB_SITE_URL || SITE_URL).replace(/\/+$/, '');
  SITE_TITLE = plain(c.seoSiteTitle || SITE_TITLE, 100);
  SITE_NAME = plain(c.seoShortTitle || SITE_NAME, 80);
  SITE_DESCRIPTION = plain(c.seoDescription || SITE_DESCRIPTION, 300);
  SITE_KEYWORDS = plain(c.seoKeywords || SITE_KEYWORDS, 1000);
  ENGLISH_TITLE = plain(c.seoEnglishTitle || ENGLISH_TITLE, 120);
  ENGLISH_DESCRIPTION = plain(c.seoEnglishDescription || ENGLISH_DESCRIPTION, 320);
  ENGLISH_KEYWORDS = plain(c.seoEnglishKeywords || ENGLISH_KEYWORDS, 1200);
  INDEXING_ENABLED = c.seoIndexingEnabled !== false;
  FOOTER_ENABLED = c.footerEnabled !== false;
  FOOTER_COPYRIGHT = plain(c.footerCopyrightText == null ? FOOTER_COPYRIGHT : c.footerCopyrightText, 160);
  FOOTER_ICP_NUMBER = plain(c.footerIcpNumber == null ? FOOTER_ICP_NUMBER : c.footerIcpNumber, 100);
  FOOTER_ICP_URL = safeUrl(c.footerIcpUrl == null ? FOOTER_ICP_URL : c.footerIcpUrl);
  BRAND_ALIAS = plain(c.siteBrandAlias || BRAND_ALIAS, 24);
  BRAND_TAGLINE = plain(c.siteTagline || BRAND_TAGLINE, 80);
  BRAND_ENGLISH_TAGLINE = plain(c.siteEnglishTagline || BRAND_ENGLISH_TAGLINE, 100);
  BRAND_LOGO_URL = safeAssetUrl(c.siteLogoUrl, BRAND_LOGO_URL);
  BRAND_FAVICON_URL = safeAssetUrl(c.siteFaviconUrl, BRAND_FAVICON_URL);
  return settings();
}

function settings() {
  return { siteUrl: SITE_URL, siteTitle: SITE_TITLE, shortTitle: SITE_NAME, brandAlias: BRAND_ALIAS, tagline: BRAND_TAGLINE, englishTagline: BRAND_ENGLISH_TAGLINE, logoUrl: BRAND_LOGO_URL, faviconUrl: BRAND_FAVICON_URL, description: SITE_DESCRIPTION, keywords: SITE_KEYWORDS, englishTitle: ENGLISH_TITLE, englishDescription: ENGLISH_DESCRIPTION, englishKeywords: ENGLISH_KEYWORDS, indexingEnabled: INDEXING_ENABLED, footerEnabled: FOOTER_ENABLED, footerCopyrightText: FOOTER_COPYRIGHT, footerIcpNumber: FOOTER_ICP_NUMBER, footerIcpUrl: FOOTER_ICP_URL };
}

function applyHomepage(html, language) {
  const lang = language === 'en' ? 'en' : 'zh';
  const canonical = SITE_URL + languagePath('/', lang);
  const title = lang === 'en' ? ENGLISH_TITLE : SITE_TITLE;
  const zhBrand = BRAND_ALIAS && SITE_NAME.toLowerCase().indexOf(BRAND_ALIAS.toLowerCase()) < 0 ? SITE_NAME + '（' + BRAND_ALIAS + '）' : SITE_NAME;
  const heading = lang === 'en' ? 'AIQB: Daily AI News and Model Updates' : zhBrand + '：每日 AI 资讯与大模型动态';
  const description = lang === 'en' ? ENGLISH_DESCRIPTION : SITE_DESCRIPTION;
  const keywords = lang === 'en' ? ENGLISH_KEYWORDS : SITE_KEYWORDS;
  const robots = INDEXING_ENABLED ? 'index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1' : 'noindex,nofollow';
  const schema = { '@context': 'https://schema.org', '@type': 'WebSite', '@id': canonical + '#website', name: lang === 'en' ? BRAND_ALIAS : SITE_NAME, alternateName: lang === 'en' ? SITE_NAME : BRAND_ALIAS, url: canonical, description, inLanguage: lang === 'en' ? 'en' : 'zh-CN', publisher: { '@type': 'Organization', '@id': SITE_URL + '/#organization', name: SITE_NAME, alternateName: BRAND_ALIAS, url: SITE_URL + '/', logo: { '@type': 'ImageObject', url: absoluteAssetUrl(BRAND_LOGO_URL) } }, potentialAction: { '@type': 'SearchAction', target: canonical + '?section=intel&q={search_term_string}', 'query-input': 'required name=search_term_string' } };
  let document = String(html)
    .replace(/<title>[\s\S]*?<\/title>/i, '<title>' + esc(title) + '</title>')
    .replace(/<meta name="description"[^>]*>/i, '<meta name="description" content="' + esc(description) + '" />')
    .replace(/<meta name="keywords"[^>]*>/i, '<meta name="keywords" content="' + esc(keywords) + '" />')
    .replace(/<meta name="robots"[^>]*>/i, '<meta name="robots" content="' + robots + '" />')
    .replace(/<link rel="canonical"[^>]*>/i, '<link rel="canonical" href="' + esc(canonical) + '" />')
    .replace(/<meta property="og:site_name"[^>]*>/i, '<meta property="og:site_name" content="' + esc(SITE_NAME) + '" />')
    .replace(/<meta property="og:title"[^>]*>/i, '<meta property="og:title" content="' + esc(title) + '" />')
    .replace(/<meta property="og:description"[^>]*>/i, '<meta property="og:description" content="' + esc(description) + '" />')
    .replace(/<meta property="og:url"[^>]*>/i, '<meta property="og:url" content="' + esc(canonical) + '" />')
    .replace(/<meta name="twitter:title"[^>]*>/i, '<meta name="twitter:title" content="' + esc(title) + '" />')
    .replace(/<meta name="twitter:description"[^>]*>/i, '<meta name="twitter:description" content="' + esc(description) + '" />')
    .replace(/<meta name="application-name"[^>]*>/i, '<meta name="application-name" content="' + esc(SITE_NAME + ' ' + BRAND_ALIAS) + '" />')
    .replace(/<meta name="apple-mobile-web-app-title"[^>]*>/i, '<meta name="apple-mobile-web-app-title" content="' + esc(BRAND_ALIAS) + '" />')
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/i, '<script type="application/ld+json">' + jsonLd(schema) + '</script>')
    .replace(/<h1[^>]*>[^<]*<\/h1>/i, '<h1>' + esc(heading) + '</h1>');
  document = lang === 'en' ? localizeEnglishDocument(document, '/') : addLanguageAlternates(document, '/', 'zh');
  const displayName = lang === 'en' ? BRAND_ALIAS : SITE_NAME;
  const displayAlias = lang === 'en' ? SITE_NAME : BRAND_ALIAS;
  const tagline = lang === 'en' ? BRAND_ENGLISH_TAGLINE : BRAND_TAGLINE;
  document = document
    .replace(/(<link rel="icon" id="runtime-favicon" href=")[^"]*/i, '$1' + esc(BRAND_FAVICON_URL))
    .replace(/(<img id="site-logo" src=")[^"]*/i, '$1' + esc(BRAND_LOGO_URL))
    .replace(/(<span id="site-name-text">)[\s\S]*?(<\/span>)/i, '$1' + esc(displayName) + '$2')
    .replace(/(<span class="brand-alias" id="site-brand-alias">)[\s\S]*?(<\/span>)/i, '$1' + esc(displayAlias) + '$2')
    .replace(/(<p id="site-tagline">)[\s\S]*?(<\/p>)/i, '$1' + esc(tagline) + '$2')
    .replace(/(<span class="grow" id="site-footer-tagline">)[\s\S]*?(<\/span>)/i, '$1' + esc(displayName + ' · ' + tagline) + '$2');
  return document;
}

function dashboard(data) {
  const items = collectItems(data || {});
  const corpus = items.map((item) => plain((item.title || '') + ' ' + (item.summary || ''), 9000).toLowerCase()).join('\n');
  const keywords = SITE_KEYWORDS.split(/[,，\n]+/).map((word) => plain(word, 80)).filter(Boolean).slice(0, 50).map((word) => ({ keyword: word, occurrences: corpus.split(word.toLowerCase()).length - 1 }));
  const categories = CATEGORIES.map((category) => ({ slug: category.slug, label: category.label, count: items.filter((item) => item.category === category.slug).length, url: SITE_URL + '/category/' + category.slug }));
  const englishArticles = collectItems(data || {}, 'en').length;
  return { settings: settings(), publishedArticles: items.length, englishArticles, sitemapUrls: items.length + englishArticles + CATEGORIES.length * 2 + 6, rssItems: Math.min(items.length, 50), keywords, categories, endpoints: { articles: SITE_URL + '/articles', english: SITE_URL + '/en/', englishArticles: SITE_URL + '/en/articles', sitemap: SITE_URL + '/sitemap.xml', rss: SITE_URL + '/rss.xml', rssReader: SITE_URL + '/rss', robots: SITE_URL + '/robots.txt' } };
}

module.exports = { CATEGORIES, collectItems, configure, settings, applyHomepage, dashboard, renderArticle, renderArticles, renderCategory, renderSitemap, renderRss, renderRssPage, renderRobots, renderFooterCopyright };
