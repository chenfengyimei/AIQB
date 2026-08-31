// endpoint-registry.js — 多源采集接口注册、配置、状态、测试与审计日志
'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const { atomicWrite } = require('./config');

const UA = 'AIQB/2.5 (+https://chenqiyuan.cn; public-metadata-collector)';
function upstreamBase() {
  const value = String(process.env.AIQB_UPSTREAM_BASE_URL || 'https://upstream.invalid').trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('AIQB_UPSTREAM_BASE_URL 不是有效 URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new Error('AIQB_UPSTREAM_BASE_URL 必须是无账号、无自定义端口的 HTTPS 根地址');
  }
  return parsed.origin;
}
const BASE = upstreamBase();
const DOCS = BASE + '/openapi-v1.json';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const UPSTREAM = { source: '上游 REST API v1', docsUrl: DOCS, allowedHosts: [new URL(BASE).hostname] };
const FULL_ENDPOINTS = [
  Object.assign({ id: 'items7d', name: '近 7 天精选', role: 'collector', target: 'window7d', enabled: true, url: BASE + '/api/v1/items?mode=selected&window=7d&limit=100', description: '公开看板近 7 天主数据，最多 100 条。', schedule: '跟随全站采集', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'items24h', name: '近 24 小时精选', role: 'collector', target: 'window24h', enabled: true, url: BASE + '/api/v1/items?mode=selected&window=24h&limit=100', description: '公开看板近 24 小时主数据，最多 100 条。', schedule: '跟随全站采集', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'itemsAll7d', name: '全量情报池（7 天滚动）', role: 'collector', target: 'windowAll7d', enabled: true, url: BASE + '/api/v1/items?mode=all&window=7d&limit=100', description: '上游全量情报池（精选+普通）按 7 天滚动窗口分页拉取入库，普通情报直接发布；上游仅保留 7 天窗口，需按采集频率持续滚动积累。', schedule: '跟随全站采集（分页同步）', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'hotTopics', name: '实时热点榜', role: 'collector', target: 'hot', enabled: true, url: BASE + '/api/v1/hot-topics', description: '当前多信源热点事件与排名。', schedule: '跟随全站采集', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'dailyLatest', name: '最新 AI 日报', role: 'collector', target: 'daily', enabled: true, url: BASE + '/api/v1/dailies/latest', description: '最新一期精编日报，每天北京时间 08:00 发布。', schedule: '跟随全站采集', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'dailyArchive', name: '日报归档索引', role: 'archive', target: 'dailyArchive', enabled: true, url: BASE + '/api/v1/dailies?limit=30', description: '最近 30 期日报索引，缓存到后台供查看。', schedule: '跟随全站采集', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'dailyByDate', name: '指定日期日报', role: 'on-demand', target: 'dailyByDate', enabled: true, url: BASE + '/api/v1/dailies/{date}', description: '按真实归档日期读取历史日报。', schedule: '按需调用', timeoutMs: 30000, retries: 1 }, UPSTREAM),
  Object.assign({ id: 'storyDetail', name: '热点事件详情', role: 'on-demand', target: 'story', enabled: true, url: BASE + '/api/v1/stories/{publicId}', description: '按热点 publicId 查询事件综述和时间线。', schedule: '按需调用', timeoutMs: 30000, retries: 1 }, UPSTREAM),
  Object.assign({ id: 'selectedSnapshot', name: '完整精选快照', role: 'sync', target: 'selectedSnapshot', enabled: true, url: BASE + '/api/v1/selected/snapshot?fields=default&limit=1000', description: '全量同步引导：一次性分页拉取全部精选条目（每页最多 1000 条），完成后保存首页 cursor 转入增量。', schedule: '跟随全站采集（每轮同步）', timeoutMs: 60000, retries: 2 }, UPSTREAM),
  Object.assign({ id: 'selectedChanges', name: '精选增量变化', role: 'sync', target: 'selectedChanges', enabled: true, url: BASE + '/api/v1/selected/changes?limit=100&cursor={cursor}', description: '全量同步增量：按 cursor 拉取新增/更新/移除并入库，收到 409 时自动重新引导快照。', schedule: '跟随全站采集（每轮同步）', timeoutMs: 30000, retries: 2 }, UPSTREAM),
  { id: 'arxivAi', name: 'arXiv 最新 AI 论文', role: 'source', target: 'external', enabled: true, url: 'https://export.arxiv.org/api/query?search_query=cat%3Acs.AI%20OR%20cat%3Acs.CL%20OR%20cat%3Acs.LG&start=0&max_results=20&sortBy=submittedDate&sortOrder=descending', description: 'arXiv 官方 Atom API；每天低频获取最多 20 篇 AI 论文，核实去重后直接发布，层级默认为普通。', schedule: '跟随全站采集（低频）', timeoutMs: 30000, retries: 1, format: 'atom', sourceName: 'arXiv', category: 'paper', selected: false, publishMode: 'published', maxItems: 20, source: 'arXiv API', docsUrl: 'https://info.arxiv.org/help/api/user-manual.html', allowedHosts: ['export.arxiv.org'] },
  { id: 'devCommunityAi', name: 'DEV Community AI 文章', role: 'source', target: 'external', enabled: true, url: 'https://dev.to/api/articles?tag=ai&per_page=20', description: 'DEV/Forem 官方公开 JSON API；获取 AI 技术文章后核实去重并直接发布，层级默认为普通。', schedule: '跟随全站采集（低频）', timeoutMs: 20000, retries: 1, format: 'json', itemsPath: '', idPath: 'id', titlePath: 'title', summaryPath: 'description', urlPath: 'url', datePath: 'published_at', sourceName: 'DEV Community', category: 'tutorial', selected: false, publishMode: 'published', maxItems: 20, source: 'Forem API', docsUrl: 'https://developers.forem.com/api/v1', allowedHosts: ['dev.to'] },
  { id: 'aiInsightRss', name: 'AI Insight 每日 AI 情报', role: 'source', target: 'external', enabled: true, url: 'https://www.ai-insight.org/rss.xml', description: 'AI Insight 公开 RSS；约每 8 小时更新，单次读取最新 30 条，按条目自带分类自动归档并直接发布。', schedule: '跟随全站采集（约 8 小时更新）', timeoutMs: 20000, retries: 1, format: 'rss', sourceName: 'AI Insight', category: 'auto', selected: false, publishMode: 'published', maxItems: 30, source: 'AI Insight RSS', docsUrl: 'https://www.ai-insight.org/rss.xml', allowedHosts: ['www.ai-insight.org'] },
];

// 开源版首次安装保持最小化：后台接口列表只预置 AI圈报 RSS，用户可在此基础上
// 自行添加公开 JSON/RSS/Atom。旧版数据目录会自动继续使用完整 legacy 列表，避免升级断流。
const COMMUNITY_ENDPOINTS = [
  { id: 'aiqbRss', name: 'AI圈报 RSS', role: 'source', target: 'external', enabled: true, url: 'https://chenqiyuan.cn/rss.xml', description: 'AI圈报公开 RSS 入门数据源；新安装可直接采集最新 AI 情报，也可随时停用并添加自己的公开接口。', schedule: '跟随全站采集（默认每 12 小时）', timeoutMs: 20000, retries: 1, format: 'rss', sourceName: 'AI圈报', category: 'auto', selected: false, publishMode: 'published', maxItems: 50, source: 'AI圈报 RSS', docsUrl: 'https://chenqiyuan.cn/rss', allowedHosts: ['chenqiyuan.cn', 'www.chenqiyuan.cn'] },
];
const PRESETS = { community: COMMUNITY_ENDPOINTS, full: FULL_ENDPOINTS, empty: [] };
const CORE_COLLECTOR_IDS = ['items7d', 'items24h', 'itemsAll7d', 'hotTopics', 'dailyLatest', 'dailyArchive'];

function endpointPreset(value) {
  const preset = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PRESETS, preset) ? preset : null;
}

function nowIso() { return new Date().toISOString(); }
function text(value, max) { return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max); }
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const p = ip.split('.').map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224; }
  if (net.isIPv6(ip)) { const v = ip.toLowerCase(); return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.'); }
  return true;
}
function validateUrl(value, endpoint) {
  const input = text(value, 2000);
  const testValue = input.replace('{publicId}', 'sample-id').replace('{cursor}', 'sample-cursor').replace('{date}', '2026-01-01');
  let url; try { url = new URL(testValue); } catch (error) { throw new Error('接口 URL 格式无效'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new Error('仅允许无账号信息、无自定义端口的 HTTPS 地址');
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (net.isIP(host) && isPrivateIp(host))) throw new Error('禁止内网、本机或保留地址');
  if (endpoint && Array.isArray(endpoint.allowedHosts) && !endpoint.allowedHosts.includes(host)) throw new Error('内置接口只能使用其官方域名');
  if (/\{[^}]+\}/.test(testValue)) throw new Error('URL 包含不支持的占位符');
  if (endpoint && endpoint.id === 'storyDetail' && !input.includes('{publicId}')) throw new Error('事件详情 URL 必须保留 {publicId}');
  if (endpoint && endpoint.id === 'dailyByDate' && !input.includes('{date}')) throw new Error('指定日期日报 URL 必须保留 {date}');
  if (endpoint && endpoint.id === 'selectedChanges' && !input.includes('{cursor}')) throw new Error('增量接口 URL 必须保留 {cursor}');
  return input;
}
async function assertPublicDns(urlValue) {
  const host = new URL(urlValue).hostname;
  if (net.isIP(host)) { if (isPrivateIp(host)) throw new Error('DNS 安全校验：禁止内网或保留 IP'); return; }
  let rows; try { rows = await dns.lookup(host, { all: true, verbatim: true }); } catch (error) { throw new Error('DNS 解析失败: ' + error.message); }
  if (!rows.length || rows.some((row) => isPrivateIp(row.address))) throw new Error('DNS 安全校验：域名解析到内网或保留 IP');
}
function decodeXml(value) { return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&'); }
function stripHtml(value) { return decodeXml(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function tag(block, name) { const m = String(block).match(new RegExp('<(?:\\w+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?' + name + '>', 'i')); return m ? stripHtml(m[1]) : ''; }
function attr(block, name, attrName) { const m = String(block).match(new RegExp("<(?:\\w+:)?" + name + "\\b[^>]*\\b" + attrName + "=[\"']([^\"']+)[\"'][^>]*>", 'i')); return m ? decodeXml(m[1]).trim() : ''; }
function parseFeed(raw, endpoint) {
  const isAtom = endpoint.format === 'atom' || /<feed\b/i.test(raw);
  const parts = String(raw).match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) || [];
  return parts.slice(0, endpoint.maxItems).map((block) => { const id = tag(block, 'id') || tag(block, 'guid'); let url = isAtom ? (attr(block, 'link', 'href') || id) : tag(block, 'link'); if (!/^https?:\/\//i.test(url)) url = ''; return { id, title: tag(block, 'title'), summary: tag(block, 'summary') || tag(block, 'description') || tag(block, 'content'), url, publishedAt: tag(block, 'published') || tag(block, 'updated') || tag(block, 'pubDate'), category: tag(block, 'category'), author: tag(block, 'author') }; }).filter((item) => item.title && item.url);
}
function getPath(value, dotted) { if (!dotted) return value; return String(dotted).split('.').reduce((cur, key) => cur == null ? undefined : cur[key], value); }
function parseJson(payload, endpoint) { const rows = getPath(payload, endpoint.itemsPath); if (!Array.isArray(rows)) throw new Error('JSON 条目路径未得到数组'); return rows.slice(0, endpoint.maxItems).map((row) => ({ id: text(getPath(row, endpoint.idPath), 500), title: text(getPath(row, endpoint.titlePath), 500), summary: text(getPath(row, endpoint.summaryPath), 8000), url: text(getPath(row, endpoint.urlPath), 3000), publishedAt: text(getPath(row, endpoint.datePath), 80) })).filter((item) => item.title && /^https?:\/\//i.test(item.url)); }
function feedCategory(value) {
  const category = text(value, 120).toLowerCase();
  if (!category) return undefined;
  if (/大模型|模型|foundation model|llm/.test(category)) return 'ai-models';
  if (/产品|应用|工具|product/.test(category)) return 'ai-products';
  if (/论文|研究|research|paper/.test(category)) return 'paper';
  if (/教程|实战|指南|入门|tutorial|guide|how[- ]?to/.test(category)) return 'tutorial';
  if (/观点|方法|评论|opinion|method/.test(category)) return 'tip';
  if (/行业|企业|动态|industry|business/.test(category)) return 'industry';
  return undefined;
}
function toIntel(item, endpoint, fetchedAt) {
  const attributionUrl = /^https?:\/\//i.test(item.id || '') && item.id !== item.url ? item.id : undefined;
  return { id: item.id || item.url, title: item.title, summary: item.summary, source: { name: endpoint.sourceName }, links: { original: item.url }, publishedAt: item.publishedAt || undefined, discoveredAt: fetchedAt, category: endpoint.category === 'auto' ? feedCategory(item.category) : endpoint.category, selected: endpoint.selected === true, attribution: attributionUrl ? { name: endpoint.sourceName, url: attributionUrl } : undefined, _src: 'C' };
}
function preview(value, depth) { const level = depth || 0; if (level > 4) return '[内容已折叠]'; if (value == null || typeof value === 'number' || typeof value === 'boolean') return value; if (typeof value === 'string') return value.length > 1200 ? value.slice(0, 1200) + '…' : value; if (Array.isArray(value)) return value.slice(0, 10).map((entry) => preview(entry, level + 1)); if (typeof value === 'object') { const out = {}; for (const key of Object.keys(value).slice(0, 40)) out[key] = preview(value[key], level + 1); return out; } return String(value); }

class EndpointRegistry {
  constructor(dataDir, options) { this.dir = path.join(dataDir, 'endpoints'); this.configFile = path.join(this.dir, 'config.json'); this.stateFile = path.join(this.dir, 'state.json'); this.cacheDir = path.join(this.dir, 'cache'); this.explicitPreset = endpointPreset(options && options.preset); this.environmentPreset = endpointPreset(process.env.AIQB_ENDPOINT_PRESET); this.preset = 'community'; this.defaults = COMMUNITY_ENDPOINTS; this.endpoints = []; this.byId = new Map(); this.state = { updatedAt: null, byId: {}, runs: [] }; }
  init() {
    fs.mkdirSync(this.cacheDir, { recursive: true });
    let saved = { version: 3, preset: null, overrides: {}, custom: [] };
    let hadConfig = false;
    try { saved = Object.assign(saved, JSON.parse(fs.readFileSync(this.configFile, 'utf8'))); hadConfig = true; } catch (error) {}
    // v1/v2 配置来自旧版完整接口注册中心；升级时沿用 full。全新安装默认 community。
    const legacyPreset = hadConfig && Number(saved.version || 0) < 3 ? 'full' : null;
    this.preset = this.explicitPreset || endpointPreset(saved.preset) || legacyPreset || this.environmentPreset || 'community';
    this.defaults = PRESETS[this.preset];
    this.endpoints = this.defaults.map((item) => Object.assign({}, item, saved.overrides[item.id] || {}, { method: 'GET', custom: false }));
    for (const row of (Array.isArray(saved.custom) ? saved.custom : [])) { try { this.endpoints.push(this._cleanCustom(row, row.id)); } catch (error) {} }
    this.byId = new Map(this.endpoints.map((item) => [item.id, item]));
    try { const loaded = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); if (loaded && typeof loaded === 'object') this.state = Object.assign(this.state, loaded); } catch (error) {}
    // 首次启动立即落盘安装档案，之后升级不会因环境变量缺失而改变预设。
    if (!hadConfig) this._persistConfig();
  }
  _cleanCustom(input, forcedId) { const endpoint = { id: forcedId || 'custom-' + crypto.randomBytes(6).toString('hex'), role: 'source', target: 'external', custom: true, method: 'GET', schedule: '跟随全站采集（低频）', source: '自定义公开接口', docsUrl: '' }; endpoint.name = text(input.name, 80); if (endpoint.name.length < 2) throw new Error('接口名称至少 2 个字符'); endpoint.description = text(input.description, 1000); endpoint.url = validateUrl(input.url, endpoint); endpoint.enabled = input.enabled === true; endpoint.timeoutMs = Math.round(Number(input.timeoutMs) || 15000); if (endpoint.timeoutMs < 3000 || endpoint.timeoutMs > 60000) throw new Error('自定义接口超时必须为 3000–60000 毫秒'); endpoint.retries = Math.round(Number(input.retries) || 0); if (endpoint.retries < 0 || endpoint.retries > 2) throw new Error('自定义接口重试次数必须为 0–2'); endpoint.format = ['json', 'rss', 'atom'].includes(input.format) ? input.format : 'json'; endpoint.maxItems = Math.min(Math.max(1, Math.round(Number(input.maxItems) || 20)), 50); endpoint.itemsPath = text(input.itemsPath, 200); endpoint.idPath = text(input.idPath, 200); endpoint.titlePath = text(input.titlePath, 200) || 'title'; endpoint.summaryPath = text(input.summaryPath, 200) || 'description'; endpoint.urlPath = text(input.urlPath, 200) || 'url'; endpoint.datePath = text(input.datePath, 200) || 'published_at'; endpoint.sourceName = text(input.sourceName, 120) || endpoint.name; endpoint.category = ['ai-models', 'ai-products', 'industry', 'paper', 'tutorial', 'tip'].includes(input.category) ? input.category : 'industry'; endpoint.selected = input.selected === true; endpoint.publishMode = input.publishMode === 'draft' ? 'draft' : 'published'; return endpoint; }
  _persistConfig() { const overrides = {}; const custom = []; for (const endpoint of this.endpoints) { const base = this.defaults.find((item) => item.id === endpoint.id); if (!base) { custom.push(endpoint); continue; } const changed = {}; for (const key of ['name', 'description', 'enabled', 'url', 'timeoutMs', 'retries', 'maxItems', 'publishMode', 'selected']) if (endpoint[key] !== base[key]) changed[key] = endpoint[key]; if (Object.keys(changed).length) overrides[endpoint.id] = changed; } atomicWrite(this.configFile, JSON.stringify({ version: 3, preset: this.preset, updatedAt: nowIso(), overrides, custom }, null, 2) + '\n'); }
  _persistState() { this.state.updatedAt = nowIso(); atomicWrite(this.stateFile, JSON.stringify(this.state, null, 1)); }
  collectorConfig() { const result = Object.fromEntries(CORE_COLLECTOR_IDS.map((id) => [id, { id, enabled: false }])); for (const endpoint of this.endpoints.filter((e) => e.role !== 'source')) result[endpoint.id] = { id: endpoint.id, enabled: endpoint.enabled, url: endpoint.url, timeoutMs: endpoint.timeoutMs, retries: endpoint.retries }; return result; }
  sourceConfigs() { return this.endpoints.filter((e) => e.role === 'source' && e.enabled); }
  summary() { const out = { total: this.endpoints.length, enabled: 0, healthy: 0, degraded: 0, error: 0, idle: 0, collector: 0, archive: 0, onDemand: 0, sync: 0, source: 0, custom: 0 }; for (const endpoint of this.endpoints) { if (endpoint.enabled) out.enabled++; if (endpoint.custom) out.custom++; if (endpoint.role === 'collector') out.collector++; else if (endpoint.role === 'archive') out.archive++; else if (endpoint.role === 'on-demand') out.onDemand++; else if (endpoint.role === 'sync') out.sync++; else if (endpoint.role === 'source') out.source++; const state = this.state.byId[endpoint.id]; if (!state || !state.lastAt) out.idle++; else if (state.lastStatus === 'ok' || state.lastStatus === 'not_modified') out.healthy++; else if (state.lastStatus === 'fallback' || state.lastStatus === 'disabled') out.degraded++; else out.error++; } return out; }
  list() { return { preset: this.preset, summary: this.summary(), updatedAt: this.state.updatedAt, items: this.endpoints.map((endpoint) => Object.assign({}, endpoint, { state: this.state.byId[endpoint.id] || null })) }; }
  logs(id, limit) { const size = Math.min(Math.max(1, Number(limit) || 100), 500); return (this.state.runs || []).filter((entry) => !id || entry.id === id).slice(-size).reverse(); }
  get(id) { const endpoint = this.byId.get(id); if (!endpoint) return null; let cached = null; try { cached = JSON.parse(fs.readFileSync(path.join(this.cacheDir, id + '.json'), 'utf8')); } catch (error) {} return Object.assign({}, endpoint, { state: this.state.byId[id] || null, logs: this.logs(id, 100), cached }); }
  create(input) { const endpoint = this._cleanCustom(input || {}); this.endpoints.push(endpoint); this.byId.set(endpoint.id, endpoint); this._persistConfig(); return this.get(endpoint.id); }
  remove(id) { const endpoint = this.byId.get(id); if (!endpoint) return null; if (!endpoint.custom) throw new Error('内置接口不能删除，可以在编辑页停用'); this.endpoints = this.endpoints.filter((row) => row.id !== id); this.byId.delete(id); delete this.state.byId[id]; this._persistConfig(); this._persistState(); return true; }
  update(id, patch) { const endpoint = this.byId.get(id); if (!endpoint) return null; const input = patch || {}; if (endpoint.custom) { Object.assign(endpoint, this._cleanCustom(Object.assign({}, endpoint, input), endpoint.id)); } else { if (input.name !== undefined) { const value = text(input.name, 80); if (value.length < 2) throw new Error('接口名称至少 2 个字符'); endpoint.name = value; } if (input.description !== undefined) endpoint.description = text(input.description, 1000); if (input.url !== undefined) endpoint.url = validateUrl(input.url, endpoint); if (input.enabled !== undefined) endpoint.enabled = input.enabled === true; if (input.timeoutMs !== undefined) { const value = Math.round(Number(input.timeoutMs)); if (!Number.isFinite(value) || value < 3000 || value > 120000) throw new Error('超时必须为 3000–120000 毫秒'); endpoint.timeoutMs = value; } if (input.retries !== undefined) { const value = Math.round(Number(input.retries)); if (!Number.isFinite(value) || value < 0 || value > 5) throw new Error('重试次数必须为 0–5'); endpoint.retries = value; } if (endpoint.role === 'source' && input.publishMode !== undefined) endpoint.publishMode = input.publishMode === 'published' ? 'published' : 'draft'; } this._persistConfig(); return this.get(id); }
  recordRun(entries, trigger, payloads) { const at = nowIso(); const lines = []; for (const input of (entries || [])) { if (!input || !this.byId.has(input.id)) continue; const event = { at, id: input.id, trigger: text(trigger, 50) || 'unknown', status: input.status || (input.ok ? 'ok' : 'error'), httpStatus: Number(input.httpStatus) || null, durationMs: Number(input.durationMs) || 0, count: Number.isFinite(Number(input.count)) ? Number(input.count) : null, bytes: Number(input.bytes) || null, etag: text(input.etag, 300) || null, cacheControl: text(input.cacheControl, 300) || null, requestId: text(input.requestId, 200) || null, error: text(input.error, 1200) || null }; lines.push(event); const previous = this.state.byId[input.id] || { attempts: 0, successes: 0, failures: 0, totalItems: 0 }; previous.attempts++; if (event.status === 'ok' || event.status === 'not_modified') previous.successes++; else if (event.status !== 'disabled') previous.failures++; if (event.count != null) previous.totalItems += event.count; Object.assign(previous, { lastAt: event.at, lastStatus: event.status, lastHttpStatus: event.httpStatus, lastDurationMs: event.durationMs, lastCount: event.count, lastBytes: event.bytes, lastEtag: event.etag || previous.lastEtag || null, lastCacheControl: event.cacheControl || previous.lastCacheControl || null, lastRequestId: event.requestId, lastError: event.error }); this.state.byId[input.id] = previous; if (payloads && payloads[input.id] !== undefined) atomicWrite(path.join(this.cacheDir, input.id + '.json'), JSON.stringify({ updatedAt: at, endpointId: input.id, data: preview(payloads[input.id]) }, null, 1)); } this.state.runs = (this.state.runs || []).concat(lines).slice(-2000); this._persistState(); return lines; }
  _resolveProbeUrl(endpoint, context) { let url = endpoint.url; if (url.includes('{publicId}')) { const hot = context && context.hot || []; const storyUrl = hot.map((item) => item && item.links && (item.links.story || item.links.original)).find((value) => /\/story\/[^/?#]+/.test(String(value || ''))); if (!storyUrl) throw new Error('当前热点没有可用的 story publicId'); url = url.replace('{publicId}', encodeURIComponent(String(storyUrl).match(/\/story\/([^/?#]+)/)[1])); } if (url.includes('{date}')) { let cached = null; try { cached = JSON.parse(fs.readFileSync(path.join(this.cacheDir, 'dailyArchive.json'), 'utf8')); } catch (error) {} const rows = cached && Array.isArray(cached.data) ? cached.data : []; const date = rows.map((item) => item && item.date).find((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))); if (!date) throw new Error('请先采集日报归档索引'); url = url.replace('{date}', date); } if (url.includes('{cursor}')) { const cursor = this.state.byId.selectedSnapshot && this.state.byId.selectedSnapshot.lastCursor; if (!cursor) throw new Error('请先测试完整精选快照'); url = url.replace('{cursor}', encodeURIComponent(cursor)); } return url; }
  async _fetch(endpoint, context) { const url = this._resolveProbeUrl(endpoint, context || {}); await assertPublicDns(url); const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), endpoint.timeoutMs); const started = Date.now(); try { const response = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': endpoint.format === 'atom' || endpoint.format === 'rss' ? 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' : 'application/json' }, signal: ac.signal, redirect: 'manual' }); if (response.status >= 300 && response.status < 400) throw new Error('安全策略拒绝未校验重定向（HTTP ' + response.status + '）'); const declared = Number(response.headers.get('content-length')) || 0; if (declared > MAX_RESPONSE_BYTES) throw new Error('响应超过 2MB 限制'); const raw = await response.text(); if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('响应超过 2MB 限制'); let payload = raw; let items = null; if (endpoint.role === 'source') { if (endpoint.format === 'json') { payload = raw ? JSON.parse(raw) : null; items = parseJson(payload, endpoint); } else items = parseFeed(raw, endpoint); } else { try { payload = raw ? JSON.parse(raw) : null; } catch (error) {} } return { response, raw, payload, items, durationMs: Date.now() - started }; } finally { clearTimeout(timer); } }
  async probe(id, context) { const endpoint = this.byId.get(id); if (!endpoint) return null; let result; let payload = null; try { const got = await this._fetch(endpoint, context); payload = got.items || got.payload; const response = got.response; result = { id, ok: response.ok, status: response.ok ? 'ok' : 'error', httpStatus: response.status, durationMs: got.durationMs, count: got.items ? got.items.length : got.payload && (got.payload.count != null ? got.payload.count : Array.isArray(got.payload.items) ? got.payload.items.length : Array.isArray(got.payload.changes) ? got.payload.changes.length : null), bytes: Buffer.byteLength(got.raw), etag: response.headers.get('etag'), cacheControl: response.headers.get('cache-control'), requestId: response.headers.get('x-request-id'), error: response.ok ? null : (got.payload && (got.payload.detail || got.payload.title || got.payload.message)) || ('HTTP ' + response.status) }; if (got.payload && got.payload.cursor) result.cursor = text(got.payload.cursor, 2000); } catch (error) { result = { id, ok: false, status: 'error', httpStatus: null, durationMs: 0, count: null, error: String(error.message || error) }; } this.recordRun([result], 'admin-test', payload != null ? { [id]: payload } : null); if (result.cursor) { this.state.byId[id].lastCursor = result.cursor; this._persistState(); } return { result, preview: preview(payload), endpoint: this.get(id) }; }
  async collectSources(trigger) { const configs = this.sourceConfigs(); const results = []; const batches = []; let cursor = 0; const worker = async () => { while (cursor < configs.length) { const endpoint = configs[cursor++]; const started = Date.now(); let event; try { const got = await this._fetch(endpoint, {}); if (!got.response.ok) throw new Error('HTTP ' + got.response.status); const fetchedAt = nowIso(); const items = (got.items || []).map((item) => toIntel(item, endpoint, fetchedAt)); event = { id: endpoint.id, ok: true, status: 'ok', httpStatus: got.response.status, durationMs: got.durationMs, count: items.length, bytes: Buffer.byteLength(got.raw), etag: got.response.headers.get('etag'), cacheControl: got.response.headers.get('cache-control'), requestId: got.response.headers.get('x-request-id') }; batches.push({ endpoint, items, fetchedAt }); this.recordRun([event], trigger, { [endpoint.id]: items }); } catch (error) { event = { id: endpoint.id, ok: false, status: 'error', durationMs: Date.now() - started, error: String(error.message || error) }; this.recordRun([event], trigger); } results.push(event); } }; await Promise.all(Array.from({ length: Math.min(3, configs.length) }, worker)); return { results, batches }; }
}

module.exports = { EndpointRegistry, DEFAULT_ENDPOINTS: FULL_ENDPOINTS, FULL_ENDPOINTS, COMMUNITY_ENDPOINTS, validateUrl, parseFeed, parseJson, isPrivateIp };
