'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Stats } = require('../server/lib/stats');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-stats-'));
const dir = path.join(root, 'stats');
fs.mkdirSync(dir, { recursive: true });
const day = new Date();
const p = (n) => String(n).padStart(2, '0');
const key = day.getFullYear() + '-' + p(day.getMonth() + 1) + '-' + p(day.getDate());
const pastDay = new Date(day.getTime() - 86400000);
const pastKey = pastDay.getFullYear() + '-' + p(pastDay.getMonth() + 1) + '-' + p(pastDay.getDate());
const records = [
  { t:new Date().toISOString(), ip:'ip-a', uv:'uv-a', p:'/', s:200, k:'page' },
  { t:new Date().toISOString(), ip:'ip-a', uv:'uv-a', p:'/article/intel-1234567890abcdef', s:200, k:'frontend' },
  { t:new Date().toISOString(), ip:'ip-b', uv:'uv-b', p:'/chenfengadmin', s:200, k:'admin' },
  { t:new Date().toISOString(), ip:'ip-b', uv:'uv-b', p:'/api/admin/stats', s:200, k:'admin' },
  { t:new Date().toISOString(), ip:'ip-a', uv:'uv-a', p:'/api/data', s:200, k:'api' },
  { t:new Date().toISOString(), ip:'ip-a', uv:'uv-a', p:'/app.js', s:200, k:'asset' },
  { t:new Date().toISOString(), ip:'ip-a', uv:'uv-a', p:'https://example.com/article', s:200, k:'click', ck:'item', ct:'文章' },
  { t:new Date().toISOString(), ip:'ip-b', uv:'uv-b', p:'https://example.com/friend', s:200, k:'click', ck:'friend', ct:'友链' },
  { t:new Date().toISOString(), ip:'ip-a', uv:'uv-a', p:'https://chenqiyuan.cn/article/intel-1234567890abcdef', s:200, k:'click', ck:'share', ct:'文章' },
];
fs.writeFileSync(path.join(dir, 'visits-' + key + '.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'visits-' + pastKey + '.jsonl'), [
  { t:pastDay.toISOString(), ip:'ip-old', uv:'uv-old', p:'/', s:200, k:'frontend' },
  { t:pastDay.toISOString(), ip:'ip-old', uv:'uv-old', p:'/article/intel-1234567890abcdef', s:200, k:'frontend' },
  { t:pastDay.toISOString(), ip:'ip-old', uv:'uv-old', p:'https://example.com/old', s:200, k:'click', ck:'item', ct:'旧文章' },
  { t:pastDay.toISOString(), ip:'ip-old', uv:'uv-old', p:'https://chenqiyuan.cn/article/intel-1234567890abcdef', s:200, k:'click', ck:'share', ct:'文章' },
].map(JSON.stringify).join('\n') + '\n');
fs.writeFileSync(path.join(dir, 'daily.json'), JSON.stringify({ version:2, days: {
  [key]: { pv:2, uv:2, ips:2, api:2, hits:5 },
  [pastKey]: { pv:1, uv:1, ips:1, api:1, hits:1, scopes:{ frontend:{ requests:1, pv:1, uv:1, ips:1, api:0 } } },
} }));

let pass=0, fail=0;
function check(name, condition) { console.log((condition ? 'PASS ' : 'FAIL ') + name); condition ? pass++ : fail++; }
(async () => {
  const stats = new Stats(root); stats.init();
  const result = await stats.summary(7); const today = result.today;
  check('旧版 page/admin/api 流水自动迁移', today.pv === 3 && today.hits === 9);
  check('前台页面独立统计', today.scopes.frontend.pv === 2 && today.scopes.frontend.uv === 1);
  check('后台页面与后台 API 同区但 PV 不混算', today.scopes.admin.requests === 2 && today.scopes.admin.pv === 1);
  check('公开 API 与资源分别统计', today.scopes.api.requests === 1 && today.scopes.asset.requests === 1);
  check('链接点击独立统计且文章分享不混入链接点击', today.clicks === 2 && today.itemClicks === 1 && today.friendClicks === 1 && today.articleShares === 1 && today.scopes.click.requests === 3 && today.api === 2);
  check('旧版历史流水自动补算链接点击', result.totals.clicks === 3 && result.totals.itemClicks === 2 && result.totals.friendClicks === 1);
  check('文章访问和分享支持今日、本月与历史聚合', today.articlePv === 1 && result.currentMonth.articlePv >= 2 && result.totals.articlePv === 2 && result.totals.articleShares === 2);
  check('总 UV/IP 跨区域去重', today.uv === 2 && today.ips === 2);
  check('永久历史和路径明细可查询', result.retention === 'forever' && result.topPages.length === 3 && result.topRoutes.length >= 9 && result.topLinks.length === 3);
  stats.track('203.0.113.42', 'Geo Browser', '/geo-a', 200, 'frontend', { country:'CN', regionCode:'CN-GD', region:'Guangdong', city:'Shenzhen' });
  stats.track('203.0.113.42', 'Geo Browser', '/geo-b', 200, 'frontend', { country:'CN', regionCode:'CN-GD', region:'Guangdong', city:'Shenzhen' });
  const updated = await stats.summary(7);
  check('同一天相同 IP 只计一个 IP/UV 但 PV 正常累加', updated.today.scopes.frontend.pv === 4 && updated.today.scopes.frontend.ips === 2 && updated.today.scopes.frontend.uv === 2);
  check('本月前台使用每日去重值累计', updated.currentMonth && updated.currentMonth.month === key.slice(0,7) && updated.currentMonth.scopes.frontend.ips >= updated.today.scopes.frontend.ips);
  check('国家与省份按前台日 IP 聚合', updated.today.scopes.frontend.geography.countries.CN.ips === 1 && updated.today.scopes.frontend.geography.regions['CN-GD'].ips === 1 && updated.today.scopes.frontend.geography.regions['CN-GD'].pv === 2);
  await stats.shutdown();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'daily.json'), 'utf8'));
  const visitText = fs.readFileSync(path.join(dir, 'visits-' + key + '.jsonl'), 'utf8');
  check('新版聚合以 v5 永久日维度格式落盘', saved.version === 5 && saved.retention === 'forever' && saved.uniqueWindow === 'daily' && saved.ipStorage === 'network-segment' && saved.days[key].scopes.frontend && saved.days[key].clicks === 2 && saved.days[key].articlePv === 1 && saved.days[key].articleShares === 1 && saved.days[pastKey].articlePv === 1 && saved.days[pastKey].articleShares === 1);
  check('访问流水保存 IP 网段和地域但不保存完整 IP 明文', visitText.includes('203.0.113.0/24') && visitText.includes('"regionCode":"CN-GD"') && !visitText.includes('203.0.113.42'));
  fs.rmSync(root, { recursive:true, force:true });
  console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
