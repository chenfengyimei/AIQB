'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EndpointRegistry, parseFeed, parseJson } = require('../server/lib/endpoint-registry');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-endpoints-'));
let pass = 0, fail = 0;
function check(name, condition) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  if (condition) pass++; else fail++;
}

try {
  const starter = new EndpointRegistry(dir);
  starter.init();
  check('全新安装仅预置 AI圈报 RSS', starter.list().preset === 'community' && starter.list().items.length === 1 && starter.get('aiqbRss').enabled === true);
  check('社区预设不会隐藏调用未登记的 上游 主接口', starter.collectorConfig().items7d.enabled === false && starter.collectorConfig().hotTopics.enabled === false);
  const registry = new EndpointRegistry(dir, { preset: 'full' });
  registry.init();
  const initial = registry.list();
  check('登记 13 个多源采集配置', initial.summary.total === 13 && initial.items.length === 13 && initial.summary.source === 3);
  check('默认启用 13 个接口（含 2 个同步接口、全量池与 AI Insight）', initial.summary.enabled === 13 && initial.summary.sync === 2);
  const aiInsight = registry.get('aiInsightRss');
  check('AI Insight RSS 默认启用并自动分类发布', aiInsight.enabled === true && aiInsight.format === 'rss' && aiInsight.category === 'auto' && aiInsight.publishMode === 'published' && aiInsight.maxItems === 30);
  check('arXiv 与 DEV 默认直接发布但层级为普通', registry.get('arxivAi').publishMode === 'published' && registry.get('arxivAi').selected === false && registry.get('devCommunityAi').publishMode === 'published' && registry.get('devCommunityAi').selected === false);
  check('全量情报池接口默认启用', registry.get('itemsAll7d').enabled === true && /mode=all&window=7d/.test(registry.get('itemsAll7d').url));
  check('完整同步接口默认启用且无授权锁', registry.get('selectedSnapshot').enabled === true && registry.get('selectedChanges').enabled === true && registry.get('selectedSnapshot').authorizationRequired === undefined);
  check('同步接口 URL 指向全量参数', /fields=default&limit=1000$/.test(registry.get('selectedSnapshot').url) && /limit=100&cursor=\{cursor\}$/.test(registry.get('selectedChanges').url));
  const disabled = registry.update('selectedSnapshot', { enabled: false });
  check('同步接口可安全停用再开启', disabled.enabled === false && registry.update('selectedSnapshot', { enabled: true }).enabled === true);

  const updated = registry.update('items7d', { name: '七日精选主接口', timeoutMs: 45000, retries: 3, enabled: true });
  check('接口名称、超时与重试可编辑', updated.name === '七日精选主接口' && updated.timeoutMs === 45000 && updated.retries === 3);
  let blocked = false;
  try { registry.update('items7d', { url: 'http://127.0.0.1/private' }); } catch (error) { blocked = true; }
  check('非官方地址被 SSRF 白名单拦截', blocked);

  const custom = registry.create({ name: '测试 JSON 信源', url: 'https://example.com/feed.json', format: 'json', sourceName: 'Example', category: 'tutorial', enabled: false, itemsPath: 'data.items', titlePath: 'headline', summaryPath: 'abstract', urlPath: 'link', datePath: 'date' });
  check('可创建教程分类且默认安全关闭、直发并按普通层级入库', custom.custom === true && custom.enabled === false && custom.category === 'tutorial' && custom.publishMode === 'published' && custom.selected === false && registry.list().summary.total === 14);
  const parsedJson = parseJson({ data: { items: [{ headline: 'AI Update', abstract: 'Summary', link: 'https://example.com/a', date: '2026-08-29' }] } }, custom);
  check('JSON 点路径映射可解析', parsedJson.length === 1 && parsedJson[0].title === 'AI Update');
  const parsedAtom = parseFeed('<feed><entry><title>Paper</title><id>https://arxiv.org/abs/1</id><summary>Abstract</summary><link href="https://arxiv.org/abs/1"/><published>2026-08-29T00:00:00Z</published></entry></feed>', { format: 'atom', maxItems: 20 });
  check('Atom 标准条目可解析', parsedAtom.length === 1 && parsedAtom[0].title === 'Paper');
  const parsedRss = parseFeed('<rss><channel><item><title>Model update</title><guid>https://ai-insight.org/news/demo</guid><link>https://x.com/demo/status/1</link><description>Summary</description><pubDate>Sun, 30 Aug 2026 00:00:00 GMT</pubDate><category>大模型</category><author>hello@example.com (@demo)</author></item></channel></rss>', { format: 'rss', maxItems: 30 });
  check('RSS 分类、作者与来源 GUID 可解析', parsedRss.length === 1 && parsedRss[0].category === '大模型' && parsedRss[0].author.includes('@demo') && /ai-insight/.test(parsedRss[0].id));
  let privateBlocked = false;
  try { registry.create({ name: '内网接口', url: 'https://127.0.0.1/feed', format: 'rss' }); } catch (error) { privateBlocked = /内网|保留/.test(error.message); }
  check('自定义接口阻止内网地址', privateBlocked);
  check('自定义接口可安全删除', registry.remove(custom.id) === true && registry.list().summary.total === 13);

  registry.recordRun([{ id: 'items7d', status: 'ok', httpStatus: 200, durationMs: 123, count: 62, bytes: 2048, etag: 'W/"test"', cacheControl: 'public, s-maxage=60' }], 'unit-test', { items7d: { count: 62, items: [{ id: 'sample', title: '示例' }] } });
  const detail = registry.get('items7d');
  check('接口状态与累计指标持久化', detail.state.attempts === 1 && detail.state.successes === 1 && detail.state.lastCount === 62);
  check('接口响应预览与日志可查看', detail.cached && detail.cached.data.count === 62 && detail.logs.length === 1);
  registry.recordRun([{ id: 'dailyArchive', status: 'ok', httpStatus: 200, durationMs: 88, count: 1 }], 'unit-test', { dailyArchive: [{ date: '2026-08-29', leadTitle: '日报' }] });
  check('指定日期日报从归档索引解析真实日期', /\/dailies\/2026-08-29$/.test(registry._resolveProbeUrl(registry.byId.get('dailyByDate'), {})));

  const reloaded = new EndpointRegistry(dir, { preset: 'full' });
  reloaded.init();
  check('接口配置和日志可跨重启恢复', reloaded.get('items7d').name === '七日精选主接口' && reloaded.get('items7d').state.lastEtag === 'W/"test"');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {}
}

console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
