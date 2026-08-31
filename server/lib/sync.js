// sync.js — 上游 精选池全量同步（snapshot 引导 + changes 增量）
// 官方口径：snapshot 只做一次性引导（分页拉到 hasMore=false，保存首页 cursor），
// 之后永远用 /selected/changes 按 cursor 增量；409 snapshot_required 时重新引导。
// 同步结果写入情报库（IntelligenceStore），cursor 与统计持久化在 data/sync/state.json。

'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./config');
const { fetchJSON } = require('./collect');

const UPSTREAM_BASE = String(process.env.AIQB_UPSTREAM_BASE_URL || 'https://upstream.invalid').trim().replace(/\/+$/, '');
const API = UPSTREAM_BASE + '/api/v1';
const SNAPSHOT_LIMIT = 1000; // 官方单页上限
const CHANGES_LIMIT = 100;   // 官方单页上限
const MAX_PAGES = 200;       // 单轮分页安全上限（1000×200 足够覆盖全集并防失控）
const MAX_TOTAL_ITEMS = 50000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const PAGE_DELAY_MS = 300;   // 分页间隔，礼貌抓取

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function text(value, max) { return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max); }
function payloadBytes(value) { return Number(value && value.__apiMeta && value.__apiMeta.bytes) || 0; }
function assertRunBudget(items, bytes) {
  if (items > MAX_TOTAL_ITEMS) throw new Error('同步条目超过单轮安全上限 ' + MAX_TOTAL_ITEMS + '，已中止');
  if (bytes > MAX_TOTAL_BYTES) throw new Error('同步响应累计超过 64MB 安全上限，已中止');
}

class SelectedSync {
  constructor(dataDir, deps) {
    this.dir = path.join(dataDir, 'sync');
    this.file = path.join(this.dir, 'state.json');
    this.registry = deps && deps.registry;
    this.intelligence = deps && deps.intelligence;
    this.busy = false;
    this.state = {
      version: 1,
      updatedAt: null,
      cursor: null,
      cursorAt: null,
      lastRunAt: null,
      lastTrigger: null,
      lastStatus: null, // ok | error | disabled
      lastError: null,
      bootstrap: null,  // { at, pages, items }
      totals: { snapshots: 0, upserts: 0, removes: 0, runs: 0 },
    };
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object') this.state = Object.assign(this.state, saved);
    } catch (e) { /* 首次启动 */ }
  }

  status() { return Object.assign({}, this.state, { busy: this.busy, hasCursor: !!this.state.cursor }); }

  _persist() {
    this.state.updatedAt = new Date().toISOString();
    atomicWrite(this.file, JSON.stringify(this.state, null, 1) + '\n');
  }

  _enabled(id) {
    const endpoint = this.registry && this.registry.get ? this.registry.get(id) : null;
    return !!(endpoint && endpoint.enabled);
  }

  _endpointUrl(id, fallback) {
    const endpoint = this.registry && this.registry.get ? this.registry.get(id) : null;
    return String(endpoint && endpoint.url || fallback);
  }

  _record(id, ok, fields) {
    if (!this.registry || !this.registry.recordRun) return;
    try { this.registry.recordRun([Object.assign({ id, ok, status: ok ? 'ok' : 'error' }, fields)], 'sync'); } catch (e) { /* 状态记录失败不影响同步 */ }
  }

  async _fetchPage(url) {
    return fetchJSON(url, { timeoutMs: 60000, retries: 2 });
  }

  // 一次性引导：分页拉取完整精选集；只有全部页成功才保存 cursor
  async _bootstrap(trigger) {
    const started = Date.now();
    const at = new Date().toISOString();
    const ingestMeta = { trigger: text(trigger, 30) + ':snapshot', sourceKind: 'sync', defaultSelected: true, at };
    let pageToken = null;
    let cursor = null;
    let pages = 0, items = 0, bytes = 0, added = 0, updated = 0;
    while (pages < MAX_PAGES) {
      const snapshotUrl = new URL(this._endpointUrl('selectedSnapshot', API + '/selected/snapshot?fields=default&limit=' + SNAPSHOT_LIMIT));
      if (pageToken) snapshotUrl.searchParams.set('page', pageToken);
      const url = snapshotUrl.toString();
      const payload = await this._fetchPage(url);
      if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.items)) throw new Error('精选快照响应结构无效');
      bytes += payloadBytes(payload);
      assertRunBudget(items + payload.items.length, bytes);
      const pageCursor = text(payload.cursor, 2000);
      if (!pageCursor) throw new Error('精选快照缺少同步 cursor');
      if (cursor === null) cursor = pageCursor;
      else if (pageCursor !== cursor) throw new Error('精选快照分页 cursor 不一致，已中止（下次采集将重新引导）');
      const verification = this.intelligence.ingestItems(payload.items, ingestMeta);
      pages++;
      items += payload.items.length;
      added += verification.added;
      updated += verification.updated;
      if (!payload.hasMore) break;
      if (!payload.nextPage) throw new Error('精选快照 hasMore=true 但缺少 nextPage，无法保证完整性，已中止');
      pageToken = String(payload.nextPage);
      await sleep(PAGE_DELAY_MS);
    }
    if (pages >= MAX_PAGES) throw new Error('精选快照分页超过安全上限 ' + MAX_PAGES + ' 页，已中止');
    this.state.cursor = cursor;
    this.state.cursorAt = at;
    this.state.bootstrap = { at, pages, items };
    this.state.totals.snapshots += items;
    this._persist();
    const summary = { cursor, pages, items, added, updated, durationMs: Date.now() - started };
    this._record('selectedSnapshot', true, { httpStatus: 200, durationMs: summary.durationMs, count: items });
    return summary;
  }

  // 增量循环：应用一页后立即保存返回的 cursor；409 表示 cursor 已不可续，需要重新引导
  async _applyChanges(trigger) {
    const started = Date.now();
    let cursor = this.state.cursor;
    let pages = 0, upserts = 0, removes = 0, bytes = 0, added = 0, updated = 0, archived = 0;
    while (pages < MAX_PAGES) {
      const template = this._endpointUrl('selectedChanges', API + '/selected/changes?limit=' + CHANGES_LIMIT + '&cursor={cursor}');
      const url = template.includes('{cursor}')
        ? template.replace('{cursor}', encodeURIComponent(cursor))
        : (() => { const parsed = new URL(template); parsed.searchParams.set('cursor', cursor); return parsed.toString(); })();
      let payload;
      try {
        payload = await this._fetchPage(url);
      } catch (error) {
        if (Number(error && error.status) === 409) return { rebootstrap: true };
        throw error;
      }
      if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.changes)) throw new Error('精选增量响应结构无效');
      bytes += payloadBytes(payload);
      assertRunBudget(upserts + removes + payload.changes.length, bytes);
      const upsertItems = [];
      const removeIds = [];
      for (const change of payload.changes) {
        if (!change || typeof change !== 'object') continue;
        if (change.op === 'upsert' && change.item && typeof change.item === 'object') { upsertItems.push(change.item); upserts++; }
        else if (change.op === 'remove' && change.id) { removeIds.push(change.id); removes++; }
      }
      if (upsertItems.length) {
        const verification = this.intelligence.ingestItems(upsertItems, {
          trigger: text(trigger, 30) + ':changes',
          sourceKind: 'sync',
          defaultSelected: true,
          at: new Date().toISOString(),
        });
        added += verification.added;
        updated += verification.updated;
      }
      if (removeIds.length) {
        const result = this.intelligence.archiveByRemoteIds(removeIds, new Date().toISOString());
        archived += result.archived;
      }
      pages++;
      cursor = text(payload.cursor, 2000) || cursor;
      this.state.cursor = cursor;
      this._persist();
      if (!payload.hasMore) break;
      await sleep(PAGE_DELAY_MS);
    }
    if (pages >= MAX_PAGES) throw new Error('精选增量分页超过安全上限 ' + MAX_PAGES + ' 页，已中止');
    this.state.totals.upserts += upserts;
    this.state.totals.removes += removes;
    this._persist();
    return { rebootstrap: false, pages, upserts, removes, added, updated, archived, durationMs: Date.now() - started };
  }

  // 每轮采集后调用；独立于主采集成败，任何异常都不向上抛出主流程
  async run(trigger) {
    if (this.busy) return { busy: true };
    if (!this.intelligence || !this.registry) return { ok: false, error: 'sync 未初始化' };
    this.busy = true;
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastTrigger = text(trigger, 50) || 'unknown';
    const started = Date.now();
    try {
      if (!this._enabled('selectedSnapshot') || !this._enabled('selectedChanges')) {
        this.state.lastStatus = 'disabled';
        this._persist();
        return { ok: true, skipped: true, reason: 'sync_disabled' };
      }
      const result = { ok: true, trigger: this.state.lastTrigger, at: this.state.lastRunAt };
      this._phase = 'bootstrap';
      if (!this.state.cursor) {
        result.bootstrap = await this._bootstrap(this.state.lastTrigger);
        result.mode = 'bootstrap';
      } else {
        this._phase = 'changes';
        const changes = await this._applyChanges(this.state.lastTrigger);
        if (changes.rebootstrap) {
          this.state.cursor = null;
          this._phase = 'bootstrap';
          result.bootstrap = await this._bootstrap(this.state.lastTrigger);
          result.mode = 'rebootstrap';
        } else {
          result.changes = changes;
          result.mode = 'changes';
        }
      }
      this.state.lastStatus = 'ok';
      this.state.lastError = null;
      this.state.totals.runs++;
      this._persist();
      this._record('selectedChanges', true, { httpStatus: 200, durationMs: Date.now() - started, count: result.changes ? result.changes.upserts + result.changes.removes : 0 });
      return result;
    } catch (error) {
      const message = String((error && error.message) || error);
      this.state.lastStatus = 'error';
      this.state.lastError = message;
      this._persist();
      this._record(this._phase === 'changes' ? 'selectedChanges' : 'selectedSnapshot', false, { durationMs: Date.now() - started, error: message });
      return { ok: false, error: message };
    } finally {
      this.busy = false;
    }
  }
}

// 全量情报池同步：/items?mode=all 的 7 天滚动窗口分页拉取（精选+普通）。
// 上游只保留 7 天窗口且无快照接口，因此每轮采集完整分页一遍（正常约 20+ 页），
// 已入库条目由情报库按身份去重合并；每轮整批一次入库，减少磁盘重写次数。
class AllPoolSync {
  constructor(dataDir, deps) {
    this.file = path.join(dataDir, 'sync', 'allpool-state.json');
    this.registry = deps && deps.registry;
    this.intelligence = deps && deps.intelligence;
    this.busy = false;
    this.state = {
      version: 1,
      updatedAt: null,
      lastRunAt: null,
      lastTrigger: null,
      lastStatus: null, // ok | error | disabled
      lastError: null,
      lastPages: 0,
      lastCount: 0,
      totals: { received: 0, added: 0, updated: 0, runs: 0 },
    };
  }

  init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved && typeof saved === 'object') this.state = Object.assign(this.state, saved);
    } catch (e) { /* 首次启动 */ }
  }

  status() { return Object.assign({}, this.state, { busy: this.busy }); }

  _persist() {
    this.state.updatedAt = new Date().toISOString();
    atomicWrite(this.file, JSON.stringify(this.state, null, 1) + '\n');
  }

  _record(ok, fields) {
    if (!this.registry || !this.registry.recordRun) return;
    try { this.registry.recordRun([Object.assign({ id: 'itemsAll7d', ok, status: ok ? 'ok' : 'error' }, fields)], 'sync'); } catch (e) { /* 状态记录失败不影响同步 */ }
  }

  _fetchPage(url, endpoint) {
    return fetchJSON(url, { timeoutMs: endpoint.timeoutMs || 30000, retries: endpoint.retries === undefined ? 2 : endpoint.retries });
  }

  async run(trigger) {
    if (this.busy) return { busy: true };
    if (!this.intelligence || !this.registry) return { ok: false, error: 'sync 未初始化' };
    const endpoint = this.registry.get('itemsAll7d');
    if (!endpoint || endpoint.enabled === false) {
      this.state.lastStatus = 'disabled';
      this._persist();
      return { ok: true, skipped: true, reason: 'disabled' };
    }
    this.busy = true;
    this.state.lastRunAt = new Date().toISOString();
    this.state.lastTrigger = text(trigger, 50) || 'unknown';
    const started = Date.now();
    let received = 0, bytes = 0, added = 0, updated = 0, pages = 0;
    try {
      const collected = [];
      let cursor = null;
      while (pages < MAX_PAGES) {
        const parsed = new URL(String(endpoint.url || API + '/items?mode=all&window=7d&limit=100'));
        if (cursor) parsed.searchParams.set('cursor', cursor);
        const url = parsed.toString();
        const payload = await this._fetchPage(url, endpoint);
        if (!payload || payload.schemaVersion !== 1 || !Array.isArray(payload.items)) throw new Error('全量池响应结构无效');
        if (!payload.page || typeof payload.page.hasMore !== 'boolean') throw new Error('全量池缺少分页信息');
        bytes += payloadBytes(payload);
        assertRunBudget(received + payload.items.length, bytes);
        collected.push(...payload.items);
        received += payload.items.length;
        pages++;
        if (!payload.page.hasMore) break;
        if (!payload.page.nextCursor) throw new Error('全量池 hasMore=true 但缺少 nextCursor，已中止');
        cursor = String(payload.page.nextCursor);
        await sleep(PAGE_DELAY_MS);
      }
      if (pages >= MAX_PAGES) throw new Error('全量池分页超过安全上限 ' + MAX_PAGES + ' 页，已中止');
      if (collected.length) {
        const verification = this.intelligence.ingestItems(collected, {
          trigger: text(trigger, 30) + ':allpool',
          sourceKind: 'sync',
          at: new Date().toISOString(),
        });
        added = verification.added;
        updated = verification.updated;
      }
      this.state.lastStatus = 'ok';
      this.state.lastError = null;
      this.state.lastPages = pages;
      this.state.lastCount = received;
      this.state.totals.received += received;
      this.state.totals.added += added;
      this.state.totals.updated += updated;
      this.state.totals.runs++;
      this._persist();
      this._record(true, { httpStatus: 200, durationMs: Date.now() - started, count: received });
      return { ok: true, mode: 'allpool', pages, received, added, updated, durationMs: Date.now() - started };
    } catch (error) {
      const message = String((error && error.message) || error);
      this.state.lastStatus = 'error';
      this.state.lastError = message;
      this._persist();
      this._record(false, { durationMs: Date.now() - started, error: message });
      return { ok: false, error: message };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { SelectedSync, AllPoolSync, API, SNAPSHOT_LIMIT, CHANGES_LIMIT, MAX_PAGES, MAX_TOTAL_ITEMS, MAX_TOTAL_BYTES, assertRunBudget };
