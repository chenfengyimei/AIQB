'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initialize } = require('./setup');
const { EndpointRegistry } = require('../server/lib/endpoint-registry');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-setup-'));
try {
  const first = initialize({ dataDir: root, siteUrl: 'https://ai.example.com', siteName: '我的 AI 站' });
  assert.strictEqual(first.changed, true);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.strictEqual(config.seoSiteUrl, 'https://ai.example.com');
  assert.strictEqual(config.seoShortTitle, '我的 AI 站');
  assert.strictEqual(config.footerIcpNumber, '');

  const registry = new EndpointRegistry(root);
  registry.init();
  const listed = registry.list();
  assert.strictEqual(listed.preset, 'community');
  assert.strictEqual(listed.items.length, 1);
  assert.strictEqual(listed.items[0].id, 'aiqbRss');
  assert.strictEqual(listed.items[0].url, 'https://chenqiyuan.cn/rss.xml');
  assert.strictEqual(listed.items[0].enabled, true);
  assert.strictEqual(registry.collectorConfig().items7d.enabled, false);

  registry.create({ name: '测试 RSS', url: 'https://example.com/rss.xml', format: 'rss', enabled: false });
  const second = initialize({ dataDir: root, siteUrl: 'https://changed.example.com', siteName: '被覆盖' });
  assert.strictEqual(second.preserved, true);
  const after = new EndpointRegistry(root);
  after.init();
  assert.strictEqual(after.list().items.length, 2);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).seoSiteUrl, 'https://ai.example.com');

  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-legacy-'));
  fs.mkdirSync(path.join(legacy, 'endpoints'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'endpoints', 'config.json'), JSON.stringify({ version: 2, overrides: {}, custom: [] }));
  const legacyRegistry = new EndpointRegistry(legacy);
  legacyRegistry.init();
  assert.strictEqual(legacyRegistry.list().preset, 'full');
  assert.ok(legacyRegistry.list().items.length >= 13);
  fs.rmSync(legacy, { recursive: true, force: true });

  console.log('RESULT PASS=14 FAIL=0');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
