// store.js — 历史快照持久化存储
// 目录结构（dataDir 下）：
//   latest.json                 当前快照（前端 /api/data 直接消费）
//   history/index.json          快照索引（元数据数组，时间升序）
//   history/snap-YYYYMMDD-HHmmss.json   全量快照文件
// 保证：每次采集（无论成败）都在 index 中留痕；成功快照全量落盘；
//       内容与上一份完全相同（sha256 一致）时不再重复写文件，以 sameAs 引用，节省磁盘；
//       全部写入均为 tmp+rename 原子操作，进程被杀不会留下半截文件。

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { atomicWrite } = require('./config');

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// 快照内容哈希不包含采集时刻和后台数据修订号，否则同一批内容每次采集
// 都会因为 fetchedAt 改变而被误判为新快照，无法真正去重。
function snapshotContentJSON(data) {
  return JSON.stringify({
    window7d: data.window7d || [],
    window24h: data.window24h || [],
    hot: data.hot || [],
    daily: data.daily || null,
  });
}

// 本地时间戳文件名（与采集时刻一致，便于按天归档/清理）
function stampId(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return 'snap-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
       + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

class Store {
  constructor(dataDir, legacyFile) {
    this.dataDir = dataDir;
    this.historyDir = path.join(dataDir, 'history');
    this.indexFile = path.join(this.historyDir, 'index.json');
    this.latestFile = path.join(dataDir, 'latest.json');
    this.legacyFile = legacyFile || null; // 旧版 server/data.json，启动时自动迁移
    this.index = [];   // 索引条目（升序）
    this.latest = null; // 最近一次「成功」快照数据
  }

  init() {
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.index = this._loadIndex();
    // 兼容迁移：旧版只有单份 data.json；若 latest.json 不存在则导入为初始快照
    if (!fs.existsSync(this.latestFile) && this.legacyFile && fs.existsSync(this.legacyFile)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
        if (legacy && legacy.fetchedAt && Array.isArray(legacy.window7d)) {
          this.saveSuccess(legacy, { durationMs: 0, migrated: true });
          console.log('[store] 已迁移旧版 data.json 为历史快照: ' + legacy.fetchedAt);
        }
      } catch (e) {
        console.error('[store] 迁移旧数据失败（忽略，继续空库启动）:', e.message);
      }
    }
    // 恢复 latest（若索引有成功快照但 latest.json 丢失，则从最新成功快照恢复）
    if (!this.latest) {
      try {
        if (fs.existsSync(this.latestFile)) {
          const obj = JSON.parse(fs.readFileSync(this.latestFile, 'utf8'));
          if (obj && obj.fetchedAt && Array.isArray(obj.window7d)) this.latest = obj;
        }
      } catch (e) { /* 损坏则忽略 */ }
    }
    if (!this.latest) {
      for (let i = this.index.length - 1; i >= 0; i--) {
        const e = this.index[i];
        if (e.ok) {
          const data = this._readSnapshotFile(e);
          if (data) { this.latest = data; break; }
        }
      }
    }
  }

  _loadIndex() {
    try {
      const arr = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (Array.isArray(arr)) return arr.filter((e) => e && e.id && e.fetchedAt);
    } catch (e) { /* 无索引或损坏 → 视为空 */ }
    return [];
  }

  _persistIndex() {
    atomicWrite(this.indexFile, JSON.stringify(this.index, null, 1));
  }

  _snapshotPath(id) {
    return path.join(this.historyDir, id + '.json');
  }

  // 读取一个索引条目指向的快照文件（解析 sameAs 引用链）
  _readSnapshotFile(entry) {
    let cur = entry;
    const seen = new Set();
    while (cur && cur.sameAs && !seen.has(cur.id)) {
      seen.add(cur.id);
      const prev = this.index.find((e) => e.id === cur.sameAs);
      if (!prev) return null;
      cur = prev;
    }
    if (!cur || cur.sameAs) return null;
    try {
      return JSON.parse(fs.readFileSync(this._snapshotPath(cur.id), 'utf8'));
    } catch (e) {
      return null;
    }
  }

  // 保存一次成功采集（data 为完整快照对象）
  saveSuccess(data, extra) {
    const json = JSON.stringify(data);
    const sha = sha256hex(snapshotContentJSON(data));
    const bytes = Buffer.byteLength(json);
    let id = stampId(data.fetchedAt);

    // 同 ID 冲突（同一秒内重复采集）：先追加序号，避免覆盖已有文件
    if (this.index.some((e) => e.id === id)) {
      let n = 2;
      while (this.index.some((e) => e.id === id + '-' + n)) n++;
      id = id + '-' + n;
    }

    const entry = Object.assign({
      id,
      fetchedAt: data.fetchedAt,
      ok: true,
      counts: {
        w7: (data.window7d || []).length,
        w24: (data.window24h || []).length,
        hot: (data.hot || []).length,
        daily: data.daily ? 1 : 0,
      },
      bytes,
      sha256: sha,
    }, extra || {});

    // 内容去重：与上一份成功快照 sha 一致 → 不再重复写全量文件
    let prevOk = null;
    for (let i = this.index.length - 1; i >= 0; i--) {
      if (this.index[i].ok) { prevOk = this.index[i]; break; }
    }
    if (prevOk && prevOk.sha256 === sha) {
      entry.sameAs = prevOk.sameAs || prevOk.id;
    } else {
      atomicWrite(this._snapshotPath(id), json);
    }

    this.index.push(entry);
    this._persistIndex();
    this.latest = data;
    atomicWrite(this.latestFile, json);
    return entry;
  }

  // 记录一次失败采集（不落数据文件，只在索引留痕，便于审计）
  saveFailure(fetchedAt, error, durationMs) {
    const entry = {
      id: stampId(fetchedAt),
      fetchedAt,
      ok: false,
      error: String(error).slice(0, 500),
      durationMs,
    };
    let finalId = entry.id;
    let n = 2;
    while (this.index.some((e) => e.id === finalId)) finalId = entry.id + '-' + (n++);
    entry.id = finalId;
    this.index.push(entry);
    this._persistIndex();
    return entry;
  }

  getLatest() { return this.latest; }

  getLatestEntry() {
    for (let i = this.index.length - 1; i >= 0; i--) {
      if (this.index[i].ok) return this.index[i];
    }
    return null;
  }

  // 分页列表（时间倒序）
  list(page, size) {
    const total = this.index.length;
    const pages = Math.max(1, Math.ceil(total / size));
    const p = Math.min(Math.max(1, page), pages);
    const start = total - p * size; // 倒序分页
    const items = [];
    for (let i = Math.max(0, start); i < Math.min(total, start + size); i++) {
      const e = this.index[i];
      items.push({
        id: e.id,
        fetchedAt: e.fetchedAt,
        ok: !!e.ok,
        counts: e.counts || null,
        bytes: e.bytes || 0,
        sha256: e.sha256 || null,
        sha8: e.sha256 ? e.sha256.slice(0, 8) : null,
        durationMs: e.durationMs != null ? e.durationMs : null,
        error: e.error || null,
        sameAs: e.sameAs || null,
        migrated: !!e.migrated,
      });
    }
    return { total, page: p, pages, items };
  }

  get(id) {
    const entry = this.index.find((e) => e.id === id);
    if (!entry || !entry.ok) return null;
    const data = this._readSnapshotFile(entry);
    if (!data) return null;
    return { entry, data };
  }

  dailyArchive(limit) {
    const cap = Math.min(Math.max(1, Number(limit) || 30), 365);
    const seen = new Set();
    const items = [];
    for (let i = this.index.length - 1; i >= 0 && items.length < cap; i--) {
      const entry = this.index[i];
      if (!entry.ok) continue;
      const data = this._readSnapshotFile(entry);
      const report = data && data.daily && data.daily.report;
      const date = report && String(report.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || seen.has(date)) continue;
      seen.add(date);
      const count = (report.sections || []).reduce((sum, section) => sum + ((section && section.items) || []).length, 0);
      items.push({ date, count, fetchedAt: entry.fetchedAt });
    }
    return items;
  }

  dailyByDate(date) {
    const target = String(date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return null;
    for (let i = this.index.length - 1; i >= 0; i--) {
      const entry = this.index[i];
      if (!entry.ok) continue;
      const data = this._readSnapshotFile(entry);
      if (data && data.daily && data.daily.report && data.daily.report.date === target) return data.daily;
    }
    return null;
  }

  del(id) {
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    const entry = this.index[idx];
    const latestBefore = this.getLatestEntry();
    const wasLatestOk = !!(latestBefore && latestBefore.id === id);
    // 删除被其它去重条目引用的物理快照时，先把文件和引用迁移到一个保留条目，
    // 避免删掉索引根节点后 sameAs 链失效。
    const refs = this.index.filter((e) => e.id !== id && e.sameAs === id);
    if (entry.ok && !entry.sameAs && refs.length) {
      const anchor = refs[0];
      try { fs.renameSync(this._snapshotPath(id), this._snapshotPath(anchor.id)); }
      catch (e) {
        try { fs.copyFileSync(this._snapshotPath(id), this._snapshotPath(anchor.id)); fs.unlinkSync(this._snapshotPath(id)); } catch (e2) {}
      }
      delete anchor.sameAs;
      for (let i = 1; i < refs.length; i++) refs[i].sameAs = anchor.id;
    } else if (entry.ok && !entry.sameAs) {
      try { fs.unlinkSync(this._snapshotPath(id)); } catch (e) { /* 已不存在 */ }
    }
    this.index.splice(idx, 1);
    this._persistIndex();
    // 若删的是最新成功快照，则回退 latest 到次新的成功快照
    if (wasLatestOk) {
      this.latest = null;
      for (let i = this.index.length - 1; i >= 0; i--) {
        if (this.index[i].ok) {
          const data = this._readSnapshotFile(this.index[i]);
          if (data) { this.latest = data; break; }
        }
      }
      if (this.latest) atomicWrite(this.latestFile, JSON.stringify(this.latest));
      else { try { fs.unlinkSync(this.latestFile); } catch (e) {} }
    }
    return true;
  }

  // 按天汇总采集量（用于概览图表）
  rollup(days) {
    const byDay = {}; // 'YYYY-MM-DD' -> {w7,w24,hot,fail}
    const dayKey = (iso) => {
      const d = new Date(iso);
      const p = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };
    for (const e of this.index) {
      if (!e.fetchedAt) continue;
      const k = dayKey(e.fetchedAt);
      if (!byDay[k]) byDay[k] = { date: k, w7: 0, w24: 0, hot: 0, fail: 0 };
      const d = byDay[k];
      if (e.ok && e.counts) { d.w7 += e.counts.w7; d.w24 += e.counts.w24; d.hot += e.counts.hot; }
      else d.fail++;
    }
    const keys = Object.keys(byDay).sort();
    const cut = keys.length > days ? keys.slice(keys.length - days) : keys;
    return cut.map((k) => byDay[k]);
  }

  usage() {
    let bytes = 0, files = 0;
    try {
      for (const f of fs.readdirSync(this.historyDir)) {
        if (f.startsWith('snap-') && f.endsWith('.json')) {
          try { bytes += fs.statSync(path.join(this.historyDir, f)).size; files++; } catch (e) {}
        }
      }
    } catch (e) {}
    const okEntries = this.index.filter((e) => e.ok).length;
    return {
      entries: this.index.length,
      okEntries,
      failEntries: this.index.length - okEntries,
      files,
      bytes,
      oldest: this.index.length ? this.index[0].fetchedAt : null,
      newest: this.index.length ? this.index[this.index.length - 1].fetchedAt : null,
    };
  }

  // 保留期清理：删除 fetchedAt 早于 N 天的索引条目及其未被引用的物理文件
  prune(retentionDays) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cut = Date.now() - retentionDays * 86400000;
    const doomed = this.index.filter((e) => new Date(e.fetchedAt).getTime() < cut);
    if (!doomed.length) return 0;
    const doomedIds = new Set(doomed.map((e) => e.id));
    // 如果即将删除的根快照仍被保留条目引用，先把物理文件迁移到一个保留条目。
    const kept = this.index.filter((e) => !doomedIds.has(e.id));
    for (const root of doomed.filter((e) => e.ok && !e.sameAs)) {
      const refs = kept.filter((e) => e.sameAs === root.id);
      if (!refs.length) continue;
      const anchor = refs[0];
      try { fs.renameSync(this._snapshotPath(root.id), this._snapshotPath(anchor.id)); }
      catch (e) {
        try { fs.copyFileSync(this._snapshotPath(root.id), this._snapshotPath(anchor.id)); fs.unlinkSync(this._snapshotPath(root.id)); } catch (e2) {}
      }
      delete anchor.sameAs;
      for (let i = 1; i < refs.length; i++) refs[i].sameAs = anchor.id;
    }
    const keptRefs = new Set(kept.filter((e) => e.sameAs).map((e) => e.sameAs));
    for (const e of doomed) {
      if (e.ok && !e.sameAs && !keptRefs.has(e.id)) {
        try { fs.unlinkSync(this._snapshotPath(e.id)); } catch (err) {}
      }
    }
    this.index = this.index.filter((e) => !doomedIds.has(e.id));
    this._persistIndex();
    return doomed.length;
  }
}

module.exports = { Store };
