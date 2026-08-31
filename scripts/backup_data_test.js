'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { StateDatabase } = require('../server/lib/state-db');
const { backupDatabase } = require('./backup_data');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-backup-test-'));
const dataDir = path.join(root, 'data');
const outputDir = path.join(root, 'backup');

backupDatabase(path.join(root, 'missing'), outputDir).then((missing) => {
  if (!missing.skipped) throw new Error('缺少数据库时应安全跳过');
  const state = new StateDatabase(dataDir).init();
  state.setJSON('test', 'important', { count: 5931, preserved: true });
  state.close();
  return backupDatabase(dataDir, outputDir);
}).then((result) => {
  if (result.skipped || !fs.existsSync(result.target) || result.bytes <= 0) throw new Error('一致性备份未生成');
  const backup = new Database(result.target, { readonly: true, fileMustExist: true });
  const row = backup.prepare('SELECT value FROM state_json WHERE namespace = ? AND key = ?').get('test', 'important');
  backup.close();
  const value = JSON.parse(row.value);
  if (value.count !== 5931 || value.preserved !== true) throw new Error('备份内容校验失败');
  console.log('RESULT PASS=3 FAIL=0');
}).catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});
