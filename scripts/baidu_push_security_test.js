'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (!condition && detail ? ' :: ' + detail : ''));
  if (condition) pass++; else fail++;
}

function runCase(apiUrl) {
  const modulePath = path.join(__dirname, 'baidu-push.js');
  const source = [
    "let calls = 0;",
    "global.fetch = async (url) => { calls++; const parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.hostname !== 'data.zz.baidu.com') throw new Error('insecure transport'); return { status: 200, json: async () => ({ success: 1, remain: 99 }) }; };",
    `const mod = require(${JSON.stringify(modulePath)});`,
    "mod.submitToBaidu('https://chenqiyuan.cn/article/security-test').then((result) => process.stdout.write(JSON.stringify({ result, calls }))).catch((error) => { process.stderr.write(error.stack); process.exit(2); });",
  ].join('\n');
  const env = Object.assign({}, process.env, { BAIDU_PUSH_TOKEN: 'test-token-never-log' });
  if (apiUrl === null) delete env.BAIDU_API_URL;
  else env.BAIDU_API_URL = apiUrl;
  const child = spawnSync(process.execPath, ['-e', source], { env, encoding: 'utf8' });
  if (child.status !== 0) return { error: child.stderr || child.stdout, status: child.status };
  try { return JSON.parse(child.stdout); } catch (error) { return { error: child.stdout, status: child.status }; }
}

const disabled = runCase(null);
check('未配置 HTTPS 接口时默认停用且不发请求', disabled.calls === 0 && disabled.result && disabled.result.stop === true, JSON.stringify(disabled));

const http = runCase('http://data.zz.baidu.com/urls');
check('明文 HTTP 百度接口被拒绝且不发请求', http.calls === 0 && http.result && http.result.stop === true, JSON.stringify(http));

const wrongHost = runCase('https://example.com/urls');
check('非官方 HTTPS 主机被拒绝且不发请求', wrongHost.calls === 0 && wrongHost.result && wrongHost.result.stop === true, JSON.stringify(wrongHost));

const secure = runCase('https://data.zz.baidu.com/urls');
check('证书有效的官方 HTTPS 地址可提交', secure.calls === 1 && secure.result && secure.result.status === 'success', JSON.stringify(secure));

console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
