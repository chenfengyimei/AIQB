// stats.js — 永久保存、按访问区域拆分的 PV / UV / IP / 请求统计
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const FLUSH_MS = 10000;
const QUEUE_FLUSH_LEN = 200;
const RECENT_LIMIT = 40;
const DETAIL_CACHE_MS = 60000;
const SCOPE_KEYS = ['frontend', 'admin', 'api', 'click', 'asset', 'other'];

function pad(n) { return String(n).padStart(2, '0'); }
function dayKeyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function sha16(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16); }
function emptyGeography() { return { countries: {}, regions: {} }; }
function emptyScope() { return { requests: 0, pv: 0, uv: 0, ips: 0, api: 0, geography: emptyGeography() }; }
function emptyScopes() { const out = {}; for (const key of SCOPE_KEYS) out[key] = emptyScope(); return out; }
function emptyDay() { return { pv: 0, uv: 0, ips: 0, api: 0, hits: 0, clicks: 0, itemClicks: 0, friendClicks: 0, articlePv: 0, articleShares: 0, geography: emptyGeography(), scopes: emptyScopes() }; }
function newGeoSets() { return { countryIps: new Set(), regionIps: new Set() }; }
function newSets() { const scopes = {}; for (const key of SCOPE_KEYS) scopes[key] = { ips: new Set(), uvs: new Set(), geography: newGeoSets() }; return { ips: new Set(), uvs: new Set(), geography: newGeoSets(), scopes }; }
function normalizeGeography(value) {
  const source = value && typeof value === 'object' ? value : {};
  const out = emptyGeography();
  for (const group of ['countries', 'regions']) {
    const rows = source[group] && typeof source[group] === 'object' ? source[group] : {};
    for (const key of Object.keys(rows)) {
      const row = rows[key] || {};
      out[group][key] = {
        code: String(row.code || key).slice(0, 20), name: String(row.name || '').slice(0, 80), country: String(row.country || '').slice(0, 8),
        requests: Number(row.requests) || 0, pv: Number(row.pv) || 0, ips: Number(row.ips) || 0,
      };
    }
  }
  return out;
}
function normalizeDay(day) {
  const out = day && typeof day === 'object' ? day : emptyDay();
  for (const key of ['pv', 'uv', 'ips', 'api', 'hits', 'clicks', 'itemClicks', 'friendClicks', 'articlePv', 'articleShares']) out[key] = Number(out[key]) || 0;
  out.geography = normalizeGeography(out.geography);
  if (!out.scopes || typeof out.scopes !== 'object') out.scopes = emptyScopes();
  for (const key of SCOPE_KEYS) {
    out.scopes[key] = Object.assign(emptyScope(), out.scopes[key] || {});
    out.scopes[key].geography = normalizeGeography(out.scopes[key].geography);
  }
  return out;
}

function ipSegmentOf(ip) {
  const value = String(ip || '').trim().toLowerCase().split('%')[0];
  if (net.isIP(value) === 4) {
    const parts = value.split('.');
    return parts[0] + '.' + parts[1] + '.' + parts[2] + '.0/24';
  }
  if (net.isIP(value) !== 6) return '';
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const groups = left.concat(new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), right);
  return groups.slice(0, 3).map((part) => (part || '0').replace(/^0+([0-9a-f])/i, '$1')).join(':') + '::/48';
}

function normalizeGeo(value) {
  const geo = value && typeof value === 'object' ? value : {};
  const country = /^[A-Z]{2}$/.test(String(geo.country || '').toUpperCase()) ? String(geo.country).toUpperCase() : '';
  const regionCode = /^[A-Z]{2}-[A-Z0-9]{1,4}$/.test(String(geo.regionCode || '').toUpperCase()) ? String(geo.regionCode).toUpperCase() : '';
  return { country: country || regionCode.slice(0, 2), regionCode, region: String(geo.region || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80), city: String(geo.city || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) };
}

function applyGeography(targetValue, geoValue, record, geoSets) {
  const target = targetValue || emptyGeography();
  const geo = normalizeGeo(geoValue);
  const isPv = isPage(record);
  if (geo.country) {
    const row = target.countries[geo.country] || (target.countries[geo.country] = { code: geo.country, name: '', country: geo.country, requests: 0, pv: 0, ips: 0 });
    row.requests++; if (isPv) row.pv++;
    if (record.ip && !geoSets.countryIps.has(geo.country + '|' + record.ip)) { geoSets.countryIps.add(geo.country + '|' + record.ip); row.ips++; }
  }
  const regionKey = geo.regionCode || (geo.country && geo.region ? geo.country + ':' + geo.region : '');
  if (regionKey) {
    const row = target.regions[regionKey] || (target.regions[regionKey] = { code: geo.regionCode || regionKey, name: geo.region || '', country: geo.country, requests: 0, pv: 0, ips: 0 });
    if (!row.name && geo.region) row.name = geo.region;
    row.requests++; if (isPv) row.pv++;
    if (record.ip && !geoSets.regionIps.has(regionKey + '|' + record.ip)) { geoSets.regionIps.add(regionKey + '|' + record.ip); row.ips++; }
  }
  return target;
}

function mergeGeography(target, source) {
  for (const group of ['countries', 'regions']) for (const key of Object.keys(source && source[group] || {})) {
    const row = source[group][key];
    if (!target[group][key]) target[group][key] = { code: row.code, name: row.name, country: row.country, requests: 0, pv: 0, ips: 0 };
    const out = target[group][key]; out.requests += row.requests || 0; out.pv += row.pv || 0; out.ips += row.ips || 0;
    if (!out.name && row.name) out.name = row.name;
  }
}
function scopeOf(record) {
  const k = String(record && record.k || 'other');
  const p = String(record && record.p || '');
  if (k === 'frontend' || k === 'page') return 'frontend';
  if (k === 'admin_page' || k === 'admin_api' || k === 'admin') return 'admin';
  if (k === 'click') return 'click';
  if (k === 'public_api' || k === 'api') return 'api';
  if (k === 'asset') return 'asset';
  if (p.startsWith('/api/admin')) return 'admin';
  return 'other';
}
function isPage(record) {
  const k = String(record && record.k || '');
  if (k === 'frontend' || k === 'page' || k === 'admin_page') return true;
  return k === 'admin' && !String(record.p || '').startsWith('/api/admin');
}
function isArticlePage(record) {
  const status = Number(record && record.s);
  return status >= 200 && status < 400 && /^\/(?:en\/)?article\/[^/?#]+\/?$/.test(String(record && record.p || ''));
}
function isApi(record) { return ['admin_api', 'public_api', 'api'].includes(String(record && record.k || '')) || (String(record && record.k || '') !== 'click' && String(record && record.p || '').startsWith('/api/')); }

class Stats {
  constructor(dataDir, stateDb) {
    this.dir = path.join(dataDir, 'stats');
    this.salt = '';
    this.days = {};
    this.todayKey = dayKeyOf(new Date());
    this.sets = newSets();
    this.queue = [];
    this.flushing = false;
    this._timer = null;
    this._lastDailyJson = '';
    this._detailCache = null;
    this.stateDb = stateDb || null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    const saltFile = path.join(this.dir, 'salt.txt');
    try { this.salt = fs.readFileSync(saltFile, 'utf8').trim(); } catch (e) { this.salt = ''; }
    if (!this.salt) { this.salt = crypto.randomBytes(16).toString('hex'); try { fs.writeFileSync(saltFile, this.salt, 'utf8'); } catch (e) {} }
    const storedDaily = this.stateDb && this.stateDb.getJSON('stats', 'daily');
    if (storedDaily && storedDaily.days && typeof storedDaily.days === 'object') this.days = storedDaily.days;
    else try { const obj = JSON.parse(fs.readFileSync(path.join(this.dir, 'daily.json'), 'utf8')); if (obj && obj.days && typeof obj.days === 'object') this.days = obj.days; } catch (e) {}
    this._upgradeHistoricalDays();
    this._replayToday();
    if (this.stateDb) {
      this.stateDb.setJSON('stats', 'daily', { version: 5, retention: 'forever', uniqueWindow: 'daily', ipStorage: 'network-segment', days: this.days });
      const info = this.stateDb.info();
      if (!info.events && !this.stateDb.skipLegacyMigration) {
        let files = [];
        try { files = fs.readdirSync(this.dir).filter((name) => /^visits-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)); } catch (e) {}
        let imported = 0;
        for (const file of files) {
          const records = this._readRecordsSync(path.join(this.dir, file));
          for (let start = 0; start < records.length; start += 1000) imported += this.stateDb.appendEvents(records.slice(start, start + 1000));
        }
        this.stateDb.markMigration('stats-jsonl-to-wal', { events: imported, files: files.length });
      }
      // 历史日聚合直接读取 state_json；仅重放当天流水，避免数据积累多年后启动扫描全库。
      this._syncDaysFromDb(this.todayKey);
    }
    this._timer = setInterval(() => this.flush().catch(() => {}), FLUSH_MS);
    this._timer.unref();
  }

  _visitsFile(day) { return path.join(this.dir, 'visits-' + day + '.jsonl'); }
  _readRecordsSync(file) {
    const rows = [];
    try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch (e) {} } } catch (e) {}
    return rows;
  }
  _dayFromRecords(records) { const day = emptyDay(); const sets = newSets(); for (const record of records) this._applyRecord(day, record, sets); return day; }
  _upgradeHistoricalDays() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((name) => /^visits-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)); } catch (e) {}
    for (const file of files) {
      const dayKey = file.slice(7, 17);
      if (dayKey === this.todayKey) continue;
      if (!this.days[dayKey] || !this.days[dayKey].scopes || !Number.isFinite(Number(this.days[dayKey].clicks)) || !Number.isFinite(Number(this.days[dayKey].articlePv)) || !Number.isFinite(Number(this.days[dayKey].articleShares))) this.days[dayKey] = this._dayFromRecords(this._readRecordsSync(path.join(this.dir, file)));
      else this.days[dayKey] = normalizeDay(this.days[dayKey]);
    }
    for (const key of Object.keys(this.days)) {
      if (this.days[key].scopes) { this.days[key] = normalizeDay(this.days[key]); continue; }
      const old = this.days[key] || {};
      const day = emptyDay();
      Object.assign(day, { pv: Number(old.pv) || 0, uv: Number(old.uv) || 0, ips: Number(old.ips) || 0, api: Number(old.api) || 0, hits: Number(old.hits) || 0, clicks: Number(old.clicks) || 0, itemClicks: Number(old.itemClicks) || 0, friendClicks: Number(old.friendClicks) || 0, legacyEstimate: true });
      Object.assign(day.scopes.frontend, { requests: day.pv, pv: day.pv, uv: day.uv, ips: day.ips });
      day.scopes.api.requests = day.api; day.scopes.api.api = day.api;
      this.days[key] = day;
    }
  }
  _replayToday() {
    this.sets = newSets();
    const records = this._readRecordsSync(this._visitsFile(this.todayKey));
    if (records.length) { const day = emptyDay(); for (const record of records) this._applyRecord(day, record, this.sets); this.days[this.todayKey] = day; }
    else this.days[this.todayKey] = normalizeDay(this.days[this.todayKey]);
  }

  _syncDaysFromDb(oldestDay) {
    if (!this.stateDb) return;
    const groups = {};
    for (const record of this.stateDb.eventsSince(oldestDay || this.todayKey)) {
      const key = record._d || String(record.t || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      (groups[key] ||= []).push(record);
    }
    for (const key of Object.keys(groups)) this.days[key] = this._dayFromRecords(groups[key]);
    if (groups[this.todayKey]) {
      this.sets = newSets();
      const today = emptyDay();
      for (const record of groups[this.todayKey]) this._applyRecord(today, record, this.sets);
      for (const record of this.queue) if ((record._d || String(record.t || '').slice(0, 10)) === this.todayKey) this._applyRecord(today, record, this.sets);
      this.days[this.todayKey] = today;
    }
  }

  _applyRecord(dayValue, record, setValue) {
    const day = normalizeDay(dayValue);
    const sets = setValue || this.sets;
    const scope = scopeOf(record);
    const metric = day.scopes[scope];
    day.hits++; metric.requests++;
    if (isPage(record)) { day.pv++; metric.pv++; if (isArticlePage(record)) day.articlePv++; }
    if (isApi(record)) { day.api++; metric.api++; }
    if (String(record && record.k || '') === 'click') {
      if (record.ck === 'share') day.articleShares++;
      else {
        day.clicks++;
        if (record.ck === 'friend') day.friendClicks++; else day.itemClicks++;
      }
    }
    if (record.ip) { sets.ips.add(record.ip); sets.scopes[scope].ips.add(record.ip); }
    if (record.uv) { sets.uvs.add(record.uv); sets.scopes[scope].uvs.add(record.uv); }
    day.ips = sets.ips.size; day.uv = sets.uvs.size;
    metric.ips = sets.scopes[scope].ips.size; metric.uv = sets.scopes[scope].uvs.size;
    day.geography = applyGeography(day.geography, record.g, record, sets.geography);
    metric.geography = applyGeography(metric.geography, record.g, record, sets.scopes[scope].geography);
    return day;
  }

  track(ip, ua, pathname, status, type, geo) {
    const now = new Date(); const key = dayKeyOf(now); if (key !== this.todayKey) this._rollover(key);
    const hasIp = net.isIP(String(ip || '')) > 0;
    const ipH = hasIp ? sha16(this.salt + '|' + this.todayKey + '|' + ip) : '';
    const uvH = hasIp ? sha16(this.salt + '|' + this.todayKey + '|' + ip + '|' + String(ua || '').slice(0, 120)) : '';
    const record = { t: now.toISOString(), ip: ipH, uv: uvH, seg: hasIp ? ipSegmentOf(ip) : '', g: normalizeGeo(geo), p: String(pathname || '/').slice(0, 160), s: status, k: type || 'other', _d: this.todayKey };
    const day = this.days[this.todayKey] || emptyDay(); this.days[this.todayKey] = this._applyRecord(day, record, this.sets);
    if (this.queue.length < 20000) this.queue.push(record);
    this._detailCache = null;
    if (this.queue.length >= QUEUE_FLUSH_LEN) setImmediate(() => this.flush().catch(() => {}));
  }

  trackClick(ip, ua, url, kind, title, geo) {
    const now = new Date(); const key = dayKeyOf(now); if (key !== this.todayKey) this._rollover(key);
    const hasIp = net.isIP(String(ip || '')) > 0;
    const ipH = hasIp ? sha16(this.salt + '|' + this.todayKey + '|' + ip) : '';
    const uvH = hasIp ? sha16(this.salt + '|' + this.todayKey + '|' + ip + '|' + String(ua || '').slice(0, 120)) : '';
    const safeKind = kind === 'friend' ? 'friend' : kind === 'share' ? 'share' : 'item';
    const record = { t: now.toISOString(), ip: ipH, uv: uvH, seg: hasIp ? ipSegmentOf(ip) : '', g: normalizeGeo(geo), p: String(url || '').slice(0, 300), s: 200, k: 'click', ck: safeKind, ct: String(title || '').slice(0, 120), _d: this.todayKey };
    const day = this.days[this.todayKey] || emptyDay(); this.days[this.todayKey] = this._applyRecord(day, record, this.sets);
    if (this.queue.length < 20000) this.queue.push(record);
    this._detailCache = null;
    if (this.queue.length >= QUEUE_FLUSH_LEN) setImmediate(() => this.flush().catch(() => {}));
  }

  _rollover(newKey) { this.flush().catch(() => {}); this.todayKey = newKey; this.sets = newSets(); this.days[newKey] = normalizeDay(this.days[newKey]); }
  async flush() {
    if (this.flushing) return; this.flushing = true;
    try {
      if (this.queue.length) {
        const pending = this.queue.slice();
        const byFile = {};
        for (const r of this.queue) { const d = r._d || dayKeyOf(new Date(r.t)); const clean = { t:r.t, ip:r.ip, uv:r.uv, seg:r.seg || '', g:normalizeGeo(r.g), p:r.p, s:r.s, k:r.k }; if (r.k === 'click') { clean.ck=r.ck; clean.ct=r.ct; } (byFile[d] = byFile[d] || []).push(JSON.stringify(clean)); }
        this.queue = [];
        if (this.stateDb) this.stateDb.appendEvents(pending);
        for (const d of Object.keys(byFile)) await fs.promises.appendFile(this._visitsFile(d), byFile[d].join('\n') + '\n', 'utf8');
      }
      // 合并其他 Web 实例刚写入的当天流水，再持久化共享日聚合，保证最终一致。
      if (this.stateDb) this._syncDaysFromDb(this.todayKey);
      const json = JSON.stringify({ version: 5, retention: 'forever', uniqueWindow: 'daily', ipStorage: 'network-segment', updatedAt: new Date().toISOString(), days: this.days });
      if (this.stateDb) this.stateDb.setJSON('stats', 'daily', JSON.parse(json));
      if (json !== this._lastDailyJson) { const tmp = path.join(this.dir, 'daily.json.tmp'); await fs.promises.writeFile(tmp, json, 'utf8'); await fs.promises.rename(tmp, path.join(this.dir, 'daily.json')); this._lastDailyJson = json; }
    } finally { this.flushing = false; }
  }
  async shutdown() { if (this._timer) clearInterval(this._timer); await this.flush(); }

  _aggregate(days) {
    const totals = Object.assign({ days: 0 }, emptyDay());
    for (const day of days) {
      totals.pv += day.pv; totals.uv += day.uv; totals.ips += day.ips; totals.api += day.api; totals.hits += day.hits; totals.clicks += day.clicks; totals.itemClicks += day.itemClicks; totals.friendClicks += day.friendClicks; totals.articlePv += day.articlePv; totals.articleShares += day.articleShares; totals.days++;
      mergeGeography(totals.geography, day.geography);
      for (const scope of SCOPE_KEYS) {
        for (const key of ['requests','pv','uv','ips','api']) totals.scopes[scope][key] += day.scopes[scope][key];
        mergeGeography(totals.scopes[scope].geography, day.scopes[scope].geography);
      }
    }
    return totals;
  }
  quickToday() { this._syncDaysFromDb(this.todayKey); const today = Object.assign({ date: this.todayKey }, normalizeDay(this.days[this.todayKey])); const all = Object.keys(this.days).sort().map((key) => normalizeDay(this.days[key])); return { today, totals: this._aggregate(all), retention: 'forever' }; }

  async summary(daysValue) {
    const requested = Math.round(Number(daysValue) || 30);
    const n = Math.min(Math.max(1, requested), 3650);
    this._syncDaysFromDb(dayKeyOf(new Date(Date.now() - Math.max(0, n - 1) * 86400000)));
    const dayKeys = []; const now = new Date();
    for (let i = n - 1; i >= 0; i--) dayKeys.push(dayKeyOf(new Date(now.getTime() - i * 86400000)));
    const series = dayKeys.map((key) => Object.assign({ date: key }, normalizeDay(this.days[key])));
    const allKeys = Object.keys(this.days).sort();
    const allDays = allKeys.map((key) => normalizeDay(this.days[key]));
    const months = {};
    for (const key of allKeys) {
      const day = normalizeDay(this.days[key]); const month = key.slice(0, 7);
      if (!months[month]) months[month] = Object.assign({ month, activeDays: 0 }, emptyDay());
      const target = months[month]; target.activeDays++; target.pv += day.pv; target.uv += day.uv; target.ips += day.ips; target.api += day.api; target.hits += day.hits; target.clicks += day.clicks; target.itemClicks += day.itemClicks; target.friendClicks += day.friendClicks; target.articlePv += day.articlePv; target.articleShares += day.articleShares;
      mergeGeography(target.geography, day.geography);
      for (const scope of SCOPE_KEYS) {
        for (const field of ['requests','pv','uv','ips','api']) target.scopes[scope][field] += day.scopes[scope][field];
        mergeGeography(target.scopes[scope].geography, day.scopes[scope].geography);
      }
    }
    const monthList = Object.keys(months).sort().map((key) => { const item = months[key]; item.avgPvPerDay = item.activeDays ? Math.round(item.pv / item.activeDays * 10) / 10 : 0; return item; });
    const details = await this._details(n);
    const currentMonth = monthList.find((item) => item.month === this.todayKey.slice(0, 7)) || Object.assign({ month: this.todayKey.slice(0, 7), activeDays: 0, avgPvPerDay: 0 }, emptyDay());
    return { today: Object.assign({ date: this.todayKey }, normalizeDay(this.days[this.todayKey])), currentMonth, days: series, months: monthList, totals: this._aggregate(allDays), rangeTotals: this._aggregate(series), topPages: details.topPages, topRoutes: details.topRoutes, topLinks: details.topLinks, recent: await this._recent(RECENT_LIMIT), retention: 'forever', uniqueWindow: 'daily', ipStorage: 'network-segment', firstDate: allKeys[0] || this.todayKey, maxRangeDays: 3650, scopeLabels: { frontend:'前台页面', admin:'后台管理', api:'公开 API', click:'点击 / 分享互动', asset:'静态资源', other:'其他请求' } };
  }

  async _details(days) {
    const cacheKey = String(days);
    if (this._detailCache && this._detailCache.key === cacheKey && Date.now() - this._detailCache.at < DETAIL_CACHE_MS) return this._detailCache.data;
    const pages = {}, routes = {}, links = {}; const minTime = Date.now() - days * 86400000;
    const apply = (r) => {
      if (!r || !r.t || new Date(r.t).getTime() < minTime) return;
      const scope = scopeOf(r); const routeKey = scope + '|' + (r.p || '/');
      if (!routes[routeKey]) routes[routeKey] = { path:r.p || '/', scope, requests:0, ips:new Set(), uvs:new Set() };
      const route = routes[routeKey]; route.requests++; if (r.ip) route.ips.add(r.ip); if (r.uv) route.uvs.add(r.uv);
      if (isPage(r)) { if (!pages[routeKey]) pages[routeKey] = { path:r.p || '/', scope, views:0, ips:new Set(), uvs:new Set() }; const page = pages[routeKey]; page.views++; if (r.ip) page.ips.add(r.ip); if (r.uv) page.uvs.add(r.uv); }
      if (r.k === 'click' && r.ck !== 'share' && r.p) { if (!links[r.p]) links[r.p] = { url:r.p, clicks:0, kind:r.ck || 'item', title:r.ct || '' }; links[r.p].clicks++; }
    };
    if (this.stateDb) {
      const oldest = dayKeyOf(new Date(Date.now() - Math.max(0, days - 1) * 86400000));
      for (const record of this.stateDb.eventsSince(oldest)) apply(record);
    } else for (let i = 0; i < days; i++) { const d = new Date(Date.now() - i * 86400000); let textValue; try { textValue = await fs.promises.readFile(this._visitsFile(dayKeyOf(d)), 'utf8'); } catch (e) { continue; } for (const line of textValue.split('\n')) { if (!line.trim()) continue; try { apply(JSON.parse(line)); } catch (e) {} } }
    for (const record of this.queue) apply(record);
    const compact = (row, countKey) => ({ path:row.path, scope:row.scope, [countKey]:row[countKey], uv:row.uvs.size, ips:row.ips.size });
    const data = {
      topPages: Object.values(pages).map((row) => compact(row, 'views')).sort((a,b) => b.views-a.views).slice(0,15),
      topRoutes: Object.values(routes).map((row) => compact(row, 'requests')).sort((a,b) => b.requests-a.requests).slice(0,20),
      topLinks: Object.values(links).sort((a,b) => b.clicks-a.clicks).slice(0,10),
    };
    this._detailCache = { key:cacheKey, at:Date.now(), data }; return data;
  }

  async _recent(limit) {
    const out = []; const add = (r) => out.push({ t:r.t, ip:r.ip, ipSegment:r.seg || '', geo:normalizeGeo(r.g), path:r.p, status:r.s, type:r.k, scope:scopeOf(r), kind:r.ck || null, title:r.ct || null });
    for (let i=this.queue.length-1; i>=0 && out.length<limit; i--) add(this.queue[i]);
    if (out.length < limit && this.stateDb) for (const record of this.stateDb.recentEvents(limit - out.length)) add(record);
    else if (out.length < limit) { try { const tail = await this._readTail(this._visitsFile(this.todayKey), 96*1024); const lines=tail.split('\n'); for (let i=lines.length-1; i>=0 && out.length<limit; i--) { if (!lines[i].trim()) continue; try { add(JSON.parse(lines[i])); } catch (e) {} } } catch (e) {} }
    return out.slice(0,limit);
  }
  async _readTail(file,maxBytes) { const st=await fs.promises.stat(file); const start=Math.max(0,st.size-maxBytes); const fh=await fs.promises.open(file,'r'); try { const buf=Buffer.alloc(st.size-start); await fh.read(buf,0,buf.length,start); let textValue=buf.toString('utf8'); if(start>0){const nl=textValue.indexOf('\n');textValue=nl>=0?textValue.slice(nl+1):'';} return textValue; } finally { await fh.close(); } }
}

module.exports = { Stats, scopeOf };
