'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../server/lib/store');
const { IntelligenceStore } = require('../server/lib/intelligence-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-intel-test-'));
let pass = 0, fail = 0;
function check(name, condition) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  if (condition) pass++; else fail++;
}
function snapshot(at) {
  const item = { id: 'source-1', title: '同一条情报', summary: '原始摘要', source: { name: '测试源' }, links: { original: 'https://example.com/story?utm_source=test' }, category: 'industry', publishedAt: '2026-08-29T00:00:00Z' };
  return { fetchedAt: at, window7d: [item, Object.assign({}, item)], window24h: [item], hot: [], daily: null };
}

try {
  const history = new Store(dir, null);
  history.init();
  const first = history.saveSuccess(snapshot('2026-08-29T01:00:00Z'));
  const second = history.saveSuccess(snapshot('2026-08-29T02:00:00Z'));
  check('快照内容相同但 fetchedAt 不同仍会去重复用', second.sameAs === first.id);
  check('重复快照只保存一个物理文件', history.usage().files === 1);
  history.del(first.id);
  check('删除被引用的原始快照会迁移文件且引用仍可读取', !!(history.get(second.id) && history.get(second.id).data.window7d.length));

  const intel = new IntelligenceStore(dir);
  intel.init();
  const ingest1 = intel.ingestSnapshot(snapshot('2026-08-29T01:00:00Z'), { trigger: 'test' });
  check('同批跨窗口重复条目合并为一条', ingest1.received === 3 && ingest1.unique === 1 && ingest1.duplicatesInBatch === 2);
  check('首次采集只新增一条情报', ingest1.added === 1 && intel.stats().active === 1);
  const id = intel.list({ status: 'active' }).items[0].id;
  check('缺少精选字段的普通采集默认按普通情报保存', intel.getPublic(id).selected === false);
  intel.update(id, { title: '人工标题', summary: '人工摘要' });
  intel.ingestSnapshot(snapshot('2026-08-29T03:00:00Z'), { trigger: 'test-2' });
  check('后续采集不会覆盖人工编辑', intel.get(id).title === '人工标题' && intel.get(id).summary === '人工摘要');
  const publicHistory = intel.publicList({ range: 'all', page: 1, size: 20, q: '人工标题', category: 'industry' });
  check('公开历史库支持范围、搜索、分类与分页', publicHistory.total === 1 && publicHistory.items[0]._intelId === id && publicHistory.page === 1 && publicHistory.pages === 1);
  check('公开历史库返回分类与信源统计', publicHistory.facets.industry === 1 && publicHistory.sourceCount === 1 && !!publicHistory.dataRevision);
  check('单条公开情报可从持久化数据库读取', intel.getPublic(id)._intelId === id && intel.publicItems().length === 1);

  const privacyDir = path.join(dir, 'private-upstream-case');
  const previousUpstream = process.env.AIQB_UPSTREAM_BASE_URL;
  process.env.AIQB_UPSTREAM_BASE_URL = 'https://private-aggregator.example';
  const privacyStore = new IntelligenceStore(privacyDir);
  privacyStore.init();
  privacyStore.ingestItems([{
    id: 'private-attribution', title: '公开输出中间链路隐藏测试', source: { name: '原始作者' },
    links: { original: 'https://publisher.example/article', upstream: 'https://private-aggregator.example/items/1' },
    attribution: { name: '中间聚合服务', url: 'https://private-aggregator.example/items/1' },
    category: 'industry', selected: true,
  }], { trigger: 'privacy-test', sourceKind: 'sync' });
  const privacyItem = privacyStore.publicItems()[0];
  check('公开输出隐藏私有聚合链路但保留原文链接', privacyItem.links.original === 'https://publisher.example/article' && !privacyItem.links.upstream && !privacyItem.attribution);
  const privacySnapshot = privacyStore.applyToSnapshot({
    fetchedAt: new Date().toISOString(), window7d: [], window24h: [], hot: [],
    daily: { report: { links: { intermediate: 'https://private-aggregator.example/daily/today' }, attribution: { name: '中间聚合服务', url: 'https://private-aggregator.example/daily/today' }, sections: [] } },
  });
  check('公开日报隐藏私有聚合元数据', !privacySnapshot.daily.report.links.intermediate && !privacySnapshot.daily.report.attribution);
  if (previousUpstream === undefined) delete process.env.AIQB_UPSTREAM_BASE_URL;
  else process.env.AIQB_UPSTREAM_BASE_URL = previousUpstream;

  const tierDir = path.join(dir, 'tier-case');
  const tierStore = new IntelligenceStore(tierDir);
  tierStore.init();
  const selectedTutorial = { id: 'tutorial-1', title: '从零部署 Qwen：安装配置完整教程', summary: '首先安装依赖，然后配置环境变量并运行命令。', source: { name: '教程源' }, links: { original: 'https://example.com/tutorial' }, category: 'tip', selected: true, publishedAt: new Date().toISOString() };
  const ordinaryOpinion = { id: 'opinion-1', title: '关于 AI 产品未来形态的观点', summary: '作者认为交互体验将成为重点。', source: { name: '观点源' }, links: { original: 'https://example.com/opinion' }, category: 'tip', selected: false, publishedAt: new Date().toISOString() };
  const hotOnly = { id: 'hot-only', title: '只属于热点的记录', source: { name: '热点源' }, links: { original: 'https://example.com/hot-only' }, category: 'industry', selected: false, publishedAt: new Date().toISOString() };
  tierStore.ingestSnapshot({ fetchedAt: new Date().toISOString(), window7d: [selectedTutorial, ordinaryOpinion], window24h: [], hot: [hotOnly], daily: null }, { trigger: 'tier-test' });
  const allTier = tierStore.publicList({ range: '24h', tier: 'all', size: 20 });
  const selectedTier = tierStore.publicList({ range: '24h', tier: 'selected', size: 20 });
  const ordinaryTier = tierStore.publicList({ range: '24h', tier: 'ordinary', size: 20 });
  check('全部严格等于精选加普通且排除仅热点记录', allTier.total === 2 && allTier.tierCounts.all === allTier.tierCounts.selected + allTier.tierCounts.ordinary && !allTier.items.some((item) => item.title === hotOnly.title));
  check('tier 精选与普通过滤精确', selectedTier.total === 1 && ordinaryTier.total === 1 && selectedTier.items[0].selected !== false && ordinaryTier.items[0].selected === false);
  check('教程规则识别中英文步骤型内容并保留观点', selectedTier.items[0].category === 'tutorial' && ordinaryTier.items[0].category === 'tip');
  const tutorialId = selectedTier.items[0]._intelId;
  tierStore.update(tutorialId, { category: 'tip' });
  tierStore.ingestItems([selectedTutorial], { trigger: 'manual-priority' });
  check('人工分类覆盖优先且后续采集不覆盖', tierStore.getPublic(tutorialId).category === 'tip');
  const selectedDefault = { id: 'selected-endpoint-default', title: '精选接口缺少字段仍按接口语义处理', summary: '仅用于测试明确精选接口的默认层级。', source: { name: '上游精选' }, links: { original: 'https://example.com/selected-default' }, category: 'industry', publishedAt: new Date().toISOString() };
  tierStore.ingestItems([selectedDefault], { trigger: 'selected-endpoint', sourceKind: 'sync', defaultSelected: true });
  check('明确精选接口可在字段缺失时使用精选默认值', tierStore.publicList({ range: 'all', q: '精选接口缺少字段', size: 20 }).items[0].selected === true);
  const directCollected = { id: 'direct-collected', title: 'DEV 直采来源不继承精选默认值', source: { name: 'DEV Community' }, links: { original: 'https://dev.to/example/direct-collected' }, category: 'tutorial', selected: true, _src: 'C', publishedAt: new Date().toISOString() };
  tierStore.ingestItems([directCollected], { trigger: 'selected-window-fallback', sourceKind: 'collected', defaultSelected: true });
  check('带直采标识的条目即使经过精选窗口仍保持普通', tierStore.publicList({ range: 'all', q: 'DEV 直采来源', size: 20 }).items[0].selected === false);
  const externalItem = { id: 'external-tier', title: '外部信源层级测试', summary: '外部 RSS 或 JSON 未提供精选口径。', source: { name: 'DEV Community' }, links: { original: 'https://example.com/external-tier' }, category: 'tutorial', selected: true, publishedAt: new Date().toISOString() };
  tierStore.ingestItems([externalItem], { trigger: 'legacy-external', sourceKind: 'custom' });
  const externalMigration = tierStore.migrateExternalTiers();
  check('历史外部信源误标精选可迁移为普通', externalMigration.downgraded === 1 && tierStore.publicList({ range: 'all', q: '外部信源层级测试', size: 20 }).items[0].selected === false);
  tierStore.ingestItems([Object.assign({}, externalItem, { selected: true })], { trigger: 'upstream-selected', sourceKind: 'sync' });
  tierStore.ingestItems([Object.assign({}, externalItem, { selected: false })], { trigger: 'external-retry', sourceKind: 'custom' });
  check('上游 明确层级优先且不会被外部信源反向覆盖', tierStore.publicList({ range: 'all', q: '外部信源层级测试', size: 20 }).items[0].selected === true);
  tierStore.update(tutorialId, { status: 'archived' });
  tierStore.ingestItems([selectedTutorial], { trigger: 'manual-status-priority' });
  check('人工归档状态不会被后续采集自动改回发布', tierStore.get(tutorialId).status === 'archived');
  tierStore.update(tutorialId, { status: 'published' });
  const draftOne = tierStore.create({ title: '批量草稿一', summary: '等待发布', category: 'tip', status: 'draft', originalUrl: 'https://example.com/draft-one' });
  const draftTwo = tierStore.create({ title: '批量草稿二', summary: '等待发布', category: 'tip', status: 'draft', originalUrl: 'https://example.com/draft-two' });
  const bulkOne = tierStore.bulkUpdate({ action: 'publish', ids: [draftOne.id] });
  const bulkRest = tierStore.bulkUpdate({ action: 'publish', allMatching: true, status: 'draft' });
  check('批量操作支持选中发布和按明确状态发布全部草稿', bulkOne.changed === 1 && bulkRest.changed === 1 && tierStore.get(draftOne.id).status === 'published' && tierStore.get(draftTwo.id).status === 'published');
  const bulkDelete = tierStore.bulkUpdate({ action: 'delete', ids: [draftOne.id, draftTwo.id] });
  const bulkRestore = tierStore.bulkUpdate({ action: 'restore', ids: [draftOne.id, draftTwo.id] });
  check('批量删除与恢复发布可一次落盘', bulkDelete.changed === 2 && bulkRestore.changed === 2 && tierStore.get(draftOne.id).status === 'published');
  const missingCategoryModel = { id: 'missing-category-model', title: '腾讯发布 Hy4 Preview 770B 开源大模型', summary: '新模型支持 1M 上下文窗口与推理配置。', source: { name: '模型资讯源' }, links: { original: 'https://example.com/missing-model' }, selected: false, publishedAt: new Date().toISOString() };
  tierStore.ingestItems([missingCategoryModel], { trigger: 'missing-category' });
  const inferredModel = tierStore.publicList({ range: 'all', q: 'Hy4 Preview', size: 20 }).items[0];
  check('新采集的空分类内容会自动归入六个正式分类', inferredModel && inferredModel.category === 'ai-models');
  tierStore.byId.get(inferredModel._intelId).base.category = null;
  tierStore.byId.get(tutorialId).base.category = null;
  const missingMigration = tierStore.migrateMissingCategories();
  check('历史空分类迁移可补齐分类并跳过人工覆盖', missingMigration.scanned === 2 && missingMigration.migrated === 1 && missingMigration.manualSkipped === 1 && tierStore.getPublic(inferredModel._intelId).category === 'ai-models' && tierStore.getPublic(tutorialId).category === 'tip');
  const aliasItem = { id: 'changed-upstream-id', title: '同一条情报', summary: '更完整的原始摘要', source: { name: '测试源' }, links: { original: 'https://www.example.com/story?fbclid=tracking', upstream: 'https://upstream.invalid/items/upstream-id' }, category: 'industry' };
  const aliasRun = intel.ingestSnapshot({ fetchedAt: '2026-08-29T03:30:00Z', window7d: [aliasItem], window24h: [], hot: [], daily: null }, { trigger: 'alias-test' });
  check('上游 ID 改变但规范化原文链接一致时仍合并', aliasRun.added === 0 && intel.stats().active === 1);
  intel.remove(id);
  intel.ingestSnapshot(snapshot('2026-08-29T04:00:00Z'), { trigger: 'test-3' });
  check('后续采集不会自动恢复已删除情报', intel.get(id).status === 'deleted');
  check('已删除情报不会出现在公开快照和历史接口', intel.applyToSnapshot(snapshot('2026-08-29T04:00:00Z')).window7d.length === 0 && intel.publicList({ range: 'all' }).total === 0);

  const reloaded = new IntelligenceStore(dir);
  reloaded.init();
  check('情报编辑和回收站状态可跨重启持久化', reloaded.get(id).title === '人工标题' && reloaded.get(id).status === 'deleted');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
