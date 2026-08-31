// state-db.js — AIQB SQLite WAL 状态层；JSON 文件继续作为可读回滚备份。
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

class StateDatabase {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'db');
    this.file = path.join(this.dir, 'aiqb.sqlite');
    this.db = null;
    this.waitMs = 0;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.db = new Database(this.file, { timeout: 5000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('wal_autocheckpoint = 1000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state_json (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(namespace, key)
      );
      CREATE TABLE IF NOT EXISTS access_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_access_events_day_id ON access_events(day, id);
      CREATE TABLE IF NOT EXISTS migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip_key, created_at);
      CREATE TABLE IF NOT EXISTS job_locks (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this._getState = this.db.prepare('SELECT value, updated_at FROM state_json WHERE namespace = ? AND key = ?');
    this._setState = this.db.prepare(`
      INSERT INTO state_json(namespace,key,value,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    this._insertEvent = this.db.prepare('INSERT INTO access_events(day,payload,created_at) VALUES(?,?,?)');
    this._insertEvents = this.db.transaction((records) => {
      for (const record of records) this._insertEvent.run(record._d || String(record.t || '').slice(0, 10), JSON.stringify(record), record.t || new Date().toISOString());
    });
    this._upsertSession = this.db.prepare(`
      INSERT INTO auth_sessions(token_hash,payload,expires_at,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(token_hash) DO UPDATE SET payload=excluded.payload, expires_at=excluded.expires_at, updated_at=excluded.updated_at
    `);
    this._registerAttempt = this.db.transaction((ipKey, now, windowMs, max) => {
      this.db.prepare('DELETE FROM login_attempts WHERE created_at < ?').run(now - windowMs);
      const count = this.db.prepare('SELECT COUNT(*) count FROM login_attempts WHERE ip_key = ? AND created_at >= ?').get(ipKey, now - windowMs).count;
      if (count >= max) return false;
      this.db.prepare('INSERT INTO login_attempts(ip_key,created_at) VALUES(?,?)').run(ipKey, now);
      return true;
    });
    this._acquireLock = this.db.transaction((name, owner, expiresAt, now) => {
      this.db.prepare('DELETE FROM job_locks WHERE expires_at <= ?').run(now);
      const current = this.db.prepare('SELECT owner FROM job_locks WHERE name = ?').get(name);
      if (current && current.owner !== owner) return false;
      this.db.prepare(`INSERT INTO job_locks(name,owner,expires_at) VALUES(?,?,?)
        ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at`).run(name, owner, expiresAt);
      return true;
    });
    return this;
  }

  getJSON(namespace, key) {
    const row = this._getState.get(namespace, key);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch (_) { return null; }
  }

  getRevision(namespace, key) {
    const row = this._getState.get(namespace, key);
    return row ? row.updated_at : null;
  }

  setJSON(namespace, key, value, updatedAt) {
    const started = Date.now();
    const stamp = updatedAt || new Date().toISOString();
    this._setState.run(namespace, key, JSON.stringify(value), stamp);
    this.waitMs = Math.max(0, Date.now() - started);
    return stamp;
  }

  appendEvents(records) {
    if (!Array.isArray(records) || !records.length) return 0;
    const started = Date.now();
    this._insertEvents(records);
    this.waitMs = Math.max(0, Date.now() - started);
    return records.length;
  }

  eventsSince(day) {
    return this.db.prepare('SELECT payload FROM access_events WHERE day >= ? ORDER BY id').all(day).map((row) => {
      try { return JSON.parse(row.payload); } catch (_) { return null; }
    }).filter(Boolean);
  }

  recentEvents(limit) {
    return this.db.prepare('SELECT payload FROM access_events ORDER BY id DESC LIMIT ?').all(Math.max(1, Number(limit) || 40)).map((row) => {
      try { return JSON.parse(row.payload); } catch (_) { return null; }
    }).filter(Boolean);
  }

  listSessions(now) {
    const stamp = Number(now) || Date.now();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(stamp);
    return this.db.prepare('SELECT payload FROM auth_sessions WHERE expires_at > ?').all(stamp).map((row) => {
      try { return JSON.parse(row.payload); } catch (_) { return null; }
    }).filter(Boolean);
  }

  getSession(tokenHash, now) {
    const row = this.db.prepare('SELECT payload FROM auth_sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, Number(now) || Date.now());
    if (!row) return null;
    try { return JSON.parse(row.payload); } catch (_) { return null; }
  }

  upsertSession(session) {
    this._upsertSession.run(session.tokenHash, JSON.stringify(session), Number(session.expiresAt) || 0, Date.now());
  }

  deleteSession(tokenHash) {
    return this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash).changes > 0;
  }

  deleteSessionsExcept(tokenHash) {
    return this.db.prepare('DELETE FROM auth_sessions WHERE token_hash <> ?').run(tokenHash || '').changes;
  }

  registerLoginAttempt(ipKey, now, windowMs, max) {
    return this._registerAttempt(ipKey, Number(now) || Date.now(), Number(windowMs) || 900000, Number(max) || 10);
  }

  acquireLock(name, owner, ttlMs) {
    const now = Date.now();
    return this._acquireLock(String(name), String(owner), now + Math.max(1000, Number(ttlMs) || 60000), now);
  }

  renewLock(name, owner, ttlMs) {
    const expiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 60000);
    return this.db.prepare('UPDATE job_locks SET expires_at = ? WHERE name = ? AND owner = ?')
      .run(expiresAt, String(name), String(owner)).changes > 0;
  }

  releaseLock(name, owner) {
    return this.db.prepare('DELETE FROM job_locks WHERE name = ? AND owner = ?').run(String(name), String(owner)).changes > 0;
  }

  markMigration(name, details) {
    this.db.prepare('INSERT OR REPLACE INTO migrations(name,applied_at,details) VALUES(?,?,?)')
      .run(name, new Date().toISOString(), JSON.stringify(details || {}));
  }

  hasMigration(name) {
    return !!this.db.prepare('SELECT 1 found FROM migrations WHERE name = ?').get(name);
  }

  info() {
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try { bytes += fs.statSync(this.file + suffix).size; } catch (_) {}
    }
    const stateRows = this.db.prepare('SELECT COUNT(*) count FROM state_json').get().count;
    const events = this.db.prepare('SELECT COUNT(*) count FROM access_events').get().count;
    const sessions = this.db.prepare('SELECT COUNT(*) count FROM auth_sessions WHERE expires_at > ?').get(Date.now()).count;
    return { enabled: true, file: this.file, journalMode: 'wal', bytes, stateRows, events, sessions, lastWriteMs: this.waitMs };
  }

  close() {
    if (!this.db) return;
    try { this.db.pragma('optimize'); } catch (_) {}
    this.db.close();
    this.db = null;
  }
}

module.exports = { StateDatabase };
