#!/usr/bin/env node
'use strict';

// 手动一次性备份 CLI（一致性备份逻辑在 server/lib/backup.js，与内置定时备份共用）
const { backupDatabase } = require('../server/lib/backup');

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
