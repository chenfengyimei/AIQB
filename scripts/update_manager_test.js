'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { UpdateManager, compareVersions, decodeManifest, sourcesFromEnv, sourceForRevision, normalizeRevision, validateUpdateConfirmation } = require('../server/lib/update-manager');
const { canonicalPayload, keyIdFor } = require('../server/lib/release-signature');
const { assertDataDirectoryIsolation, updateHealthUrl, waitForHealthyVersion, rollbackInstallation } = require('./online_update');

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
  const revision = 'a'.repeat(40);
  check('更新地址固定到不可变提交而不是分支', () => {
    const sources = sourcesFromEnv({ AIQB_UPDATE_GITEE_TOKEN: 'secret' });
    const github = sourceForRevision(sources.github, revision);
    const gitee = sourceForRevision(sources.gitee, revision);
    assert.ok(github.manifestUrl.endsWith('ref=' + revision));
    assert.ok(github.archiveUrl.endsWith('/' + revision));
    assert.ok(gitee.archiveUrl.includes('ref=' + revision));
    assert.ok(gitee.signatureUrl.includes('release-signature.json'));
    assert.strictEqual(normalizeRevision('../master'), '');
  });

  check('安装确认同时绑定版本、提交与签名密钥', () => {
    const checked = { updateAvailable: true, latestVersion: '2.26.0', revision, signatureKeyId: '1234567890abcdef' };
    assert.strictEqual(validateUpdateConfirmation(checked, '2.26.0', revision, checked.signatureKeyId), revision);
    assert.throws(() => validateUpdateConfirmation(checked, '2.26.0', 'b'.repeat(40), checked.signatureKeyId));
    assert.throws(() => validateUpdateConfirmation(checked, '2.26.0', revision, 'fedcba0987654321'));
  });

  check('自定义数据目录不得与应用更新目录重叠', () => {
    const app = path.resolve(path.join(os.tmpdir(), 'aiqb-app'));
    assert.strictEqual(assertDataDirectoryIsolation(app, path.join(app, 'server', 'data')), path.join(app, 'server', 'data'));
    assert.throws(() => assertDataDirectoryIsolation(app, path.join(app, 'scripts', 'data')));
    assert.throws(() => assertDataDirectoryIsolation(path.join(app, 'nested'), app));
    assert.strictEqual(assertDataDirectoryIsolation(app, path.resolve(path.join(os.tmpdir(), 'aiqb-data'))), path.resolve(path.join(os.tmpdir(), 'aiqb-data')));
  });

  {
    let reloads = 0;
    let stops = 0;
    const rollback = await rollbackInstallation({ appDir: 'app', backupDir: 'backup', previous: [], fromVersion: '2.25.0' }, {
      install: () => { throw new Error('simulated npm failure'); },
      reload: () => { reloads++; },
      wait: async () => {},
      stop: () => { stops++; },
    });
    check('依赖恢复失败仍会重载并确认旧版本', () => {
      assert.strictEqual(reloads, 1);
      assert.strictEqual(stops, 0);
      assert.strictEqual(rollback.healthy, true);
      assert.ok(rollback.errors.some((item) => item.includes('依赖恢复失败')));
    });
  }

  {
    let stops = 0;
    const rollback = await rollbackInstallation({ appDir: 'app', backupDir: 'backup', previous: [], fromVersion: '2.25.0' }, {
      install: () => {},
      reload: () => { throw new Error('simulated reload failure'); },
      wait: async () => {},
      stop: () => { stops++; },
    });
    check('旧版本无法恢复时停止服务避免拒绝版本继续运行', () => {
      assert.strictEqual(rollback.healthy, false);
      assert.strictEqual(rollback.stopped, true);
      assert.strictEqual(stops, 1);
    });
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-update-test-'));
  try {
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const signed = { schema: 1, product: 'aiqb', version: '2.26.0', algorithm: 'Ed25519', keyId: keyIdFor(publicKey), files: [{ path: 'package.json', size: 1, sha256: '0'.repeat(64) }] };
    signed.signature = crypto.sign(null, Buffer.from(canonicalPayload(signed), 'utf8'), keys.privateKey).toString('base64');
    const manager = new UpdateManager({ dataDir: temp, appDir: path.join(__dirname, '..'), version: '2.25.0', env: { AIQB_UPDATE_PUBLIC_KEY: publicKey } });
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
    const requested = [];
    const mock = http.createServer((req, res) => {
      requested.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/commits/')) return res.end(JSON.stringify({ sha: revision }));
      if (req.url.startsWith('/contents/package.json')) return res.end(JSON.stringify({ name: 'aiqb', version: '2.26.0' }));
      if (req.url.startsWith('/contents/release-signature.json')) return res.end(JSON.stringify(signed));
      res.statusCode = 404; res.end('{}');
    });
    await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
    try {
      manager.sources.github.apiBase = 'http://127.0.0.1:' + mock.address().port;
      manager.sources.github.commitUrl = manager.sources.github.apiBase + '/commits/master';
      const checked = await manager.check('github');
      check('版本检查验证签名、固定提交并持久化结果', () => {
        assert.strictEqual(checked.updateAvailable, true);
        assert.strictEqual(checked.latestVersion, '2.26.0');
        assert.strictEqual(checked.revision, revision);
        assert.strictEqual(checked.signed, true);
        assert.strictEqual(checked.signatureKeyId, signed.keyId);
        assert.ok(requested.some((url) => url.includes('package.json?ref=' + revision)));
        assert.ok(requested.some((url) => url.includes('release-signature.json?ref=' + revision)));
        assert.strictEqual(manager.status().lastCheck.latestVersion, '2.26.0');
      });
    } finally { await new Promise((resolve) => mock.close(resolve)); }

    const health = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, status: 'alive', version: '2.26.0' }));
    });
    await new Promise((resolve) => health.listen(0, '127.0.0.1', resolve));
    const previousHealthUrl = process.env.AIQB_UPDATE_HEALTH_URL;
    try {
      process.env.AIQB_UPDATE_HEALTH_URL = 'http://127.0.0.1:' + health.address().port + '/health/live';
      const ready = await waitForHealthyVersion('2.26.0', 1);
      check('更新完成后只通过本机健康端点确认实际版本', () => assert.strictEqual(ready.version, '2.26.0'));
      process.env.AIQB_UPDATE_HEALTH_URL = 'https://example.com/health/live';
      check('健康检查拒绝外部地址', () => assert.throws(() => updateHealthUrl()));
    } finally {
      if (previousHealthUrl === undefined) delete process.env.AIQB_UPDATE_HEALTH_URL;
      else process.env.AIQB_UPDATE_HEALTH_URL = previousHealthUrl;
      await new Promise((resolve) => health.close(resolve));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('\nUpdate manager: ' + pass + ' PASS');
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
