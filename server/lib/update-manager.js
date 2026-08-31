'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const AUTHOR = 'chenfeng';
const DEFAULT_GITHUB_REPO = 'chenfengyimei/AIQB';
const DEFAULT_GITEE_REPO = 'chenfengloveyuri/aiqb';
const BILIBILI_URL = 'https://space.bilibili.com/508302628';
const LICENSE_URL = 'https://opensource.org/license/cpal-1.0';

function cleanRepo(value, fallback) {
  const repo = String(value || fallback || '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.includes('..') || repo.startsWith('.') || repo.includes('/.')) return fallback;
  return repo;
}

function cleanBranch(value) {
  const branch = String(value || 'master').trim();
  return /^[A-Za-z0-9._/-]{1,100}$/.test(branch) && !branch.includes('..') ? branch : 'master';
}

function sourcesFromEnv(env) {
  const vars = env || process.env;
  const branch = cleanBranch(vars.AIQB_UPDATE_BRANCH);
  const githubRepo = cleanRepo(vars.AIQB_UPDATE_GITHUB_REPO, DEFAULT_GITHUB_REPO);
  const giteeRepo = cleanRepo(vars.AIQB_UPDATE_GITEE_REPO, DEFAULT_GITEE_REPO);
  const githubToken = String(vars.AIQB_UPDATE_GITHUB_TOKEN || '').trim();
  const giteeToken = String(vars.AIQB_UPDATE_GITEE_TOKEN || '').trim();
  const githubApi = 'https://api.github.com/repos/' + githubRepo;
  const giteeApi = 'https://gitee.com/api/v5/repos/' + giteeRepo;
  return {
    github: {
      id: 'github', name: 'GitHub', repo: githubRepo, branch,
      repositoryUrl: 'https://github.com/' + githubRepo,
      manifestUrl: githubApi + '/contents/package.json?ref=' + encodeURIComponent(branch),
      archiveUrl: githubApi + '/tarball/' + encodeURIComponent(branch),
      token: githubToken,
    },
    gitee: {
      id: 'gitee', name: 'Gitee', repo: giteeRepo, branch,
      repositoryUrl: 'https://gitee.com/' + giteeRepo,
      manifestUrl: giteeApi + '/contents/package.json?ref=' + encodeURIComponent(branch) + (giteeToken ? '&access_token=' + encodeURIComponent(giteeToken) : ''),
      archiveUrl: giteeApi + '/tarball?ref=' + encodeURIComponent(branch) + (giteeToken ? '&access_token=' + encodeURIComponent(giteeToken) : ''),
      token: giteeToken,
    },
  };
}

function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    repositoryUrl: source.repositoryUrl,
    repo: source.repo,
    branch: source.branch,
    authenticated: !!source.token,
  };
}

function parseVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  return match ? { raw: match[0].replace(/^v/, ''), major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] || '' } : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw Object.assign(new Error('版本号必须符合 x.y.z 格式'), { statusCode: 422 });
  for (const key of ['major', 'minor', 'patch']) if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true }) > 0 ? 1 : -1;
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

async function readLimitedResponse(response, limit) {
  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (contentLength > limit) throw Object.assign(new Error('远端版本文件过大'), { statusCode: 502 });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > limit) throw Object.assign(new Error('远端版本文件过大'), { statusCode: 502 });
  return bytes.toString('utf8');
}

function decodeManifest(text) {
  let value;
  try { value = JSON.parse(text); } catch (_) { throw Object.assign(new Error('远端未返回有效的 package.json'), { statusCode: 502 }); }
  if (value && value.encoding === 'base64' && value.content) {
    try { value = JSON.parse(Buffer.from(String(value.content).replace(/\s/g, ''), 'base64').toString('utf8')); }
    catch (_) { throw Object.assign(new Error('远端 package.json 解码失败'), { statusCode: 502 }); }
  }
  if (!value || value.name !== 'aiqb' || !parseVersion(value.version)) {
    throw Object.assign(new Error('远端安装包不是有效的 AIQB 版本'), { statusCode: 502 });
  }
  return value;
}

function requestHeaders(source) {
  const headers = { 'user-agent': 'AIQB-Updater', accept: 'application/json' };
  if (source.id === 'github') {
    headers.accept = 'application/vnd.github+json';
    headers['x-github-api-version'] = '2022-11-28';
    if (source.token) headers.authorization = 'Bearer ' + source.token;
  }
  return headers;
}

class UpdateManager {
  constructor(options) {
    const opts = options || {};
    this.dataDir = path.resolve(opts.dataDir);
    this.appDir = path.resolve(opts.appDir || path.join(__dirname, '..', '..'));
    this.version = String(opts.version || '0.0.0');
    this.updateDir = path.join(this.dataDir, 'updates');
    this.stateFile = path.join(this.updateDir, 'state.json');
    this.lockFile = path.join(this.updateDir, 'running.lock');
    this.script = path.join(this.appDir, 'scripts', 'online_update.js');
    this.sources = sourcesFromEnv(opts.env);
    fs.mkdirSync(this.updateDir, { recursive: true, mode: 0o750 });
  }

  status() {
    const state = readJson(this.stateFile, { phase: 'idle', message: '尚未执行在线更新' });
    if (state.phase === 'queued' || state.phase === 'downloading' || state.phase === 'backing_up' || state.phase === 'installing' || state.phase === 'restarting') {
      const updated = new Date(state.updatedAt || state.startedAt || 0).getTime();
      if (updated && Date.now() - updated > 30 * 60 * 1000) {
        try { fs.unlinkSync(this.lockFile); } catch (_) {}
        state.phase = 'failed';
        state.message = '更新进程已中断，请检查服务器日志后重试';
        state.updatedAt = new Date().toISOString();
        try { atomicJson(this.stateFile, state); } catch (_) {}
      }
    }
    return state;
  }

  overview(extra) {
    const status = this.status();
    return {
      system: Object.assign({
        name: 'AIQB', version: this.version, author: AUTHOR,
        description: '可自托管的开源 AI 情报采集、去重、归档、展示与运营管理系统',
        githubUrl: 'https://github.com/' + DEFAULT_GITHUB_REPO,
        giteeUrl: 'https://gitee.com/' + DEFAULT_GITEE_REPO,
        bilibiliUrl: BILIBILI_URL,
        openSourceUrl: 'https://github.com/' + DEFAULT_GITHUB_REPO,
        license: { id: 'CPAL-1.0', name: 'Common Public Attribution License 1.0', url: LICENSE_URL },
      }, extra || {}),
      sources: Object.values(this.sources).map(publicSource),
      status,
      supported: process.platform === 'linux' && fs.existsSync(this.script),
      safeguards: ['仅允许预设 GitHub/Gitee 仓库', '远端版本与安装包双重校验', '更新前备份完整运行数据与代码', '永不覆盖 server/data', '失败自动恢复旧代码'],
    };
  }

  source(id) {
    const source = this.sources[String(id || '').toLowerCase()];
    if (!source) throw Object.assign(new Error('更新源仅支持 github 或 gitee'), { statusCode: 400 });
    return source;
  }

  async check(id) {
    const source = this.source(id);
    let response;
    try {
      response = await fetch(source.manifestUrl, { headers: requestHeaders(source), redirect: 'follow', signal: AbortSignal.timeout(12000) });
    } catch (error) {
      throw Object.assign(new Error('无法连接 ' + source.name + '：' + (error.name === 'TimeoutError' ? '请求超时' : error.message)), { statusCode: 502 });
    }
    if (!response.ok) {
      const privateHint = response.status === 401 || response.status === 403 || response.status === 404;
      throw Object.assign(new Error(source.name + ' 版本检查失败（HTTP ' + response.status + '）' + (privateHint ? '，仓库若为私有请配置只读访问令牌' : '')), { statusCode: 502 });
    }
    const manifest = decodeManifest(await readLimitedResponse(response, 256 * 1024));
    const result = {
      source: source.id,
      sourceName: source.name,
      checkedAt: new Date().toISOString(),
      currentVersion: this.version,
      latestVersion: manifest.version,
      updateAvailable: compareVersions(manifest.version, this.version) > 0,
      repositoryUrl: source.repositoryUrl,
      branch: source.branch,
    };
    const state = this.status();
    state.lastCheck = result;
    state.updatedAt = new Date().toISOString();
    atomicJson(this.stateFile, state);
    return result;
  }

  async start(id, expectedVersion) {
    if (process.platform !== 'linux') throw Object.assign(new Error('在线安装仅支持 Linux 生产服务器；当前环境可检查版本但不能覆盖本机代码'), { statusCode: 409 });
    if (!fs.existsSync(this.script)) throw Object.assign(new Error('在线更新脚本缺失，请先用部署包升级一次'), { statusCode: 409 });
    const checked = await this.check(id);
    if (!checked.updateAvailable) throw Object.assign(new Error('当前已经是最新版'), { statusCode: 409 });
    if (String(expectedVersion || '') !== checked.latestVersion) throw Object.assign(new Error('确认版本与最新版本不一致，请重新检查'), { statusCode: 409 });
    fs.mkdirSync(this.updateDir, { recursive: true, mode: 0o750 });
    let lock;
    try { lock = fs.openSync(this.lockFile, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try { stale = Date.now() - fs.statSync(this.lockFile).mtimeMs > 30 * 60 * 1000; } catch (_) {}
      if (!stale) throw Object.assign(new Error('已有更新任务正在运行'), { statusCode: 409 });
      try { fs.unlinkSync(this.lockFile); } catch (_) {}
      try { lock = fs.openSync(this.lockFile, 'wx', 0o600); }
      catch (_) { throw Object.assign(new Error('已有更新任务正在运行'), { statusCode: 409 }); }
    }
    fs.writeFileSync(lock, JSON.stringify({ owner: process.pid, source: checked.source, version: checked.latestVersion, createdAt: new Date().toISOString() }) + '\n');
    fs.closeSync(lock);
    const state = {
      phase: 'queued', source: checked.source, fromVersion: this.version, toVersion: checked.latestVersion,
      message: '更新任务已进入队列', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    atomicJson(this.stateFile, state);
    try {
      const child = spawn(process.execPath, [this.script, '--source', checked.source, '--version', checked.latestVersion, '--app-dir', this.appDir, '--data-dir', this.dataDir], {
        cwd: this.appDir,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return { accepted: true, pid: child.pid, status: state };
    } catch (error) {
      try { fs.unlinkSync(this.lockFile); } catch (_) {}
      atomicJson(this.stateFile, Object.assign(state, { phase: 'failed', message: '无法启动更新进程：' + error.message, updatedAt: new Date().toISOString() }));
      throw Object.assign(error, { statusCode: 500 });
    }
  }
}

module.exports = { UpdateManager, AUTHOR, sourcesFromEnv, publicSource, parseVersion, compareVersions, decodeManifest, atomicJson, requestHeaders };
