'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateDatabase } = require('../server/lib/state-db');
const { Stats } = require('../server/lib/stats');
const { Auth } = require('../server/lib/auth');

let pass = 0, fail = 0;
function check(name, ok) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (ok) pass++; else fail++;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-multiprocess-'));
  const dbA = new StateDatabase(dir).init();
  const dbB = new StateDatabase(dir).init();
  dbB.skipLegacyMigration = true;
  const statsA = new Stats(dir, dbA); statsA.init();
  const statsB = new Stats(dir, dbB); statsB.init();
  statsA.track('203.0.113.10', 'Browser A', '/', 200, 'frontend');
  statsB.track('203.0.113.11', 'Browser B', '/articles', 200, 'frontend');
  await statsA.flush();
  await statsB.flush();
  const combined = statsA.quickToday().today;
  check('多 Web 实例访问流水汇总不丢失', combined.scopes.frontend.pv === 2 && combined.scopes.frontend.ips === 2);

  const session = { tokenHash: 'shared-session', createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 60000 };
  dbA.upsertSession(session);
  check('多连接共享后台会话', dbB.getSession('shared-session').tokenHash === 'shared-session');
  check('多连接共享登录限流', dbA.registerLoginAttempt('shared-ip', Date.now(), 60000, 1) === true && dbB.registerLoginAttempt('shared-ip', Date.now(), 60000, 1) === false);

  const initialPassword = 'Multi-Process-Password-2026';
  process.env.AIQB_INITIAL_ADMIN_PASSWORD = initialPassword;
  const authA = new Auth(dir, { sessionTtlHours: 24 }, dbA); authA.init();
  const authB = new Auth(dir, { sessionTtlHours: 24 }, dbB); authB.init();
  check('首次管理员口令不写入明文文件', !fs.existsSync(path.join(dir, 'auth', 'initial-password.txt')));
  const first = await authA.login('admin', initialPassword, '198.51.100.10');
  check('兄弟进程可读取新建共享会话', !!authB.verify(first.token));
  authA.logout(first.token);
  check('一个进程注销后兄弟进程缓存不能继续授权', authB.verify(first.token) === null);
  const keep = await authA.login('admin', initialPassword, '198.51.100.11');
  const sibling = await authB.login('admin', initialPassword, '198.51.100.12');
  await authA.changePassword(initialPassword, 'NewStrongPassword-2026', keep.token);
  let oldPasswordRejected = false;
  try { await authB.login('admin', initialPassword, '198.51.100.13'); } catch (error) { oldPasswordRejected = error && error.code === 'bad_credentials'; }
  check('一个进程改密后兄弟进程立即拒绝旧密码', oldPasswordRejected);
  check('改密会立即撤销兄弟进程已缓存的其他会话', authB.verify(sibling.token) === null);
  await authA.changeUsername('NewStrongPassword-2026', 'secureadmin');
  let oldUsernameRejected = false;
  try { await authB.login('admin', 'NewStrongPassword-2026', '198.51.100.14'); } catch (error) { oldUsernameRejected = error && error.code === 'bad_credentials'; }
  const renamed = await authB.login('secureadmin', 'NewStrongPassword-2026', '198.51.100.15');
  check('一个进程改名后兄弟进程立即拒绝旧用户名并接受新用户名', oldUsernameRejected && !!renamed.token);
  await authA.shutdown();
  await authB.shutdown();

  await statsA.shutdown();
  await statsB.shutdown();
  dbA.close(); dbB.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });
