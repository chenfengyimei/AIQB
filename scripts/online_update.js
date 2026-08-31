#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawnSync } = require('child_process');
const { backupDatabase } = require('./backup_data');
const { sourcesFromEnv, parseVersion, atomicJson, requestHeaders } = require('../server/lib/update-manager');

const COPY_TARGETS = [
  'server/server.js', 'server/lib', 'frontend', 'scripts/setup.js', 'scripts/backup_data.js',
  'scripts/online_update.js', 'package.json', 'package-lock.json', 'ecosystem.config.js',
  'README.md', 'deploy.sh', '.npmignore', '.env.example',
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function assertSafeDirectory(target, label) {
  const value = path.resolve(target || '');
  const root = path.parse(value).root;
  if (!target || value === root || value.length < root.length + 6) throw new Error(label + ' 目录不安全');
  return value;
}

function run(command, args, options) {
  const result = spawnSync(command, args, Object.assign({ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, options || {}));
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error && result.error.message || '').trim().slice(-1200);
    throw new Error(command + ' 执行失败' + (detail ? '：' + detail : ''));
  }
  return result.stdout;
}

async function download(url, file, headers) {
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('下载更新包失败（HTTP ' + response.status + '）');
  const max = 100 * 1024 * 1024;
  const size = Number(response.headers.get('content-length')) || 0;
  if (size > max) throw new Error('更新包超过 100MB 安全限制');
  let bytes = 0;
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length;
    callback(bytes > max ? new Error('更新包超过 100MB 安全限制') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), limiter, fs.createWriteStream(file, { mode: 0o600 }));
  return bytes;
}

function findPackageRoot(extractDir) {
  const candidates = [extractDir].concat(fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(extractDir, e.name)));
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'server', 'server.js')) && fs.existsSync(path.join(dir, 'frontend'))) || null;
}

function copyTarget(sourceRoot, targetRoot, relative) {
  const source = path.join(sourceRoot, relative);
  if (!fs.existsSync(source)) return false;
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, force: true, preserveTimestamps: true });
  return true;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

async function main() {
  if (process.platform !== 'linux') throw new Error('在线更新只能在 Linux 服务器执行');
  const sourceId = option('--source');
  const expectedVersion = String(option('--version') || '').replace(/^v/, '');
  if (!parseVersion(expectedVersion)) throw new Error('目标版本无效');
  const appDir = assertSafeDirectory(option('--app-dir'), '应用');
  const dataDir = assertSafeDirectory(option('--data-dir'), '数据');
  const expectedDataDir = path.join(appDir, 'server', 'data');
  if (dataDir !== expectedDataDir && !process.env.AIQB_DATA_DIR) throw new Error('非默认数据目录必须由 AIQB_DATA_DIR 明确配置');
  const updateDir = path.join(dataDir, 'updates');
  const stateFile = path.join(updateDir, 'state.json');
  const lockFile = path.join(updateDir, 'running.lock');
  const sources = sourcesFromEnv(process.env);
  const source = sources[sourceId];
  if (!source) throw new Error('未知更新源');
  let state = { phase: 'queued', source: sourceId, toVersion: expectedVersion, startedAt: new Date().toISOString() };
  const setState = (phase, message, extra) => {
    state = Object.assign({}, state, extra || {}, { phase, message, updatedAt: new Date().toISOString() });
    atomicJson(stateFile, state);
  };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-update-'));
  const archive = path.join(tempDir, 'source.tar.gz');
  const extractDir = path.join(tempDir, 'source');
  const backupDir = path.join(path.dirname(appDir), path.basename(appDir) + '-backups', 'online-' + new Date().toISOString().replace(/[:.]/g, '-'));
  const previous = [];
  let copied = false;
  try {
    setState('downloading', '正在从 ' + source.name + ' 下载 v' + expectedVersion);
    fs.mkdirSync(extractDir, { recursive: true });
    const bytes = await download(source.archiveUrl, archive, requestHeaders(source));
    run('tar', ['-xzf', archive, '-C', extractDir]);
    const packageRoot = findPackageRoot(extractDir);
    if (!packageRoot) throw new Error('更新包目录结构不完整');
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'aiqb' || String(manifest.version) !== expectedVersion) throw new Error('安装包版本与确认版本不一致');
    for (const required of ['server/server.js', 'server/lib', 'frontend', 'package.json', 'package-lock.json', 'ecosystem.config.js']) {
      if (!fs.existsSync(path.join(packageRoot, required))) throw new Error('更新包缺少必要文件：' + required);
    }

    setState('backing_up', '正在备份代码、数据库和完整运行数据', { archiveBytes: bytes, archiveSha256: sha256(archive), backupDir });
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o750 });
    const codeBackup = path.join(backupDir, 'code');
    for (const relative of COPY_TARGETS) {
      const existed = fs.existsSync(path.join(appDir, relative));
      previous.push({ relative, existed });
      if (existed) copyTarget(appDir, codeBackup, relative);
    }
    await backupDatabase(dataDir, backupDir);
    const dataArchive = path.join(backupDir, 'server-data.tar.gz');
    run('tar', ['-czf', dataArchive, '-C', path.dirname(dataDir), path.basename(dataDir)]);
    fs.writeFileSync(dataArchive + '.sha256', sha256(dataArchive) + '  server-data.tar.gz\n', { mode: 0o600 });

    setState('installing', '正在安装 v' + expectedVersion + '，运行数据保持原位');
    for (const relative of COPY_TARGETS) copyTarget(packageRoot, appDir, relative);
    copied = true;
    run('npm', ['ci', '--omit=dev'], { cwd: appDir, env: Object.assign({}, process.env, { npm_config_audit: 'false', npm_config_fund: 'false' }) });

    setState('restarting', '代码安装完成，正在平滑重载服务');
    let restartRequired = false;
    try {
      run('pm2', ['reload', 'aiqb-web', '--update-env'], { cwd: appDir });
      run('pm2', ['restart', 'aiqb-collector', '--update-env'], { cwd: appDir });
      try { run('pm2', ['save'], { cwd: appDir }); } catch (_) {}
    } catch (error) {
      restartRequired = true;
      setState('completed', '更新完成，但 PM2 自动重载失败，请手动重启服务', { completedAt: new Date().toISOString(), restartRequired, warning: error.message });
      return;
    }
    setState('completed', '已成功更新到 v' + expectedVersion, { completedAt: new Date().toISOString(), restartRequired: false });
  } catch (error) {
    let rollbackError = '';
    if (copied) {
      try {
        for (const item of previous) {
          const target = path.join(appDir, item.relative);
          if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
          if (item.existed) copyTarget(path.join(backupDir, 'code'), appDir, item.relative);
        }
        try { run('npm', ['ci', '--omit=dev'], { cwd: appDir }); } catch (restoreDepsError) { rollbackError = '；依赖恢复失败：' + restoreDepsError.message; }
      } catch (restoreError) { rollbackError = '；代码恢复失败：' + restoreError.message; }
    }
    setState('failed', '更新失败：' + error.message + (copied ? (rollbackError || '；旧代码已恢复') : ''), { failedAt: new Date().toISOString(), rollbackError: rollbackError || null });
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  try {
    const dataDir = assertSafeDirectory(option('--data-dir'), '数据');
    const updateDir = path.join(dataDir, 'updates');
    atomicJson(path.join(updateDir, 'state.json'), {
      phase: 'failed',
      source: option('--source') || null,
      toVersion: option('--version') || null,
      message: '更新任务启动失败：' + error.message,
      failedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    try { fs.unlinkSync(path.join(updateDir, 'running.lock')); } catch (_) {}
  } catch (_) {}
  process.exitCode = 1;
});
