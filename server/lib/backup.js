// backup.js — 运行数据定时备份：SQLite 一致性备份 + 关键 JSON 副本，带保留上限与跨实例锁。
// 背景：此前备份只发生在在线更新/重新部署时，日常运行数据没有任何周期性备份。
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const LOCK_NAME = 'backup';
const LOCK_TTL_MS = 30 * 60 * 1000;
const DEFAULT_AT = [4, 30];       // 每日本地 04:30（避开零点日界切换与采集高峰）
const DEFAULT_KEEP = 14;

function pad(n) { return String(n).padStart(2, '0'); }

// 本地时间戳目录名（与 store.js 的快照命名习惯一致）
function backupStampId(date) {
  const t = date || new Date();
  return 'daily-' + t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate())
       + '-' + pad(t.getHours()) + pad(t.getMinutes()) + pad(t.getSeconds());
}

async function backupDatabase(dataDir, outputDir) {
  const source = path.join(path.resolve(dataDir), 'db', 'aiqb.sqlite');
  if (!fs.existsSync(source)) return { skipped: true, reason: 'database_missing' };
  const targetDir = path.resolve(outputDir);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'aiqb.sqlite.consistent-backup');
  try { fs.rmSync(target, { force: true }); } catch (_) {}
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try { await db.backup(target); }
  finally { db.close(); }
  const stat = fs.statSync(target);
  return { skipped: false, source, target, bytes: stat.size };
}

function cleanAtSpec(value) {
  if (value == null) return DEFAULT_AT.slice();
  const match = String(value).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return match ? [Number(match[1]), Number(match[2])] : DEFAULT_AT.slice();
}

function clampKeep(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(365, Math.max(1, n)) : DEFAULT_KEEP;
}

function directoryBytes(dir) {
  let total = 0;
  let pending = [dir];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { continue; }
    if (stat.isDirectory()) {
      try { pending = pending.concat(fs.readdirSync(current).map((name) => path.join(current, name))); } catch (e) {}
    } else total += stat.size;
  }
  return total;
}

// 全量模式排除项：db/ 已由一致性备份覆盖（运行中直接拷贝 sqlite/wal 会得到不一致副本）；
// backups/ 防递归自拷贝；logs/ 与 updates/ 属可再生内容；initial-password.txt 为敏感一次性凭据。
const FULL_EXCLUDE = new Set(['db', 'backups', 'logs', 'updates']);

function copyFullData(dataDir, targetDir) {
  const fullDir = path.join(targetDir, 'full');
  fs.mkdirSync(fullDir, { recursive: true });
  let entries = [];
  try { entries = fs.readdirSync(dataDir); } catch (e) {}
  for (const name of entries) {
    if (FULL_EXCLUDE.has(name)) continue;
    const source = path.join(dataDir, name);
    if (name === 'auth') {
      fs.cpSync(source, path.join(fullDir, name), { recursive: true, filter: (src) => path.basename(src) !== 'initial-password.txt' });
      continue;
    }
    fs.cpSync(source, path.join(fullDir, name), { recursive: true });
  }
  return fullDir;
}

class BackupScheduler {
  constructor(options) {
    const opts = options || {};
    this.dataDir = path.resolve(opts.dataDir);
    this.backupDir = path.join(this.dataDir, 'backups');
    this.stateDb = opts.stateDb || null;
    this.logger = typeof opts.logger === 'function' ? opts.logger : ((message) => console.log(message));
    this.owner = 'backup:' + process.pid + ':' + Math.random().toString(16).slice(2, 8);
    this.atSpec = cleanAtSpec(opts.atSpec);
    this.keep = clampKeep(opts.keep);
    this.includeFull = opts.includeFull === true;
    this._timer = null;
    this._running = false;
    // 初始状态优先读取共享状态库：多实例部署时任一实例执行过备份，其他实例的总览都能看到。
    // atSpec/keep 以本实例配置为准，历史结果类字段以库中持久化值为准。
    const persisted = (this.stateDb && this.stateDb.getJSON('runtime', 'backup')) || null;
    this._state = Object.assign(
      { enabled: true, atSpec: this.atLabel(), keep: this.keep, lastAt: null, nextAt: null, lastTrigger: null, lastResult: null },
      persisted && typeof persisted === 'object' ? persisted : {},
      { enabled: true, atSpec: this.atLabel(), keep: this.keep });
  }

  atLabel() { return pad(this.atSpec[0]) + ':' + pad(this.atSpec[1]); }

  nextRunAt(nowMs) {
    // 单一时钟源：以传入的 Date.now()（缺省再取一次）为锚构造 Date
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const t = new Date(now);
    t.setHours(this.atSpec[0], this.atSpec[1], 0, 0);
    if (t.getTime() <= now) t.setDate(t.getDate() + 1);
    return t.getTime();
  }

  start() {
    if (this._timer) return;
    this._schedule();
    // 补跑：今日触发点已过但今天还没备份过（停机跨过触发点），延迟一分钟补一次。
    // 全部比较都以 Date.now() 为锚：与 new Date() 混用会在时钟回拨/外部包装下互相矛盾。
    const state = this.status();
    const lastAt = Date.parse(state && state.lastAt || '') || 0;
    const now = Date.now();
    const todayTrigger = new Date(now);
    todayTrigger.setHours(this.atSpec[0], this.atSpec[1], 0, 0);
    if (now >= todayTrigger.getTime() && (!lastAt || new Date(lastAt).toDateString() !== new Date(now).toDateString())) {
      const catchUp = setTimeout(() => { this.runNow('catch-up').catch(() => {}); }, 60 * 1000);
      catchUp.unref();
      this._setState({ pendingCatchUp: true });
    }
  }

  shutdown() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  _schedule() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const nextAt = this.nextRunAt(Date.now());
    this._setState({ nextAt: new Date(nextAt).toISOString() });
    this._timer = setTimeout(() => {
      this._timer = null;
      this.runNow('daily').catch(() => {});
      this._schedule();
    }, Math.max(1000, nextAt - Date.now()));
    this._timer.unref();
  }

  status() { return this._state; }

  _setState(patch) {
    this._state = Object.assign({}, this._state, patch);
    if (this.stateDb) {
      try { this.stateDb.setJSON('runtime', 'backup', this._state); } catch (e) {}
    }
  }

  async runNow(trigger) {
    if (this._running) return { busy: true };
    if (this.stateDb && !this.stateDb.acquireLock(LOCK_NAME, this.owner, LOCK_TTL_MS)) return { busy: true };
    this._running = true;
    const startedAt = new Date().toISOString();
    try {
      const result = await this._backupOnce();
      this._setState(Object.assign({ lastAt: startedAt, lastTrigger: trigger || 'manual', lastResult: result, pendingCatchUp: false }, result.ok ? { error: null } : {}));
      this.logger('数据备份' + (result.ok ? '完成: ' + (result.dbSkipped ? '（数据库缺失，已跳过）' : result.bytesKB + 'KB') + ' → ' + result.dir
        : '跳过: ' + result.reason));
      return { ok: true, result };
    } catch (error) {
      const message = String((error && error.message) || error);
      this._setState({ lastAt: startedAt, lastTrigger: trigger || 'manual', lastResult: { ok: false, error: message } });
      this.logger('数据备份失败: ' + message);
      return { ok: false, error: message };
    } finally {
      this._running = false;
      if (this.stateDb) {
        try { this.stateDb.releaseLock(LOCK_NAME, this.owner); } catch (e) {}
      }
    }
  }

  async _backupOnce() {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const targetDir = path.join(this.backupDir, backupStampId());
    try { fs.mkdirSync(targetDir); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let n = 2;
      while (true) {
        const retry = targetDir + '-' + n++;
        try { fs.mkdirSync(retry); return await this._fill(retry); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
    }
    return this._fill(targetDir);
  }

  async _fill(targetDir) {
    const files = [];
    const dbResult = await backupDatabase(this.dataDir, targetDir);
    if (!dbResult.skipped) files.push('aiqb.sqlite.consistent-backup');
    for (const rel of ['config.json', 'stats/daily.json', 'intelligence/items.json', 'sync/state.json']) {
      const source = path.join(this.dataDir, rel);
      if (!fs.existsSync(source)) continue;
      try {
        const dest = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest);
        files.push(rel);
      } catch (e) { /* 单文件复制失败不致命，其余内容照常备份 */ }
    }
    if (this.includeFull) {
      try { copyFullData(this.dataDir, targetDir); files.push('full/'); } catch (e) {}
    }
    this._prune();
    return { ok: true, dir: targetDir, files, bytesKB: Math.round(directoryBytes(targetDir) / 1024), dbSkipped: dbResult.skipped === true };
  }

  _prune() {
    let entries = [];
    try { entries = fs.readdirSync(this.backupDir).filter((name) => /^daily-\d{8}-\d{6}(?:-\d+)?$/.test(name)).sort(); }
    catch (e) { return; }
    while (entries.length > this.keep) {
      const doomed = entries.shift();
      try { fs.rmSync(path.join(this.backupDir, doomed), { recursive: true, force: true }); } catch (e) {}
    }
  }
}

module.exports = { BackupScheduler, backupDatabase, backupStampId, cleanAtSpec, clampKeep };
