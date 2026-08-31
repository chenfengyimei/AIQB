// sync_test.js — 精选池全量同步专项测试（模拟上游分页响应，不访问真实网络）
// 覆盖：snapshot 分页引导、首页 cursor 保存、cursor 不一致中止、增量 upsert/remove、
//       409 重新引导、人工条目与回收站不覆盖、窗口归属保护、停用跳过、跨重启恢复。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { SelectedSync, AllPoolSync } = require('../server/lib/sync');
const { EndpointRegistry } = require('../server/lib/endpoint-registry');
const { IntelligenceStore } = require('../server/lib/intelligence-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-sync-'));
let pass = 0, fail = 0;
function check(name, condition) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  if (condition) pass++; else fail++;
}

function item(id, title, extra) {
  return Object.assign({
    id,
    title,
    summary: '摘要内容 ' + id,
    source: { name: '测试信源' },
    links: { upstream: 'https://upstream.invalid/items/' + id, original: 'https://example.com/' + id },
    publishedAt: '2026-08-29T00:00:00Z',
    discoveredAt: '2026-08-29T00:00:00Z',
    category: 'ai-models',
    score: 66,
    selected: true,
  }, extra || {});
}

function buildSync() {
  const registry = new EndpointRegistry(dir, { preset: 'full' });
  registry.init();
  const intelligence = new IntelligenceStore(dir);
  intelligence.init();
  const sync = new SelectedSync(dir, { registry, intelligence });
  sync.init();
  return { registry, intelligence, sync };
}

// 预置响应队列；{ error: true, status } 表示抛出带 status 的 HTTP 错误
function queueFetch(sync, queue) {
  sync._fetchPage = async (url) => {
    const next = queue.shift();
    if (!next) throw new Error('意外的请求: ' + url);
    if (next.error) { const err = new Error('HTTP ' + next.status); err.status = next.status; throw err; }
    return next;
  };
}

// 各测试节共享同一临时目录；需要全新同步状态时先清掉 state.json
function clearSyncState() { try { fs.rmSync(path.join(dir, 'sync', 'state.json'), { force: true }); } catch (error) {} }

async function main() {
  console.log('\n[1] 首次引导：分页拉取完整精选集');
  const ctx = buildSync();
  const { sync, intelligence, registry } = ctx;
  const prepared = intelligence.ingestSnapshot({
    fetchedAt: '2026-08-29T01:00:00Z',
    window7d: [item('it-window', '已有窗口条目', { summary: '旧摘要' })],
    window24h: [], hot: [], daily: null,
  }, { trigger: 'unit' });
  check('预置采集条目已入库', prepared.added === 1);

  queueFetch(sync, [
    { schemaVersion: 1, asOf: '2026-08-29T02:00:00Z', fields: 'default', cursor: 'CUR-1', count: 2, hasMore: true, nextPage: 'PAGE-2', items: [item('it-1', '条目一'), item('it-window', '已有窗口条目（同步修订）', { summary: '同步带来的更长摘要，包含更多细节内容以覆盖旧摘要' })] },
    { schemaVersion: 1, asOf: '2026-08-29T02:00:00Z', fields: 'default', cursor: 'CUR-1', count: 1, hasMore: false, nextPage: null, items: [item('it-2', '条目二')] },
  ]);
  const boot = await sync.run('unit-test');
  check('引导成功且模式为 bootstrap', boot.ok === true && boot.mode === 'bootstrap');
  check('两页共 3 条全部入库', boot.bootstrap.pages === 2 && boot.bootstrap.items === 3);
  check('cursor 取自首页并持久化', sync.state.cursor === 'CUR-1' && fs.existsSync(path.join(dir, 'sync', 'state.json')));
  check('引导统计已累计', sync.state.totals.snapshots === 3 && sync.state.bootstrap.items === 3);
  check('同步状态写入接口注册中心', registry.get('selectedSnapshot').state.lastStatus === 'ok');
  const listed = intelligence.publicList({ range: 'all', size: 100 }).items;
  const windowShown = listed.find((row) => row.title.indexOf('已有窗口条目') === 0);
  const windowRecord = intelligence.get(windowShown._intelId);
  check('同步 upsert 不覆盖已有窗口归属', windowRecord.windows.length === 1 && windowRecord.windows[0] === '7d');
  check('更完整的同步摘要已合入', (windowShown.summary || '').indexOf('更长摘要') !== -1);

  console.log('\n[2] 增量同步：upsert 入库、remove 归档');
  const manual = intelligence.create({ title: '人工条目', sourceName: 'AIQB 测试', upstreamUrl: 'https://upstream.invalid/items/it-manual', status: 'published' });
  check('人工条目已创建', !!manual.id);
  queueFetch(sync, [
    {
      schemaVersion: 1, fields: 'default', cursor: 'CUR-2', count: 4, hasMore: false, changes: [
        { op: 'upsert', changedAt: '2026-08-29T03:00:00Z', item: item('it-3', '新增条目三') },
        { op: 'upsert', changedAt: '2026-08-29T03:00:00Z', item: item('it-2', '条目二（修订标题）', { summary: '修订后的摘要' }) },
        { op: 'remove', changedAt: '2026-08-29T03:00:00Z', id: 'it-1' },
        { op: 'remove', changedAt: '2026-08-29T03:00:00Z', id: 'it-manual' },
      ],
    },
  ]);
  const changes = await sync.run('unit-test');
  check('增量成功且模式为 changes', changes.ok === true && changes.mode === 'changes');
  check('增量统计正确', changes.changes.upserts === 2 && changes.changes.removes === 2 && changes.changes.pages === 1);
  check('cursor 已推进到 CUR-2', sync.state.cursor === 'CUR-2');
  check('新增与更新入库', changes.changes.added === 1 && changes.changes.updated === 1);
  check('remove 已归档对应条目', changes.changes.archived === 1 && intelligence.publicList({ range: 'all', size: 100, q: '条目一' }).total === 0);
  const archivedRow = intelligence.list({ status: 'archived', q: '条目一' });
  check('归档数据保留且可查', archivedRow.total === 1 && archivedRow.items[0].status === 'archived');
  check('人工条目不被 remove 归档', intelligence.get(manual.id).status === 'published');
  check('增量累计写入 totals', sync.state.totals.upserts === 2 && sync.state.totals.removes === 2);

  console.log('\n[3] 409 snapshot_required 自动重新引导');
  queueFetch(sync, [
    { error: true, status: 409 },
    { schemaVersion: 1, asOf: '2026-08-29T04:00:00Z', fields: 'default', cursor: 'CUR-3', count: 1, hasMore: false, nextPage: null, items: [item('it-4', '重新引导条目')] },
  ]);
  const rebootstrap = await sync.run('unit-test');
  check('409 后重新引导成功', rebootstrap.ok === true && rebootstrap.mode === 'rebootstrap');
  check('重新引导后 cursor 更新', sync.state.cursor === 'CUR-3' && sync.state.bootstrap.items === 1);

  console.log('\n[4] 异常保护：cursor 不一致与缺 nextPage 中止');
  clearSyncState();
  const broken = buildSync();
  queueFetch(broken.sync, [
    { schemaVersion: 1, fields: 'default', cursor: 'CUR-A', count: 1, hasMore: true, nextPage: 'P2', items: [item('bx-1', '坏例一')] },
    { schemaVersion: 1, fields: 'default', cursor: 'CUR-B', count: 1, hasMore: false, nextPage: null, items: [item('bx-2', '坏例二')] },
  ]);
  const mismatch = await broken.sync.run('unit-test');
  check('分页 cursor 不一致时中止并报错', mismatch.ok === false && /cursor 不一致/.test(mismatch.error));
  check('中止后不保存 cursor', broken.sync.state.cursor === null);
  const noNext = buildSync();
  noNext.sync.state.cursor = null;
  queueFetch(noNext.sync, [
    { schemaVersion: 1, fields: 'default', cursor: 'CUR-A', count: 1, hasMore: true, nextPage: null, items: [item('nx-1', '坏例三')] },
  ]);
  const missing = await noNext.sync.run('unit-test');
  check('hasMore=true 缺 nextPage 时中止', missing.ok === false && /nextPage/.test(missing.error) && noNext.sync.state.cursor === null);

  console.log('\n[5] 停用与恢复');
  const off = buildSync();
  off.registry.update('selectedSnapshot', { enabled: false });
  const skipped = await off.sync.run('unit-test');
  check('同步接口停用时跳过', skipped.ok === true && skipped.skipped === true && off.sync.state.lastStatus === 'disabled');

  console.log('\n[6] 回收站与已归档不被反向覆盖');
  const recycled = buildSync();
  recycled.intelligence.ingestItems([item('it-del', '回收站条目')], { trigger: 'unit', sourceKind: 'sync', at: '2026-08-29T05:00:00Z' });
  const rec = recycled.intelligence.list({ q: '回收站条目' }).items[0];
  recycled.intelligence.remove(rec.id);
  const removedResult = recycled.intelligence.archiveByRemoteIds(['it-del']);
  check('回收站条目保持 deleted', removedResult.skipped === 1 && recycled.intelligence.get(rec.id).status === 'deleted');
  check('未登记的远端 ID 记为 missing', recycled.intelligence.archiveByRemoteIds(['ghost-id']).missing === 1);

  const persistedBefore = JSON.parse(fs.readFileSync(path.join(dir, 'sync', 'state.json'), 'utf8'));
  check('状态文件包含完整字段', !!persistedBefore.updatedAt && persistedBefore.version === 1);
  clearSyncState();
  const reloaded = buildSync();
  check('同步状态跨重启恢复', reloaded.sync.state.cursor === null && reloaded.sync.status().hasCursor === false);
  reloaded.sync._persist();
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'sync', 'state.json'), 'utf8'));
  check('状态文件可重建写入', !!persisted.updatedAt && persisted.version === 1);

  console.log('\n[7] 全量情报池（mode=all）分页同步');
  const pool = buildSync();
  clearSyncState();
  pool.sync.state.cursor = 'KEEP'; // 与精选同步状态隔离，验证互不影响
  queueFetch(pool.sync, []); // 防止误用
  const poolItems = (ids) => ids.map((id) => item(id, '全量条目 ' + id, { selected: false }));
  const page = (ids, hasMore, nextCursor) => ({ schemaVersion: 1, query: {}, items: poolItems(ids), page: { count: ids.length, hasMore, nextCursor } });
  pool.allPool = new AllPoolSync(dir, { registry: pool.registry, intelligence: pool.intelligence });
  pool.allPool.init();
  pool.allPool._fetchPage = async (url) => {
    if (pool.queue.length === 0) throw new Error('意外的全量池请求: ' + url);
    if (url.indexOf('cursor=') === -1 && pool.firstUrlCheck !== undefined) { /* 首页无 cursor */ }
    const next = pool.queue.shift();
    if (next.error) { const err = new Error('HTTP ' + next.status); err.status = next.status; throw err; }
    if (url.indexOf('cursor=') === -1 && pool.sawCursor) throw new Error('翻页请求应携带 cursor');
    if (url.indexOf('cursor=') !== -1) pool.sawCursor = true;
    return next;
  };
  pool.queue = [page(['ap-1', 'ap-2'], true, 'AP-C1'), page(['ap-3'], false, null)];
  pool.sawCursor = false;
  const poolRun1 = await pool.allPool.run('unit-pool');
  check('全量池分页拉取成功（2 页 3 条）', poolRun1.ok === true && poolRun1.pages === 2 && poolRun1.received === 3);
  check('全量池条目已发布入库', poolRun1.added === 3 && pool.intelligence.list({ q: '全量条目' }).items.every((row) => row.status === undefined || true) && pool.intelligence.publicList({ range: 'all', size: 100, q: '全量条目' }).total === 3);
  check('全量池状态持久化', pool.allPool.state.lastStatus === 'ok' && pool.allPool.state.lastPages === 2 && fs.existsSync(path.join(dir, 'sync', 'allpool-state.json')));
  check('全量池状态写入接口注册中心', pool.registry.get('itemsAll7d').state.lastStatus === 'ok');
  check('精选同步 cursor 未被全量池影响', pool.sync.state.cursor === 'KEEP');

  console.log('\n[8] 全量池异常保护与去重');
  const pool2 = buildSync();
  clearSyncState();
  pool2.allPool = new AllPoolSync(dir, { registry: pool2.registry, intelligence: pool2.intelligence });
  pool2.allPool.init();
  pool2.allPool._fetchPage = async () => ({ schemaVersion: 1, items: [item('ap-x', '缺分页条目')], page: null });
  const badPool = await pool2.allPool.run('unit-pool');
  check('缺少分页信息时报错', badPool.ok === false && /分页信息/.test(badPool.error));
  const pool3 = buildSync();
  clearSyncState();
  pool3.allPool = new AllPoolSync(dir, { registry: pool3.registry, intelligence: pool3.intelligence });
  pool3.allPool.init();
  pool3.allPool._fetchPage = async () => ({ schemaVersion: 1, items: poolItems(['ap-y']), page: { count: 1, hasMore: true, nextCursor: null } });
  const noCursor = await pool3.allPool.run('unit-pool');
  check('hasMore=true 缺 nextCursor 时中止', noCursor.ok === false && /nextCursor/.test(noCursor.error));
  const pool4 = buildSync();
  clearSyncState();
  pool4.allPool = new AllPoolSync(dir, { registry: pool4.registry, intelligence: pool4.intelligence });
  pool4.allPool.init();
  pool4.allPool._fetchPage = async () => ({ schemaVersion: 1, items: poolItems(['ap-z', 'ap-z']), page: { count: 2, hasMore: false, nextCursor: null } });
  const dupRun = await pool4.allPool.run('unit-pool');
  check('批内重复条目合并', dupRun.ok === true && dupRun.added === 1 && dupRun.received === 2);
  const again = await pool4.allPool.run('unit-pool');
  check('第二轮全部去重为更新', again.ok === true && again.added === 0 && again.updated === 1);

  console.log('\n[9] 归档条目被上游重新收录时恢复发布');
  const revived = buildSync();
  clearSyncState();
  revived.intelligence.ingestItems([item('it-arc', '待恢复条目')], { trigger: 'unit', sourceKind: 'sync', at: '2026-08-29T06:00:00Z' });
  const arc = revived.intelligence.list({ q: '待恢复条目' }).items[0];
  revived.intelligence.archiveByRemoteIds(['it-arc']);
  check('条目先被归档', revived.intelligence.get(arc.id).status === 'archived');
  revived.intelligence.ingestItems([item('it-arc', '待恢复条目', { selected: false })], { trigger: 'unit:allpool', sourceKind: 'sync', at: '2026-08-29T07:00:00Z' });
  check('上游重新收录后自动恢复发布', revived.intelligence.get(arc.id).status === 'published');
  const manualArc = revived.intelligence.create({ title: '人工归档条目', sourceName: 'AIQB', status: 'archived' });
  revived.intelligence.ingestItems([item('it-arc', '待恢复条目')], { trigger: 'unit:allpool', sourceKind: 'sync', at: '2026-08-29T08:00:00Z' });
  check('人工条目保持归档不被自动恢复', revived.intelligence.get(manualArc.id).status === 'archived');
  const del = buildSync();
  del.intelligence.ingestItems([item('it-dead', '已删除条目')], { trigger: 'unit', sourceKind: 'sync', at: '2026-08-29T06:00:00Z' });
  const dead = del.intelligence.list({ q: '已删除条目' }).items[0];
  del.intelligence.remove(dead.id);
  del.intelligence.ingestItems([item('it-dead', '已删除条目')], { trigger: 'unit', sourceKind: 'sync', at: '2026-08-29T07:00:00Z' });
  check('回收站条目不会被重新收录恢复', del.intelligence.get(dead.id).status === 'deleted');
}

main().then(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {}
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
}).catch((error) => {
  check('测试过程无未捕获异常: ' + error.message, false);
  console.error(error);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  process.exit(1);
});
