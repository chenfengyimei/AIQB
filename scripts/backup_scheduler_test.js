'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateDatabase } = require('../server/lib/state-db');
const { BackupScheduler, backupDatabase, cleanAtSpec, clampKeep } = require('../server/lib/backup');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-backup-sched-'));
const dataDir = path.join(root, 'data');
let pass = 0, fail = 0;
function check(name, condition) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  if (condition) pass++; else fail++;
}
const quiet = () => {};

(async () => {
  check('备份时间与保留份数配置容错', cleanAtSpec('25:99')[0] === 4 && cleanAtSpec('07:05')[1] === 5 && clampKeep('0') === 14 && clampKeep('99') === 99);

  // 空数据目录（无 SQLite）：调度器仍能完成一次备份（关键 JSON 副本），不因缺库失败
  const emptyDir = path.join(root, 'empty');
  fs.mkdirSync(path.join(emptyDir, 'stats'), { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(emptyDir, 'stats', 'daily.json'), '{"days":{}}');
  const emptyScheduler = new BackupScheduler({ dataDir: emptyDir, logger: quiet, keep: 3 });
  const emptyRun = await emptyScheduler.runNow('test');
  check('数据库缺失时备份不报错并记录跳过原因', emptyRun.ok && emptyRun.result.dbSkipped === true && fs.existsSync(path.join(emptyRun.result.dir, 'config.json')));

  const db = new StateDatabase(dataDir).init();
  db.setJSON('test', 'important', { count: 7321, preserved: true });
  db.appendEvents([{ t: new Date().toISOString(), ip: 'ip-1', uv: 'uv-1', p: '/', s: 200, k: 'frontend', _d: '2026-01-01' }]);
  fs.mkdirSync(path.join(dataDir, 'stats'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"collectIntervalHours":12}');
  fs.writeFileSync(path.join(dataDir, 'stats', 'daily.json'), '{"version":5,"days":{}}');

  const direct = await backupDatabase(dataDir, path.join(root, 'manual'));
  check('手动一致性备份生成且内容可读', !direct.skipped && fs.existsSync(direct.target) && direct.bytes > 0);

  const scheduler = new BackupScheduler({ dataDir, stateDb: db, logger: quiet, keep: 2 });
  const first = await scheduler.runNow('test');
  check('定时备份包含数据库一致性副本与关键 JSON', first.ok &&
    fs.existsSync(path.join(first.result.dir, 'aiqb.sqlite.consistent-backup')) &&
    fs.existsSync(path.join(first.result.dir, 'config.json')) &&
    fs.existsSync(path.join(first.result.dir, 'stats', 'daily.json')));
  check('备份状态持久化到共享状态库并可跨实例读取', db.getJSON('runtime', 'backup').lastAt === scheduler.status().lastAt &&
    new BackupScheduler({ dataDir, stateDb: db, logger: quiet }).status().lastAt === scheduler.status().lastAt);

  await scheduler.runNow('test-2');
  await scheduler.runNow('test-3');
  await scheduler.runNow('test-4');
  const kept = fs.readdirSync(path.join(dataDir, 'backups')).filter((name) => /^daily-/.test(name));
  check('保留上限生效（keep=2 只留最新两份）', kept.length === 2);

  db.acquireLock('backup', 'other-instance-owner', 60 * 1000);
  const busy = await new BackupScheduler({ dataDir, stateDb: db, logger: quiet }).runNow('locked-test');
  check('跨实例锁持有期间备份返回 busy 不执行', busy.busy === true);
  db.releaseLock('backup', 'other-instance-owner');

  const now = Date.now();
  const soon = new Date(now);
  soon.setMinutes(soon.getMinutes() + 30);
  const timed = new BackupScheduler({ dataDir, stateDb: db, logger: quiet, atSpec: soon.getHours() + ':' + (soon.getMinutes() < 10 ? '0' : '') + soon.getMinutes() });
  const next = timed.nextRunAt(now);
  check('下次触发时间按本地时刻计算且在未来', next > now && next - now <= 31 * 60 * 1000 && new Date(next).getHours() === soon.getHours());

  const fullDir = path.join(root, 'full-mode');
  fs.mkdirSync(path.join(fullDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(fullDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(fullDir, 'auth'), { recursive: true });
  fs.writeFileSync(path.join(fullDir, 'logs', 'collect-today.log'), 'noise');
  fs.writeFileSync(path.join(fullDir, 'auth', 'initial-password.txt'), 'secret-once');
  fs.writeFileSync(path.join(fullDir, 'auth', 'user.json'), '{"username":"admin"}');
  fs.writeFileSync(path.join(fullDir, 'config.json'), '{"a":1}');
  const fullRun = await new BackupScheduler({ dataDir: fullDir, stateDb: null, logger: quiet, includeFull: true }).runNow('full-test');
  const fullCopy = path.join(fullRun.result.dir, 'full');
  check('全量模式排除 db/logs 与一次性初始密码但保留其余数据',
    fs.existsSync(fullCopy) && !fs.existsSync(path.join(fullCopy, 'logs')) && !fs.existsSync(path.join(fullCopy, 'db')) &&
    fs.existsSync(path.join(fullCopy, 'auth', 'user.json')) && !fs.existsSync(path.join(fullCopy, 'auth', 'initial-password.txt')) &&
    fs.existsSync(path.join(fullCopy, 'config.json')));

  db.close();
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
});
