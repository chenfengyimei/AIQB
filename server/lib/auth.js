// auth.js — 管理后台认证：账号 / 会话 / 登录限流
// 存储（data/auth/ 下）：
//   users.json             单管理员账号（scrypt 哈希，绝不落明文密码）
//   sessions.json          活跃会话（只存 token 的 sha256，泄漏文件也无法伪造 cookie）
// 初始管理员必须通过本机安装流程一次性提供；只保存 scrypt 哈希，不生成明文密码文件。
// 会话策略：httpOnly + SameSite=Lax cookie；HTTPS（X-Forwarded-Proto）下自动加 Secure；
//           滑动续期（剩余不足一半时刷新），最长生命周期 30 天；服务重启会话不失效。
// 限流：同一 IP 15 分钟内最多 10 次登录尝试。

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { atomicWrite } = require('./config');

const COOKIE_NAME = 'aqb_admin';
const SESSION_MAX_MS = 30 * 24 * 3600 * 1000; // 会话最长生命周期
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 10;
const LOGIN_ACCOUNT_MAX = 50;

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function safeEqualStr(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err); else resolve(key.toString('hex'));
    });
  });
}

class AuthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

class Auth {
  constructor(dataDir, config, stateDb) {
    this.dir = path.join(dataDir, 'auth');
    this.config = config; // { sessionTtlHours }
    this.stateDb = stateDb || null;
    this.user = null;                     // 当前管理员
    this.sessions = new Map();            // tokenHash -> session
    this.initialPasswordFile = path.join(this.dir, 'initial-password.txt');
    this._attempts = new Map();           // ip -> number[]（登录尝试时间戳）
    this._sessionsDirty = false;
    this._sweepTimer = null;
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch (_) {}
    this._loadUser();
    // 旧版本可能留下初始口令文件。账号哈希加载成功后立即清除，避免升级后继续遗留明文。
    try { fs.unlinkSync(this.initialPasswordFile); } catch (_) {}
    this._loadSessions();
    this._sweepTimer = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this._sweepTimer.unref();
  }

  _usersFile() { return path.join(this.dir, 'users.json'); }

  _loadUser() {
    if (this.stateDb) {
      const stored = this.stateDb.getJSON('auth', 'user');
      if (stored && stored.username && stored.passHash) { this.user = stored; return; }
    }
    try {
      const obj = JSON.parse(fs.readFileSync(this._usersFile(), 'utf8'));
      if (obj && obj.user && obj.user.username && obj.user.passHash) {
        this.user = obj.user;
        return;
      }
    } catch (e) { /* 不存在或损坏 */ }
    // 首次启动必须由本机安装器一次性注入口令。读取后立即从进程环境移除；
    // 服务不会生成、打印或持久化可直接登录的明文凭据。
    const password = String(process.env.AIQB_INITIAL_ADMIN_PASSWORD || '');
    delete process.env.AIQB_INITIAL_ADMIN_PASSWORD;
    if (password.length < 12 || password.length > 128) {
      throw new Error('尚未初始化管理员账号；请先运行 npm run admin:bootstrap（密码需为 12–128 位）');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    this.user = {
      id: crypto.randomBytes(8).toString('hex'),
      username: 'admin',
      passHash: crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex'),
      salt,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this._persistUser();
    console.log('管理后台账号已安全初始化；登录地址 /chenfengadmin，用户名 admin。');
  }

  _refreshUserFromShared() {
    if (!this.stateDb) return this.user;
    const stored = this.stateDb.getJSON('auth', 'user');
    if (stored && stored.username && stored.passHash && stored.salt) this.user = stored;
    return this.user;
  }

  _persistUser() {
    if (this.stateDb) this.stateDb.setJSON('auth', 'user', this.user, this.user.updatedAt || new Date().toISOString());
    atomicWrite(this._usersFile(), JSON.stringify({ version: 1, user: this.user }, null, 2) + '\n');
  }

  _loadSessions() {
    if (this.stateDb) {
      const rows = this.stateDb.listSessions(Date.now());
      for (const session of rows) if (session && session.tokenHash) this.sessions.set(session.tokenHash, session);
      if (this.sessions.size) return;
      if (this.stateDb.hasMigration('auth-sessions-to-wal')) return;
      const stored = this.stateDb.getJSON('auth', 'sessions');
      if (stored && Array.isArray(stored.sessions)) {
        for (const session of stored.sessions) if (session && session.tokenHash && session.expiresAt > Date.now()) this.sessions.set(session.tokenHash, session);
        for (const session of this.sessions.values()) this.stateDb.upsertSession(session);
        this.stateDb.markMigration('auth-sessions-to-wal', { sessions: this.sessions.size, source: 'state_json' });
        return;
      }
    }
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(this.dir, 'sessions.json'), 'utf8'));
      if (obj && Array.isArray(obj.sessions)) {
        for (const s of obj.sessions) {
          if (s && s.tokenHash && s.expiresAt > Date.now()) this.sessions.set(s.tokenHash, s);
        }
      }
    } catch (e) { /* 无会话文件 */ }
    if (this.stateDb) {
      for (const session of this.sessions.values()) this.stateDb.upsertSession(session);
      this.stateDb.markMigration('auth-sessions-to-wal', { sessions: this.sessions.size, source: 'json' });
    }
  }

  _persistSessions() {
    let arr = [];
    for (const s of this.sessions.values()) arr.push(s);
    if (this.stateDb) {
      // SQLite 是多进程会话唯一权威；绝不能用本进程旧缓存反向写回并复活已撤销会话。
      arr = this.stateDb.listSessions(Date.now());
      this.sessions = new Map(arr.map((session) => [session.tokenHash, session]));
      this.stateDb.setJSON('auth', 'sessions', { version: 1, sessions: arr });
    }
    atomicWrite(path.join(this.dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: arr }, null, 1) + '\n');
    this._sessionsDirty = false;
  }

  _markSessionsDirty() {
    this._sessionsDirty = true;
    setImmediate(() => { if (this._sessionsDirty) this._persistSessions(); });
  }

  sweep() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of this.sessions) {
      if (s.expiresAt <= now || now - s.createdAt > SESSION_MAX_MS) {
        this.sessions.delete(k);
        changed = true;
      }
    }
    if (changed || this._sessionsDirty) this._persistSessions();
  }

  // ---------- 限流 ----------

  _rateCheck(ip, username) {
    const now = Date.now();
    if (this.stateDb) {
      const ipKey = 'ip:' + sha256hex(String(ip || 'unknown'));
      const accountKey = 'account:' + sha256hex(String(username || '').trim().toLowerCase() || 'unknown');
      if (!this.stateDb.registerLoginAttempt(ipKey, now, LOGIN_WINDOW_MS, LOGIN_MAX) ||
          !this.stateDb.registerLoginAttempt(accountKey, now, LOGIN_WINDOW_MS, LOGIN_ACCOUNT_MAX)) {
        throw new AuthError('rate_limited', '尝试过于频繁，请 15 分钟后再试', 429);
      }
      return;
    }
    let arr = this._attempts.get(ip);
    if (!arr) { arr = []; this._attempts.set(ip, arr); }
    while (arr.length && now - arr[0] > LOGIN_WINDOW_MS) arr.shift();
    if (arr.length >= LOGIN_MAX) {
      throw new AuthError('rate_limited', '尝试过于频繁，请 15 分钟后再试', 429);
    }
    arr.push(now);
    if (this._attempts.size > 10000) {
      for (const [k, v] of this._attempts) {
        if (!v.length || now - v[v.length - 1] > LOGIN_WINDOW_MS) this._attempts.delete(k);
      }
    }
  }

  // ---------- 登录 / 会话 ----------

  async login(username, password, ip) {
    if (!username || !password) throw new AuthError('invalid_input', '请输入用户名和密码', 400);
    this._rateCheck(ip || 'unknown', username);
    const u = this._refreshUserFromShared();
    const hash = await scryptAsync(String(password), u.salt);
    const userOk = safeEqualStr(String(username).toLowerCase(), u.username.toLowerCase());
    const passOk = safeEqualStr(hash, u.passHash);
    if (!userOk || !passOk) {
      throw new AuthError('bad_credentials', '用户名或密码错误', 401);
    }
    u.lastLoginAt = new Date().toISOString();
    this._persistUser();

    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    const session = {
      tokenHash: sha256hex(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this._ttlMs(),
      ip: ip || '',
    };
    this.sessions.set(session.tokenHash, session);
    if (this.stateDb) this.stateDb.upsertSession(session);
    this._persistSessions();
    return { token, user: this.publicInfo() };
  }

  _ttlMs() {
    const h = Number(this.config.sessionTtlHours) || 24 * 7;
    return Math.min(Math.max(1, h), 720) * 3600 * 1000;
  }

  // 校验会话（滑动续期：剩余有效期不足一半时刷新）
  verify(token) {
    if (!token) return null;
    const tokenHash = sha256hex(token);
    // SQLite 是多进程权威。每次鉴权都读取共享行，确保注销和改密立即在兄弟进程生效。
    let s = this.stateDb ? this.stateDb.getSession(tokenHash, Date.now()) : this.sessions.get(tokenHash);
    if (s) this.sessions.set(tokenHash, s);
    else this.sessions.delete(tokenHash);
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt <= now || now - s.createdAt > SESSION_MAX_MS) {
      this.sessions.delete(tokenHash);
      if (this.stateDb) this.stateDb.deleteSession(tokenHash);
      this._markSessionsDirty();
      return null;
    }
    s.lastSeenAt = now;
    if (s.expiresAt - now < this._ttlMs() / 2 && now - s.createdAt < SESSION_MAX_MS) {
      // 续期但不超过最长生命周期
      s.expiresAt = Math.min(now + this._ttlMs(), s.createdAt + SESSION_MAX_MS);
      if (this.stateDb) this.stateDb.upsertSession(s);
      this._markSessionsDirty();
    }
    this._refreshUserFromShared();
    return { tokenHash, session: s, user: this.publicInfo() };
  }

  logout(token) {
    if (!token) return;
    const tokenHash = sha256hex(token);
    const deleted = this.sessions.delete(tokenHash);
    const sharedDeleted = this.stateDb ? this.stateDb.deleteSession(tokenHash) : false;
    if (deleted || sharedDeleted) this._persistSessions();
  }

  // ---------- 账号管理 ----------

  publicInfo() {
    const u = this.user;
    return {
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
      lastLoginAt: u.lastLoginAt,
      initialPasswordPresent: fs.existsSync(this.initialPasswordFile),
    };
  }

  async changePassword(currentPassword, newPassword, currentToken) {
    if (!currentPassword || !newPassword) throw new AuthError('invalid_input', '请填写当前密码和新密码', 400);
    if (String(newPassword).length < 12) throw new AuthError('weak_password', '新密码至少 12 位', 400);
    if (String(newPassword).length > 128) throw new AuthError('weak_password', '新密码过长', 400);
    const u = this._refreshUserFromShared();
    const hash = await scryptAsync(String(currentPassword), u.salt);
    if (!safeEqualStr(hash, u.passHash)) throw new AuthError('bad_credentials', '当前密码不正确', 401);

    u.salt = crypto.randomBytes(16).toString('hex');
    u.passHash = await scryptAsync(String(newPassword), u.salt);
    u.updatedAt = new Date().toISOString();
    this._persistUser();
    // 修改密码后：仅保留当前会话，其它会话全部失效
    const keep = currentToken ? sha256hex(currentToken) : null;
    for (const k of Array.from(this.sessions.keys())) {
      if (k !== keep) this.sessions.delete(k);
    }
    if (this.stateDb) this.stateDb.deleteSessionsExcept(keep || '');
    this._persistSessions();
    // 删除初始密码文件（若存在）
    try { fs.unlinkSync(this.initialPasswordFile); } catch (e) {}
    return this.publicInfo();
  }

  async changeUsername(currentPassword, newUsername) {
    if (!currentPassword || !newUsername) throw new AuthError('invalid_input', '请填写当前密码和新用户名', 400);
    const name = String(newUsername).trim();
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(name)) {
      throw new AuthError('invalid_username', '用户名需为 3–32 位字母/数字/下划线/短横线', 400);
    }
    const u = this._refreshUserFromShared();
    const hash = await scryptAsync(String(currentPassword), u.salt);
    if (!safeEqualStr(hash, u.passHash)) throw new AuthError('bad_credentials', '当前密码不正确', 401);
    if (name.toLowerCase() === u.username.toLowerCase()) {
      throw new AuthError('same_username', '新用户名与当前相同', 400);
    }
    u.username = name;
    u.updatedAt = new Date().toISOString();
    this._persistUser();
    return this.publicInfo();
  }

  // ---------- cookie ----------

  sessionCookie(token, secure) {
    const parts = [
      COOKIE_NAME + '=' + token,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=' + Math.floor(this._ttlMs() / 1000),
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie() {
    return COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  }

  async shutdown() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this.sweep(); // 清理过期会话并持久化
  }
}

module.exports = { Auth, AuthError, COOKIE_NAME };
