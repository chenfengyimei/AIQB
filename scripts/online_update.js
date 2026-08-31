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
const { sourcesFromEnv, sourceForRevision, parseVersion, normalizeRevision, atomicJson, requestHeaders } = require('../server/lib/update-manager');
const { publicKeyFromEnv, verifyReleaseManifest, verifyPackageFiles, readReleaseManifest } = require('../server/lib/release-signature');

const COPY_TARGETS = [
  'server/server.js', 'server/lib', 'frontend', 'scripts',
  'package.json', 'package-lock.json', 'ecosystem.config.js',
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
  'RELEASING.md',
  'LICENSE', 'LICENSE.zh-CN.md', 'NOTICE',
  'release-signature.json',
  'deploy.sh', 'install.sh', '.gitignore', '.npmignore', '.env.example',
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

function assertDataDirectoryIsolation(appDir, dataDir) {
  const app = path.resolve(appDir);
  const data = path.resolve(dataDir);
  const defaultData = path.join(app, 'server', 'data');
  if (data === defaultData) return data;
  const appPrefix = app + path.sep;
  const dataPrefix = data + path.sep;
  if (data.startsWith(appPrefix) || app.startsWith(dataPrefix)) {
    throw new Error('自定义数据目录不得位于应用目录内，也不得包含应用目录');
  }
  return data;
}

function run(command, args, options) {
  const result = spawnSync(command, args, Object.assign({ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, options || {}));
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error && result.error.message || '').trim().slice(-1200);
    throw new Error(command + ' 执行失败' + (detail ? '：' + detail : ''));
  }
  return result.stdout;
}

function validateArchiveListing(namesOutput, verboseOutput) {
  const names = String(namesOutput || '').split(/\r?\n/).filter(Boolean);
  if (!names.length || names.length > 20000) throw new Error('更新包文件数量无效或超过安全限制');
  for (const name of names) {
    const normalized = name.replace(/\\/g, '/').replace(/\/$/, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) throw new Error('更新包包含越界路径');
  }
  const details = String(verboseOutput || '').split(/\r?\n/).filter(Boolean);
  if (details.length !== names.length || details.some((line) => !['-', 'd'].includes(line.charAt(0)))) {
    throw new Error('更新包包含符号链接、硬链接或特殊文件');
  }
  return names.length;
}

function inspectArchive(file) {
  const names = run('tar', ['-tzf', file]);
  const details = run('tar', ['-tvzf', file]);
  return validateArchiveListing(names, details);
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

function assertSafePackageTree(root) {
  const base = path.resolve(root);
  const prefix = base + path.sep;
  const pending = [base];
  let files = 0;
  let bytes = 0;
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('更新包包含符号链接：' + path.relative(base, current));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        const child = path.resolve(current, name);
        if (child !== base && !child.startsWith(prefix)) throw new Error('更新包路径越界');
        pending.push(child);
      }
      continue;
    }
    if (!stat.isFile()) throw new Error('更新包包含不支持的文件类型：' + path.relative(base, current));
    files++;
    bytes += stat.size;
    if (files > 20000 || bytes > 512 * 1024 * 1024) throw new Error('更新包解压后超过安全限制');
  }
  return { files, bytes };
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

function reloadServices(appDir) {
  run('pm2', ['reload', 'aiqb-web', '--update-env'], { cwd: appDir });
  run('pm2', ['restart', 'aiqb-collector', '--update-env'], { cwd: appDir });
  try { run('pm2', ['save'], { cwd: appDir }); } catch (_) {}
}

function stopServices(appDir) {
  const errors = [];
  for (const name of ['aiqb-web', 'aiqb-collector']) {
    try { run('pm2', ['stop', name], { cwd: appDir }); } catch (error) { errors.push(name + '：' + error.message); }
  }
  if (errors.length) throw new Error(errors.join('；'));
}

async function rollbackInstallation(options, operations) {
  const opts = options || {};
  const ops = Object.assign({
    remove: (target) => { if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true }); },
    copy: copyTarget,
    install: () => run('npm', ['ci', '--omit=dev'], { cwd: opts.appDir }),
    reload: () => reloadServices(opts.appDir),
    wait: () => parseVersion(opts.fromVersion) ? waitForHealthyVersion(opts.fromVersion, 16) : Promise.resolve(),
    stop: () => stopServices(opts.appDir),
  }, operations || {});
  const errors = [];
  let filesRestored = false;
  let healthy = false;
  let stopped = false;
  try {
    for (const item of opts.previous || []) {
      const target = path.join(opts.appDir, item.relative);
      ops.remove(target);
      if (item.existed) ops.copy(path.join(opts.backupDir, 'code'), opts.appDir, item.relative);
    }
    filesRestored = true;
  } catch (error) { errors.push('代码恢复失败：' + error.message); }
  if (filesRestored) {
    try { ops.install(); } catch (error) { errors.push('依赖恢复失败：' + error.message); }
    try {
      ops.reload();
      await ops.wait();
      healthy = true;
    } catch (error) { errors.push('旧版本重载或健康检查失败：' + error.message); }
  }
  if (!healthy) {
    try { ops.stop(); stopped = true; } catch (error) { errors.push('停止异常服务失败：' + error.message); }
  }
  return { filesRestored, healthy, stopped, errors };
}

function updateHealthUrl() {
  const port = Number(process.env.AIQB_PORT || process.env.PORT || 3001);
  const raw = String(process.env.AIQB_UPDATE_HEALTH_URL || ('http://127.0.0.1:' + port + '/health/live')).trim();
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('AIQB_UPDATE_HEALTH_URL 格式无效'); }
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('更新健康检查仅允许本机 HTTP/HTTPS 地址');
  }
  return url.toString();
}

async function waitForHealthyVersion(expectedVersion, attempts) {
  const url = updateHealthUrl();
  let lastError = '';
  for (let index = 0; index < (attempts || 24); index++) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
      const body = response.ok ? await response.json() : null;
      if (body && body.ok === true && String(body.version) === String(expectedVersion)) return body;
      lastError = response.ok ? '版本或状态不匹配' : 'HTTP ' + response.status;
    } catch (error) { lastError = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('服务健康检查未通过：' + lastError);
}

async function main() {
  if (process.platform !== 'linux') throw new Error('在线更新只能在 Linux 服务器执行');
  const sourceId = option('--source');
  const expectedVersion = String(option('--version') || '').replace(/^v/, '');
  const expectedRevision = normalizeRevision(option('--revision'));
  const expectedKeyId = String(option('--key-id') || '').trim();
  if (!parseVersion(expectedVersion)) throw new Error('目标版本无效');
  if (!expectedRevision) throw new Error('目标提交标识无效');
  if (!/^[0-9a-f]{16}$/.test(expectedKeyId)) throw new Error('发布签名密钥标识无效');
  const appDir = assertSafeDirectory(option('--app-dir'), '应用');
  const dataDir = assertSafeDirectory(option('--data-dir'), '数据');
  const expectedDataDir = path.join(appDir, 'server', 'data');
  if (dataDir !== expectedDataDir && !process.env.AIQB_DATA_DIR) throw new Error('非默认数据目录必须由 AIQB_DATA_DIR 明确配置');
  assertDataDirectoryIsolation(appDir, dataDir);
  const updateDir = path.join(dataDir, 'updates');
  const stateFile = path.join(updateDir, 'state.json');
  const lockFile = path.join(updateDir, 'running.lock');
  const sources = sourcesFromEnv(process.env);
  const baseSource = sources[sourceId];
  if (!baseSource) throw new Error('未知更新源');
  const source = sourceForRevision(baseSource, expectedRevision);
  let fromVersion = 'unknown';
  try { fromVersion = String(JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version || 'unknown'); } catch (_) {}
  let state = { phase: 'queued', source: sourceId, fromVersion, toVersion: expectedVersion, revision: expectedRevision, startedAt: new Date().toISOString() };
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
    setState('downloading', '正在从 ' + source.name + ' 下载 v' + expectedVersion + '（提交 ' + expectedRevision.slice(0, 12) + '）');
    fs.mkdirSync(extractDir, { recursive: true });
    const bytes = await download(source.archiveUrl, archive, requestHeaders(source));
    inspectArchive(archive);
    run('tar', ['--no-same-owner', '--no-same-permissions', '-xzf', archive, '-C', extractDir]);
    const packageRoot = findPackageRoot(extractDir);
    if (!packageRoot) throw new Error('更新包目录结构不完整');
    const packageTree = assertSafePackageTree(packageRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.name !== 'aiqb' || String(manifest.version) !== expectedVersion) throw new Error('安装包版本与确认版本不一致');
    const signatureManifest = verifyReleaseManifest(readReleaseManifest(path.join(packageRoot, 'release-signature.json')), publicKeyFromEnv(process.env));
    if (signatureManifest.version !== expectedVersion || signatureManifest.keyId !== expectedKeyId) throw new Error('安装包发布签名与确认信息不一致');
    const signedPackage = verifyPackageFiles(packageRoot, signatureManifest);
    for (const required of ['server/server.js', 'server/lib', 'frontend', 'package.json', 'package-lock.json', 'ecosystem.config.js']) {
      if (!fs.existsSync(path.join(packageRoot, required))) throw new Error('更新包缺少必要文件：' + required);
    }

    setState('backing_up', '签名与逐文件校验通过，正在备份代码、数据库和完整运行数据', { archiveBytes: bytes, archiveSha256: sha256(archive), packageFiles: signedPackage.files, packageBytes: signedPackage.bytes, signatureKeyId: signedPackage.keyId, extractedFiles: packageTree.files, backupDir });
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o750 });
    const codeBackup = path.join(backupDir, 'code');
    for (const relative of COPY_TARGETS) {
      const existed = fs.existsSync(path.join(appDir, relative));
      previous.push({ relative, existed });
      if (existed) copyTarget(appDir, codeBackup, relative);
    }
    await backupDatabase(dataDir, backupDir);
    const dataArchive = path.join(backupDir, 'server-data.tar.gz');
    run('tar', ['-czf', dataArchive, '--exclude=' + path.basename(dataDir) + '/auth/initial-password.txt', '-C', path.dirname(dataDir), path.basename(dataDir)]);
    fs.writeFileSync(dataArchive + '.sha256', sha256(dataArchive) + '  server-data.tar.gz\n', { mode: 0o600 });

    setState('installing', '正在安装 v' + expectedVersion + '，运行数据保持原位');
    copied = true;
    for (const relative of COPY_TARGETS) copyTarget(packageRoot, appDir, relative);
    run('npm', ['ci', '--omit=dev'], { cwd: appDir, env: Object.assign({}, process.env, { npm_config_audit: 'false', npm_config_fund: 'false' }) });

    setState('restarting', '代码安装完成，正在平滑重载并验证服务');
    reloadServices(appDir);
    await waitForHealthyVersion(expectedVersion);
    setState('completed', '已成功更新到 v' + expectedVersion + '，服务健康检查通过', { completedAt: new Date().toISOString(), restartRequired: false, verifiedVersion: expectedVersion });
  } catch (error) {
    let rollbackError = '';
    if (copied) {
      const rollback = await rollbackInstallation({ appDir, backupDir, previous, fromVersion });
      rollbackError = rollback.errors.length ? '；' + rollback.errors.join('；') : '';
      if (!rollback.healthy && rollback.stopped) rollbackError += '；为防止拒绝的新版本继续运行，服务已停止，请人工恢复';
    }
    setState('failed', '更新失败：' + error.message + (copied ? (rollbackError || '；旧代码已恢复') : ''), { failedAt: new Date().toISOString(), rollbackError: rollbackError || null });
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(lockFile); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) main().catch((error) => {
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

module.exports = { COPY_TARGETS, assertSafeDirectory, assertDataDirectoryIsolation, validateArchiveListing, inspectArchive, assertSafePackageTree, updateHealthUrl, waitForHealthyVersion, rollbackInstallation };
