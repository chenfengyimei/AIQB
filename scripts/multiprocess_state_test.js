'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateDatabase } = require('../server/lib/state-db');
const { Stats } = require('../server/lib/stats');

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

  await statsA.shutdown();
  await statsB.shutdown();
  dbA.close(); dbB.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  if (fail) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exit(1); });
