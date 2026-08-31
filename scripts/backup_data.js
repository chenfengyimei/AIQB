'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

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

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (require.main === module) {
  const dataDir = option('--data-dir');
  const outputDir = option('--output-dir');
  if (!dataDir || !outputDir) {
    console.error('用法: node scripts/backup_data.js --data-dir <server/data> --output-dir <backup-dir>');
    process.exit(2);
  }
  backupDatabase(dataDir, outputDir).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
}

module.exports = { backupDatabase };
