// server.js — AIQB 情报看板后端（零依赖，Node 18+）
// 职责：
//   1) 定时采集已登记的公开 JSON/RSS/Atom（可配置间隔，默认 12h），每次采集落盘并去重；
//   2) 对外提供只读公开 API（/api/data 预序列化 + 预压缩 + ETag）；
//   3) 管理后台 API（/api/admin/*）：登录会话、账号管理、访问统计、快照管理、采集控制、日志、设置；
//   4) 托管前端静态页（公开看板 + 管理后台），带内存缓存 / gzip / ETag 304；
//   5) 全站访问埋点（PV/UV/日独立 IP/月度访问量），批量异步落盘。
// 目录结构见 README；运行数据全部在 server/data/ 下，代码目录零状态、可随时整体替换升级。
// 启动：node server.js [port]   （默认 3000，监听 0.0.0.0；环境变量 AIQB_PORT/AIQB_HOST/AIQB_DATA_DIR 可覆盖）

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const configLib = require('./lib/config');
const { collect } = require('./lib/collect');
const { Store } = require('./lib/store');
const { IntelligenceStore, isEnglishItem } = require('./lib/intelligence-store');
const { EndpointRegistry } = require('./lib/endpoint-registry');
const { FriendLinkStore } = require('./lib/friend-links');
const { EmailManager } = require('./lib/email-manager');
const { SelectedSync, AllPoolSync } = require('./lib/sync');
const { Stats } = require('./lib/stats');
const { Auth, AuthError, COOKIE_NAME } = require('./lib/auth');
const { StateDatabase } = require('./lib/state-db');
const { UpdateManager } = require('./lib/update-manager');
const SEO = require('./lib/seo');
const U = require('./lib/http-util');

const VERSION = '2.25.0';
const ADMIN_PATH = '/chenfengadmin';
const PORT = Number(process.argv[2] || process.env.AIQB_PORT || process.env.PORT || 3000);
const HOST = process.env.AIQB_HOST || process.env.HOST || '0.0.0.0';
const ROLE = ['web', 'collector', 'primary'].includes(process.env.AIQB_ROLE) ? process.env.AIQB_ROLE : 'primary';
const INSTANCE_ID = String(process.env.NODE_APP_INSTANCE || '0');
const INSTANCE_OWNER = ROLE + ':' + INSTANCE_ID + ':' + process.pid + ':' + crypto.randomBytes(4).toString('hex');
// 默认单进程保持旧行为；生产多进程由两个 web 实例提供流量、collector 独立采集。
const DISABLE_COLLECT = process.env.AIQB_DISABLE_COLLECT === '1' || ROLE === 'web';
const DATA_DIR = process.env.AIQB_DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const LEGACY_DATA_FILE = path.join(__dirname, 'data.json'); // 旧版单文件缓存，启动时自动迁移

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xsl': 'application/xslt+xml; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// ---------- 全局状态 ----------
let config;
let store;
let intelligence;
let endpoints;
let friendLinks;
let emailManager;
let selectedSync;
let allPoolSync;
let stats;
let auth;
let stateDb;
let updateManager;
let apiCache = null;          // /api/data 预序列化响应 {jsonBuf, gzipBuf, etag}
let publicData = null;        // 已应用后台编辑、归档与删除规则的公开数据
let collectTimer = null;
let collectLeaseTimer = null;
let collectorHeartbeatTimer = null;
let sharedStateTimer = null;
let collectBusy = false;
let nextCollectAt = 0;
let lastCollectResult = null; // {ok, at, counts?, error?, durationMs}
let collectorHeartbeatAt = 0;
let collectorStateOwner = null;
function boundedEnvMs(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
const COLLECT_LOCK_TTL_MS = boundedEnvMs('AIQB_COLLECT_LOCK_TTL_MS', 2 * 60 * 1000, 1000, 30 * 60 * 1000);
const COLLECT_LOCK_RENEW_MS = boundedEnvMs('AIQB_COLLECT_LOCK_RENEW_MS', 30 * 1000, 250, COLLECT_LOCK_TTL_MS - 100);
const COLLECT_BUSY_RETRY_MS = boundedEnvMs('AIQB_COLLECT_BUSY_RETRY_MS', 30 * 1000, 250, 5 * 60 * 1000);
const COLLECT_FAILURE_RETRY_MS = boundedEnvMs('AIQB_COLLECT_FAILURE_RETRY_MS', 5 * 60 * 1000, 1000, 60 * 60 * 1000);
const COLLECT_HEARTBEAT_MS = boundedEnvMs('AIQB_COLLECT_HEARTBEAT_MS', 30 * 1000, 1000, 5 * 60 * 1000);
const startedAt = Date.now();
const publicRefreshLimiter = U.createRateLimiter(); // 公开 /api/refresh 限流
const clickLimiter = U.createRateLimiter();          // /api/track 点击统计限流
const rumLimiter = U.createRateLimiter();            // 匿名 Web Vitals 上报限流
const rumTelemetry = { samples: [] };

// 后台健康管理使用的进程内滚动指标。仅保留最近样本，不写入业务数据库，
// 避免高频请求造成磁盘压力；长期访问统计仍由 Stats 独立永久保存。
const requestTelemetry = {
  inFlight: 0,
  total: 0,
  errors: 0,
  samples: [],
  paths: new Map(),
};
const PUBLIC_STATUS_TTL_MS = 10 * 60 * 1000;
let publicStatusCache = { at: 0, value: null };
let readyHealthCache = { at: 0, value: null };
let derivedCacheEpoch = 0;
let seoDataCache = null;
let sharedConfigRevision = null;
const sharedFileRevisions = new Map();

function fileRevision(file) {
  try {
    const stat = fs.statSync(file);
    return stat.mtimeMs + ':' + stat.size;
  } catch (_) { return 'missing'; }
}

function rememberSharedFiles() {
  const files = [
    endpoints && endpoints.configFile,
    endpoints && endpoints.stateFile,
    friendLinks && friendLinks.file,
    emailManager && emailManager.configFile,
    emailManager && emailManager.stateFile,
  ].filter(Boolean);
  for (const file of files) sharedFileRevisions.set(file, fileRevision(file));
}

function refreshSharedState() {
  try {
    if (intelligence && intelligence.refreshFromStateDb()) {
      rebuildPublicCache();
      console.log('[shared] 已载入情报数据版本 ' + intelligence.revision());
    }
    const revision = stateDb && stateDb.getRevision('config', 'site');
    if (revision && revision !== sharedConfigRevision) {
      const next = stateDb.getJSON('config', 'site');
      if (next && typeof next === 'object') {
        config = next;
        auth.config = config;
        SEO.configure(config);
        staticCache.clear();
        invalidateDerivedCaches();
        if (!DISABLE_COLLECT) scheduleCollect();
        sharedConfigRevision = revision;
      }
    }
    if (ROLE === 'web' && stateDb) {
      const sharedCollect = stateDb.getJSON('runtime', 'collect');
      if (sharedCollect) {
        collectBusy = sharedCollect.busy === true;
        nextCollectAt = Number(sharedCollect.nextCollectAt) || 0;
        lastCollectResult = sharedCollect.last || null;
        collectorHeartbeatAt = new Date(sharedCollect.heartbeatAt || sharedCollect.updatedAt || 0).getTime() || 0;
        collectorStateOwner = sharedCollect.owner || null;
      }
    }
    for (const target of [
      { owner: endpoints, files: endpoints && [endpoints.configFile, endpoints.stateFile] },
      { owner: friendLinks, files: friendLinks && [friendLinks.file] },
      { owner: emailManager, files: emailManager && [emailManager.configFile, emailManager.stateFile] },
    ]) {
      if (!target.owner) continue;
      const changed = target.files.some((file) => sharedFileRevisions.get(file) !== fileRevision(file));
      if (changed) {
        target.owner.init();
        for (const file of target.files) sharedFileRevisions.set(file, fileRevision(file));
        invalidateDerivedCaches();
      }
    }
  } catch (error) {
    console.error('[shared] 共享状态同步失败:', error && error.message || error);
  }
}

function scheduleSharedStateRefresh() {
  if (sharedStateTimer) clearInterval(sharedStateTimer);
  sharedStateTimer = setInterval(refreshSharedState, 2500);
  sharedStateTimer.unref();
}

function persistCollectState() {
  if (!stateDb) return;
  const heartbeatAt = new Date().toISOString();
  collectorHeartbeatAt = Date.now();
  collectorStateOwner = INSTANCE_OWNER;
  stateDb.setJSON('runtime', 'collect', {
    busy: collectBusy,
    nextCollectAt: nextCollectAt || 0,
    last: lastCollectResult,
    owner: INSTANCE_OWNER,
    role: ROLE,
    heartbeatAt,
    updatedAt: heartbeatAt,
  });
  readyHealthCache = { at: 0, value: null };
}

function startCollectorHeartbeat() {
  if (DISABLE_COLLECT) return;
  if (collectorHeartbeatTimer) clearInterval(collectorHeartbeatTimer);
  persistCollectState();
  collectorHeartbeatTimer = setInterval(persistCollectState, COLLECT_HEARTBEAT_MS);
  collectorHeartbeatTimer.unref();
}

function createBoundedCache(maxEntries, maxBytes) {
  const entries = new Map();
  let bytes = 0;
  const metrics = { hits: 0, misses: 0, evictions: 0 };
  return {
    get(key) {
      const value = entries.get(key);
      if (!value) { metrics.misses++; return null; }
      entries.delete(key);
      entries.set(key, value);
      metrics.hits++;
      return value;
    },
    set(key, value) {
      const old = entries.get(key);
      if (old) { entries.delete(key); bytes -= old.bytes || 0; }
      entries.set(key, value);
      bytes += value.bytes || 0;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const first = entries.keys().next().value;
        const removed = entries.get(first);
        entries.delete(first);
        bytes -= removed && removed.bytes || 0;
        metrics.evictions++;
      }
      return value;
    },
    clear() { entries.clear(); bytes = 0; },
    info() { return Object.assign({ entries: entries.size, bytes }, metrics); },
  };
}

const historyResponseCache = createBoundedCache(160, 32 * 1024 * 1024);
const documentResponseCache = createBoundedCache(320, 64 * 1024 * 1024);

function bufferedBody(value, contentType) {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const gzip = raw.length >= 512 ? zlib.gzipSync(raw, { level: 6 }) : null;
  return { raw, gzip, etag: U.etagOf(raw), contentType, bytes: raw.length + (gzip ? gzip.length : 0) };
}

function bufferedJSON(value) {
  return bufferedBody(JSON.stringify(value), 'application/json; charset=utf-8');
}

function sendBuffered(req, res, status, entry, cacheControl, cacheStatus, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': entry.contentType,
    'Cache-Control': cacheControl,
    'ETag': entry.etag,
    'X-AIQB-Cache': cacheStatus || 'HIT',
  }, extraHeaders || {});
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, Object.assign({}, headers, U.SECURITY_HEADERS));
    return res.end();
  }
  if (req.method === 'HEAD') {
    headers['Content-Length'] = entry.raw.length;
    res.writeHead(status, Object.assign({}, headers, U.SECURITY_HEADERS));
    return res.end();
  }
  return U.sendBuf(req, res, status, entry.raw, entry.gzip, headers);
}

function invalidateDerivedCaches() {
  derivedCacheEpoch++;
  seoDataCache = null;
  readyHealthCache = { at: 0, value: null };
  publicStatusCache = { at: 0, value: null };
  historyResponseCache.clear();
  documentResponseCache.clear();
}

function cpuTicks() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of cpus) {
    const times = cpu.times || {};
    idle += Number(times.idle) || 0;
    total += (Number(times.user) || 0) + (Number(times.nice) || 0) +
      (Number(times.sys) || 0) + (Number(times.idle) || 0) + (Number(times.irq) || 0);
  }
  return { idle, total };
}

let lastCpuTicks = cpuTicks();

function sampleCpuPercent() {
  const now = cpuTicks();
  const totalDelta = now.total - lastCpuTicks.total;
  const idleDelta = now.idle - lastCpuTicks.idle;
  lastCpuTicks = now;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

function requestPathKey(pathname) {
  let key = String(pathname || '/');
  key = key.replace(/^\/article\/intel-[a-f0-9-]+\/?$/i, '/article/:id');
  key = key.replace(/^(\/api\/admin\/(?:intelligence|endpoints|snapshots|friend-links))\/[^/]+(?:\/test)?$/i, '$1/:id');
  if (!requestTelemetry.paths.has(key) && requestTelemetry.paths.size >= 160) return '其他路径';
  return key;
}

function recordRequestMetric(pathname, scope, status, durationMs) {
  const at = Date.now();
  const ms = Math.max(0, Math.round(Number(durationMs) * 10) / 10);
  requestTelemetry.total++;
  if (status >= 500) requestTelemetry.errors++;
  requestTelemetry.samples.push({ at, ms, status, scope });
  if (requestTelemetry.samples.length > 3000) requestTelemetry.samples.splice(0, requestTelemetry.samples.length - 3000);

  const key = requestPathKey(pathname);
  const row = requestTelemetry.paths.get(key) || { path: key, count: 0, totalMs: 0, maxMs: 0, errors: 0, lastAt: null };
  row.count++;
  row.totalMs += ms;
  row.maxMs = Math.max(row.maxMs, ms);
  if (status >= 500) row.errors++;
  row.lastAt = new Date(at).toISOString();
  requestTelemetry.paths.set(key, row);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function latencySummary(windowMs) {
  const cut = Date.now() - windowMs;
  const rows = requestTelemetry.samples.filter((s) => s.at >= cut);
  const values = rows.map((s) => s.ms).sort((a, b) => a - b);
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  const errors = rows.filter((s) => s.status >= 500).length;
  const byScope = {};
  for (const row of rows) {
    const bucket = byScope[row.scope] || { count: 0, totalMs: 0, maxMs: 0, errors: 0 };
    bucket.count++;
    bucket.totalMs += row.ms;
    bucket.maxMs = Math.max(bucket.maxMs, row.ms);
    if (row.status >= 500) bucket.errors++;
    byScope[row.scope] = bucket;
  }
  for (const key of Object.keys(byScope)) {
    const bucket = byScope[key];
    bucket.avgMs = Math.round(bucket.totalMs / bucket.count * 10) / 10;
    bucket.maxMs = Math.round(bucket.maxMs * 10) / 10;
    bucket.errorRate = Math.round(bucket.errors / bucket.count * 1000) / 10;
    delete bucket.totalMs;
  }
  return {
    count: rows.length,
    avgMs: rows.length ? Math.round(totalMs / rows.length * 10) / 10 : 0,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: values.length ? Math.round(values[values.length - 1] * 10) / 10 : 0,
    errors,
    errorRate: rows.length ? Math.round(errors / rows.length * 1000) / 10 : 0,
    byScope,
  };
}

function diskUsage(target) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stat = fs.statfsSync(target);
    const blockSize = Number(stat.bsize) || 0;
    const total = Number(stat.blocks) * blockSize;
    const free = Number(stat.bavail) * blockSize;
    const used = Math.max(0, total - free);
    return { total, used, free, percent: total ? Math.round(used / total * 1000) / 10 : 0 };
  } catch (e) {
    return null;
  }
}

function measureEventLoopLag() {
  const waitMs = 25;
  const started = process.hrtime.bigint();
  return new Promise((resolve) => setTimeout(() => {
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    resolve(Math.max(0, Math.round((elapsed - waitMs) * 10) / 10));
  }, waitMs));
}

function checkLevel(value, warningAt, criticalAt) {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value >= criticalAt) return 'critical';
  if (value >= warningAt) return 'warning';
  return 'healthy';
}

function buildHealthSnapshot(eventLoopLagMs) {
  const cores = Math.max(1, os.cpus().length);
  const loads = os.loadavg();
  const loadPercent = Math.round((loads[0] / cores) * 1000) / 10;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const memoryPercent = totalMemory ? Math.round(usedMemory / totalMemory * 1000) / 10 : 0;
  const processMemory = process.memoryUsage();
  const disk = diskUsage(DATA_DIR);
  const recent = latencySummary(15 * 60 * 1000);
  const hour = latencySummary(60 * 60 * 1000);
  const latest = store.getLatestEntry();
  const latestAt = latest && latest.fetchedAt ? new Date(latest.fetchedAt).getTime() : 0;
  const dataAgeSec = latestAt ? Math.max(0, Math.floor((Date.now() - latestAt) / 1000)) : null;
  const intervalSec = Math.max(1, Number(config.collectIntervalHours) || 12) * 3600;
  const endpointSummary = endpoints.summary();
  const endpointErrorRatio = endpointSummary.enabled ? endpointSummary.error / endpointSummary.enabled : 0;
  const collectorAgeSec = collectorHeartbeatAt ? Math.max(0, Math.floor((Date.now() - collectorHeartbeatAt) / 1000)) : null;
  const collectorStatus = collectorAgeSec == null ? 'warning' : collectorAgeSec > 120 ? 'critical' : 'healthy';

  const cpuPercent = sampleCpuPercent();
  const checks = [
    { key: 'cpu', label: 'CPU 使用率', status: checkLevel(cpuPercent, 75, 92), message: cpuPercent == null ? '等待下次采样' : cpuPercent + '% · ' + cores + ' 核' },
    { key: 'load', label: '系统负载', status: checkLevel(loadPercent, 80, 110), message: '1 分钟负载 ' + loads[0].toFixed(2) + ' · 折算 ' + loadPercent + '%' },
    { key: 'memory', label: '系统内存', status: checkLevel(memoryPercent, 82, 94), message: memoryPercent + '% 已使用' },
    { key: 'disk', label: '数据盘空间', status: disk ? checkLevel(disk.percent, 82, 94) : 'unknown', message: disk ? disk.percent + '% 已使用' : '当前运行时无法读取磁盘指标' },
    { key: 'eventLoop', label: '事件循环', status: checkLevel(eventLoopLagMs, 80, 250), message: eventLoopLagMs + ' ms 延迟' },
    { key: 'response', label: '请求响应', status: recent.count >= 5 ? checkLevel(recent.p95Ms, 1200, 4000) : 'healthy', message: recent.count ? '近 15 分钟 P95 ' + recent.p95Ms + ' ms' : '等待请求样本' },
    { key: 'errors', label: '服务错误率', status: recent.count >= 20 ? checkLevel(recent.errorRate, 3, 10) : 'healthy', message: '近 15 分钟 ' + recent.errorRate + '% · ' + recent.errors + ' 次 5xx' },
    { key: 'collector', label: '采集器心跳', status: collectorStatus, message: collectorAgeSec == null ? '尚未收到采集器心跳' : collectorAgeSec + ' 秒前 · ' + (collectorStateOwner || '未知实例') },
    { key: 'data', label: '采集数据新鲜度', status: dataAgeSec == null ? 'critical' : checkLevel(dataAgeSec, intervalSec * 2, intervalSec * 4), message: dataAgeSec == null ? '尚无成功快照' : Math.floor(dataAgeSec / 60) + ' 分钟前更新' },
    { key: 'endpoints', label: '采集接口', status: endpointErrorRatio >= 0.5 ? 'critical' : endpointErrorRatio >= 0.2 ? 'warning' : 'healthy', message: endpointSummary.healthy + ' 正常 · ' + endpointSummary.error + ' 异常 · ' + endpointSummary.idle + ' 待运行' },
  ];
  const rank = { unknown: 0, healthy: 1, warning: 2, critical: 3 };
  const worst = checks.reduce((value, item) => Math.max(value, rank[item.status] || 0), 0);
  const overall = worst >= 3 ? 'critical' : worst >= 2 ? 'warning' : 'healthy';
  const topPaths = Array.from(requestTelemetry.paths.values()).map((row) => ({
    path: row.path,
    count: row.count,
    avgMs: row.count ? Math.round(row.totalMs / row.count * 10) / 10 : 0,
    maxMs: Math.round(row.maxMs * 10) / 10,
    errors: row.errors,
    lastAt: row.lastAt,
  })).sort((a, b) => b.avgMs - a.avgMs).slice(0, 12);

  return {
    generatedAt: new Date().toISOString(),
    overall,
    checks,
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.floor(os.uptime()),
      cpu: { percent: cpuPercent, cores, model: (os.cpus()[0] && os.cpus()[0].model) || 'unknown', load1: loads[0], load5: loads[1], load15: loads[2], loadPercent },
      memory: { total: totalMemory, used: usedMemory, free: freeMemory, percent: memoryPercent },
      disk,
    },
    process: {
      pid: process.pid,
      version: VERSION,
      nodeVersion: process.version,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      rss: processMemory.rss,
      heapUsed: processMemory.heapUsed,
      heapTotal: processMemory.heapTotal,
      external: processMemory.external,
      eventLoopLagMs,
      inFlight: requestTelemetry.inFlight,
    },
    response: {
      inFlight: requestTelemetry.inFlight,
      sinceStart: { count: requestTelemetry.total, errors: requestTelemetry.errors },
      recent,
      hour,
      topPaths,
    },
    performance: {
      caches: {
        history: historyResponseCache.info(),
        documents: documentResponseCache.info(),
        apiData: apiCache ? { ready: true, bytes: apiCache.jsonBuf.length + apiCache.gzipBuf.length } : { ready: false, bytes: 0 },
      },
      webVitals: { samples: rumTelemetry.samples.length },
      database: stateDb ? stateDb.info() : { enabled: false },
      dataRevision: intelligence.revision(),
    },
    data: {
      latestAt: latest ? latest.fetchedAt : null,
      ageSec: dataAgeSec,
      snapshots: store.usage(),
      intelligence: intelligence.stats(),
      endpoints: endpointSummary,
      collect: {
        busy: collectBusy,
        intervalHours: config.collectIntervalHours,
        nextCollectAt: nextCollectAt ? new Date(nextCollectAt).toISOString() : null,
        heartbeatAt: collectorHeartbeatAt ? new Date(collectorHeartbeatAt).toISOString() : null,
        heartbeatAgeSec: collectorAgeSec,
        owner: collectorStateOwner,
        last: lastCollectResult,
      },
    },
  };
}

function clampPercent(value, min) {
  return Math.round(Math.max(min == null ? 0 : min, Math.min(100, Number(value) || 0)));
}

// 前台只展示经过归一化的百分比概况，绝不返回主机名、负载、内存、磁盘、
// 接口地址、响应耗时等可用于识别服务器环境的详细数据。
function buildPublicStatus() {
  const now = Date.now();
  if (publicStatusCache.value && now - publicStatusCache.at < PUBLIC_STATUS_TTL_MS) return publicStatusCache.value;

  const cores = Math.max(1, os.cpus().length);
  const loadPercent = os.loadavg()[0] / cores * 100;
  const totalMemory = os.totalmem();
  const memoryPercent = totalMemory ? (totalMemory - os.freemem()) / totalMemory * 100 : 0;
  const disk = diskUsage(DATA_DIR);
  const cpuPercent = sampleCpuPercent();
  const pressurePenalty = Math.max(
    Math.max(0, (cpuPercent == null ? loadPercent : cpuPercent) - 45) * 0.72,
    Math.max(0, loadPercent - 45) * 0.68,
    Math.max(0, memoryPercent - 60) * 0.65,
    disk ? Math.max(0, disk.percent - 65) * 0.72 : 0,
  );
  const service = clampPercent(99 - pressurePenalty - (collectBusy ? 2 : 0), 45);

  const recent = latencySummary(15 * 60 * 1000);
  const response = recent.count < 5
    ? 96
    : clampPercent(100 - Math.min(45, recent.p95Ms / 45) - Math.min(35, recent.errorRate * 4), 35);

  const latest = store.getLatestEntry();
  const latestAt = latest && latest.fetchedAt ? new Date(latest.fetchedAt).getTime() : 0;
  const intervalMs = Math.max(1, Number(config.collectIntervalHours) || 12) * 60 * 60 * 1000;
  const ageRatio = latestAt ? Math.max(0, now - latestAt) / intervalMs : null;
  const data = ageRatio == null
    ? 25
    : clampPercent(ageRatio <= 1 ? 99 - ageRatio * 8 : 91 - Math.min(70, (ageRatio - 1) * 24), 20);

  const endpointSummary = endpoints.summary();
  const enabled = Math.max(0, Number(endpointSummary.enabled) || 0);
  const sourceScore = enabled
    ? ((Number(endpointSummary.healthy) || 0) + (Number(endpointSummary.degraded) || 0) * 0.7 + (Number(endpointSummary.idle) || 0) * 0.55) / enabled * 100
    : 60;
  const sources = clampPercent(sourceScore, 25);
  const overall = clampPercent(service * 0.28 + response * 0.24 + data * 0.27 + sources * 0.21, 20);
  const status = overall >= 85 ? 'healthy' : overall >= 65 ? 'attention' : 'degraded';

  const value = {
    status,
    overall,
    metrics: { service, response, data, sources },
    updatedAt: new Date(now).toISOString(),
    refreshAfterSec: PUBLIC_STATUS_TTL_MS / 1000,
  };
  publicStatusCache = { at: now, value };
  return value;
}

// ---------- 日志 ----------
function localDay(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

function logCollect(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  fs.promises.appendFile(path.join(LOG_DIR, 'collect-' + localDay() + '.log'), line + '\n', 'utf8').catch(() => {});
}

// ---------- 采集 ----------
function buildApiCache(data) {
  const jsonBuf = Buffer.from(JSON.stringify(data));
  return {
    jsonBuf,
    gzipBuf: zlib.gzipSync(jsonBuf, { level: 6 }),
    etag: U.etagOf(jsonBuf),
  };
}

function rebuildPublicCache() {
  const latest = store.getLatest();
  publicData = latest ? intelligence.applyToSnapshot(latest) : null;
  apiCache = publicData ? buildApiCache(publicData) : null;
  invalidateDerivedCaches();
  return publicData;
}

function seoPublicData() {
  const revision = intelligence ? intelligence.revision() : 'empty';
  if (seoDataCache && seoDataCache.revision === revision && seoDataCache.epoch === derivedCacheEpoch) return seoDataCache.value;
  const history = intelligence ? intelligence.publicItems() : [];
  const english = history.filter(isEnglishItem);
  const indexRows = (rows) => {
    const byId = new Map();
    const byCategory = new Map();
    for (const item of rows) {
      byId.set(item._intelId, item);
      const category = item.category || 'uncategorized';
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category).push(item);
    }
    return { rows, byId, byCategory };
  };
  const value = Object.assign({}, publicData || {}, {
    history,
    dataRevision: revision,
    _seo: { all: indexRows(history), en: indexRows(english) },
  });
  seoDataCache = { revision, epoch: derivedCacheEpoch, value };
  return value;
}

function readyHealthPayload() {
  const now = Date.now();
  if (readyHealthCache.value && now - readyHealthCache.at < 5000) return readyHealthCache.value;
  const latest = store.getLatestEntry();
  const value = {
    ok: !!apiCache,
    status: apiCache ? 'ready' : 'empty',
    version: VERSION,
    fetchedAt: latest ? latest.fetchedAt : null,
    items7d: latest && latest.counts ? latest.counts.w7 : 0,
    items24h: latest && latest.counts ? latest.counts.w24 : 0,
    hot: latest && latest.counts ? latest.counts.hot : 0,
    daily: latest && latest.counts ? (latest.counts.daily ? 'ok' : 'null') : 'null',
    dataRevision: intelligence.revision(),
    intelligence: intelligence.stats().active,
    endpoints: endpoints.summary(),
    friendLinks: friendLinks.summary(),
    lastError: lastCollectResult && !lastCollectResult.ok ? lastCollectResult.error : null,
    refreshIntervalHours: config.collectIntervalHours,
    nextCollectAt: nextCollectAt ? new Date(nextCollectAt).toISOString() : null,
    snapshots: store.usage().entries,
    uptimeSec: Math.floor((now - startedAt) / 1000),
    generatedAt: new Date(now).toISOString(),
  };
  readyHealthCache = { at: now, value };
  return value;
}

function englishPublicData(data) {
  const source = data || {};
  const filter = (items) => (Array.isArray(items) ? items.filter(isEnglishItem) : []);
  const output = Object.assign({}, source, {
    language: 'en',
    window7d: filter(source.window7d),
    window24h: filter(source.window24h),
    hot: filter(source.hot),
  });
  if (source.daily && source.daily.report) {
    const labels = { '模型发布 / 更新': 'Models', '产品发布 / 更新': 'Products', '行业动态': 'Industry', '论文研究': 'Research', '教程 / 实战': 'Tutorials', '观点 / 方法': 'Perspectives' };
    const sections = (source.daily.report.sections || []).map((section) => Object.assign({}, section, {
      label: labels[section.label] || section.label,
      items: filter(section.items),
    })).filter((section) => section.items.length);
    output.daily = Object.assign({}, source.daily, { report: Object.assign({}, source.daily.report, { sections }) });
  }
  return output;
}

function preferredLanguage(req) {
  const cookies = U.parseCookies(req);
  if (cookies.aiqb_lang === 'zh' || cookies.aiqb_lang === 'en') return cookies.aiqb_lang;
  if (/bot|crawler|spider|slurp|bingpreview|facebookexternalhit/i.test(String(req.headers['user-agent'] || ''))) return 'zh';
  const country = String(req.headers['eo-client-ipcountry'] || req.headers['eo-client-country'] || req.headers['x-country-code'] || req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || req.headers['cloudfront-viewer-country'] || '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) return ['CN', 'HK', 'MO', 'TW'].includes(country) ? 'zh' : 'en';
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return /^zh(?:-|,|;|$)/.test(accept) ? 'zh' : (/^[a-z]{2}(?:-|,|;|$)/.test(accept) ? 'en' : 'zh');
}

function sendDocument(req, res, status, body, contentType, cacheControl, extraHeaders) {
  const raw = Buffer.from(body, 'utf8');
  const headers = Object.assign({
    'Content-Type': contentType,
    'Cache-Control': cacheControl || 'public, max-age=300, stale-while-revalidate=3600',
    'ETag': U.etagOf(raw),
  }, extraHeaders || {});
  if (req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, Object.assign({}, headers, U.SECURITY_HEADERS));
    return res.end();
  }
  if (req.method === 'HEAD') {
    headers['Content-Length'] = raw.length;
    res.writeHead(status, Object.assign({}, headers, U.SECURITY_HEADERS));
    return res.end();
  }
  let gz = null;
  if (raw.length >= 512) {
    try { gz = zlib.gzipSync(raw, { level: 6 }); } catch (error) { gz = null; }
  }
  return U.sendBuf(req, res, status, raw, gz, headers);
}

function serveCachedDocument(req, res, key, render, contentType, cacheControl) {
  let entry = documentResponseCache.get(key);
  let cacheStatus = 'HIT';
  if (!entry) {
    const body = render();
    if (body == null) return null;
    entry = documentResponseCache.set(key, bufferedBody(body, contentType));
    cacheStatus = 'MISS';
  }
  sendBuffered(req, res, 200, entry,
    cacheControl || 'public, max-age=0, s-maxage=300, stale-while-revalidate=300', cacheStatus,
    { 'X-Data-Revision': intelligence.revision() });
  return true;
}

function publicSiteSettings() {
  const sanitize = (value) => String(value || '')
    .replace(/\u0000/g, '')
    .replace(/<\s*(script|iframe|object|embed|form|style|svg|math|canvas|audio|video)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|form|input|button|textarea|select|meta|link|base|style|svg|math|canvas|audio|video)\b[^>]*>/gi, '')
    .replace(/\s(on[a-z0-9_-]+|srcdoc|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(javascript|vbscript)\s*:/gi, 'blocked:');
  const payload = {
    enabled: !!config.customHeaderEnabled && !!String(config.customHeaderCode || '').trim(),
    mode: config.customHeaderMode === 'popup' ? 'popup' : 'banner',
    code: sanitize(config.customHeaderCode),
    footer: {
      enabled: config.footerEnabled !== false,
      copyrightText: String(config.footerCopyrightText || ''),
      icpNumber: String(config.footerIcpNumber || ''),
      icpUrl: String(config.footerIcpUrl || ''),
    },
    branding: {
      name: String(config.seoShortTitle || 'AI圈报'),
      alias: String(config.siteBrandAlias || 'AIQB'),
      tagline: String(config.siteTagline || ''),
      englishTagline: String(config.siteEnglishTagline || ''),
      logoUrl: String(config.siteLogoUrl || '/favicon.svg'),
      faviconUrl: String(config.siteFaviconUrl || '/favicon.ico'),
    },
    appearance: {
      defaultTheme: ['light', 'dark', 'system'].includes(config.defaultTheme) ? config.defaultTheme : 'light',
      showLanguageSwitcher: config.showLanguageSwitcher !== false,
      showStatusStrip: config.showStatusStrip !== false,
    },
    health: {
      enabled: config.healthWidgetEnabled !== false,
      refreshMinutes: Math.min(60, Math.max(10, Number(config.healthWidgetRefreshMinutes) || 10)),
    },
    content: {
      homeLatestCount: Math.min(20, Math.max(5, Number(config.homeLatestCount) || 10)),
    },
  };
  payload.revision = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
  return payload;
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderFriendLinks() {
  const items = friendLinks ? friendLinks.publicItems() : [];
  if (!items.length) return '';
  return '<section class="friend-links" aria-labelledby="friend-links-title">' +
    '<div class="friend-head"><span class="friend-bar" aria-hidden="true"></span><strong id="friend-links-title">友情链接</strong></div>' +
    '<nav class="friend-list" aria-label="友情链接列表">' + items.map((item) => {
      const name = String(item.name || '').trim();
      const avatar = Array.from(name)[0] || '友';
      return '<a class="friend-link" href="' + htmlEscape(item.url) + '" target="_blank" rel="noopener" data-track="friend" data-title="' + htmlEscape(name) + '"' +
        (item.description ? ' title="' + htmlEscape(item.description) + '"' : '') + '><span class="friend-avatar" aria-hidden="true">' + htmlEscape(avatar) + '</span><span>' + htmlEscape(name) + '</span></a>';
    }).join('') + '</nav></section>';
}

function injectSiteChrome(html) {
  return String(html || '')
    .replace('<!--AIQB_FRIEND_LINKS-->', renderFriendLinks())
    .replace('<!--AIQB_COPYRIGHT-->', SEO.renderFooterCopyright());
}

async function runCollect(trigger) {
  if (collectBusy) return { busy: true };
  if (stateDb && !stateDb.acquireLock('collect', INSTANCE_OWNER, COLLECT_LOCK_TTL_MS)) {
    logCollect('采集暂缓（触发: ' + trigger + '）：另一个实例持有采集锁，将在短间隔后重试');
    return { busy: true };
  }
  collectBusy = true;
  if (stateDb) {
    collectLeaseTimer = setInterval(() => {
      if (!stateDb.renewLock('collect', INSTANCE_OWNER, COLLECT_LOCK_TTL_MS)) {
        logCollect('采集锁续期失败：当前任务继续运行，但不会启动并行任务');
      }
    }, COLLECT_LOCK_RENEW_MS);
    collectLeaseTimer.unref();
  }
  persistCollectState();
  try {
    logCollect('采集开始（触发: ' + trigger + '）');
    const [result, sourceResult] = await Promise.all([
      collect({ fallback: store.getLatest(), endpoints: endpoints.collectorConfig() }),
      endpoints.collectSources(trigger),
    ]);
    try {
      const payloads = result.auxiliary && result.auxiliary.dailyArchive
        ? { dailyArchive: result.auxiliary.dailyArchive } : null;
      endpoints.recordRun(result.endpoints || [], trigger, payloads);
    } catch (endpointError) {
      logCollect('接口状态记录失败（不影响主采集）: ' + endpointError.message);
    }
    const sourceVerifications = [];
    for (const batch of sourceResult.batches) {
      const sourceSnapshot = { fetchedAt: batch.fetchedAt, window7d: batch.items, window24h: batch.items, hot: [], daily: null };
      sourceVerifications.push({ id: batch.endpoint.id, result: intelligence.ingestSnapshot(sourceSnapshot, {
        trigger: 'source:' + batch.endpoint.id,
        sourceKind: 'custom',
        defaultStatus: batch.endpoint.publishMode,
      }) });
    }
    if (result.ok) {
      const verification = intelligence.ingestSnapshot(result.data, { trigger, defaultSelected: true });
      const published = intelligence.applyToSnapshot(result.data);
      const entry = store.saveSuccess(published, { durationMs: result.durationMs, trigger, verification });
      publicData = published;
      apiCache = buildApiCache(published);
      lastCollectResult = {
        ok: true, at: result.data.fetchedAt, counts: result.counts, verification,
        freshness: result.freshness, warnings: result.warnings, durationMs: result.durationMs, sources: sourceVerifications,
      };
      logCollect('采集成功: 7d=' + result.counts.w7 + ' 24h=' + result.counts.w24 +
        ' hot=' + result.counts.hot + ' daily=' + (result.counts.daily ? 'ok' : 'null') +
        ' 核实=' + verification.unique + '条（新增' + verification.added + '、去重' + verification.duplicatesPrevented + '、无效' + verification.invalid + '）' +
        ' 耗时=' + result.durationMs + 'ms' +
        (result.warnings && result.warnings.length ? '（分区降级: ' + result.warnings.join('；') + '）' : '') +
        (entry.sameAs ? '（内容与上一份相同，未重复落盘，引用 ' + entry.sameAs + '）' : '（已落盘 ' + entry.id + '.json）'));
      const pruned = store.prune(config.retentionDays);
      if (pruned > 0) logCollect('已按保留策略清理 ' + pruned + ' 条过期快照');
      emailManager.notifyCollect(lastCollectResult, config.seoSiteUrl);
      return { ok: true, entry };
    }
    // 社区版默认只有 RSS/Atom/JSON 信源。只要任一外部源成功，就用情报库生成完整快照，
    // 不要求 上游 专用分区存在，确保全新安装首次采集即可看到内容。
    if (sourceResult.batches.length && (endpoints.preset !== 'full' || !store.getLatest())) {
      const sourceBase = { fetchedAt: new Date().toISOString(), window7d: [], window24h: [], hot: [], daily: null };
      const published = intelligence.applyToSnapshot(sourceBase);
      const verification = sourceVerifications.reduce((acc, row) => {
        for (const key of ['received', 'valid', 'unique', 'added', 'updated', 'duplicatesPrevented', 'invalid']) acc[key] = (acc[key] || 0) + (Number(row.result && row.result[key]) || 0);
        return acc;
      }, {});
      const entry = store.saveSuccess(published, { durationMs: result.durationMs, trigger, verification });
      publicData = published;
      apiCache = buildApiCache(published);
      lastCollectResult = { ok: true, at: sourceBase.fetchedAt, counts: entry.counts, verification, freshness: { sources: 'fresh' }, warnings: result.warnings || [], durationMs: result.durationMs, sources: sourceVerifications, mode: 'source-only' };
      logCollect('社区信源采集成功: 接口=' + sourceResult.batches.length + '，新增=' + (verification.added || 0) + '，更新=' + (verification.updated || 0) + '（已生成公开快照）');
      emailManager.notifyCollect(lastCollectResult, config.seoSiteUrl);
      return { ok: true, entry, sourceOnly: true };
    }
    if (sourceResult.batches.length && store.getLatest()) {
      // 完整生产预设的核心分区失败时，外部 RSS/JSON 仍入库，但绝不能用空热点/空日报
      // 覆盖最后一份健康快照。公开缓存基于旧快照叠加新增外部内容，采集状态保持失败并提前重试。
      publicData = intelligence.applyToSnapshot(store.getLatest());
      apiCache = buildApiCache(publicData);
    }
    const entry = store.saveFailure(new Date().toISOString(), result.error, result.durationMs);
    lastCollectResult = { ok: false, at: entry.fetchedAt, error: result.error, durationMs: result.durationMs };
    logCollect('采集失败（保留旧数据）: ' + result.error);
    emailManager.notifyCollect(lastCollectResult, config.seoSiteUrl);
    return { ok: false, error: result.error, entry };
  } catch (err) {
    // saveSuccess 等本地 IO 异常兜底
    logCollect('采集流程异常: ' + (err && err.message));
    lastCollectResult = { ok: false, at: new Date().toISOString(), error: String((err && err.message) || err) };
    emailManager.notifyCollect(lastCollectResult, config.seoSiteUrl);
    return lastCollectResult;
  } finally {
    if (collectLeaseTimer) { clearInterval(collectLeaseTimer); collectLeaseTimer = null; }
    collectBusy = false;
    if (stateDb) stateDb.releaseLock('collect', INSTANCE_OWNER);
    persistCollectState();
  }
}

function collectIntervalMs() {
  return Math.max(1, Number(config.collectIntervalHours) || 12) * 3600 * 1000;
}

function scheduleCollect(delayMs) {
  if (collectTimer) { clearTimeout(collectTimer); collectTimer = null; }
  const intervalMs = collectIntervalMs();
  const delay = Number.isFinite(Number(delayMs)) ? Math.max(1000, Number(delayMs)) : intervalMs;
  nextCollectAt = Date.now() + delay;
  persistCollectState();
  collectTimer = setTimeout(async () => {
    collectTimer = null;
    nextCollectAt = 0;
    persistCollectState();
    let result;
    try { result = await runCollectWithSync('timer'); }
    catch (error) {
      result = { ok: false, error: String((error && error.message) || error) };
      logCollect('定时采集异常，将提前重试: ' + result.error);
    }
    const retryDelay = result && result.busy
      ? COLLECT_BUSY_RETRY_MS
      : result && result.ok
        ? collectIntervalMs()
        : Math.min(collectIntervalMs(), COLLECT_FAILURE_RETRY_MS);
    scheduleCollect(retryDelay);
  }, delay);
  collectTimer.unref();
}

async function runStartupCollect(trigger) {
  let result;
  try { result = await runCollectWithSync(trigger); }
  catch (error) {
    result = { ok: false, error: String((error && error.message) || error) };
    logCollect('启动采集异常，将提前重试: ' + result.error);
  }
  const delay = result && result.busy
    ? COLLECT_BUSY_RETRY_MS
    : result && result.ok
      ? collectIntervalMs()
      : Math.min(collectIntervalMs(), COLLECT_FAILURE_RETRY_MS);
  scheduleCollect(delay);
  return result;
}

// 主采集之后的双池同步（精选快照/增量 + 全量池滚动）：无论主采集成败都尝试，失败只记日志，不影响采集结果
async function runCollectWithSync(trigger) {
  const result = await runCollect(trigger);
  if (result && result.busy) return result;
  try {
    const syncResult = await selectedSync.run(trigger);
    if (syncResult && !syncResult.busy && !syncResult.skipped) {
      if (syncResult.ok) {
        if (syncResult.mode === 'changes') {
          const c = syncResult.changes;
          logCollect('精选同步完成（增量）: ' + c.pages + ' 页，upsert=' + c.upserts + ' remove=' + c.removes +
            '（新增 ' + c.added + '、更新 ' + c.updated + '、归档 ' + c.archived + '），耗时 ' + c.durationMs + 'ms');
        } else {
          const b = syncResult.bootstrap;
          logCollect('精选同步完成（' + (syncResult.mode === 'rebootstrap' ? '409 重新引导' : '首次引导') + '）: ' +
            b.pages + ' 页 ' + b.items + ' 条（新增 ' + b.added + '、更新 ' + b.updated + '），耗时 ' + b.durationMs + 'ms，cursor 已保存');
        }
      } else {
        logCollect('精选同步失败（不影响主采集）: ' + syncResult.error);
      }
    }
  } catch (syncError) {
    logCollect('精选同步异常（不影响主采集）: ' + String((syncError && syncError.message) || syncError));
  }
  try {
    const poolResult = await allPoolSync.run(trigger);
    if (poolResult && !poolResult.busy && !poolResult.skipped) {
      if (poolResult.ok) {
        logCollect('全量池同步完成: ' + poolResult.pages + ' 页 ' + poolResult.received + ' 条' +
          '（新增 ' + poolResult.added + '、更新 ' + poolResult.updated + '），耗时 ' + poolResult.durationMs + 'ms');
      } else {
        logCollect('全量池同步失败（不影响主采集）: ' + poolResult.error);
      }
    }
  } catch (poolError) {
    logCollect('全量池同步异常（不影响主采集）: ' + String((poolError && poolError.message) || poolError));
  }
  return result;
}

// ---------- 静态托管（内存缓存 + gzip + ETag 304） ----------
const staticCache = new Map(); // 绝对路径 -> {mtimeMs,size,raw,gz,contentType,etag}

async function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname === '/' || pathname === '' || pathname === '/en' || pathname === '/en/') filePath = path.join(FRONTEND_DIR, 'index.html');
  else if (pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/') filePath = path.join(FRONTEND_DIR, 'admin.html');
  else if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
    return U.sendJSON(req, res, 404, { error: 'not_found' });
  }
  else {
    const rel = path.normalize(pathname).replace(/^([/\\])+/, '').replace(/(\.\.[/\\])+/g, '');
    filePath = path.join(FRONTEND_DIR, rel);
  }
  if (!filePath.startsWith(FRONTEND_DIR)) return U.sendJSON(req, res, 403, { error: 'forbidden' });

  let st;
  try { st = await fs.promises.stat(filePath); } catch (e) {
    return U.sendJSON(req, res, 404, { error: 'not_found', path: pathname });
  }
  if (!st.isFile()) return U.sendJSON(req, res, 404, { error: 'not_found' });

  let c = staticCache.get(filePath);
  if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
    const raw = await fs.promises.readFile(filePath);
    const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    let gz = null;
    if (raw.length >= 1024) { try { gz = await U.gzip(raw); } catch (e) { /* 压缩失败回退原文 */ } }
    c = { mtimeMs: st.mtimeMs, size: st.size, raw, gz, contentType, etag: U.etagOf(raw) };
    staticCache.set(filePath, c);
    if (staticCache.size > 64) staticCache.delete(staticCache.keys().next().value); // 简单容量上限
  }

  const isAdminPage = pathname === ADMIN_PATH || pathname === ADMIN_PATH + '/';
  const isHashedAsset = /\.[a-f0-9]{12}\.(?:css|js)$/i.test(pathname);
  if (pathname === '/' || pathname === '' || pathname === '/en' || pathname === '/en/') {
    const language = pathname.indexOf('/en') === 0 ? 'en' : 'zh';
    return sendDocument(req, res, 200, SEO.applyHomepage(injectSiteChrome(c.raw.toString('utf8')), language), 'text/html; charset=utf-8', 'no-cache');
  }
  const headers = {
    'Content-Type': c.contentType,
    'Cache-Control': isAdminPage ? 'no-store' : (isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache'),
    'ETag': c.etag,
  };
  if (isAdminPage) headers['X-Robots-Tag'] = 'noindex, nofollow, noarchive';
  if (req.headers['if-none-match'] === c.etag) {
    res.writeHead(304, Object.assign({}, headers, U.SECURITY_HEADERS));
    return res.end();
  }
  return U.sendBuf(req, res, 200, c.raw, c.gz, headers);
}

// ---------- 管理接口辅助 ----------
function getSession(req) {
  const token = U.parseCookies(req)[COOKIE_NAME];
  return token ? auth.verify(token) : null;
}

function adminOverviewPayload() {
  const latest = store.getLatestEntry();
  const q = stats.quickToday();
  return {
    version: VERSION,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    nodeVersion: process.version,
    platform: process.platform + ' ' + process.arch,
    startedAt: new Date(startedAt).toISOString(),
    latest: latest ? {
      id: latest.id, fetchedAt: latest.fetchedAt, counts: latest.counts,
      sha8: latest.sha256 ? latest.sha256.slice(0, 8) : null,
      sizeKB: latest.bytes ? Math.round(latest.bytes / 1024) : 0,
      durationMs: latest.durationMs != null ? latest.durationMs : null,
    } : null,
    store: store.usage(),
    intelligence: intelligence.stats(),
    endpoints: endpoints.summary(),
    friendLinks: friendLinks.summary(),
    email: emailManager.overview().summary,
    stats: q,
    collect: {
      intervalHours: config.collectIntervalHours,
      nextCollectAt: nextCollectAt ? new Date(nextCollectAt).toISOString() : null,
      busy: collectBusy,
      last: lastCollectResult,
    },
    sync: selectedSync.status(),
    allPool: allPoolSync.status(),
    config,
    memoryMB: { rss: Math.round(process.memoryUsage().rss / 1048576), heap: Math.round(process.memoryUsage().heapUsed / 1048576) },
    dataDir: DATA_DIR,
  };
}

function classifyPath(pathname) {
  if (pathname === '/' || pathname === '/index.html' || pathname === '/en' || pathname === '/en/' || pathname === '/articles' || pathname === '/articles/' || pathname.indexOf('/article/') === 0 || pathname.indexOf('/category/') === 0 || pathname.indexOf('/en/article/') === 0 || pathname.indexOf('/en/category/') === 0 || pathname === '/en/articles' || pathname === '/en/articles/' || pathname === '/rss' || pathname === '/rss.xml' || pathname === '/feed.xml' || pathname === '/en/rss' || pathname === '/en/rss.xml' || pathname === '/en/feed.xml') return 'frontend';
  if (pathname === ADMIN_PATH || pathname.startsWith(ADMIN_PATH + '/')) return 'admin_page';
  if (pathname.indexOf('/api/admin') === 0) return 'admin_api';
  if (pathname.indexOf('/api/') === 0) return 'public_api';
  if (/\.(?:css|js|png|jpe?g|gif|webp|svg|ico|woff2?|map|xsl)$/i.test(pathname)) return 'asset';
  return 'other';
}

async function readLogTail(date, lines) {
  const file = path.join(LOG_DIR, 'collect-' + date + '.log');
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    const arr = text.split('\n').filter((l) => l.length);
    return { exists: true, lines: arr.slice(-lines) };
  } catch (e) {
    return { exists: false, lines: [] };
  }
}

// ---------- 管理接口 ----------
async function handleAdmin(req, res, pathname, query) {
  const method = req.method;
  const isPost = method === 'POST';
  const isMutation = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

  // ---- 无需登录 ----
  if (pathname === '/api/admin/login' && isPost) {
    if (!U.sameOriginGuard(req)) return U.sendJSON(req, res, 403, { error: 'cross_origin_forbidden' });
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const ip = U.clientIp(req);
      const { token, user } = await auth.login(body.username, body.password, ip);
      const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
      logCollect('后台登录成功: user=' + user.username + ' ip=' + ip);
      return U.sendJSON(req, res, 200, { ok: true, user }, { headers: { 'Set-Cookie': auth.sessionCookie(token, secure) } });
    } catch (err) {
      if (err instanceof AuthError) {
        logCollect('后台登录失败: ' + err.code + ' ip=' + U.clientIp(req));
        return U.sendJSON(req, res, err.status, { error: err.code, message: err.message });
      }
      throw err;
    }
  }

  // ---- 以下全部需要会话 ----
  const sess = getSession(req);
  if (!sess) return U.sendJSON(req, res, 401, { error: 'unauthorized', message: '未登录或会话已过期' });

  if (pathname === '/api/admin/logout' && isPost) {
    const token = U.parseCookies(req)[COOKIE_NAME];
    auth.logout(token);
    return U.sendJSON(req, res, 200, { ok: true }, { headers: { 'Set-Cookie': auth.clearCookie() } });
  }

  if (pathname === '/api/admin/me' && method === 'GET') {
    return U.sendJSON(req, res, 200, { user: sess.user });
  }

  if (isMutation && !U.sameOriginGuard(req)) {
    return U.sendJSON(req, res, 403, { error: 'cross_origin_forbidden' });
  }

  if (pathname === '/api/admin/password' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    const user = await auth.changePassword(body.currentPassword, body.newPassword, U.parseCookies(req)[COOKIE_NAME]);
    logCollect('后台修改密码成功: user=' + user.username);
    return U.sendJSON(req, res, 200, { ok: true, user });
  }

  if (pathname === '/api/admin/username' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    const user = await auth.changeUsername(body.currentPassword, body.newUsername);
    logCollect('后台修改用户名成功: user=' + user.username);
    return U.sendJSON(req, res, 200, { ok: true, user });
  }

  if (pathname === '/api/admin/about' && method === 'GET') {
    return U.sendJSON(req, res, 200, updateManager.overview({
      nodeVersion: process.version,
      platform: process.platform + ' / ' + process.arch,
      role: ROLE,
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    }), { cacheControl: 'no-store' });
  }

  if (pathname === '/api/admin/update' && method === 'GET') {
    return U.sendJSON(req, res, 200, updateManager.overview(), { cacheControl: 'no-store' });
  }

  if (pathname === '/api/admin/update/check' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const result = await updateManager.check(body.source);
      logCollect('后台检查在线更新: source=' + result.source + ' current=' + result.currentVersion + ' latest=' + result.latestVersion);
      return U.sendJSON(req, res, 200, { ok: true, result, overview: updateManager.overview() }, { cacheControl: 'no-store' });
    } catch (e) {
      logCollect('后台检查在线更新失败: source=' + String(body.source || '') + ' error=' + e.message);
      return U.sendJSON(req, res, e.statusCode || 502, { error: 'update_check_failed', message: e.message });
    }
  }

  if (pathname === '/api/admin/update/apply' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const result = await updateManager.start(body.source, body.expectedVersion);
      logCollect('后台启动在线更新: source=' + String(body.source || '') + ' version=' + String(body.expectedVersion || '') + ' pid=' + result.pid);
      return U.sendJSON(req, res, 202, { ok: true, result }, { cacheControl: 'no-store' });
    } catch (e) {
      logCollect('后台启动在线更新失败: source=' + String(body.source || '') + ' error=' + e.message);
      return U.sendJSON(req, res, e.statusCode || 500, { error: 'update_start_failed', message: e.message });
    }
  }

  if (pathname === '/api/admin/overview' && method === 'GET') {
    return U.sendJSON(req, res, 200, adminOverviewPayload());
  }

  if (pathname === '/api/admin/dashboard' && method === 'GET') {
    const [summary] = await Promise.all([stats.summary(14)]);
    return U.sendJSON(req, res, 200, {
      overview: adminOverviewPayload(),
      stats: summary,
      rollup: { days: store.rollup(14) },
      snapshots: store.list(1, 8),
      intelligenceTrend: { days: intelligence.trend(14) },
      generatedAt: new Date().toISOString(),
    }, { cacheControl: 'no-store' });
  }

  if (pathname === '/api/admin/email' && method === 'GET') {
    return U.sendJSON(req, res, 200, emailManager.overview());
  }

  if (pathname === '/api/admin/email/settings' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const settings = emailManager.save(body);
      logCollect('后台修改邮箱设置: enabled=' + settings.enabled + ' host=' + (settings.host || '未配置') + ' recipients=' + settings.recipients.length);
      return U.sendJSON(req, res, 200, { ok: true, settings, summary: emailManager.overview().summary });
    } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_email_settings', message: e.message }); }
  }

  if (pathname === '/api/admin/email/test' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const result = await emailManager.sendTest(body.recipient, config.seoSiteUrl);
      logCollect('后台 SMTP 测试邮件发送成功: messageId=' + result.messageId);
      return U.sendJSON(req, res, 200, { ok: true, result });
    } catch (e) {
      logCollect('后台 SMTP 测试邮件发送失败: ' + e.message);
      return U.sendJSON(req, res, 502, { error: 'email_test_failed', message: e.message });
    }
  }

  if (pathname === '/api/admin/health' && method === 'GET') {
    const eventLoopLagMs = await measureEventLoopLag();
    return U.sendJSON(req, res, 200, buildHealthSnapshot(eventLoopLagMs), {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    });
  }

  if (pathname === '/api/admin/performance' && method === 'GET') {
    const eventLoopLagMs = await measureEventLoopLag();
    const memory = process.memoryUsage();
    return U.sendJSON(req, res, 200, {
      generatedAt: new Date().toISOString(),
      version: VERSION,
      process: {
        pid: process.pid,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        inFlight: requestTelemetry.inFlight,
        eventLoopLagMs,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
      },
      windows: {
        minute15: latencySummary(15 * 60 * 1000),
        hour1: latencySummary(60 * 60 * 1000),
      },
      caches: {
        history: historyResponseCache.info(),
        documents: documentResponseCache.info(),
        apiData: apiCache ? { ready: true, bytes: apiCache.jsonBuf.length + apiCache.gzipBuf.length } : { ready: false, bytes: 0 },
        epoch: derivedCacheEpoch,
      },
      database: stateDb ? stateDb.info() : { enabled: false },
      webVitals: {
        count: rumTelemetry.samples.length,
        recent: rumTelemetry.samples.slice(-100),
      },
      dataRevision: intelligence.revision(),
    }, { cacheControl: 'no-store' });
  }

  if (pathname === '/api/admin/stats' && method === 'GET') {
    const days = Math.min(Math.max(1, Number(query.get('days')) || 30), 3650);
    return U.sendJSON(req, res, 200, await stats.summary(days));
  }

  if (pathname === '/api/admin/rollup' && method === 'GET') {
    const days = Math.min(Math.max(1, Number(query.get('days')) || 14), 366);
    return U.sendJSON(req, res, 200, { days: store.rollup(days) });
  }

  if (pathname === '/api/admin/intelligence/trend' && method === 'GET') {
    const days = Math.min(Math.max(1, Number(query.get('days')) || 30), 366);
    return U.sendJSON(req, res, 200, { days: intelligence.trend(days) });
  }

  if (pathname === '/api/admin/friend-links' && method === 'GET') {
    return U.sendJSON(req, res, 200, friendLinks.list());
  }

  if (pathname === '/api/admin/friend-links' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const item = friendLinks.create(body);
      logCollect('后台新增友链: ' + item.name + ' ' + item.url);
      return U.sendJSON(req, res, 201, { ok: true, item, summary: friendLinks.summary() });
    } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_friend_link', message: e.message }); }
  }

  const friendMatch = pathname.match(/^\/api\/admin\/friend-links\/(friend-[a-f0-9]{16})$/);
  if (friendMatch) {
    const id = friendMatch[1];
    if (method === 'GET') {
      const item = friendLinks.get(id);
      return item ? U.sendJSON(req, res, 200, { item }) : U.sendJSON(req, res, 404, { error: 'not_found' });
    }
    if (method === 'PATCH' || method === 'PUT') {
      let body;
      try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
      try {
        const item = friendLinks.update(id, body);
        if (!item) return U.sendJSON(req, res, 404, { error: 'not_found' });
        logCollect('后台修改友链: ' + id + ' ' + item.name);
        return U.sendJSON(req, res, 200, { ok: true, item, summary: friendLinks.summary() });
      } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_friend_link', message: e.message }); }
    }
    if (method === 'DELETE') {
      const item = friendLinks.get(id);
      if (!item || !friendLinks.remove(id)) return U.sendJSON(req, res, 404, { error: 'not_found' });
      logCollect('后台删除友链: ' + id + ' ' + item.name);
      return U.sendJSON(req, res, 200, { ok: true, summary: friendLinks.summary() });
    }
  }

  if (pathname === '/api/admin/endpoints' && method === 'GET') {
    return U.sendJSON(req, res, 200, endpoints.list());
  }

  if (pathname === '/api/admin/endpoints' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const item = endpoints.create(body);
      logCollect('后台新增自定义采集接口: ' + item.id + ' ' + item.name);
      return U.sendJSON(req, res, 201, { ok: true, item });
    } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_endpoint', message: e.message }); }
  }

  if (pathname === '/api/admin/endpoints/logs' && method === 'GET') {
    return U.sendJSON(req, res, 200, { items: endpoints.logs(query.get('id'), query.get('limit')) });
  }

  const endpointMatch = pathname.match(/^\/api\/admin\/endpoints\/([a-zA-Z0-9_-]+)(?:\/(test))?$/);
  if (endpointMatch) {
    const id = endpointMatch[1];
    if (method === 'GET' && !endpointMatch[2]) {
      const item = endpoints.get(id);
      return item ? U.sendJSON(req, res, 200, { item }) : U.sendJSON(req, res, 404, { error: 'not_found' });
    }
    if ((method === 'PATCH' || method === 'PUT') && !endpointMatch[2]) {
      let body;
      try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
      try {
        const item = endpoints.update(id, body);
        if (!item) return U.sendJSON(req, res, 404, { error: 'not_found' });
        logCollect('后台修改采集接口: ' + id);
        return U.sendJSON(req, res, 200, { ok: true, item });
      } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_endpoint', message: e.message }); }
    }
    if (method === 'DELETE' && !endpointMatch[2]) {
      try {
        const removed = endpoints.remove(id);
        if (!removed) return U.sendJSON(req, res, 404, { error: 'not_found' });
        logCollect('后台删除自定义采集接口: ' + id);
        return U.sendJSON(req, res, 200, { ok: true });
      } catch (e) { return U.sendJSON(req, res, 400, { error: 'endpoint_delete_failed', message: e.message }); }
    }
    if (method === 'POST' && endpointMatch[2] === 'test') {
      try {
        const tested = await endpoints.probe(id, { hot: publicData && publicData.hot || [] });
        if (!tested) return U.sendJSON(req, res, 404, { error: 'not_found' });
        logCollect('后台测试采集接口: ' + id + ' status=' + tested.result.status + ' http=' + (tested.result.httpStatus || '—'));
        return U.sendJSON(req, res, 200, tested);
      } catch (e) { return U.sendJSON(req, res, 400, { error: 'endpoint_test_failed', message: e.message }); }
    }
  }

  if (pathname === '/api/admin/intelligence' && method === 'GET') {
    return U.sendJSON(req, res, 200, intelligence.list({
      page: query.get('page'),
      size: query.get('size'),
      q: query.get('q'),
      status: query.get('status'),
      category: query.get('category'),
    }));
  }

  if (pathname === '/api/admin/intelligence' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const item = intelligence.create(body);
      rebuildPublicCache();
      logCollect('后台新增情报: ' + item.id + ' ' + item.title);
      return U.sendJSON(req, res, 201, { ok: true, item });
    } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_item', message: e.message }); }
  }

  if (pathname === '/api/admin/intelligence/bulk' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    try {
      const result = intelligence.bulkUpdate(body);
      if (result.changed) rebuildPublicCache();
      logCollect('后台批量操作情报: action=' + result.action + ' matched=' + result.matched + ' changed=' + result.changed + ' skipped=' + result.skipped);
      return U.sendJSON(req, res, 200, { ok: true, result, stats: intelligence.stats() });
    } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_bulk_operation', message: e.message }); }
  }

  let intelMatch = pathname.match(/^\/api\/admin\/intelligence\/(intel-[a-f0-9]{16,32})(?:\/(restore))?$/);
  if (intelMatch) {
    const id = intelMatch[1];
    if (method === 'GET' && !intelMatch[2]) {
      const item = intelligence.get(id);
      return item ? U.sendJSON(req, res, 200, { item }) : U.sendJSON(req, res, 404, { error: 'not_found' });
    }
    if ((method === 'PATCH' || method === 'PUT') && !intelMatch[2]) {
      let body;
      try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
      try {
        const item = intelligence.update(id, body);
        if (!item) return U.sendJSON(req, res, 404, { error: 'not_found' });
        rebuildPublicCache();
        logCollect('后台编辑情报: ' + id + ' status=' + item.status);
        return U.sendJSON(req, res, 200, { ok: true, item });
      } catch (e) { return U.sendJSON(req, res, 400, { error: 'invalid_item', message: e.message }); }
    }
    if (method === 'DELETE' && !intelMatch[2]) {
      if (!intelligence.remove(id)) return U.sendJSON(req, res, 404, { error: 'not_found' });
      rebuildPublicCache();
      logCollect('后台删除情报（移入回收站）: ' + id);
      return U.sendJSON(req, res, 200, { ok: true });
    }
    if (method === 'POST' && intelMatch[2] === 'restore') {
      const item = intelligence.restore(id);
      if (!item) return U.sendJSON(req, res, 404, { error: 'not_found' });
      rebuildPublicCache();
      logCollect('后台恢复情报: ' + id);
      return U.sendJSON(req, res, 200, { ok: true, item });
    }
  }

  if (pathname === '/api/admin/snapshots' && method === 'GET') {
    const page = Math.max(1, Number(query.get('page')) || 1);
    const size = Math.min(Math.max(1, Number(query.get('size')) || 20), 100);
    return U.sendJSON(req, res, 200, store.list(page, size));
  }

  let m = pathname.match(/^\/api\/admin\/snapshots\/([\w.-]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') {
      const got = store.get(id);
      if (!got) return U.sendJSON(req, res, 404, { error: 'not_found', message: '快照不存在或采集失败无数据' });
      return U.sendJSON(req, res, 200, { meta: got.entry, data: got.data });
    }
    if (method === 'DELETE') {
      const ok = store.del(id);
      if (!ok) return U.sendJSON(req, res, 404, { error: 'not_found' });
      rebuildPublicCache();
      logCollect('后台删除快照: ' + id);
      return U.sendJSON(req, res, 200, { ok: true });
    }
  }

  if (pathname === '/api/admin/collect' && isPost) {
    if (collectBusy) return U.sendJSON(req, res, 409, { error: 'collect_in_progress', message: '采集正在进行中，请稍候' });
    const result = await runCollectWithSync('admin');
    if (result.busy) return U.sendJSON(req, res, 409, { error: 'collect_in_progress' });
    if (!result.ok) return U.sendJSON(req, res, 502, { error: 'collect_failed', message: result.error });
    return U.sendJSON(req, res, 200, { ok: true, entry: result.entry });
  }

  if (pathname === '/api/admin/sync' && method === 'GET') {
    return U.sendJSON(req, res, 200, { sync: selectedSync.status(), allPool: allPoolSync.status() });
  }

  if (pathname === '/api/admin/sync' && isPost) {
    const selected = await selectedSync.run('admin-sync');
    const allPool = selected.busy ? { busy: true } : await allPoolSync.run('admin-sync');
    const failures = [selected, allPool].filter((r) => r && r.ok === false);
    if (failures.length) {
      return U.sendJSON(req, res, 502, { error: 'sync_failed', message: failures.map((r) => r.error).join('；'), result: { selected, allPool } });
    }
    return U.sendJSON(req, res, 200, { ok: true, result: { selected, allPool } });
  }

  if (pathname === '/api/admin/logs' && method === 'GET') {
    const date = String(query.get('date') || localDay());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return U.sendJSON(req, res, 400, { error: 'bad_date' });
    const lines = Math.min(Math.max(10, Number(query.get('lines')) || 200), 2000);
    let listRes = null;
    try { listRes = await fs.promises.readdir(LOG_DIR); } catch (e) { listRes = []; }
    const dates = listRes
      .filter((f) => /^collect-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => f.slice(7, 17))
      .sort()
      .reverse()
      .slice(0, 60);
    const r = await readLogTail(date, lines);
    return U.sendJSON(req, res, 200, { date, dates, exists: r.exists, lines: r.lines });
  }

  if (pathname === '/api/admin/settings' && method === 'GET') {
    return U.sendJSON(req, res, 200, {
      config,
      auth: sess.user,
      env: {
        version: VERSION,
        nodeVersion: process.version,
        platform: process.platform + ' ' + process.arch,
        pid: process.pid,
        startedAt: new Date(startedAt).toISOString(),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        port: PORT,
        host: HOST,
        dataDir: DATA_DIR,
        memoryMB: { rss: Math.round(process.memoryUsage().rss / 1048576), heap: Math.round(process.memoryUsage().heapUsed / 1048576) },
      },
    });
  }

  if (pathname === '/api/admin/seo' && method === 'GET') {
    return U.sendJSON(req, res, 200, SEO.dashboard(seoPublicData()));
  }

  if (pathname === '/api/admin/seo' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    let applied;
    try { applied = configLib.apply(config, body); }
    catch (err) { return U.sendJSON(req, res, 400, { error: 'invalid_seo', message: err.message }); }
    config = applied.config;
    configLib.save(DATA_DIR, config);
    if (stateDb) stateDb.setJSON('config', 'site', config);
    SEO.configure(config);
    staticCache.clear();
    invalidateDerivedCaches();
    logCollect('后台修改 SEO: ' + (applied.changedKeys.join(', ') || '无变化'));
    return U.sendJSON(req, res, 200, { ok: true, changedKeys: applied.changedKeys, dashboard: SEO.dashboard(seoPublicData()) });
  }

  if (pathname === '/api/admin/settings' && isPost) {
    let body;
    try { body = await U.parseBody(req); } catch (e) { return U.sendJSON(req, res, e.status || 400, { error: 'bad_request', message: e.message }); }
    let applied;
    try { applied = configLib.apply(config, body); }
    catch (err) { return U.sendJSON(req, res, 400, { error: 'invalid_settings', message: err.message }); }
    config = applied.config;
    configLib.save(DATA_DIR, config);
    if (stateDb) stateDb.setJSON('config', 'site', config);
    auth.config = config; // 会话 TTL 即时生效
    SEO.configure(config);
    staticCache.clear();
    invalidateDerivedCaches();
    if (applied.changedKeys.indexOf('collectIntervalHours') !== -1) scheduleCollect();
    logCollect('后台修改设置: ' + (applied.changedKeys.join(', ') || '无变化'));
    return U.sendJSON(req, res, 200, { ok: true, config, changedKeys: applied.changedKeys });
  }

  return U.sendJSON(req, res, 404, { error: 'not_found', endpoints: [
    'POST /api/admin/login', 'POST /api/admin/logout', 'GET /api/admin/me',
    'POST /api/admin/password', 'POST /api/admin/username', 'GET /api/admin/overview', 'GET /api/admin/health', 'GET /api/admin/performance',
    'GET /api/admin/about', 'GET /api/admin/update', 'POST /api/admin/update/check', 'POST /api/admin/update/apply',
    'GET /api/admin/stats?days=30', 'GET /api/admin/rollup?days=14', 'GET /api/admin/email', 'POST /api/admin/email/settings', 'POST /api/admin/email/test',
    'GET|POST /api/admin/endpoints', 'GET|PATCH|DELETE /api/admin/endpoints/:id', 'POST /api/admin/endpoints/:id/test', 'GET /api/admin/endpoints/logs',
    'GET|POST /api/admin/friend-links', 'GET|PATCH|DELETE /api/admin/friend-links/:id',
    'GET|POST /api/admin/intelligence', 'POST /api/admin/intelligence/bulk', 'GET|PATCH|DELETE /api/admin/intelligence/:id',
    'GET /api/admin/snapshots?page=1&size=20', 'GET|DELETE /api/admin/snapshots/:id',
    'POST /api/admin/collect', 'GET /api/admin/logs?date=YYYY-MM-DD', 'GET|POST /api/admin/settings', 'GET|POST /api/admin/seo',
    'GET|POST /api/admin/sync',
  ] });
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  let pathname = '/', query = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    query = u.searchParams;
  } catch (e) {
    return U.sendJSON(req, res, 400, { error: 'bad_request' });
  }

  // 响应性能滚动采样。健康检查本身不进入样本，避免后台轮询污染统计。
  const shouldMeasure = req.method !== 'OPTIONS' && !pathname.startsWith('/health') && pathname !== '/api/status' &&
    pathname !== '/api/admin/health' && pathname !== '/api/track' && pathname !== '/api/rum';
  if (shouldMeasure) {
    const metricStarted = process.hrtime.bigint();
    requestTelemetry.inFlight++;
    let metricDone = false;
    const finishMetric = (status) => {
      if (metricDone) return;
      metricDone = true;
      requestTelemetry.inFlight = Math.max(0, requestTelemetry.inFlight - 1);
      const durationMs = Number(process.hrtime.bigint() - metricStarted) / 1e6;
      recordRequestMetric(pathname, classifyPath(pathname), status, durationMs);
    };
    res.once('finish', () => finishMetric(res.statusCode));
    res.once('close', () => finishMetric(res.writableEnded ? res.statusCode : 499));
  }

  // 访问埋点（响应结束后异步记录；/health 与预检请求不统计）
  const ip = U.clientIp(req);
  const clientGeo = U.clientGeo(req);
  const isTrack = pathname === '/api/track';
  const isRum = pathname === '/api/rum';
  const benchmarkToken = String(process.env.AIQB_BENCHMARK_TOKEN || '');
  const isBenchmark = !!benchmarkToken && String(req.headers['x-aiqb-benchmark'] || '') === benchmarkToken;
  if (!pathname.startsWith('/health') && pathname !== '/api/status' && req.method !== 'OPTIONS' && !isTrack && !isRum && !isBenchmark) {
    res.on('finish', () => {
      try { stats.track(ip, req.headers['user-agent'], pathname, res.statusCode, classifyPath(pathname), clientGeo); } catch (e) {}
    });
  }

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, Object.assign({}, U.CORS_HEADERS, U.SECURITY_HEADERS));
      return res.end();
    }

    // 首次访问才按 CDN 国家代码（无国家代码时退回浏览器语言）选择入口。
    // 搜索引擎与已手动选择语言的用户永不重定向，两种 URL 始终可直接访问。
    if (pathname === '/' && req.method === 'GET' && preferredLanguage(req) === 'en' && !U.parseCookies(req).aiqb_lang) {
      const suffix = query && query.toString() ? '?' + query.toString() : '';
      res.writeHead(302, Object.assign({ Location: '/en/' + suffix, 'Cache-Control': 'private, no-store', Vary: 'Cookie, Accept-Language' }, U.SECURITY_HEADERS));
      return res.end();
    }

    // ---- 公开接口 ----
    if (pathname === '/health/live' && req.method === 'GET') {
      return U.sendJSON(req, res, 200, {
        ok: true, status: 'alive', version: VERSION,
        pid: process.pid, uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      }, { cors: true, etag: false, cacheControl: 'no-store' });
    }

    if ((pathname === '/health' || pathname === '/health/ready') && req.method === 'GET') {
      const ready = readyHealthPayload();
      return U.sendJSON(req, res, ready.ok ? 200 : 503, ready, {
        cors: true, etag: true, cacheControl: 'no-store',
        headers: { 'X-AIQB-Health-Cache': Date.now() - readyHealthCache.at < 100 ? 'MISS' : 'HIT' },
      });
    }

    if (pathname === '/api/status' && req.method === 'GET') {
      return U.sendJSON(req, res, 200, buildPublicStatus(), {
        cors: true,
        cacheControl: 'public, max-age=60, stale-while-revalidate=600',
      });
    }

    if ((pathname === '/api/data' || pathname === '/api/d') && req.method === 'GET') {
      if (!apiCache) {
        return U.sendJSON(req, res, 503, { error: 'not_ready', message: '采集尚未完成，请稍后重试' }, { cors: true });
      }
      if (query.get('language') === 'en') {
        return U.sendJSON(req, res, 200, englishPublicData(publicData), { cors: true, etag: true, cacheControl: 'public, max-age=60, stale-while-revalidate=300' });
      }
      const headers = Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=120',
        'ETag': apiCache.etag,
        'X-Data-Revision': intelligence.revision(),
      }, U.CORS_HEADERS);
      if (req.headers['if-none-match'] === apiCache.etag) {
        res.writeHead(304, Object.assign({}, headers, U.SECURITY_HEADERS));
        return res.end();
      }
      return U.sendBuf(req, res, 200, apiCache.jsonBuf, apiCache.gzipBuf, headers);
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      const cacheKey = derivedCacheEpoch + '|history|' + query.toString();
      let entry = historyResponseCache.get(cacheKey);
      let cacheStatus = 'HIT';
      if (!entry) {
        const history = intelligence.publicList({
          range: query.get('range'),
          page: query.get('page'),
          size: query.get('size'),
          q: query.get('q'),
          category: query.get('category'),
          tier: query.get('tier'),
          language: query.get('language'),
        });
        entry = historyResponseCache.set(cacheKey, bufferedJSON(history));
        cacheStatus = 'MISS';
      }
      return sendBuffered(req, res, 200, entry,
        'public, max-age=0, s-maxage=60, stale-while-revalidate=120', cacheStatus,
        Object.assign({ 'X-Data-Revision': intelligence.revision() }, U.CORS_HEADERS));
    }

    if (pathname === '/api/home' && req.method === 'GET') {
      const language = query.get('language') === 'en' ? 'en' : 'all';
      const q = query.get('q') || '';
      const cacheKey = derivedCacheEpoch + '|home|' + language + '|' + q;
      let entry = historyResponseCache.get(cacheKey);
      let cacheStatus = 'HIT';
      if (!entry) {
        const selected = intelligence.publicList({ range: '24h', tier: 'selected', page: 1, size: 20, language, q });
        const latest = intelligence.publicList({ range: '24h', tier: 'all', page: 1, size: 40, language, q });
        const base = language === 'en' ? englishPublicData(publicData) : publicData;
        entry = historyResponseCache.set(cacheKey, bufferedJSON({
          dataRevision: intelligence.revision(),
          generatedAt: intelligence.revision(),
          data: {
            fetchedAt: base && base.fetchedAt,
            dataRevision: intelligence.revision(),
            counts: base && base.counts,
            hot: base && base.hot || [],
            daily: base && base.daily || null,
          },
          selected,
          latest,
        }));
        cacheStatus = 'MISS';
      }
      return sendBuffered(req, res, 200, entry,
        'public, max-age=0, s-maxage=60, stale-while-revalidate=120', cacheStatus,
        Object.assign({ 'X-Data-Revision': intelligence.revision() }, U.CORS_HEADERS));
    }

    if (pathname === '/api/hot' && req.method === 'GET') {
      const language = query.get('language') === 'en' ? 'en' : 'all';
      const cacheKey = derivedCacheEpoch + '|hot|' + language;
      let entry = historyResponseCache.get(cacheKey);
      let cacheStatus = 'HIT';
      if (!entry) {
        const base = language === 'en' ? englishPublicData(publicData) : publicData;
        entry = historyResponseCache.set(cacheKey, bufferedJSON({
          items: base && base.hot || [], fetchedAt: base && base.fetchedAt,
          dataRevision: intelligence.revision(), generatedAt: intelligence.revision(),
        }));
        cacheStatus = 'MISS';
      }
      return sendBuffered(req, res, 200, entry,
        'public, max-age=0, s-maxage=60, stale-while-revalidate=120', cacheStatus,
        Object.assign({ 'X-Data-Revision': intelligence.revision() }, U.CORS_HEADERS));
    }

    if (pathname === '/api/daily/latest' && req.method === 'GET') {
      const language = query.get('language') === 'en' ? 'en' : 'all';
      const cacheKey = derivedCacheEpoch + '|daily-latest|' + language;
      let entry = historyResponseCache.get(cacheKey);
      let cacheStatus = 'HIT';
      if (!entry) {
        const base = language === 'en' ? englishPublicData(publicData) : publicData;
        entry = historyResponseCache.set(cacheKey, bufferedJSON({
          daily: base && base.daily || null, fetchedAt: base && base.fetchedAt,
          dataRevision: intelligence.revision(), generatedAt: intelligence.revision(),
        }));
        cacheStatus = 'MISS';
      }
      return sendBuffered(req, res, 200, entry,
        'public, max-age=0, s-maxage=60, stale-while-revalidate=120', cacheStatus,
        Object.assign({ 'X-Data-Revision': intelligence.revision() }, U.CORS_HEADERS));
    }

    if (pathname === '/api/dailies' && req.method === 'GET') {
      return U.sendJSON(req, res, 200, { items: store.dailyArchive(query.get('limit')) }, { cors: true, etag: true, cacheControl: 'public, max-age=300, stale-while-revalidate=3600' });
    }

    const dailyMatch = pathname.match(/^\/api\/dailies\/(\d{4}-\d{2}-\d{2})$/);
    if (dailyMatch && req.method === 'GET') {
      const daily = store.dailyByDate(dailyMatch[1]);
      if (!daily) return U.sendJSON(req, res, 404, { error: 'not_found', message: '未找到该日期日报' }, { cors: true });
      return U.sendJSON(req, res, 200, { daily: query.get('language') === 'en' ? englishPublicData({ daily }).daily : daily }, { cors: true, etag: true, cacheControl: 'public, max-age=300, stale-while-revalidate=3600' });
    }

    if (pathname === '/site.webmanifest' && req.method === 'GET') {
      const manifest = {
        name: String(config.seoShortTitle || 'AI圈报'),
        short_name: String(config.siteBrandAlias || 'AIQB'),
        description: String(config.seoDescription || ''),
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f4f6fb',
        theme_color: '#0b5cff',
        icons: [{ src: String(config.siteLogoUrl || '/favicon.svg'), sizes: 'any', purpose: 'any maskable' }],
      };
      return sendDocument(req, res, 200, JSON.stringify(manifest), 'application/manifest+json; charset=utf-8', 'public, max-age=300, stale-while-revalidate=3600');
    }

    if (pathname === '/api/site-settings' && req.method === 'GET') {
      return U.sendJSON(req, res, 200, publicSiteSettings(), { cors: true, etag: true });
    }

    if (pathname === '/api/friend-links' && req.method === 'GET') {
      return U.sendJSON(req, res, 200, { items: friendLinks.publicItems() }, { cors: true, etag: true, cacheControl: 'public, max-age=60, stale-while-revalidate=300' });
    }

    // 链接点击统计（sendBeacon 兼容：CORS + 204 快速响应；限流防刷）
    if (isTrack && (req.method === 'POST' || req.method === 'GET')) {
      if (!clickLimiter.allow('click:' + ip, 120, 60 * 1000)) {
        return U.sendJSON(req, res, 429, { error: 'rate_limited' }, { cors: true, etag: false });
      }
      const parseAndRecord = async () => {
        let body = {};
        if (req.method === 'POST') {
          try { body = await U.parseBody(req, 16 * 1024); } catch (e) { body = {}; }
        } else {
          const u2 = new URL(req.url, 'http://localhost');
          body = { url: u2.searchParams.get('url'), kind: u2.searchParams.get('kind'), title: u2.searchParams.get('title') };
        }
        if (body && typeof body.url === 'string' && /^https?:\/\//i.test(body.url)) {
          stats.trackClick(ip, req.headers['user-agent'], body.url, body.kind, body.title, clientGeo);
        }
        res.writeHead(204, Object.assign({ 'Access-Control-Allow-Origin': '*' }, U.SECURITY_HEADERS));
        res.end();
      };
      return parseAndRecord();
    }

    if (isRum && req.method === 'POST') {
      if (!rumLimiter.allow('rum:' + ip, 30, 60 * 1000)) {
        return U.sendJSON(req, res, 429, { error: 'rate_limited' }, { cors: true, etag: false });
      }
      let body = {};
      try { body = await U.parseBody(req, 8 * 1024); } catch (e) { body = {}; }
      const finiteMetric = (value, max) => {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 && number <= max ? Math.round(number * 10) / 10 : null;
      };
      rumTelemetry.samples.push({
        at: new Date().toISOString(),
        path: String(body.path || '/').slice(0, 160),
        lcp: finiteMetric(body.lcp, 120000),
        inp: finiteMetric(body.inp, 120000),
        cls: finiteMetric(body.cls, 100),
        navigation: finiteMetric(body.navigation, 120000),
      });
      if (rumTelemetry.samples.length > 1000) rumTelemetry.samples.splice(0, rumTelemetry.samples.length - 1000);
      res.writeHead(204, Object.assign({ 'Access-Control-Allow-Origin': '*' }, U.SECURITY_HEADERS));
      return res.end();
    }

    if (pathname === '/api/refresh' && req.method === 'GET') {
      if (!publicRefreshLimiter.allow('refresh:' + ip, 1, 10 * 60 * 1000)) {
        return U.sendJSON(req, res, 429, { error: 'rate_limited', message: '刷新过于频繁（每 10 分钟最多 1 次），请稍后再试' }, { cors: true });
      }
      const result = await runCollectWithSync('public-refresh');
      if (result.busy) return U.sendJSON(req, res, 202, { ok: true, message: '采集正在进行中' }, { cors: true });
      if (!result.ok) {
        return U.sendJSON(req, res, 502, { error: 'collect_failed', message: result.error, data: publicData || null }, { cors: true });
      }
      return U.sendJSON(req, res, 200, publicData, { cors: true });
    }

    // ---- 管理接口 ----
    if (pathname.indexOf('/api/admin') === 0) {
      return await handleAdmin(req, res, pathname, query);
    }

    // ---- 可索引内容页与搜索引擎发现端点 ----
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if ((pathname === '/articles' || pathname === '/articles/' || pathname === '/en/articles' || pathname === '/en/articles/') && isRead) {
      const language = pathname.indexOf('/en/') === 0 ? 'en' : 'zh';
      return serveCachedDocument(req, res,
        derivedCacheEpoch + '|articles|' + language + '|' + (query.get('page') || '1'),
        () => SEO.renderArticles(seoPublicData(), query.get('page'), language),
        'text/html; charset=utf-8');
    }
    const articleMatch = pathname.match(/^\/(en\/)?article\/(intel-[a-f0-9]{16,32})\/?$/);
    if (articleMatch && isRead) {
      const language = articleMatch[1] ? 'en' : 'zh';
      const served = serveCachedDocument(req, res,
        derivedCacheEpoch + '|article|' + language + '|' + articleMatch[2],
        () => SEO.renderArticle(seoPublicData(), articleMatch[2], language),
        'text/html; charset=utf-8');
      if (!served) {
        return sendDocument(req, res, 404,
          '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="robots" content="noindex"><title>情报不存在 - AI圈报</title></head><body><main><h1>情报不存在或已下线</h1><p><a href="/">返回 AI圈报</a></p></main></body></html>',
          'text/html; charset=utf-8', 'no-store', { 'X-Robots-Tag': 'noindex, nofollow' });
      }
      return;
    }
    const categoryMatch = pathname.match(/^\/(en\/)?category\/([a-z0-9-]+)\/?$/);
    if (categoryMatch && isRead) {
      const language = categoryMatch[1] ? 'en' : 'zh';
      const served = serveCachedDocument(req, res,
        derivedCacheEpoch + '|category|' + language + '|' + categoryMatch[2] + '|' + (query.get('page') || '1'),
        () => SEO.renderCategory(seoPublicData(), categoryMatch[2], query.get('page'), language),
        'text/html; charset=utf-8');
      if (!served) return U.sendJSON(req, res, 404, { error: 'not_found' });
      return;
    }
    if (pathname === '/sitemap.xml' && isRead) {
      return serveCachedDocument(req, res, derivedCacheEpoch + '|sitemap',
        () => SEO.renderSitemap(seoPublicData()), 'application/xml; charset=utf-8',
        'public, max-age=0, s-maxage=300, stale-while-revalidate=300');
    }
    if ((pathname === '/rss' || pathname === '/en/rss') && isRead) {
      const language = pathname.indexOf('/en/') === 0 ? 'en' : 'zh';
      return serveCachedDocument(req, res, derivedCacheEpoch + '|rss-page|' + language,
        () => SEO.renderRssPage(seoPublicData(), language), 'text/html; charset=utf-8');
    }
    if ((pathname === '/rss.xml' || pathname === '/en/rss.xml') && isRead) {
      const language = pathname.indexOf('/en/') === 0 ? 'en' : 'zh';
      return serveCachedDocument(req, res, derivedCacheEpoch + '|rss-xml|' + language,
        () => SEO.renderRss(seoPublicData(), '/rss.xml', language), 'application/rss+xml; charset=utf-8',
        'public, max-age=0, s-maxage=300, stale-while-revalidate=300');
    }
    if ((pathname === '/feed.xml' || pathname === '/en/feed.xml') && isRead) {
      const language = pathname.indexOf('/en/') === 0 ? 'en' : 'zh';
      return serveCachedDocument(req, res, derivedCacheEpoch + '|feed-xml|' + language,
        () => SEO.renderRss(seoPublicData(), '/feed.xml', language), 'application/rss+xml; charset=utf-8',
        'public, max-age=0, s-maxage=300, stale-while-revalidate=300');
    }
    if (pathname === '/robots.txt' && isRead) {
      return sendDocument(req, res, 200, SEO.renderRobots(), 'text/plain; charset=utf-8', 'public, max-age=86400');
    }
    // ---- 静态前端 ----
    if (req.method === 'GET') return serveStatic(req, res, pathname);

    return U.sendJSON(req, res, 405, { error: 'method_not_allowed' });
  } catch (err) {
    console.error('[' + new Date().toISOString() + '] 请求处理异常:', err);
    try {
      if (err instanceof AuthError) {
        return U.sendJSON(req, res, err.status, { error: err.code, message: err.message });
      }
      return U.sendJSON(req, res, 500, { error: 'internal', message: String((err && err.message) || err) });
    } catch (e) {}
  }
});

// ---------- 启动 / 停机 ----------
async function shutdown(signal) {
  console.log('收到 ' + signal + '，正在优雅停机…');
  if (sharedStateTimer) clearInterval(sharedStateTimer);
  if (collectTimer) clearTimeout(collectTimer);
  if (collectorHeartbeatTimer) clearInterval(collectorHeartbeatTimer);
  if (collectLeaseTimer) clearInterval(collectLeaseTimer);
  if (!DISABLE_COLLECT && stateDb) {
    collectBusy = false;
    nextCollectAt = 0;
    try { stateDb.releaseLock('collect', INSTANCE_OWNER); } catch (_) {}
    try { persistCollectState(); } catch (_) {}
  }
  try { server.close(); } catch (e) {}
  await Promise.allSettled([stats.shutdown(), auth.shutdown()]);
  if (stateDb) stateDb.close();
  process.exit(0);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  config = configLib.load(DATA_DIR);
  stateDb = new StateDatabase(DATA_DIR).init();
  // 只有第一次迁移从 JSON 写入 WAL，避免多实例用旧文件覆盖后台刚保存的设置。
  const sharedConfig = stateDb.getJSON('config', 'site');
  if (sharedConfig && typeof sharedConfig === 'object') config = sharedConfig;
  else stateDb.setJSON('config', 'site', config);
  sharedConfigRevision = stateDb.getRevision('config', 'site');
  stateDb.skipLegacyMigration = ROLE === 'web' && INSTANCE_ID !== '0';
  SEO.configure(config);
  store = new Store(DATA_DIR, LEGACY_DATA_FILE);
  store.init();
  intelligence = new IntelligenceStore(DATA_DIR, stateDb);
  intelligence.init();
  if (!stateDb.skipLegacyMigration) {
    const tutorialMigration = intelligence.migrateTutorialCategories();
    console.log('[intelligence] 教程分类迁移: 扫描 ' + tutorialMigration.scanned + '，迁移 ' + tutorialMigration.migrated + '，人工覆盖跳过 ' + tutorialMigration.manualSkipped + '，保留观点/方法 ' + tutorialMigration.remainingTip);
    const missingCategoryMigration = intelligence.migrateMissingCategories();
    console.log('[intelligence] 空分类迁移: 扫描 ' + missingCategoryMigration.scanned + '，迁移 ' + missingCategoryMigration.migrated + '，人工覆盖跳过 ' + missingCategoryMigration.manualSkipped + '，分布 ' + JSON.stringify(missingCategoryMigration.byCategory));
  }
  endpoints = new EndpointRegistry(DATA_DIR);
  endpoints.init();
  friendLinks = new FriendLinkStore(DATA_DIR);
  friendLinks.init();
  emailManager = new EmailManager(DATA_DIR);
  emailManager.init();
  selectedSync = new SelectedSync(DATA_DIR, { registry: endpoints, intelligence });
  selectedSync.init();
  allPoolSync = new AllPoolSync(DATA_DIR, { registry: endpoints, intelligence });
  allPoolSync.init();
  stats = new Stats(DATA_DIR, stateDb);
  stats.init();
  auth = new Auth(DATA_DIR, config, stateDb);
  auth.init();
  updateManager = new UpdateManager({ dataDir: DATA_DIR, appDir: path.join(__dirname, '..'), version: VERSION });

  const latest = store.getLatest();
  if (latest && intelligence.stats().total === 0) {
    const migrated = intelligence.ingestSnapshot(latest, { trigger: 'migration' });
    console.log('[intelligence] 已从最新快照建立情报库: 新增 ' + migrated.added + ' 条，批内去重 ' + migrated.duplicatesInBatch + ' 条');
  }
  if (!stateDb.skipLegacyMigration) {
    const tierMigration = intelligence.migrateExternalTiers();
    console.log('[intelligence] 外部信源层级迁移: 扫描 ' + tierMigration.scanned + '，降为普通 ' + tierMigration.downgraded + '，原本普通 ' + tierMigration.alreadyOrdinary);
  }
  if (latest) rebuildPublicCache();
  rememberSharedFiles();
  scheduleSharedStateRefresh();
  startCollectorHeartbeat();

  server.listen(PORT, HOST, () => {
    console.log('AIQB 后端 v' + VERSION + ' [' + ROLE + ':' + INSTANCE_ID + '] 已启动: http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
    console.log('  公开看板: /        管理后台: ' + ADMIN_PATH);
    console.log('  数据目录: ' + DATA_DIR);
    console.log('  状态数据库: SQLite WAL · ' + stateDb.file);
    console.log('  采集间隔: ' + config.collectIntervalHours + ' 小时（后台可改）· 历史快照保留: ' +
      (config.retentionDays > 0 ? config.retentionDays + ' 天' : '永久'));
    console.log('  端点: /api/data  /api/refresh  /health  /api/admin/*');
    console.log('  精选全量同步: ' + (selectedSync.status().hasCursor
      ? '已引导（cursor ' + String(selectedSync.state.cursorAt || '').slice(0, 10) + '，每轮采集后增量）'
      : '待引导（首轮采集后自动拉取完整精选集）'));
    console.log('  全量池同步: ' + (allPoolSync.state.lastRunAt
      ? '已运行 ' + allPoolSync.state.totals.runs + ' 轮（每轮采集后滚动 7 天窗口）'
      : '待首轮（每轮采集后分页拉取全量情报池）'));
  });

  // 启动即采集（有缓存时后台刷新，不阻塞服务）
  if (DISABLE_COLLECT) {
    console.log('采集调度已由 AIQB_DISABLE_COLLECT=1 禁用');
  } else if (!latest) {
    runStartupCollect('startup-cold').then((r) => console.log(r.ok ? '启动采集完成' : (r.busy ? '启动采集被占用，30 秒后重试' : '启动采集失败: ' + r.error)));
  } else {
    console.log('已加载本地快照: ' + latest.fetchedAt + '（历史快照 ' + store.usage().entries + ' 份）');
    setTimeout(() => runStartupCollect('startup-warm').then((r) => {
      if (r.busy) console.log('后台刷新被占用，30 秒后重试');
      else if (!r.ok) console.log('后台刷新失败（继续使用旧数据，5 分钟内重试）: ' + r.error);
    }), 1500);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('[' + new Date().toISOString() + '] 未处理的 Promise 异常:', err);
});

main();
