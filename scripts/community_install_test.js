'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-community-install-'));
const port = 4100 + Math.floor(Math.random() * 500);
const base = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, [path.join(root, 'server', 'server.js')], {
  cwd: root,
  env: Object.assign({}, process.env, {
    AIQB_DATA_DIR: dataDir,
    AIQB_PORT: String(port),
    AIQB_HOST: '127.0.0.1',
    AIQB_ENDPOINT_PRESET: 'community',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function json(url) {
  const response = await fetch(base + url);
  const body = await response.text();
  if (!response.ok) throw new Error(url + ' HTTP ' + response.status + ': ' + body.slice(0, 200));
  return JSON.parse(body);
}

async function main() {
  let ready = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      ready = await json('/health/ready');
      if (ready.status === 'ready') break;
    } catch (error) {}
  }
  if (!ready || ready.status !== 'ready') throw new Error('60 秒内未完成首次 RSS 采集\n' + logs.slice(-3000));
  const history = await json('/api/history?range=7d&size=1');
  const endpointConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'endpoints', 'config.json'), 'utf8'));
  if (endpointConfig.preset !== 'community') throw new Error('接口预设不是 community');
  if (!history.total || !history.items[0]) throw new Error('AI圈报 RSS 没有生成公开情报');
  const source = history.items[0].source && history.items[0].source.name;
  console.log('PASS 全新 community 安装完成首次采集');
  console.log('PASS 默认接口仅为 AI圈报 RSS');
  console.log('PASS RSS 情报已保存并进入历史接口：' + history.total + ' 条，来源 ' + source);
}

main().catch((error) => { console.error('FAIL ' + error.message); process.exitCode = 1; }).finally(async () => {
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
  if (!child.killed) child.kill('SIGKILL');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
