// intelligence-store.js — 按情报条目持久化、去重与后台 CRUD
// 使用单个原子 JSON 数据文件，适合当前数据规模；采集快照仍由 store.js 独立负责。

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./config');

const STATUS = new Set(['published', 'draft', 'archived', 'deleted']);
const WINDOWS = new Set(['7d', '24h', 'hot', 'daily']);
const CATEGORIES = new Set(['ai-models', 'ai-products', 'industry', 'paper', 'tutorial', 'tip']);
const CATEGORY_BY_DAILY = {
  '模型发布/更新': 'ai-models',
  '产品发布/更新': 'ai-products',
  '行业动态': 'industry',
  '论文研究': 'paper',
  '技巧与观点': 'tip',
};

// 轻量、确定性的教程识别：只作用于上游仍标记为 tip 的基础分类。
// 后台人工分类保存在 record.manual.category，展示时始终以人工值为准。
function tutorialScore(item) {
  const titleValue = text(item && item.title, 500);
  const summaryValue = text(item && item.summary, 3000);
  const combined = titleValue + '\n' + summaryValue;
  let score = 0;
  if (/(教程|指南|入门|实战|手把手|从零(?:开始)?|快速上手|完整攻略|操作步骤|搭建|部署|安装|配置|how[ -]?to|tutorial|guide|walkthrough|step[ -]?by[ -]?step|cookbook|getting started)/i.test(titleValue)) score += 2;
  if (/(如何|怎么|怎样|用.+(?:实现|构建|搭建|开发|部署|配置)|构建.+(?:应用|智能体|工作流))/i.test(titleValue)) score += 2;
  const steps = combined.match(/(步骤|首先|其次|然后|最后|安装|配置|运行|代码|命令|示例|API|依赖|环境变量)/gi) || [];
  if (steps.length >= 2) score += 1;
  if (/(发布|宣布|融资|收购|裁员|诉讼|观点|认为|表示|报告称|数据显示)/i.test(titleValue)) score -= 2;
  return score;
}

function classifyCategory(item, category) {
  const current = text(category, 80);
  if (CATEGORIES.has(current)) return current === 'tip' && tutorialScore(item) >= 2 ? 'tutorial' : current;
  const titleValue = text(item && item.title, 500);
  const summaryValue = text(item && item.summary, 3000);
  const sourceValue = sourceName(item);
  const combined = [titleValue, summaryValue, sourceValue].join('\n');
  if (tutorialScore(item) >= 2) return 'tutorial';
  if (/(论文|研究论文|技术报告|研究报告|arxiv|paper|benchmark|基准测试|数据集|dataset|评测|实验结果|学术|research)/i.test(combined)) return 'paper';
  if (/(大模型|语言模型|多模态模型|视觉模型|推理模型|模型权重|开源模型|参数量|上下文窗口|训练模型|微调模型|\bLLM\b|\bVLM\b|\bGPT(?:[-\s]?\d+)?\b|DeepSeek|Qwen|通义千问|Claude|Gemini|GLM|Llama|Mistral|Grok|Hugging\s*Face)/i.test(combined)) return 'ai-models';
  if (/(AI\s*(?:产品|应用|工具|平台|助手|浏览器|插件)|智能体|Agent|应用上线|功能上线|功能更新|产品发布|客户端|工作流|生成器|编辑器|API\s*(?:发布|上线|更新)|App\b|Copilot|Cursor|Sora)/i.test(combined)) return 'ai-products';
  if (/(融资|收购|并购|投资|估值|营收|利润|市场份额|行业|产业|政策|监管|法规|诉讼|合作|裁员|公司战略|商业化|数据中心|算力基础设施|芯片订单)/i.test(combined)) return 'industry';
  return 'tip';
}

function nowIso() { return new Date().toISOString(); }
function hash(value, size) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, size || 24);
}
function text(value, max) {
  if (value == null) return '';
  return String(value).replace(/\u0000/g, '').trim().slice(0, max);
}
function validHttpUrl(value) {
  const input = text(value, 3000);
  if (!input) return '';
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch (e) { return ''; }
}
let configuredUpstreamCache = { value: null, host: '' };
function isConfiguredUpstreamUrl(value) {
  const configured = text(process.env.AIQB_UPSTREAM_BASE_URL, 3000);
  if (configuredUpstreamCache.value !== configured) {
    configuredUpstreamCache = { value: configured, host: '' };
    try { configuredUpstreamCache.host = new URL(configured).hostname.toLowerCase(); } catch (e) {}
  }
  const safe = validHttpUrl(value);
  if (!safe || !configuredUpstreamCache.host) return false;
  try { return new URL(safe).hostname.toLowerCase() === configuredUpstreamCache.host; } catch (e) { return false; }
}
function canonicalUrl(value) {
  const safe = validHttpUrl(value);
  if (!safe) return '';
  try {
    const url = new URL(safe);
    url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_.+|spm|from|source|ref|ref_src|fbclid|gclid|igshid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch (e) { return safe.toLowerCase(); }
}
function sourceName(item) {
  return text(item && item.source && item.source.name, 300) || text(item && item.sourceName, 300);
}

// 英文入口只展示正文确实以英文为主的记录，避免只翻译导航、正文仍为中文的薄内容页。
function isEnglishItem(item) {
  const shown = item || {};
  const sample = text([shown.title, shown.summary].filter(Boolean).join(' '), 12000);
  const cjk = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const words = (sample.match(/[A-Za-z][A-Za-z0-9'-]{1,}/g) || []).length;
  return words >= 4 && latin >= 20 && cjk / Math.max(1, latin + cjk) <= 0.12;
}
function itemUrl(item) {
  const links = (item && item.links) || {};
  return validHttpUrl(links.original || item.originalUrl || links.upstream || item.upstreamUrl || item.url);
}
function normalizedTitle(value) {
  return text(value, 500).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
function identityAliases(item) {
  const aliases = [];
  const add = (identity) => {
    if (!identity) return;
    const id = /^intel-[a-f0-9]{16,32}$/.test(identity) ? identity : 'intel-' + hash(identity, 24);
    if (aliases.indexOf(id) === -1) aliases.push(id);
  };
  if (item && /^intel-[a-f0-9]{16,32}$/.test(String(item._intelId || ''))) add(String(item._intelId));
  const links = (item && item.links) || {};
  const upstream = canonicalUrl(links.upstream || item && item.upstreamUrl);
  const match = upstream.match(/\/items\/([^/?#]+)/i);
  if (match) add('upstream:' + match[1]);
  const original = canonicalUrl(links.original || item && (item.originalUrl || item.url));
  if (original) add('url:' + original);
  if (item && item.id) add('source-id:' + text(item.id, 500));
  const title = normalizedTitle(item && item.title);
  const source = normalizedTitle(sourceName(item));
  if (title) add('title:' + title + '|source:' + source);
  return aliases;
}
function fingerprint(item) {
  if (item && /^intel-[a-f0-9]{16,32}$/.test(String(item._intelId || ''))) return String(item._intelId);
  const links = (item && item.links) || {};
  const upstream = canonicalUrl(links.upstream || item.upstreamUrl);
  const match = upstream.match(/\/items\/([^/?#]+)/i);
  const identity = match ? 'upstream:' + match[1]
    : canonicalUrl(links.original || item.originalUrl || item.url)
      ? 'url:' + canonicalUrl(links.original || item.originalUrl || item.url)
      : item && item.id ? 'source-id:' + text(item.id, 500)
        : 'title:' + text(item && item.title, 500).toLowerCase() + '|source:' + sourceName(item).toLowerCase();
  return 'intel-' + hash(identity, 24);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function cleanItem(item, categoryHint, defaultSelected) {
  if (!item || typeof item !== 'object') return null;
  const title = text(item.title, 500);
  if (title.length < 2) return null;
  const links = item.links || {};
  const source = sourceName(item);
  const original = validHttpUrl(links.original || item.originalUrl || item.url);
  const upstream = validHttpUrl(links.upstream || item.upstreamUrl);
  const publishedAt = text(item.publishedAt, 80);
  const discoveredAt = text(item.discoveredAt, 80);
  const category = text(item.category || categoryHint, 80) || null;
  return {
    id: text(item.id, 500) || undefined,
    title,
    originalTitle: text(item.originalTitle, 500) || undefined,
    summary: text(item.summary, 8000),
    source: { name: source || '未知来源' },
    links: { original: original || undefined, upstream: upstream || undefined },
    publishedAt: publishedAt || undefined,
    discoveredAt: discoveredAt || undefined,
    category: classifyCategory(item, category),
    score: Number.isFinite(Number(item.score)) ? Number(item.score) : undefined,
    // 精选必须来自上游明确字段或明确的“精选接口”语义；缺失字段一律按普通处理。
    // `_src: C` 是本站外部 RSS/API 直采标识。这类来源没有上游精选语义，
    // 即使旧快照曾被错误写成 selected=true，也必须按普通情报处理。
    selected: item._src === 'C' ? false : (item.selected === true || (item.selected == null && defaultSelected === true)),
    reason: text(item.reason, 2000) || undefined,
    attribution: item.attribution && typeof item.attribution === 'object' ? {
      name: text(item.attribution.name, 300) || undefined,
      url: validHttpUrl(item.attribution.url) || undefined,
    } : undefined,
    _src: text(item._src, 20) || undefined,
  };
}

function publicItem(record) {
  const base = clone(record.base || {});
  const manual = record.manual || {};
  if (manual.title !== undefined) base.title = manual.title;
  if (manual.summary !== undefined) base.summary = manual.summary;
  if (manual.category !== undefined) base.category = manual.category || null;
  if (manual.sourceName !== undefined) base.source = { name: manual.sourceName || '未知来源' };
  base.links = Object.assign({}, base.links || {});
  if (manual.originalUrl !== undefined) base.links.original = manual.originalUrl || undefined;
  if (manual.upstreamUrl !== undefined) base.links.upstream = manual.upstreamUrl || undefined;
  if (manual.publishedAt !== undefined) base.publishedAt = manual.publishedAt || undefined;
  // 私有聚合服务只负责采集和去重。公开 API、文章与页面保留原始来源，
  // 但不暴露中间服务的域名、详情链接或归属字段。
  if (isConfiguredUpstreamUrl(base.links.upstream)) delete base.links.upstream;
  if (isConfiguredUpstreamUrl(base.links.story)) delete base.links.story;
  if (isConfiguredUpstreamUrl(base.links.original)) delete base.links.original;
  if (base.attribution && isConfiguredUpstreamUrl(base.attribution.url)) delete base.attribution;
  if (!base.publishedAt && !base.discoveredAt) base.discoveredAt = record.firstSeenAt || record.createdAt;
  base._intelId = record.id;
  return base;
}

function recordTime(record, shown) {
  const candidates = [shown && shown.publishedAt, shown && shown.discoveredAt, record && record.firstSeenAt, record && record.createdAt];
  for (const value of candidates) {
    const timestamp = Date.parse(value || '');
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

class IntelligenceStore {
  constructor(dataDir, stateDb) {
    this.dir = path.join(dataDir, 'intelligence');
    this.file = path.join(this.dir, 'items.json');
    this.items = [];
    this.byId = new Map();
    this.aliasToId = new Map();
    this.metrics = { received: 0, added: 0, updated: 0, invalid: 0, duplicatesPrevented: 0, runs: [] };
    this.updatedAt = null;
    this.stateDb = stateDb || null;
    // 公开查询只读索引。此前 publicList/SEO 在每次请求中会多次深拷贝、
    // 过滤并排序全部记录；索引改为仅在数据版本变化后重建一次。
    this._publicIndex = null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    let loadedFromDb = false;
    if (this.stateDb) {
      const data = this.stateDb.getJSON('intelligence', 'store');
      if (data && Array.isArray(data.items)) {
        this.items = data.items.filter((item) => item && item.id && item.base);
        if (data.metrics && typeof data.metrics === 'object') this.metrics = Object.assign(this.metrics, data.metrics);
        this.updatedAt = data.updatedAt || null;
        loadedFromDb = true;
      }
    }
    try {
      if (loadedFromDb) throw new Error('loaded_from_sqlite');
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && Array.isArray(data.items)) this.items = data.items.filter((item) => item && item.id && item.base);
      if (data && data.metrics && typeof data.metrics === 'object') this.metrics = Object.assign(this.metrics, data.metrics);
      this.updatedAt = data && data.updatedAt || null;
    } catch (e) { /* 首次启动或已由 SQLite 加载 */ }
    this._reindex();
    if (this.stateDb && !loadedFromDb && this.items.length) {
      const payload = { version: 1, updatedAt: this.updatedAt, metrics: this.metrics, items: this.items };
      this.stateDb.setJSON('intelligence', 'store', payload, this.updatedAt || nowIso());
      this.stateDb.markMigration('intelligence-json-to-wal', { items: this.items.length, source: this.file });
    }
  }

  migrateTutorialCategories() {
    const stats = { scanned: 0, migrated: 0, manualSkipped: 0, remainingTip: 0 };
    for (const record of this.items) {
      if (!record || !record.base || record.base.category !== 'tip') continue;
      stats.scanned++;
      if (record.manual && Object.prototype.hasOwnProperty.call(record.manual, 'category')) {
        stats.manualSkipped++;
        continue;
      }
      if (classifyCategory(record.base, 'tip') === 'tutorial') {
        record.base.category = 'tutorial';
        stats.migrated++;
      } else stats.remainingTip++;
    }
    if (stats.migrated) this._persist();
    return stats;
  }

  migrateMissingCategories() {
    const stats = { scanned: 0, migrated: 0, manualSkipped: 0, byCategory: {} };
    for (const record of this.items) {
      if (!record || !record.base || CATEGORIES.has(record.base.category)) continue;
      stats.scanned++;
      if (record.manual && Object.prototype.hasOwnProperty.call(record.manual, 'category')) {
        stats.manualSkipped++;
        continue;
      }
      const category = classifyCategory(record.base, record.base.category);
      record.base.category = category;
      stats.migrated++;
      stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
    }
    if (stats.migrated) this._persist();
    return stats;
  }

  migrateExternalTiers() {
    const stats = { scanned: 0, downgraded: 0, alreadyOrdinary: 0 };
    for (const record of this.items) {
      if (!record || !record.base || (record.sourceKind !== 'custom' && record.base._src !== 'C')) continue;
      stats.scanned++;
      if (record.base._src === 'C' && record.sourceKind !== 'manual') record.sourceKind = 'custom';
      if (record.base.selected === false) { stats.alreadyOrdinary++; continue; }
      record.base.selected = false;
      record.updatedAt = nowIso();
      stats.downgraded++;
    }
    if (stats.downgraded) this._persist();
    return stats;
  }

  _reindex() {
    this.byId = new Map(this.items.map((item) => [item.id, item]));
    this.aliasToId = new Map();
    for (const record of this.items) {
      const aliases = Array.from(new Set([record.id].concat(record.aliases || [], identityAliases(record.base || {}))));
      record.aliases = aliases;
      for (const alias of aliases) {
        if (!this.aliasToId.has(alias)) this.aliasToId.set(alias, record.id);
      }
    }
    this._publicIndex = null;
  }
  _persist() {
    this.updatedAt = nowIso();
    this._publicIndex = null;
    const payload = { version: 1, updatedAt: this.updatedAt, metrics: this.metrics, items: this.items };
    if (this.stateDb) this.stateDb.setJSON('intelligence', 'store', payload, this.updatedAt);
    atomicWrite(this.file, JSON.stringify(payload, null, 1));
  }
  revision() { return this.updatedAt || 'empty'; }

  refreshFromStateDb() {
    if (!this.stateDb) return false;
    const revision = this.stateDb.getRevision('intelligence', 'store');
    if (!revision || revision === this.revision()) return false;
    const data = this.stateDb.getJSON('intelligence', 'store');
    if (!data || !Array.isArray(data.items)) return false;
    this.items = data.items.filter((item) => item && item.id && item.base);
    this.metrics = Object.assign({ received: 0, added: 0, updated: 0, invalid: 0, duplicatesPrevented: 0, runs: [] }, data.metrics || {});
    this.updatedAt = data.updatedAt || revision;
    this._reindex();
    return true;
  }

  _ensurePublicIndex() {
    if (this._publicIndex && this._publicIndex.revision === this.revision()) return this._publicIndex;
    const rows = [];
    const byId = new Map();
    for (const record of this.items) {
      if (!record || record.status !== 'published') continue;
      const item = publicItem(record);
      const source = sourceName(item);
      const time = recordTime(record, item);
      const windows = Array.isArray(record.windows) ? record.windows : [];
      const standalone = windows.length > 0 && windows.every((value) => value === 'hot' || value === 'daily');
      const row = {
        id: record.id,
        record,
        item,
        time,
        source,
        category: item.category || 'uncategorized',
        selected: item.selected !== false,
        standalone,
        english: isEnglishItem(item),
        haystack: [item.title, item.summary, source, item.category, itemUrl(item)].join('\n').toLowerCase(),
      };
      rows.push(row);
      byId.set(record.id, row);
    }
    rows.sort((a, b) => b.time - a.time || String(b.id).localeCompare(String(a.id)));
    this._publicIndex = { revision: this.revision(), rows, byId };
    return this._publicIndex;
  }

  _references(snapshot) {
    const refs = [];
    for (const item of (snapshot.window7d || [])) refs.push({ item, window: '7d' });
    for (const item of (snapshot.window24h || [])) refs.push({ item, window: '24h' });
    for (const item of (snapshot.hot || [])) refs.push({ item, window: 'hot' });
    const sections = snapshot.daily && snapshot.daily.report && snapshot.daily.report.sections;
    if (Array.isArray(sections)) {
      for (const section of sections) {
        for (const item of (section.items || [])) refs.push({ item, window: 'daily', category: CATEGORY_BY_DAILY[section.label] || null });
      }
    }
    return refs;
  }

  // refs: [{ item, window, category? }]；window 为 null 表示来自窗口外同步（不覆盖已有窗口归属）
  _buildBatch(refs, meta) {
    const batch = new Map();
    const batchAlias = new Map();
    let received = 0, invalid = 0, repeatedInBatch = 0;
    for (const ref of refs) {
      received++;
      const cleaned = cleanItem(ref.item, ref.category, meta && meta.defaultSelected);
      if (!cleaned) { invalid++; continue; }
      const aliases = identityAliases(ref.item);
      const knownId = aliases.map((alias) => this.aliasToId.get(alias) || batchAlias.get(alias)).find(Boolean);
      const id = knownId || fingerprint(ref.item);
      let row = batch.get(id);
      if (!row) {
        row = { id, base: cleaned, windows: new Set(), aliases: new Set(aliases.concat(id)) };
        batch.set(id, row);
      } else {
        repeatedInBatch++;
        // 更完整的摘要优先，避免日报简版覆盖详情。
        if ((cleaned.summary || '').length > (row.base.summary || '').length) row.base = Object.assign({}, row.base, cleaned);
        for (const alias of aliases) row.aliases.add(alias);
      }
      for (const alias of aliases) batchAlias.set(alias, id);
      if (ref.window) row.windows.add(ref.window);
    }
    return { batch, received, invalid, repeatedInBatch };
  }

  _ingest(refs, meta, at) {
    const { batch, received, invalid, repeatedInBatch } = this._buildBatch(refs, meta);
    const defaultIncomingKind = text(meta && meta.sourceKind, 30) || 'collected';

    let added = 0, updated = 0, existing = 0;
    for (const row of batch.values()) {
      const incomingKind = row.base._src === 'C' ? 'custom' : defaultIncomingKind;
      let record = this.byId.get(row.id);
      if (!record) {
        record = {
          id: row.id,
          fingerprint: row.id,
          aliases: Array.from(row.aliases),
          sourceKind: incomingKind,
          status: STATUS.has(meta && meta.defaultStatus) ? meta.defaultStatus : 'published',
          base: row.base,
          manual: {},
          windows: Array.from(row.windows),
          firstSeenAt: at,
          lastSeenAt: at,
          seenCount: 1,
          createdAt: at,
          updatedAt: at,
        };
        this.items.push(record);
        this.byId.set(record.id, record);
        added++;
      } else {
        existing++;
        // 上游精选字段的层级优先于外部聚合源；外部源不能反向覆盖已确认的层级。
        if (incomingKind === 'custom' && record.sourceKind !== 'custom') row.base.selected = record.base.selected;
        else if (record.sourceKind !== 'manual' && incomingKind !== 'custom') record.sourceKind = incomingKind;
        if (record.sourceKind === 'manual') row.base.selected = record.base.selected;
        record.base = row.base;
        record.aliases = Array.from(new Set((record.aliases || []).concat(Array.from(row.aliases))));
        // 窗口外同步（精选全量同步）不改变窗口归属，避免抹掉正常采集写入的窗口。
        if (row.windows.size) record.windows = Array.from(row.windows);
        // 上游池重新收录了曾被同步移除而归档的条目 → 恢复发布；人工删除（deleted）与人工条目不受影响。
        if (record.status === 'archived' && record.sourceKind !== 'manual' && record.manualStatus !== true) record.status = 'published';
        record.lastSeenAt = at;
        record.seenCount = (Number(record.seenCount) || 0) + 1;
        record.updatedAt = at;
        updated++;
      }
      for (const alias of (record.aliases || []).concat(record.id)) this.aliasToId.set(alias, record.id);
    }

    const result = {
      at,
      trigger: text(meta && meta.trigger, 50) || 'unknown',
      received,
      valid: received - invalid,
      unique: batch.size,
      added,
      updated,
      invalid,
      duplicatesInBatch: repeatedInBatch,
      duplicatesPrevented: repeatedInBatch + existing,
      totalAfter: this.items.filter((item) => item.status !== 'deleted').length,
    };
    this.metrics.received = (this.metrics.received || 0) + received;
    this.metrics.added = (this.metrics.added || 0) + added;
    this.metrics.updated = (this.metrics.updated || 0) + updated;
    this.metrics.invalid = (this.metrics.invalid || 0) + invalid;
    this.metrics.duplicatesPrevented = (this.metrics.duplicatesPrevented || 0) + result.duplicatesPrevented;
    this.metrics.runs = (this.metrics.runs || []).concat(result).slice(-1000);
    this._persist();
    return result;
  }

  ingestSnapshot(snapshot, meta) {
    const at = text(snapshot && snapshot.fetchedAt, 80) || nowIso();
    return this._ingest(this._references(snapshot || {}), meta, at);
  }

  // 精选全量同步专用：扁平条目入库，不带窗口语义
  ingestItems(items, meta) {
    const at = text(meta && meta.at, 80) || nowIso();
    const rows = Array.isArray(items) ? items : [];
    return this._ingest(rows.map((item) => ({ item, window: null })), meta, at);
  }

  // 精选增量同步的 remove 操作：把对应条目归档（保留数据、可恢复）；人工条目与回收站/已归档状态不覆盖
  archiveByRemoteIds(remoteIds, at) {
    const stamp = text(at, 80) || nowIso();
    const result = { archived: 0, missing: 0, skipped: 0, ids: [] };
    for (const remoteId of (Array.isArray(remoteIds) ? remoteIds : [])) {
      const id = text(remoteId, 500);
      if (!id) { result.missing++; continue; }
      // 远端 ID 对应 source-id 与 upstream 两类身份别名（aliasToId 存的是哈希后的别名）
      const candidates = identityAliases({ id }).concat(identityAliases({ links: { upstream: 'https://upstream.invalid/items/' + id } }));
      let record = null;
      for (const alias of candidates) {
        const found = this.aliasToId.get(alias);
        if (found) { record = this.byId.get(found); if (record) break; }
      }
      if (!record) { result.missing++; continue; }
      if (record.sourceKind === 'manual' || record.status === 'deleted' || record.status === 'archived') { result.skipped++; continue; }
      record.status = 'archived';
      record.updatedAt = stamp;
      result.archived++;
      result.ids.push(record.id);
    }
    if (result.archived) this._persist();
    return result;
  }

  _recordForSource(item) {
    if (item && item._intelId && this.byId.has(item._intelId)) return this.byId.get(item._intelId);
    for (const alias of identityAliases(item)) {
      const id = this.aliasToId.get(alias);
      if (id && this.byId.has(id)) return this.byId.get(id);
    }
    return this.byId.get(fingerprint(item));
  }

  applyToSnapshot(snapshot) {
    if (!snapshot) return null;
    const output = clone(snapshot);
    const renderArray = (items, windowName) => {
      const seen = new Set();
      const out = [];
      for (const source of (items || [])) {
        const record = this._recordForSource(source);
        if (!record || record.status !== 'published' || seen.has(record.id)) continue;
        seen.add(record.id);
        out.push(publicItem(record));
      }
      for (const record of this.items) {
        if (!['manual', 'custom'].includes(record.sourceKind) || record.status !== 'published' || seen.has(record.id)) continue;
        if ((record.windows || []).indexOf(windowName) === -1) continue;
        seen.add(record.id);
        out.unshift(publicItem(record));
      }
      return out;
    };
    output.window7d = renderArray(snapshot.window7d, '7d');
    output.window24h = renderArray(snapshot.window24h, '24h');
    output.hot = renderArray(snapshot.hot, 'hot');
    const sections = output.daily && output.daily.report && output.daily.report.sections;
    if (Array.isArray(sections)) {
      for (const section of sections) section.items = renderArray(section.items, 'daily').filter((item) => item.category === (CATEGORY_BY_DAILY[section.label] || item.category));
    }
    const dailyReport = output.daily && output.daily.report;
    if (dailyReport && dailyReport.links && typeof dailyReport.links === 'object') {
      for (const [key, value] of Object.entries(dailyReport.links)) {
        if (isConfiguredUpstreamUrl(value)) delete dailyReport.links[key];
      }
    }
    if (dailyReport && dailyReport.attribution && isConfiguredUpstreamUrl(dailyReport.attribution.url)) delete dailyReport.attribution;
    output.dataRevision = this.revision();
    return output;
  }

  stats() {
    const today = new Date().toISOString().slice(0, 10);
    const result = { total: this.items.length, active: 0, published: 0, draft: 0, archived: 0, deleted: 0, manual: 0, newToday: 0, updatedToday: 0, uniqueSources: 0, categories: {}, storageBytes: 0, duplicatesPrevented: this.metrics.duplicatesPrevented || 0 };
    const sources = new Set();
    for (const item of this.items) {
      result[item.status] = (result[item.status] || 0) + 1;
      if (item.status !== 'deleted') result.active++;
      if (item.sourceKind === 'manual') result.manual++;
      if (String(item.createdAt || '').slice(0, 10) === today) result.newToday++;
      if (String(item.updatedAt || '').slice(0, 10) === today) result.updatedToday++;
      const shown = publicItem(item);
      const src = sourceName(shown);
      if (src) sources.add(src);
      const cat = shown.category || 'uncategorized';
      if (item.status !== 'deleted') result.categories[cat] = (result.categories[cat] || 0) + 1;
    }
    result.uniqueSources = sources.size;
    try { result.storageBytes = fs.statSync(this.file).size; } catch (e) {}
    return result;
  }

  list(opts) {
    const o = opts || {};
    const page = Math.max(1, Number(o.page) || 1);
    const size = Math.min(Math.max(1, Number(o.size) || 20), 100);
    const q = text(o.q, 300).toLowerCase();
    const status = text(o.status, 30) || 'active';
    const category = text(o.category, 80);
    let rows = this.items.filter((record) => {
      if (status === 'active' && record.status === 'deleted') return false;
      if (status !== 'all' && status !== 'active' && record.status !== status) return false;
      const shown = publicItem(record);
      if (category && shown.category !== category) return false;
      if (q) {
        const haystack = [shown.title, shown.summary, sourceName(shown), shown.category, itemUrl(shown)].join('\n').toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      return true;
    });
    rows.sort((a, b) => String(b.lastSeenAt || b.updatedAt).localeCompare(String(a.lastSeenAt || a.updatedAt)));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(page, pages);
    rows = rows.slice((current - 1) * size, current * size).map((record) => this._adminItem(record));
    return { total, page: current, pages, items: rows, stats: this.stats() };
  }

  publicList(opts) {
    const o = opts || {};
    const page = Math.max(1, Number(o.page) || 1);
    const size = Math.min(Math.max(1, Number(o.size) || 60), 100);
    const q = text(o.q, 300).toLowerCase();
    const category = text(o.category, 80);
    const tier = ['all', 'selected', 'ordinary'].includes(String(o.tier)) ? String(o.tier) : 'all';
    const range = ['24h', '7d', '30d', 'all'].includes(String(o.range)) ? String(o.range) : '7d';
    const language = String(o.language || '').toLowerCase() === 'en' ? 'en' : 'all';
    const spanMs = range === '24h' ? 24 * 3600 * 1000 : range === '7d' ? 7 * 86400 * 1000 : range === '30d' ? 30 * 86400 * 1000 : 0;
    const cutoff = spanMs ? Date.now() - spanMs : 0;

    let rows = this._ensurePublicIndex().rows.filter((row) => {
      if (row.standalone) return false;
      if (language === 'en' && !row.english) return false;
      if (cutoff && row.time < cutoff) return false;
      if (q) {
        const keywords = q.split(/[\s,，]+/).filter(Boolean);
        if (!keywords.every((keyword) => row.haystack.includes(keyword))) return false;
      }
      return true;
    });

    const tierCounts = { all: rows.length, selected: 0, ordinary: 0 };
    for (const row of rows) {
      if (!row.selected) tierCounts.ordinary++;
      else tierCounts.selected++;
    }
    if (tier === 'selected') rows = rows.filter((row) => row.selected);
    if (tier === 'ordinary') rows = rows.filter((row) => !row.selected);

    const facets = {};
    for (const row of rows) facets[row.category] = (facets[row.category] || 0) + 1;
    if (category) rows = rows.filter((row) => row.category === category);
    const sources = new Set();
    for (const row of rows) if (row.source) sources.add(row.source);

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(page, pages);
    const pageRows = rows.slice((current - 1) * size, current * size).map((row) => row.item);
    const newest = rows.length ? rows[0].time : 0;
    const oldest = rows.length ? rows[rows.length - 1].time : 0;
    return {
      range,
      language,
      tier,
      total,
      page: current,
      pages,
      size,
      hasMore: current < pages,
      items: pageRows,
      tierCounts,
      facets,
      sourceCount: sources.size,
      newestAt: newest ? new Date(newest).toISOString() : null,
      oldestAt: oldest ? new Date(oldest).toISOString() : null,
      dataRevision: this.revision(),
      generatedAt: this.revision(),
    };
  }

  publicItems() {
    return this._ensurePublicIndex().rows.map((row) => row.item);
  }

  getPublic(id) {
    const row = this._ensurePublicIndex().byId.get(id);
    return row ? row.item : null;
  }

  _adminItem(record) {
    const shown = publicItem(record);
    return {
      id: record.id,
      status: record.status,
      sourceKind: record.sourceKind,
      windows: record.windows || [],
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      seenCount: record.seenCount || 0,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt || null,
      manualFields: Object.keys(record.manual || {}),
      title: shown.title,
      summary: shown.summary,
      category: shown.category,
      sourceName: sourceName(shown),
      originalUrl: shown.links && shown.links.original || '',
      upstreamUrl: shown.links && shown.links.upstream || '',
      publishedAt: shown.publishedAt || '',
    };
  }

  get(id) {
    const record = this.byId.get(id);
    return record ? this._adminItem(record) : null;
  }

  create(input) {
    const cleaned = cleanItem({
      title: input && input.title,
      summary: input && input.summary,
      category: input && input.category,
      sourceName: input && input.sourceName,
      originalUrl: input && input.originalUrl,
      upstreamUrl: input && input.upstreamUrl,
      publishedAt: input && input.publishedAt,
      selected: true,
    });
    if (!cleaned) throw new Error('标题至少需要 2 个字符');
    const at = nowIso();
    const record = {
      id: 'intel-' + hash('manual:' + crypto.randomUUID(), 24),
      sourceKind: 'manual',
      status: STATUS.has(input && input.status) && input.status !== 'deleted' ? input.status : 'published',
      base: cleaned,
      manual: {},
      windows: this._cleanWindows(input && input.windows, ['7d']),
      firstSeenAt: at,
      lastSeenAt: at,
      seenCount: 1,
      createdAt: at,
      updatedAt: at,
    };
    record.aliases = Array.from(new Set([record.id].concat(identityAliases(record.base))));
    this.items.push(record);
    this.byId.set(record.id, record);
    for (const alias of record.aliases) this.aliasToId.set(alias, record.id);
    this._persist();
    return this._adminItem(record);
  }

  _cleanWindows(value, fallback) {
    const rows = Array.isArray(value) ? value.filter((v) => WINDOWS.has(v)) : [];
    return Array.from(new Set(rows.length ? rows : (fallback || [])));
  }

  update(id, input) {
    const record = this.byId.get(id);
    if (!record) return null;
    const patch = input || {};
    const manual = record.manual || (record.manual = {});
    if (patch.title !== undefined) {
      const value = text(patch.title, 500);
      if (value.length < 2) throw new Error('标题至少需要 2 个字符');
      manual.title = value;
    }
    if (patch.summary !== undefined) manual.summary = text(patch.summary, 8000);
    if (patch.category !== undefined) manual.category = text(patch.category, 80);
    if (patch.sourceName !== undefined) manual.sourceName = text(patch.sourceName, 300);
    if (patch.originalUrl !== undefined) {
      if (text(patch.originalUrl, 3000) && !validHttpUrl(patch.originalUrl)) throw new Error('原文链接必须是 http/https 地址');
      manual.originalUrl = validHttpUrl(patch.originalUrl);
    }
    if (patch.upstreamUrl !== undefined) {
      if (text(patch.upstreamUrl, 3000) && !validHttpUrl(patch.upstreamUrl)) throw new Error('采集链接必须是 http/https 地址');
      manual.upstreamUrl = validHttpUrl(patch.upstreamUrl);
    }
    if (patch.publishedAt !== undefined) manual.publishedAt = text(patch.publishedAt, 80);
    if (patch.status !== undefined) {
      if (!STATUS.has(patch.status)) throw new Error('无效的状态');
      record.status = patch.status;
      record.manualStatus = true;
      if (patch.status === 'deleted') record.deletedAt = nowIso();
      else delete record.deletedAt;
    }
    if (patch.windows !== undefined) record.windows = this._cleanWindows(patch.windows, record.windows);
    record.aliases = Array.from(new Set((record.aliases || []).concat(identityAliases(publicItem(record)))));
    for (const alias of record.aliases) this.aliasToId.set(alias, record.id);
    record.updatedAt = nowIso();
    this._persist();
    return this._adminItem(record);
  }

  bulkUpdate(input) {
    const patch = input || {};
    const action = text(patch.action, 30);
    const targets = { publish: 'published', draft: 'draft', archive: 'archived', delete: 'deleted', restore: 'published' };
    const targetStatus = targets[action];
    if (!targetStatus) throw new Error('批量操作仅支持 publish、draft、archive、delete、restore');

    let records = [];
    if (Array.isArray(patch.ids) && patch.ids.length) {
      const ids = Array.from(new Set(patch.ids.map((id) => text(id, 80)).filter((id) => /^intel-[a-f0-9]{16,32}$/.test(id))));
      if (ids.length > 500) throw new Error('单次最多操作 500 条情报');
      records = ids.map((id) => this.byId.get(id)).filter(Boolean);
    } else if (patch.allMatching === true) {
      const status = text(patch.status, 30);
      if (!['published', 'draft', 'archived', 'deleted'].includes(status)) throw new Error('全部匹配操作必须指定明确状态');
      const category = text(patch.category, 80);
      const q = text(patch.q, 300).toLowerCase();
      records = this.items.filter((record) => {
        if (record.status !== status) return false;
        const shown = publicItem(record);
        if (category && shown.category !== category) return false;
        if (q) {
          const haystack = [shown.title, shown.summary, sourceName(shown), shown.category, itemUrl(shown)].join('\n').toLowerCase();
          if (haystack.indexOf(q) === -1) return false;
        }
        return true;
      });
    } else {
      throw new Error('请选择情报，或指定明确状态的全部匹配项');
    }

    const at = nowIso();
    let changed = 0, skipped = 0;
    const changedIds = [];
    for (const record of records) {
      if (action === 'restore' && record.status !== 'deleted') { skipped++; continue; }
      if (action !== 'restore' && action !== 'delete' && record.status === 'deleted') { skipped++; continue; }
      if (record.status === targetStatus && !(action === 'restore' && record.status === 'deleted')) { skipped++; continue; }
      record.status = targetStatus;
      record.manualStatus = true;
      record.updatedAt = at;
      if (targetStatus === 'deleted') record.deletedAt = at;
      else delete record.deletedAt;
      changed++;
      changedIds.push(record.id);
    }
    if (changed) this._persist();
    return { action, targetStatus, matched: records.length, changed, skipped, ids: changedIds };
  }

  remove(id) {
    const record = this.byId.get(id);
    if (!record) return false;
    record.status = 'deleted';
    record.deletedAt = nowIso();
    record.updatedAt = record.deletedAt;
    this._persist();
    return true;
  }

  restore(id) {
    const record = this.byId.get(id);
    if (!record) return null;
    record.status = 'published';
    record.manualStatus = true;
    delete record.deletedAt;
    record.updatedAt = nowIso();
    this._persist();
    return this._adminItem(record);
  }

  trend(days) {
    const limit = Math.min(Math.max(1, Number(days) || 30), 366);
    const byDay = {};
    for (const run of (this.metrics.runs || [])) {
      const day = String(run.at || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      if (!byDay[day]) byDay[day] = { date: day, added: 0, updated: 0, duplicates: 0, invalid: 0, total: 0, runs: 0 };
      byDay[day].added += Number(run.added) || 0;
      byDay[day].updated += Number(run.updated) || 0;
      byDay[day].duplicates += Number(run.duplicatesPrevented) || 0;
      byDay[day].invalid += Number(run.invalid) || 0;
      byDay[day].total = Number(run.totalAfter) || byDay[day].total;
      byDay[day].runs++;
    }
    const out = [];
    for (let i = limit - 1; i >= 0; i--) {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - i);
      const day = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
      out.push(byDay[day] || { date: day, added: 0, updated: 0, duplicates: 0, invalid: 0, total: 0, runs: 0 });
    }
    return out;
  }
}

module.exports = { IntelligenceStore, fingerprint, identityAliases, cleanItem, tutorialScore, classifyCategory, isEnglishItem };
