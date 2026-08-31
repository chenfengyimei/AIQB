'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { UpdateManager, compareVersions, decodeManifest, sourcesFromEnv } = require('../server/lib/update-manager');

async function main() {
  let pass = 0;
  function check(name, fn) {
    fn(); pass++; console.log('  ✓ ' + name);
  }

  check('语义版本比较正确', () => {
    assert.strictEqual(compareVersions('2.24.0', '2.23.9'), 1);
    assert.strictEqual(compareVersions('v2.24.0', '2.24.0'), 0);
    assert.strictEqual(compareVersions('2.24.0-beta.1', '2.24.0'), -1);
  });
  check('安装包清单只接受 AIQB 与规范版本', () => {
    assert.strictEqual(decodeManifest(JSON.stringify({ name: 'aiqb', version: '3.0.0' })).version, '3.0.0');
    assert.throws(() => decodeManifest(JSON.stringify({ name: 'other', version: '3.0.0' })));
  });
  check('GitHub/Gitee 仓库地址固定为 HTTPS 允许源', () => {
    const sources = sourcesFromEnv({ AIQB_UPDATE_GITHUB_REPO: '../bad', AIQB_UPDATE_GITEE_REPO: 'owner/repo', AIQB_UPDATE_BRANCH: '../../bad' });
    assert.strictEqual(sources.github.repo, 'chenfengyimei/AIQB');
    assert.strictEqual(sources.gitee.repositoryUrl, 'https://gitee.com/owner/repo');
    assert.strictEqual(sources.github.branch, 'master');
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-update-test-'));
  try {
    const manager = new UpdateManager({ dataDir: temp, appDir: path.join(__dirname, '..'), version: '2.25.0', env: {} });
    const overview = manager.overview({ test: true });
    check('系统信息包含版本、作者、开源链接与双更新源', () => {
      assert.strictEqual(overview.system.version, '2.25.0');
      assert.strictEqual(overview.system.author, 'chenfeng');
      assert.strictEqual(overview.system.githubUrl, 'https://github.com/chenfengyimei/AIQB');
      assert.strictEqual(overview.system.giteeUrl, 'https://gitee.com/chenfengloveyuri/aiqb');
      assert.strictEqual(overview.system.bilibiliUrl, 'https://space.bilibili.com/508302628');
      assert.strictEqual(overview.system.license.id, 'CPAL-1.0');
      assert.deepStrictEqual(overview.sources.map((s) => s.id).sort(), ['gitee', 'github']);
      assert.ok(!JSON.stringify(overview).includes('token'));
    });
    check('Windows 环境禁止直接覆盖代码', () => {
      if (process.platform === 'win32') assert.strictEqual(overview.supported, false);
    });
    const mock = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'aiqb', version: '2.26.0' }));
    });
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
    try {
      manager.sources.github.manifestUrl = 'http://127.0.0.1:' + mock.address().port + '/package.json';
      const checked = await manager.check('github');
      check('版本检查识别新版本并持久化最近检查结果', () => {
        assert.strictEqual(checked.updateAvailable, true);
        assert.strictEqual(checked.latestVersion, '2.26.0');
        assert.strictEqual(manager.status().lastCheck.latestVersion, '2.26.0');
      });
    } finally { await new Promise((resolve) => mock.close(resolve)); }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('\nUpdate manager: ' + pass + ' PASS');
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
