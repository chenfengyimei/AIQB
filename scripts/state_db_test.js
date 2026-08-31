'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateDatabase } = require('../server/lib/state-db');

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.error('FAIL ' + name); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-state-db-'));
let db = new StateDatabase(dir).init();
check('SQLite 使用 WAL 模式', db.db.pragma('journal_mode', { simple: true }) === 'wal');
db.setJSON('test', 'config', { enabled: true, count: 3 }, '2026-08-31T00:00:00.000Z');
check('JSON 状态可读写', db.getJSON('test', 'config').count === 3);
db.appendEvents([
  { _d: '2026-08-30', t: '2026-08-30T12:00:00.000Z', p: '/' },
  { _d: '2026-08-31', t: '2026-08-31T01:00:00.000Z', p: '/articles' },
]);
check('访问流水按日期查询', db.eventsSince('2026-08-31').length === 1);
const session = { tokenHash: 'token-a', createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60000 };
db.upsertSession(session);
check('会话按行共享且可读取', db.getSession('token-a').tokenHash === 'token-a' && db.listSessions().length === 1);
check('登录限流跨实例原子计数', db.registerLoginAttempt('ip-a', Date.now(), 60000, 2) === true && db.registerLoginAttempt('ip-a', Date.now(), 60000, 2) === true && db.registerLoginAttempt('ip-a', Date.now(), 60000, 2) === false);
check('跨实例任务锁避免重复采集', db.acquireLock('collect', 'worker-a', 60000) === true && db.acquireLock('collect', 'worker-b', 60000) === false && db.releaseLock('collect', 'worker-a') === true && db.acquireLock('collect', 'worker-b', 60000) === true);
check('任务锁只允许持有者续期并可在退出时释放', db.renewLock('collect', 'worker-b', 120000) === true && db.renewLock('collect', 'worker-a', 120000) === false && db.releaseLock('collect', 'worker-b') === true);
db.close();
db = new StateDatabase(dir).init();
check('重启后状态仍存在', db.getJSON('test', 'config').enabled === true && db.recentEvents(5).length === 2);
check('数据库健康信息完整', db.info().journalMode === 'wal' && db.info().bytes > 0 && db.info().events === 2);
check('会话跨连接保持且可撤销', db.info().sessions === 1 && db.deleteSession('token-a') === true && db.getSession('token-a') === null);
db.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
if (fail) process.exitCode = 1;
