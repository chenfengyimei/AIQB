// collect.js — 旧版完整预设的数据分区采集器（分接口容错、质量校验、退避重试）
// 采集失败时不覆盖旧数据；单个接口异常时可复用最近有效分区，避免整批数据中断。

'use strict';

const { fetchText } = require('./safe-fetch');

const UPSTREAM_BASE = String(process.env.AIQB_UPSTREAM_BASE_URL || 'https://upstream.invalid').trim().replace(/\/+$/, '');
const API = UPSTREAM_BASE + '/api/v1';
const UA = 'AIQB/2.0';

const DEFAULT_TIMEOUT_MS = 30 * 1000;
const RETRIES = 2; // 总尝试次数 = 1 + RETRIES
const RETRY_DELAY_MS = 1200;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJSONOnce(url, timeoutMs, transport) {
  const res = await (transport || fetchText)(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeoutMs,
    maxBytes: MAX_RESPONSE_BYTES,
    maxWireBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 3,
  });
  const body = res.body || '';
    const meta = {
      httpStatus: res.status,
      etag: res.headers.get('etag'),
      cacheControl: res.headers.get('cache-control'),
      requestId: res.headers.get('x-request-id'),
      retryAfterSec: Number(res.headers.get('retry-after')) || null,
      bytes: res.bytes == null ? Buffer.byteLength(body) : res.bytes,
    };
    if (!res.ok) {
      const error = new Error('上游接口返回 HTTP ' + res.status);
      error.status = res.status;
      error.apiMeta = meta;
      throw error;
    }
    let data;
    try { data = JSON.parse(body); } catch (error) { throw new Error('上游接口返回了无效 JSON'); }
    if (!data || typeof data !== 'object') throw new Error('上游接口没有返回 JSON 对象');
    Object.defineProperty(data, '__apiMeta', { value: meta, enumerable: false });
    return data;
}

function retryable(error) {
  if (error && typeof error.retryable === 'boolean') return error.retryable;
  const status = Number(error && error.status) || 0;
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function fetchJSON(url, opts) {
  const o = opts || {};
  const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const retries = Number.isFinite(Number(o.retries)) ? Math.max(0, Number(o.retries)) : RETRIES;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJSONOnce(url, timeoutMs, o.transport);
    } catch (error) {
      lastErr = error;
      if (attempt >= retries || !retryable(error)) break;
      const jitter = Math.floor(Math.random() * 350);
      const retryAfter = Number(error && error.apiMeta && error.apiMeta.retryAfterSec) || 0;
      await sleep(Math.max(RETRY_DELAY_MS * Math.pow(2, attempt) + jitter, retryAfter * 1000));
    }
  }
  throw lastErr;
}

function itemIdentity(item) {
  if (!item || typeof item !== 'object') return '';
  const links = item.links || {};
  return String(item.id || links.original || links.upstream || item.url || item.title || '').trim().toLowerCase();
}

function cleanItems(value, label) {
  if (!Array.isArray(value)) throw new Error(label + ' 缺少 items 数组');
  const seen = new Set();
  const items = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const title = String(item.title || '').replace(/\s+/g, ' ').trim();
    if (title.length < 2) continue;
    const key = itemIdentity(item) || title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  if (value.length && !items.length) throw new Error(label + ' 的条目均未通过标题校验');
  return items;
}

function qualityGate(label, fresh, fallback) {
  const oldItems = Array.isArray(fallback) ? fallback : [];
  // 数据量突然跌至最近有效分区的 15% 以下时，优先保留旧数据，防止上游瞬时空响应覆盖内容。
  if (oldItems.length >= 10 && fresh.length < Math.max(2, Math.floor(oldItems.length * 0.15))) {
    throw new Error(label + ' 数据量异常下降（' + oldItems.length + ' → ' + fresh.length + '）');
  }
  return fresh;
}

function mapHot(h) {
  return {
    id: h.id || h.title,
    title: h.title,
    summary: '当前 AI 热点，聚合 ' + (h.sourceCount || 0) + ' 个独立信源、' + (h.signalCount || 0) + ' 条信号。',
    source: { name: (h.source && h.source.name) || '热点聚合' },
    links: {
      upstream: (h.links && h.links.upstream) || '#',
      original: (h.links && h.links.original) || (h.links && h.links.story) || '#',
      story: (h.links && h.links.story) || undefined,
    },
    publishedAt: h.latestAt,
    discoveredAt: h.latestAt,
    category: null,
    selected: true,
    _src: 'H',
  };
}

function validDaily(value) {
  if (!value || typeof value !== 'object') throw new Error('今日日报不是有效对象');
  const sections = value.report && value.report.sections;
  if (!Array.isArray(sections)) throw new Error('今日日报缺少 sections');
  return value;
}

function validDailyArchive(value) {
  if (!value || !Array.isArray(value.items)) throw new Error('日报归档缺少 items 数组');
  return value.items.filter((item) => item && /^\d{4}-\d{2}-\d{2}$/.test(String(item.date || '')));
}

async function loadPartition(id, name, endpoint, opts, fallback, extract) {
  const started = Date.now();
  if (endpoint.enabled === false) {
    return { id, name, value: fallback === undefined ? null : fallback, fresh: false, status: 'disabled', httpStatus: null, durationMs: 0, count: null, error: null };
  }
  try {
    const payload = await fetchJSON(endpoint.url, {
      timeoutMs: endpoint.timeoutMs || opts.timeoutMs,
      retries: endpoint.retries === undefined ? opts.retries : endpoint.retries,
      transport: opts.transport,
    });
    const value = extract(payload);
    const meta = payload.__apiMeta || {};
    return {
      id, name, value, fresh: true, status: 'ok', httpStatus: meta.httpStatus || 200,
      durationMs: Date.now() - started, count: Array.isArray(value) ? value.length : value ? 1 : 0,
      bytes: meta.bytes || null, etag: meta.etag || null, cacheControl: meta.cacheControl || null,
      requestId: meta.requestId || null, error: null,
    };
  } catch (error) {
    const meta = error && error.apiMeta || {};
    if (fallback !== undefined && fallback !== null) {
      return { id, name, value: fallback, fresh: false, status: 'fallback', httpStatus: meta.httpStatus || error.status || null, durationMs: Date.now() - started, count: Array.isArray(fallback) ? fallback.length : fallback ? 1 : 0, bytes: meta.bytes || null, etag: meta.etag || null, cacheControl: meta.cacheControl || null, requestId: meta.requestId || null, error: String((error && error.message) || error) };
    }
    return { id, name, value: null, fresh: false, status: 'error', httpStatus: meta.httpStatus || error.status || null, durationMs: Date.now() - started, count: null, bytes: meta.bytes || null, etag: meta.etag || null, cacheControl: meta.cacheControl || null, requestId: meta.requestId || null, error: String((error && error.message) || error) };
  }
}

// 返回 { ok, data?, error?, warnings?, freshness?, durationMs, counts }
async function collect(opts) {
  const t0 = Date.now();
  const o = opts || {};
  const fallback = o.fallback && typeof o.fallback === 'object' ? o.fallback : {};
  const configured = o.endpoints && typeof o.endpoints === 'object' ? o.endpoints : {};
  const endpoint = (id, url) => Object.assign({ id, enabled: true, url }, configured[id] || {});
  const partitions = await Promise.all([
    loadPartition('items7d', 'window7d', endpoint('items7d', API + '/items?mode=selected&window=7d&limit=100'), o, fallback.window7d,
      (payload) => qualityGate('近 7 天', cleanItems(payload.items, '近 7 天'), fallback.window7d)),
    loadPartition('items24h', 'window24h', endpoint('items24h', API + '/items?mode=selected&window=24h&limit=100'), o, fallback.window24h,
      (payload) => qualityGate('近 24 小时', cleanItems(payload.items, '近 24 小时'), fallback.window24h)),
    loadPartition('hotTopics', 'hot', endpoint('hotTopics', API + '/hot-topics'), o, fallback.hot,
      (payload) => qualityGate('热点', cleanItems(payload.items, '热点'), fallback.hot).map(mapHot)),
    loadPartition('dailyLatest', 'daily', endpoint('dailyLatest', API + '/dailies/latest'), o, fallback.daily || null, validDaily),
    loadPartition('dailyArchive', 'dailyArchive', endpoint('dailyArchive', API + '/dailies?limit=30'), o, null, validDailyArchive),
  ]);

  const byName = Object.fromEntries(partitions.map((part) => [part.name, part]));
  const required = ['window7d', 'window24h', 'hot'];
  const missing = required.filter((name) => !Array.isArray(byName[name].value));
  const freshRequired = required.filter((name) => byName[name].fresh);
  const warnings = partitions.filter((part) => part.error).map((part) => part.id + ': ' + part.error);

  // 三个核心接口全部失败时，本轮标记失败并继续使用旧快照，不制造一次“成功采集”。
  if (missing.length || freshRequired.length === 0) {
    return {
      ok: false,
      error: missing.length ? ('缺少有效分区: ' + missing.join(', ') + (warnings.length ? '；' + warnings.join('；') : ''))
        : ('核心接口均未刷新；' + warnings.join('；')),
      warnings,
      endpoints: partitions,
      auxiliary: { dailyArchive: byName.dailyArchive && byName.dailyArchive.value },
      durationMs: Date.now() - t0,
      counts: null,
    };
  }

  const data = {
    fetchedAt: new Date().toISOString(),
    window7d: byName.window7d.value,
    window24h: byName.window24h.value,
    hot: byName.hot.value,
    daily: byName.daily.value,
  };
  const freshness = Object.fromEntries(partitions.map((part) => [part.name, part.fresh ? 'fresh' : part.status]));
  return {
    ok: true,
    data,
    warnings,
    freshness,
    endpoints: partitions,
    auxiliary: { dailyArchive: byName.dailyArchive && byName.dailyArchive.value },
    durationMs: Date.now() - t0,
    counts: {
      w7: data.window7d.length,
      w24: data.window24h.length,
      hot: data.hot.length,
      daily: data.daily ? 1 : 0,
    },
  };
}

module.exports = { collect, fetchJSON, fetchJSONOnce, cleanItems, API };
