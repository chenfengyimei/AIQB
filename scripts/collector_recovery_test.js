'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateDatabase } = require('../server/lib/state-db');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-collector-recovery-'));
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = 'http://127.0.0.1:' + PORT;
let pass = 0;
let fail = 0;

function check(name, condition, detail) {
  if (condition) { pass++; console.log('PASS ' + name); }
  else { fail++; console.error('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(BASE + '/health/ready');
      if (response.ok) {
        const body = await response.json();
        if (predicate(body)) return body;
      }
    } catch (_) {}
    await sleep(250);
  }
  return null;
}

async function main() {
  const seed = new StateDatabase(DATA_DIR).init();
  check('可预置模拟崩溃遗留的采集锁', seed.acquireLock('collect', 'dead-worker', 1000) === true);
  seed.close();

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      AIQB_DATA_DIR: DATA_DIR,
      AIQB_PORT: String(PORT),
      AIQB_HOST: '127.0.0.1',
      AIQB_ROLE: 'collector',
      AIQB_ENDPOINT_PRESET: 'community',
      AIQB_INITIAL_ADMIN_PASSWORD: 'Collector-Test-Password-2026',
      AIQB_COLLECT_BUSY_RETRY_MS: '500',
      AIQB_COLLECT_HEARTBEAT_MS: '1000',
      AIQB_COLLECT_LOCK_TTL_MS: '1500',
      AIQB_COLLECT_LOCK_RENEW_MS: '500',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  try {
    const ready = await waitFor((body) => body.fetchedAt && body.intelligence > 0, 15000);
    check('启动遇到旧锁后会短间隔自动重试并完成采集', !!ready, logs.slice(-800));
    check('恢复后公开数据和默认 RSS 接口均正常', !!(ready && ready.items7d > 0 && ready.endpoints.total === 1 && ready.endpoints.healthy === 1));

    const inspect = new StateDatabase(DATA_DIR).init();
    const runtime = inspect.getJSON('runtime', 'collect');
    check('采集器持续写入心跳、所有者和下次运行时间', !!(runtime && runtime.heartbeatAt && runtime.owner && runtime.busy === false && runtime.nextCollectAt > Date.now()));
    inspect.close();
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(5000),
    ]);
  }

  await sleep(1800);
  const finalDb = new StateDatabase(DATA_DIR).init();
  const finalRuntime = finalDb.getJSON('runtime', 'collect');
  const recoveredLock = finalDb.acquireLock('collect', 'replacement-worker', 1000);
  check('进程异常退出后锁会在短租约到期后自动恢复', recoveredLock === true && finalRuntime && finalRuntime.busy === false);
  if (recoveredLock) finalDb.releaseLock('collect', 'replacement-worker');
  finalDb.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (_) {}
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  if (fail) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
