// smoke_test.js — 后端冒烟测试
// 用临时数据目录在随机端口启动服务，验证全部核心行为，结束后输出 PASS/FAIL 汇总。
// 用法：node scripts/smoke_test.js
// 说明：不依赖外部网络（采集接口允许 502/409 失败），登录限流按 15 分钟窗口实测。

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');
const PORT = 3999;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-smoke-'));
const INITIAL_ADMIN_PASSWORD = 'Smoke-Admin-Password-2026';

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function req(method, url, opts) {
  const o = Object.assign({ method, headers: {} }, opts || {});
  const res = await fetch(BASE + url, o);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, headers: res.headers, text, json };
}

async function waitServer(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await req('GET', '/health');
      if (r.status === 200 && r.json && r.json.ok) return true;
    } catch (e) {}
    await sleep(300);
  }
  return false;
}

function seedSmokeData() {
  const fetchedAt = new Date().toISOString();
  const id = 'seed-item-1';
  const item = {
    id,
    title: 'AIQB 冒烟测试情报',
    summary: '本地测试数据用于验证公开接口、文章和日报，不依赖任何外部服务。',
    source: { name: 'AIQB 测试' },
    links: { original: 'https://example.com/aiqb-smoke' },
    publishedAt: fetchedAt,
    category: 'industry',
    selected: true,
  };
  const relatedItem = Object.assign({}, item, {
    id: 'seed-item-2',
    title: 'AIQB 冒烟测试相关情报',
    summary: '第二条本地数据用于验证相关推荐与列表导航。',
    links: { original: 'https://example.com/aiqb-smoke-related' },
  });
  const snapshot = {
    fetchedAt,
    window7d: [item, relatedItem],
    window24h: [item, relatedItem],
    hot: [],
    daily: { report: { date: fetchedAt.slice(0, 10), sections: [{ title: '测试日报', items: [item, relatedItem] }] } },
  };
  const historyDir = path.join(DATA_DIR, 'history');
  const snapshotId = 'snap-smoke-seed';
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'latest.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(historyDir, snapshotId + '.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify([{
    id: snapshotId, fetchedAt, ok: true, counts: { w7: 2, w24: 2, hot: 0, daily: 2 }, bytes: Buffer.byteLength(JSON.stringify(snapshot)), durationMs: 0, seeded: true,
  }]));
}

async function main() {
  console.log('数据目录: ' + DATA_DIR);
  seedSmokeData();
  const child = spawn(process.execPath, [SERVER], {
    env: Object.assign({}, process.env, { AIQB_DATA_DIR: DATA_DIR, AIQB_PORT: String(PORT), AIQB_HOST: '127.0.0.1', AIQB_ENDPOINT_PRESET: 'full', AIQB_INITIAL_ADMIN_PASSWORD: INITIAL_ADMIN_PASSWORD }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d.toString(); });
  child.stderr.on('data', (d) => { serverLog += d.toString(); });

  try {
    // ---------- 就绪 ----------
    console.log('\n[1] 启动与健康检查');
    check('服务在 15s 内就绪', await waitServer(15000), serverLog.slice(-400));

    const health = await req('GET', '/health');
    check('/health 返回 200', health.status === 200);
    check('/health 字段完整', !!(health.json && health.json.ok && health.json.version && health.json.snapshots !== undefined));
    check('旧数据已迁移为快照（snapshots>=1）', health.json && health.json.snapshots >= 1, JSON.stringify(health.json).slice(0, 200));
    const publicStatus = await req('GET', '/api/status');
    const publicStatusKeys = publicStatus.json ? Object.keys(publicStatus.json).sort().join(',') : '';
    const publicMetricKeys = publicStatus.json && publicStatus.json.metrics ? Object.keys(publicStatus.json.metrics).sort().join(',') : '';
    check('公开健康概况无需登录且只返回模糊化字段', publicStatus.status === 200 && publicStatusKeys === 'metrics,overall,refreshAfterSec,status,updatedAt' && publicMetricKeys === 'data,response,service,sources');
    check('公开健康概况四项均为合法百分比且十分钟更新', publicStatus.json && publicStatus.json.refreshAfterSec === 600 && [publicStatus.json.overall].concat(Object.values(publicStatus.json.metrics || {})).every((value) => Number.isInteger(value) && value >= 0 && value <= 100));
    check('公开健康概况支持 CORS、短缓存和 ETag', publicStatus.headers.get('access-control-allow-origin') === '*' && /max-age=60/.test(publicStatus.headers.get('cache-control') || '') && !!publicStatus.headers.get('etag'));
    const publicStatusAgain = await req('GET', '/api/status');
    check('公开健康概况服务端十分钟内保持同一快照', publicStatusAgain.status === 200 && publicStatusAgain.json.updatedAt === publicStatus.json.updatedAt && JSON.stringify(publicStatusAgain.json) === JSON.stringify(publicStatus.json));
    const publicStatus304 = await req('GET', '/api/status', { headers: { 'If-None-Match': publicStatus.headers.get('etag') } });
    check('公开健康概况支持 ETag 304', publicStatus304.status === 304);

    // ---------- 静态页 ----------
    console.log('\n[2] 静态托管');
    const home = await req('GET', '/');
    check('GET / 200 HTML', home.status === 200 && home.text.indexOf('<!DOCTYPE html>') === 0);
    const geoHome = await req('GET', '/?geo-test=1', { headers: { 'X-Real-IP': '8.8.8.42', 'EO-Connecting-IP': '127.0.0.1', 'EO-Client-IPCountry': 'CN', 'EO-Client-Region-Code': 'CN-GD', 'EO-Client-Region': 'Guangdong', 'EO-Client-City': 'Shenzhen' } });
    check('可信本机反向代理覆盖的真实 IP 可用于统计且厂商 IP 头不参与鉴权', geoHome.status === 200);
    check('中文首页同时建立 AI圈报与 AIQB 品牌信号', home.text.indexOf('<title>AI圈报（AIQB）- 每日AI资讯、大模型动态、AI产品与行业热点</title>') !== -1 && home.text.indexOf('<h1>AI圈报（AIQB）：每日 AI 资讯与大模型动态</h1>') !== -1 && home.text.indexOf('"name":"AI圈报"') !== -1 && home.text.indexOf('"alternateName":"AIQB"') !== -1 && home.text.indexOf('"@id":"https://chenqiyuan.cn/#organization"') !== -1);
    check('首页默认展示版权和 ICP 备案链接', home.text.indexOf('2025–2026 Copyright © AI圈报') !== -1 && home.text.indexOf('粤ICP备2025432484号') !== -1 && home.text.indexOf('https://beian.miit.gov.cn/') !== -1);
    check('首页固定展示可点击的 AIQB 项目来源署名', home.text.indexOf('设计与开发由') !== -1 && home.text.indexOf('href="https://github.com/chenfengyimei/AIQB"') !== -1 && home.text.indexOf('class="project-attribution"') !== -1);
    const homeGz = await req('GET', '/', { headers: { 'Accept-Encoding': 'gzip' } });
    check('GET / gzip 压缩生效', homeGz.headers.get('content-encoding') === 'gzip');
    const homeEtag = homeGz.headers.get('etag');
    const home304 = await req('GET', '/', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': homeEtag } });
    check('GET / ETag 304', home304.status === 304);
    const admin = await req('GET', '/chenfengadmin');
    check('GET /chenfengadmin 200 HTML', admin.status === 200 && admin.text.indexOf('管理后台') !== -1);
    check('后台入口禁止缓存与索引', admin.headers.get('cache-control') === 'no-store' && /noindex/i.test(admin.headers.get('x-robots-tag') || ''));
    const oldAdmin = await req('GET', '/admin');
    const rawAdmin = await req('GET', '/admin.html');
    check('旧后台入口与真实文件名均返回 404', oldAdmin.status === 404 && rawAdmin.status === 404);
    const robots = await req('GET', '/robots.txt');
    check('GET /robots.txt 200、公开站点地图且不泄露后台路径', robots.status === 200 && robots.text.indexOf('Disallow: /admin') !== -1 && robots.text.indexOf('Sitemap: https://chenqiyuan.cn/sitemap.xml') !== -1 && robots.text.indexOf('chenfengadmin') === -1);
    const fav = await req('GET', '/favicon.ico');
    check('传统 favicon.ico 可抓取且返回真实图标', fav.status === 200 && /image\/x-icon/.test(fav.headers.get('content-type') || '') && fav.text.length > 100);
    const brandFav = await req('GET', '/favicon.svg');
    check('品牌 SVG 图标可抓取并正确缓存', brandFav.status === 200 && /image\/svg\+xml/.test(brandFav.headers.get('content-type') || '') && brandFav.text.indexOf('aria-label="AI圈报 AIQB"') !== -1);
    const appIcon = await req('GET', '/icon-192.png');
    const manifest = await req('GET', '/site.webmanifest');
    check('PNG 应用图标与 Web Manifest 可抓取', appIcon.status === 200 && /image\/png/.test(appIcon.headers.get('content-type') || '') && manifest.status === 200 && /application\/manifest\+json/.test(manifest.headers.get('content-type') || '') && manifest.json && manifest.json.short_name === 'AIQB');
    const nf = await req('GET', '/no-such-page.xyz');
    check('未知路径 404 JSON', nf.status === 404 && !!(nf.json && nf.json.error));
    const trav = await req('GET', '/..%2f..%2fserver%2fserver.js');
    check('目录穿越被拒绝', trav.status === 404 || trav.status === 403);
    const cross = await req('GET', '/api/data', { headers: { 'Origin': 'https://evil.example.com' } });
    check('公开 API 带 CORS 头', cross.headers.get('access-control-allow-origin') === '*');

    // ---------- 公开数据 API ----------
    console.log('\n[3] 公开数据 API');
    const data1 = await req('GET', '/api/data');
    check('/api/data 200', data1.status === 200);
    check('/api/data 有 window7d 数据（迁移）', !!(data1.json && Array.isArray(data1.json.window7d) && data1.json.window7d.length > 0));
    const publicItem = data1.json.window7d.find((item) => item._intelId && item.selected !== false) || data1.json.window7d.find((item) => item._intelId);
    check('公开情报包含稳定站内 ID', !!publicItem);
    const publicId = publicItem ? publicItem._intelId : 'intel-0000000000000000';
    const etag = data1.headers.get('etag');
    check('/api/data 带 ETag', !!etag);
    const dataGz = await req('GET', '/api/data', { headers: { 'Accept-Encoding': 'gzip' } });
    check('/api/data gzip 生效', dataGz.headers.get('content-encoding') === 'gzip');
    const data304 = await req('GET', '/api/data', { headers: { 'If-None-Match': etag } });
    check('/api/data ETag 304', data304.status === 304);
    const historyApi = await req('GET', '/api/history?range=all&page=1&size=100&q=' + encodeURIComponent(publicItem && publicItem.title || ''));
    check('/api/history 返回永久历史库、分页和分类统计', historyApi.status === 200 && historyApi.json.total >= 1 && historyApi.json.items.some((item) => item._intelId === publicId) && historyApi.json.facets && historyApi.json.dataRevision);
    const tierApi = await req('GET', '/api/history?range=all&tier=selected&page=1&size=100');
    check('/api/history 返回层级计数且全部=精选+普通', tierApi.status === 200 && tierApi.json.tier === 'selected' && tierApi.json.tierCounts.all === tierApi.json.tierCounts.selected + tierApi.json.tierCounts.ordinary && tierApi.json.items.every((item) => item.selected !== false));
    check('/api/history 浏览器即时校验、CDN 短缓存并支持 CORS', /max-age=0/.test(historyApi.headers.get('cache-control') || '') && /s-maxage=60/.test(historyApi.headers.get('cache-control') || '') && historyApi.headers.get('access-control-allow-origin') === '*');
    const liveHealth = await req('GET', '/health/live');
    check('轻量存活探针无需全量统计即可返回', liveHealth.status === 200 && liveHealth.json.status === 'alive' && liveHealth.json.pid);
    const homeApi = await req('GET', '/api/home');
    check('首页聚合接口一次返回精选、最新与日报摘要', homeApi.status === 200 && homeApi.json.selected && homeApi.json.latest && homeApi.json.data && homeApi.json.dataRevision);
    const hotApi = await req('GET', '/api/hot');
    check('热点轻量接口独立返回并携带数据版本', hotApi.status === 200 && Array.isArray(hotApi.json.items) && hotApi.json.dataRevision);
    const dailyLatestApi = await req('GET', '/api/daily/latest');
    check('最新日报轻量接口保持独立', dailyLatestApi.status === 200 && Object.prototype.hasOwnProperty.call(dailyLatestApi.json, 'daily') && dailyLatestApi.json.dataRevision);
    const englishHome = await req('GET', '/en/');
    check('英文首页独立可访问并使用英文 SEO 与语言标记', englishHome.status === 200 && englishHome.text.indexOf('<html lang="en"') !== -1 && englishHome.text.indexOf('Daily AI News') !== -1 && englishHome.text.indexOf('https://chenqiyuan.cn/en/') !== -1);
    check('英文首页描述与关键词反向关联 AI圈报 品牌', englishHome.text.indexOf('AIQB (AI圈报) tracks daily AI news') !== -1 && englishHome.text.indexOf('AIQB,AI圈报,AI news') !== -1);
    check('中英文首页提供双向 hreflang 与 x-default', englishHome.text.indexOf('hreflang="zh-CN"') !== -1 && englishHome.text.indexOf('hreflang="en"') !== -1 && englishHome.text.indexOf('hreflang="x-default"') !== -1);
    const englishHistory = await req('GET', '/api/history?range=all&language=en&page=1&size=20');
    check('英文情报接口启用独立语言口径', englishHistory.status === 200 && englishHistory.json.language === 'en' && Array.isArray(englishHistory.json.items));
    const dailies = await req('GET', '/api/dailies?limit=30');
    check('公开日报归档接口返回已保存日期', dailies.status === 200 && Array.isArray(dailies.json.items) && dailies.json.items.length >= 1);
    const dailyDate = dailies.json.items[0] && dailies.json.items[0].date;
    const dailyByDate = await req('GET', '/api/dailies/' + dailyDate);
    check('公开指定日期日报从本地快照读取', dailyByDate.status === 200 && dailyByDate.json.daily.report.date === dailyDate);
    const article = await req('GET', '/article/' + publicId);
    check('情报详情页展示完整摘要、分类导航、元信息和相关推荐', article.status === 200 && article.text.indexOf('<article class="card article-card">') !== -1 && article.text.indexOf('内容摘要') !== -1 && article.text.indexOf('class="category-nav"') !== -1 && article.text.indexOf('class="info-grid"') !== -1 && article.text.indexOf('相关推荐') !== -1 && article.text.indexOf('data-share') !== -1);
    check('文章分享成功后会上报独立分享事件', article.text.indexOf('kind:"share"') !== -1 && article.text.indexOf('then(reportShare)') !== -1);
    check('情报详情页含 canonical 与增强 Article 结构化数据', article.text.indexOf('rel="canonical"') !== -1 && article.text.indexOf('"@type":"Article"') !== -1 && article.text.indexOf('"isAccessibleForFree":true') !== -1 && article.text.indexOf('"wordCount":') !== -1);
    check('文章系统页脚同步展示版权备案信息', article.text.indexOf('2025–2026 Copyright © AI圈报') !== -1 && article.text.indexOf('粤ICP备2025432484号') !== -1);
    check('文章系统页脚同步展示项目来源署名', article.text.indexOf('设计与开发由') !== -1 && article.text.indexOf('href="https://github.com/chenfengyimei/AIQB"') !== -1);
    const articles = await req('GET', '/articles');
    check('文章归档页汇总六分类并列出完整文章入口', articles.status === 200 && articles.text.indexOf('AI 情报文章归档') !== -1 && articles.text.indexOf('全部文章') !== -1 && articles.text.indexOf('/category/tutorial') !== -1 && articles.text.indexOf('/category/tip') !== -1 && articles.text.indexOf('/article/intel-') !== -1 && articles.text.indexOf('CollectionPage') !== -1);
    const category = await req('GET', '/category/' + (publicItem && publicItem.category || 'industry'));
    check('分类专题页可索引并展示摘要、来源、分类导航和文章入口', category.status === 200 && category.text.indexOf('/article/' + publicId) !== -1 && category.text.indexOf('CollectionPage') !== -1 && category.text.indexOf('class="list-summary"') !== -1 && category.text.indexOf('class="category-nav"') !== -1);
    const sitemap = await req('GET', '/sitemap.xml');
    check('站点地图包含文章归档、教程分类页和情报详情页', sitemap.status === 200 && /application\/xml/.test(sitemap.headers.get('content-type') || '') && sitemap.text.indexOf('/articles') !== -1 && sitemap.text.indexOf('/category/tutorial') !== -1 && sitemap.text.indexOf('/article/' + publicId) !== -1);
    check('站点地图包含英文首页、归档、分类和英文文章入口', sitemap.text.indexOf('/en/') !== -1 && sitemap.text.indexOf('/en/articles') !== -1 && sitemap.text.indexOf('/en/category/tutorial') !== -1);
    const rss = await req('GET', '/rss.xml');
    check('RSS 订阅包含最新情报与浏览器 CSS 样式声明', rss.status === 200 && /application\/rss\+xml/.test(rss.headers.get('content-type') || '') && rss.text.indexOf('/article/intel-') !== -1 && rss.text.indexOf('rss-style.css') !== -1);
    const rssBrowser = await req('GET', '/rss.xml', { headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9' } });
    check('浏览器访问 RSS 保持标准 XML 并应用 CSS', rssBrowser.status === 200 && /application\/rss\+xml/.test(rssBrowser.headers.get('content-type') || '') && rssBrowser.text.indexOf('type="text/css"') !== -1);
    const rssRaw = await req('GET', '/rss.xml?raw=1', { headers: { 'Accept': 'text/html,application/xhtml+xml' } });
    check('raw=1 始终返回标准 RSS XML', rssRaw.status === 200 && /application\/rss\+xml/.test(rssRaw.headers.get('content-type') || '') && rssRaw.text.indexOf('<rss version="2.0"') !== -1);
    const rssPage = await req('GET', '/rss');
    check('RSS 阅读页为服务端 HTML 且包含最新文章', rssPage.status === 200 && /text\/html/.test(rssPage.headers.get('content-type') || '') && rssPage.text.indexOf('/article/intel-') !== -1 && rssPage.text.indexOf('CollectionPage') !== -1);
    const rssStyle = await req('GET', '/rss-style.xsl');
    check('RSS 阅读界面 XSL 可访问', rssStyle.status === 200 && /xml/.test(rssStyle.headers.get('content-type') || '') && rssStyle.text.indexOf('标准 RSS 订阅源') !== -1);
    const rssCss = await req('GET', '/rss-style.css');
    check('RSS XML 的跨浏览器 CSS 卡片样式可访问', rssCss.status === 200 && /text\/css/.test(rssCss.headers.get('content-type') || '') && rssCss.text.indexOf('AI圈报 · 标准 RSS 订阅源') !== -1);
    const article404 = await req('GET', '/article/intel-0000000000000000');
    check('不存在的情报详情返回 404 且 noindex', article404.status === 404 && /noindex/i.test(article404.headers.get('x-robots-tag') || ''));
    const adminNoAuth = await req('GET', '/api/admin/overview');
    check('未登录访问管理接口 401', adminNoAuth.status === 401);
    const healthNoAuth = await req('GET', '/api/admin/health');
    check('健康管理接口仅登录后可访问', healthNoAuth.status === 401);
    const emailNoAuth = await req('GET', '/api/admin/email');
    check('邮箱管理接口仅登录后可访问', emailNoAuth.status === 401);

    // ---------- 登录与会话 ----------
    console.log('\n[4] 登录认证');
    const pwdFile = path.join(DATA_DIR, 'auth', 'initial-password.txt');
    check('首次管理员密码不生成明文文件', !fs.existsSync(pwdFile));
    if (process.platform !== 'win32') check('认证目录权限为 0700', (fs.statSync(path.dirname(pwdFile)).mode & 0o777) === 0o700);
    check('首次管理员密码不会写入服务日志', serverLog.indexOf(INITIAL_ADMIN_PASSWORD) === -1);
    const initPwd = INITIAL_ADMIN_PASSWORD;

    const badLogin = await req('POST', '/api/admin/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    check('错误密码 401', badLogin.status === 401 && badLogin.json.error === 'bad_credentials');

    const crossLogin = await req('POST', '/api/admin/login', {
      headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com' },
      body: JSON.stringify({ username: 'admin', password: initPwd }),
    });
    check('跨域登录被拒绝 403', crossLogin.status === 403);

    const login = await req('POST', '/api/admin/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: initPwd }),
    });
    check('正确密码登录 200', login.status === 200 && !!(login.json && login.json.user));
    const setCookie = login.headers.get('set-cookie') || '';
    check('登录 Set-Cookie 含 HttpOnly + SameSite', /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie));
    const cookie = setCookie.split(';')[0];
    const H = { 'Cookie': cookie, 'Content-Type': 'application/json' };

    const me = await req('GET', '/api/admin/me', { headers: { 'Cookie': cookie } });
    check('GET /api/admin/me 200', me.status === 200 && !!(me.json && me.json.user && me.json.user.username === 'admin'));

    // ---------- 账号管理 ----------
    console.log('\n[5] 账号管理');
    const badPwd = await req('POST', '/api/admin/password', {
      headers: H, body: JSON.stringify({ currentPassword: 'nope', newPassword: 'new-password-123' }),
    });
    check('改密码-当前密码错误 401', badPwd.status === 401);
    const weakPwd = await req('POST', '/api/admin/password', {
      headers: H, body: JSON.stringify({ currentPassword: initPwd, newPassword: 'short' }),
    });
    check('改密码-弱密码被拒 400', weakPwd.status === 400);
    const chPwd = await req('POST', '/api/admin/password', {
      headers: H, body: JSON.stringify({ currentPassword: initPwd, newPassword: 'new-password-123' }),
    });
    check('改密码成功 200', chPwd.status === 200);
    check('改密码后仍不存在明文初始密码文件', !fs.existsSync(pwdFile));
    const relogin = await req('POST', '/api/admin/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'new-password-123' }),
    });
    check('新密码可重新登录', relogin.status === 200);
    const cookie2 = (relogin.headers.get('set-cookie') || '').split(';')[0];
    const H2 = { 'Cookie': cookie2, 'Content-Type': 'application/json' };
    const chUser = await req('POST', '/api/admin/username', {
      headers: H2, body: JSON.stringify({ currentPassword: 'new-password-123', newUsername: 'boss' }),
    });
    check('改用户名成功 200', chUser.status === 200 && chUser.json.user.username === 'boss');
    const loginNew = await req('POST', '/api/admin/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'new-password-123' }),
    });
    check('新用户名可登录', loginNew.status === 200);
    const cookie3 = (loginNew.headers.get('set-cookie') || '').split(';')[0];
    const H3 = { 'Cookie': cookie3, 'Content-Type': 'application/json' };

    // ---------- 管理数据接口 ----------
    console.log('\n[6] 管理数据接口');
    const ov = await req('GET', '/api/admin/overview', { headers: { 'Cookie': cookie3 } });
    check('GET overview 200 且字段完整', ov.status === 200 && !!(ov.json && ov.json.store && ov.json.collect && ov.json.stats && ov.json.latest));
    check('overview 含 13 个多源采集接口总览', !!(ov.json.endpoints && ov.json.endpoints.total === 13));
    const dashboard = await req('GET', '/api/admin/dashboard', { headers: { 'Cookie': cookie3 } });
    check('后台概览聚合接口一次返回五组数据', dashboard.status === 200 && dashboard.json.overview && dashboard.json.stats && dashboard.json.rollup && dashboard.json.snapshots && dashboard.json.intelligenceTrend);
    const performanceApi = await req('GET', '/api/admin/performance', { headers: { 'Cookie': cookie3 } });
    check('后台性能接口包含分位值、缓存和 SQLite WAL', performanceApi.status === 200 && performanceApi.json.windows && performanceApi.json.caches && performanceApi.json.database && performanceApi.json.database.journalMode === 'wal');
    const adminHealth = await req('GET', '/api/admin/health', { headers: { 'Cookie': cookie3 } });
    check('GET health 返回服务器、进程、响应和采集健康信息', adminHealth.status === 200 && !!(adminHealth.json && adminHealth.json.host && adminHealth.json.host.cpu && adminHealth.json.host.memory && adminHealth.json.process && adminHealth.json.response && adminHealth.json.data && Array.isArray(adminHealth.json.checks)));
    check('健康接口包含滚动响应指标与整体状态', ['healthy','warning','critical'].includes(adminHealth.json.overall) && adminHealth.json.response.recent && typeof adminHealth.json.response.recent.p95Ms === 'number' && adminHealth.json.response.recent.count > 0 && adminHealth.json.process.eventLoopLagMs >= 0);
    check('健康接口可识别采集器心跳与独立实例', adminHealth.json.checks.some((item) => item.key === 'collector') && adminHealth.json.data.collect.heartbeatAt && adminHealth.json.data.collect.heartbeatAgeSec >= 0);
    const about = await req('GET', '/api/admin/about', { headers: { 'Cookie': cookie3 } });
    check('关于系统返回版本、作者、运行环境、双仓库、哔哩哔哩与协议', about.status === 200 && about.json.system.version === '2.27.0' && about.json.system.author === 'chenfeng' && about.json.system.githubUrl === 'https://github.com/chenfengyimei/AIQB' && about.json.system.giteeUrl === 'https://gitee.com/chenfengloveyuri/aiqb' && about.json.system.bilibiliUrl === 'https://space.bilibili.com/508302628' && about.json.system.license && about.json.system.license.id === 'CPAL-1.0' && about.json.sources.length === 2);
    const updateInfo = await req('GET', '/api/admin/update', { headers: { 'Cookie': cookie3 } });
    check('在线更新返回 GitHub/Gitee 双源、状态与安全措施', updateInfo.status === 200 && updateInfo.json.sources.some((s) => s.id === 'github') && updateInfo.json.sources.some((s) => s.id === 'gitee') && Array.isArray(updateInfo.json.safeguards) && !JSON.stringify(updateInfo.json).includes('AIQB_UPDATE_GITHUB_TOKEN'));
    const crossUpdate = await req('POST', '/api/admin/update/apply', { headers: Object.assign({}, H3, { Origin: 'https://evil.example.com' }), body: JSON.stringify({ source: 'github', expectedVersion: '9.9.9' }) });
    check('在线更新写操作受到同源保护', crossUpdate.status === 403);
    const emailEmpty = await req('GET', '/api/admin/email', { headers: { 'Cookie': cookie3 } });
    check('GET email 返回默认关闭且无明文密码的配置', emailEmpty.status === 200 && emailEmpty.json.settings.enabled === false && emailEmpty.json.settings.hasPassword === false && !Object.prototype.hasOwnProperty.call(emailEmpty.json.settings, 'passwordEncrypted'));
    const emailBad = await req('POST', '/api/admin/email/settings', { headers: H3, body: JSON.stringify({ enabled: true, host: '127.0.0.1', port: 25, security: 'tls', recipients: 'bad' }) });
    check('邮箱设置阻止 IP 主机、不安全端口和无效配置', emailBad.status === 400);
    const emailSave = await req('POST', '/api/admin/email/settings', { headers: H3, body: JSON.stringify({ enabled: false, providerName: '测试 SMTP', host: 'smtp.example.com', port: 465, security: 'tls', username: 'notice@example.com', password: 'smoke-smtp-secret', fromName: 'AI圈报', fromAddress: 'notice@example.com', replyTo: '', recipients: 'owner@example.com', rules: { collectFailure: true, collectRecovery: true } }) });
    const emailConfigRaw = fs.readFileSync(path.join(DATA_DIR, 'email', 'config.json'), 'utf8');
    check('SMTP 配置保存成功且密码仅以密文落盘', emailSave.status === 200 && emailSave.json.settings.hasPassword === true && !emailConfigRaw.includes('smoke-smtp-secret') && emailConfigRaw.includes('v1:'));
    const emailReload = await req('GET', '/api/admin/email', { headers: { 'Cookie': cookie3 } });
    check('邮箱设置返回收件人与通知规则但不泄露密码', emailReload.status === 200 && emailReload.json.settings.recipients[0] === 'owner@example.com' && emailReload.json.settings.rules.collectFailure === true && !JSON.stringify(emailReload.json).includes('smoke-smtp-secret'));
    const emailInvalidTest = await req('POST', '/api/admin/email/test', { headers: H3, body: JSON.stringify({ recipient: 'not-an-email' }) });
    check('测试邮件发送前验证收件邮箱', emailInvalidTest.status === 502 && /邮箱格式/.test(emailInvalidTest.json.message || ''));
    const st = await req('GET', '/api/admin/stats?days=7', { headers: { 'Cookie': cookie3 } });
    check('GET stats 200 且今日 PV>0', st.status === 200 && st.json.today && st.json.today.pv > 0, JSON.stringify(st.json.today || null));
    check('stats 含永久分区、本月、地域、路径与最近访问', !!(st.json.retention === 'forever' && st.json.uniqueWindow === 'daily' && st.json.ipStorage === 'network-segment' && st.json.today.scopes && st.json.today.scopes.frontend && st.json.today.scopes.admin && st.json.today.scopes.click && typeof st.json.today.clicks === 'number' && st.json.currentMonth && st.json.months && st.json.topPages && st.json.topRoutes && Array.isArray(st.json.recent)));
    check('stats 含今日、本月与历史文章访问和分享口径', Number.isFinite(st.json.today.articlePv) && Number.isFinite(st.json.today.articleShares) && Number.isFinite(st.json.currentMonth.articlePv) && Number.isFinite(st.json.totals.articlePv) && st.json.today.articlePv >= 1);
    check('前台国家省份聚合来自 EdgeOne 回源字段', !!(st.json.today.scopes.frontend.geography.countries.CN && st.json.today.scopes.frontend.geography.regions['CN-GD']));
    check('前台与后台 PV 分开统计', st.json.today.scopes.frontend.pv >= 1 && st.json.today.scopes.admin.pv >= 1 && st.json.today.pv === st.json.today.scopes.frontend.pv + st.json.today.scopes.admin.pv);
    const snaps = await req('GET', '/api/admin/snapshots?page=1&size=10', { headers: { 'Cookie': cookie3 } });
    check('GET snapshots 200 且 total>=1', snaps.status === 200 && snaps.json.total >= 1);
    const snapId = snaps.json.items[0].id;
    const snapOne = await req('GET', '/api/admin/snapshots/' + snapId, { headers: { 'Cookie': cookie3 } });
    check('GET snapshot 详情 200 含数据', snapOne.status === 200 && !!(snapOne.json && snapOne.json.data && snapOne.json.data.window7d));
    const rollup = await req('GET', '/api/admin/rollup?days=7', { headers: { 'Cookie': cookie3 } });
    check('GET rollup 200', rollup.status === 200 && Array.isArray(rollup.json.days));

    console.log('\n[6.2] 友链管理');
    const friendEmpty = await req('GET', '/api/admin/friend-links', { headers: { 'Cookie': cookie3 } });
    check('GET friend-links 初始列表为空', friendEmpty.status === 200 && friendEmpty.json.summary.total === 0 && Array.isArray(friendEmpty.json.items));
    const friendBad = await req('POST', '/api/admin/friend-links', { headers: H3, body: JSON.stringify({ name: '危险友链', url: 'javascript:alert(1)' }) });
    check('友链阻止非 HTTP 协议', friendBad.status === 400);
    const friendOne = await req('POST', '/api/admin/friend-links', { headers: H3, body: JSON.stringify({ name: 'AI 站点一', url: 'https://one.example.com/', description: '第一个测试站点', sort: 20, enabled: true }) });
    const friendTwo = await req('POST', '/api/admin/friend-links', { headers: H3, body: JSON.stringify({ name: 'AI 站点二', url: 'https://two.example.com/', sort: 10, enabled: false }) });
    check('POST friend-links 可新增启用和停用项', friendOne.status === 201 && friendTwo.status === 201 && friendTwo.json.summary.total === 2);
    const friendList = await req('GET', '/api/admin/friend-links', { headers: { 'Cookie': cookie3 } });
    check('后台友链按排序返回并包含状态汇总', friendList.status === 200 && friendList.json.items[0].id === friendTwo.json.item.id && friendList.json.summary.enabled === 1 && friendList.json.summary.disabled === 1);
    const friendPublic = await req('GET', '/api/friend-links');
    check('公开友链接口只返回启用项', friendPublic.status === 200 && friendPublic.json.items.length === 1 && friendPublic.json.items[0].id === friendOne.json.item.id);
    const friendHome = await req('GET', '/');
    check('首页服务端渲染友链标题、短竖线、头像卡片与点击统计标记', friendHome.status === 200 && friendHome.text.indexOf('AI 站点一') !== -1 && friendHome.text.indexOf('AI 站点二') === -1 && friendHome.text.indexOf('class="friend-head"') !== -1 && friendHome.text.indexOf('class="friend-bar"') !== -1 && friendHome.text.indexOf('class="friend-avatar"') !== -1 && friendHome.text.indexOf('data-track="friend"') !== -1);
    const friendEdit = await req('PATCH', '/api/admin/friend-links/' + friendTwo.json.item.id, { headers: H3, body: JSON.stringify({ name: 'AI 站点二（已启用）', enabled: true, sort: 5 }) });
    check('PATCH friend-links 支持编辑、启停和排序', friendEdit.status === 200 && friendEdit.json.item.enabled === true && friendEdit.json.item.sort === 5);
    const friendDelete = await req('DELETE', '/api/admin/friend-links/' + friendOne.json.item.id, { headers: H3 });
    check('DELETE friend-links 可删除且独立持久化', friendDelete.status === 200 && friendDelete.json.summary.total === 1 && fs.existsSync(path.join(DATA_DIR, 'friend-links', 'items.json')));

    console.log('\n[6.5] 情报仓库与单条管理');
    check('overview 含情报库统计', !!(ov.json.intelligence && ov.json.intelligence.active > 0));
    const intelList = await req('GET', '/api/admin/intelligence?page=1&size=100&status=active', { headers: { 'Cookie': cookie3 } });
    check('GET intelligence 返回去重后的情报列表', intelList.status === 200 && intelList.json.items.length > 0 && intelList.json.total > 0);
    const intelOne = await req('GET', '/api/admin/intelligence/' + publicId, { headers: { 'Cookie': cookie3 } });
    const intelItem = intelOne.json && intelOne.json.item || intelList.json.items[0];
    check('GET intelligence/:id 可查看详情', intelOne.status === 200 && intelItem.id === publicId);
    const crossEdit = await req('PATCH', '/api/admin/intelligence/' + intelItem.id, {
      headers: Object.assign({}, H3, { 'Origin': 'https://evil.example.com' }),
      body: JSON.stringify({ title: '不应保存' }),
    });
    check('跨域编辑情报被拒绝 403', crossEdit.status === 403);
    const editedTitle = '后台人工编辑测试情报';
    const intelEdit = await req('PATCH', '/api/admin/intelligence/' + intelItem.id, {
      headers: H3, body: JSON.stringify({ title: editedTitle, summary: '人工编辑内容不会被后续采集覆盖', status: 'published' }),
    });
    check('PATCH intelligence 可编辑情报', intelEdit.status === 200 && intelEdit.json.item.title === editedTitle);
    const dataEdited = await req('GET', '/api/data');
    const editedPublic = (dataEdited.json.window7d || []).find((item) => item._intelId === intelItem.id);
    check('人工编辑即时反映到公开数据', !!(editedPublic && editedPublic.title === editedTitle));
    const intelDelete = await req('DELETE', '/api/admin/intelligence/' + intelItem.id, { headers: H3 });
    check('DELETE intelligence 移入回收站', intelDelete.status === 200);
    const dataDeleted = await req('GET', '/api/data');
    check('回收站情报从公开数据隐藏', !(dataDeleted.json.window7d || []).some((item) => item._intelId === intelItem.id));
    const intelRestore = await req('POST', '/api/admin/intelligence/' + intelItem.id + '/restore', { headers: H3 });
    check('POST intelligence/:id/restore 恢复情报', intelRestore.status === 200 && intelRestore.json.item.status === 'published');
    const created = await req('POST', '/api/admin/intelligence', {
      headers: H3,
      body: JSON.stringify({ title: '后台手工新增测试', summary: '持久化到情报仓库', category: 'industry', sourceName: 'AIQB 测试', originalUrl: 'https://example.com/aiqb-test', windows: ['7d'], status: 'published' }),
    });
    check('POST intelligence 可手工新增', created.status === 201 && created.json.item.sourceKind === 'manual');
    const dataCreated = await req('GET', '/api/data');
    check('手工新增情报进入公开数据', (dataCreated.json.window7d || []).some((item) => item._intelId === created.json.item.id));
    const draftCreate = await req('POST', '/api/admin/intelligence', {
      headers: H3,
      body: JSON.stringify({ title: '等待批量发布的测试草稿', summary: '验证情报管理批量发布', category: 'tip', sourceName: 'AIQB 测试', originalUrl: 'https://example.com/aiqb-draft-test', windows: ['7d'], status: 'draft' }),
    });
    check('可创建草稿用于后台审核', draftCreate.status === 201 && draftCreate.json.item.status === 'draft');
    const bulkPublish = await req('POST', '/api/admin/intelligence/bulk', { headers: H3, body: JSON.stringify({ action: 'publish', ids: [draftCreate.json.item.id] }) });
    check('批量发布接口可将选中草稿快捷发布', bulkPublish.status === 200 && bulkPublish.json.result.changed === 1 && bulkPublish.json.stats.draft === 0);
    const publishedDraft = await req('GET', '/api/admin/intelligence/' + draftCreate.json.item.id, { headers: { 'Cookie': cookie3 } });
    check('批量发布结果已持久化并进入发布状态', publishedDraft.status === 200 && publishedDraft.json.item.status === 'published');
    const trend = await req('GET', '/api/admin/intelligence/trend?days=14', { headers: { 'Cookie': cookie3 } });
    check('情报库存与去重趋势返回精确日序列', trend.status === 200 && trend.json.days.length === 14 && trend.json.days.some((day) => day.total > 0));
    check('情报仓库已持久化到独立数据文件', fs.existsSync(path.join(DATA_DIR, 'intelligence', 'items.json')));

    console.log('\n[6.8] 采集接口管理');
    const endpointList = await req('GET', '/api/admin/endpoints', { headers: { 'Cookie': cookie3 } });
    check('GET endpoints 返回 13 个已登记多源配置', endpointList.status === 200 && endpointList.json.summary.total === 13 && endpointList.json.items.length === 13 && endpointList.json.summary.source === 3);
    check('完整快照与增量同步接口默认启用', endpointList.status === 200 && endpointList.json.items.filter((item) => item.role === 'sync').every((item) => item.enabled === true && item.authorizationRequired === undefined));
    const syncStatus = await req('GET', '/api/admin/sync', { headers: { 'Cookie': cookie3 } });
    check('GET sync 返回同步状态（未引导无 cursor）', syncStatus.status === 200 && syncStatus.json.sync && syncStatus.json.sync.hasCursor === false);
    const endpointCross = await req('PATCH', '/api/admin/endpoints/items7d', {
      headers: Object.assign({}, H3, { 'Origin': 'https://evil.example.com' }), body: JSON.stringify({ name: '不应保存' }),
    });
    check('跨域修改接口被拒绝 403', endpointCross.status === 403);
    const endpointBad = await req('PATCH', '/api/admin/endpoints/items7d', {
      headers: H3, body: JSON.stringify({ url: 'http://127.0.0.1/private' }),
    });
    check('接口 URL SSRF 白名单生效', endpointBad.status === 400);
    const endpointEdit = await req('PATCH', '/api/admin/endpoints/items7d', {
      headers: H3, body: JSON.stringify({ name: '近 7 天精选主接口', timeoutMs: 45000, retries: 3, enabled: true }),
    });
    check('PATCH endpoint 可编辑并持久化参数', endpointEdit.status === 200 && endpointEdit.json.item.timeoutMs === 45000 && fs.existsSync(path.join(DATA_DIR, 'endpoints', 'config.json')));
    const endpointTest = await req('POST', '/api/admin/endpoints/dailyArchive/test', { headers: H3 });
    check('POST endpoint/test 返回完整检测元数据', endpointTest.status === 200 && endpointTest.json.result && endpointTest.json.result.status && endpointTest.json.endpoint);
    const endpointDetail = await req('GET', '/api/admin/endpoints/dailyArchive', { headers: { 'Cookie': cookie3 } });
    check('GET endpoint 详情含状态、日志与响应预览', endpointDetail.status === 200 && endpointDetail.json.item.state && Array.isArray(endpointDetail.json.item.logs));
    const endpointLogs = await req('GET', '/api/admin/endpoints/logs?id=dailyArchive&limit=20', { headers: { 'Cookie': cookie3 } });
    check('GET endpoint logs 可按接口查看', endpointLogs.status === 200 && endpointLogs.json.items.length >= 1 && endpointLogs.json.items.every((item) => item.id === 'dailyArchive'));
    const customEndpoint = await req('POST', '/api/admin/endpoints', { headers: H3, body: JSON.stringify({ name: '测试外部 JSON', sourceName: 'Example', url: 'https://example.com/feed.json', format: 'json', itemsPath: 'data.items', titlePath: 'title', summaryPath: 'summary', urlPath: 'url', datePath: 'date', category: 'industry', maxItems: 10, publishMode: 'draft', enabled: false }) });
    check('POST endpoints 可创建安全关闭的自定义接口', customEndpoint.status === 201 && customEndpoint.json.item.custom === true && customEndpoint.json.item.enabled === false);
    const privateEndpoint = await req('POST', '/api/admin/endpoints', { headers: H3, body: JSON.stringify({ name: '内网接口', url: 'https://127.0.0.1/feed', format: 'rss' }) });
    check('自定义接口阻止内网 SSRF', privateEndpoint.status === 400);
    const customDelete = await req('DELETE', '/api/admin/endpoints/' + customEndpoint.json.item.id, { headers: H3 });
    check('DELETE endpoints 可删除自定义接口', customDelete.status === 200);

    console.log('\n[6.9] SEO 管理');
    const seo = await req('GET', '/api/admin/seo', { headers: { 'Cookie': cookie3 } });
    check('GET SEO 返回设置、关键词与六类统计', seo.status === 200 && seo.json.settings && Array.isArray(seo.json.keywords) && seo.json.sitemapUrls > 0 && seo.json.categories.length === 6 && seo.json.categories.some((item) => item.slug === 'tutorial'));
    const badSeo = await req('POST', '/api/admin/seo', { headers: H3, body: JSON.stringify({ seoSiteUrl: 'http://example.com' }) });
    check('SEO 站点地址仅允许 HTTPS，只有本机开发可用 HTTP', badSeo.status === 400);
    const seoSave = await req('POST', '/api/admin/seo', { headers: H3, body: JSON.stringify({ seoSiteTitle: 'AIQB 测试标题', seoShortTitle: 'AIQB 测试', seoDescription: '这是用于验证动态 SEO 首页元数据即时生效的完整测试描述。', seoKeywords: 'AI测试,大模型测试', seoSiteUrl: 'https://chenqiyuan.cn', seoIndexingEnabled: true }) });
    check('POST SEO 可持久化并返回新仪表盘', seoSave.status === 200 && seoSave.json.dashboard.settings.siteTitle === 'AIQB 测试标题');
    const seoHome = await req('GET', '/');
    check('首页 SEO 标题、正文 H1、品牌名、描述和结构化数据动态生效', seoHome.status === 200 && seoHome.text.indexOf('<title>AIQB 测试标题</title>') !== -1 && seoHome.text.indexOf('<h1>AIQB 测试：每日 AI 资讯与大模型动态</h1>') !== -1 && seoHome.text.indexOf('"name":"AIQB 测试"') !== -1 && seoHome.text.indexOf('动态 SEO 首页元数据') !== -1 && seoHome.text.indexOf('application/ld+json') !== -1);

    // ---------- 设置 ----------
    console.log('\n[7] 运行设置');
    const badCfg = await req('POST', '/api/admin/settings', {
      headers: H3, body: JSON.stringify({ collectIntervalHours: 999 }),
    });
    check('非法设置被拒 400', badCfg.status === 400);
    const cfg = await req('POST', '/api/admin/settings', {
      headers: H3, body: JSON.stringify({ collectIntervalHours: 6, retentionDays: 90 }),
    });
    check('保存设置 200', cfg.status === 200 && cfg.json.config.collectIntervalHours === 6);
    const cfgFile = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
    check('设置已持久化到 config.json', cfgFile.collectIntervalHours === 6 && cfgFile.retentionDays === 90);
    const settings = await req('GET', '/api/admin/settings', { headers: { 'Cookie': cookie3 } });
    check('GET settings 200 含 env', settings.status === 200 && !!(settings.json.env && settings.json.env.dataDir));
    const siteDefault = await req('GET', '/api/site-settings');
    check('自定义 Header 默认关闭且公开页脚设置完整', siteDefault.status === 200 && siteDefault.json.enabled === false && siteDefault.json.footer.enabled === true && siteDefault.json.footer.icpNumber === '粤ICP备2025432484号');
    check('公开设置包含品牌、图标、展示、健康球与首页数量分组', siteDefault.json.branding && siteDefault.json.branding.alias === 'AIQB' && siteDefault.json.appearance.defaultTheme === 'light' && siteDefault.json.health.enabled === true && siteDefault.json.health.refreshMinutes === 10 && siteDefault.json.content.homeLatestCount === 10);
    const badBrandAsset = await req('POST', '/api/admin/settings', { headers: H3, body: JSON.stringify({ siteLogoUrl: 'javascript:alert(1)' }) });
    check('品牌图标阻止危险协议', badBrandAsset.status === 400);
    const badHealthRefresh = await req('POST', '/api/admin/settings', { headers: H3, body: JSON.stringify({ healthWidgetRefreshMinutes: 5 }) });
    check('健康球刷新间隔限制为 10–60 分钟', badHealthRefresh.status === 400);
    const brandCfg = await req('POST', '/api/admin/settings', { headers: H3, body: JSON.stringify({ seoShortTitle: '圈测情报', siteBrandAlias: 'AQTEST', siteTagline: '每天快速掌握人工智能动态', siteEnglishTagline: 'Daily AI intelligence in one place', siteLogoUrl: '/icon-192.png', siteFaviconUrl: '/favicon.svg', defaultTheme: 'system', showLanguageSwitcher: false, showStatusStrip: false, healthWidgetEnabled: false, healthWidgetRefreshMinutes: 20, homeLatestCount: 7 }) });
    check('后台可统一保存品牌、图标与前台体验设置', brandCfg.status === 200 && brandCfg.json.config.siteBrandAlias === 'AQTEST' && brandCfg.json.config.healthWidgetEnabled === false && brandCfg.json.config.homeLatestCount === 7);
    const siteBranded = await req('GET', '/api/site-settings');
    check('公开设置仅输出前台需要的安全配置', siteBranded.status === 200 && siteBranded.json.branding.name === '圈测情报' && siteBranded.json.branding.logoUrl === '/icon-192.png' && siteBranded.json.appearance.showLanguageSwitcher === false && siteBranded.json.appearance.showStatusStrip === false && siteBranded.json.health.enabled === false && siteBranded.json.health.refreshMinutes === 20 && siteBranded.json.content.homeLatestCount === 7 && !Object.prototype.hasOwnProperty.call(siteBranded.json, 'collectIntervalHours'));
    const brandedHome = await req('GET', '/');
    check('品牌名称、简称、Logo、favicon、副标题与结构化数据服务端即时生效', brandedHome.status === 200 && brandedHome.text.indexOf('id="site-name-text">圈测情报</span>') !== -1 && brandedHome.text.indexOf('id="site-brand-alias">AQTEST</span>') !== -1 && brandedHome.text.indexOf('id="site-logo" src="/icon-192.png"') !== -1 && brandedHome.text.indexOf('id="runtime-favicon" href="/favicon.svg"') !== -1 && brandedHome.text.indexOf('每天快速掌握人工智能动态') !== -1 && brandedHome.text.indexOf('"alternateName":"AQTEST"') !== -1);
    const dynamicManifest = await req('GET', '/site.webmanifest');
    check('Web Manifest 同步品牌简称和可配置图标', dynamicManifest.status === 200 && /application\/manifest\+json/.test(dynamicManifest.headers.get('content-type') || '') && dynamicManifest.json.short_name === 'AQTEST' && dynamicManifest.json.icons[0].src === '/icon-192.png');
    const headerCfg = await req('POST', '/api/admin/settings', {
      headers: H3,
      body: JSON.stringify({ customHeaderEnabled: true, customHeaderMode: 'popup', customHeaderCode: '<h3>系统公告</h3><script>alert(1)</script><img src=x onerror=alert(2)>' }),
    });
    check('自定义 Header 设置可持久化', headerCfg.status === 200 && headerCfg.json.config.customHeaderMode === 'popup');
    const siteEnabled = await req('GET', '/api/site-settings');
    check('公开 Header 配置启用且危险代码被过滤', siteEnabled.status === 200 && siteEnabled.json.enabled === true && siteEnabled.json.mode === 'popup' && siteEnabled.json.code.indexOf('<script') === -1 && !/onerror\s*=/i.test(siteEnabled.json.code));
    const badFooter = await req('POST', '/api/admin/settings', { headers: H3, body: JSON.stringify({ footerIcpUrl: 'javascript:alert(1)' }) });
    check('页脚备案链接阻止非 HTTPS 地址', badFooter.status === 400);
    const footerCfg = await req('POST', '/api/admin/settings', {
      headers: H3,
      body: JSON.stringify({ footerEnabled: true, footerCopyrightText: '2026 Copyright © AIQB 测试站', footerIcpNumber: '粤ICP备TEST号', footerIcpUrl: 'https://beian.miit.gov.cn/' }),
    });
    check('后台可编辑并持久化页脚版权备案', footerCfg.status === 200 && footerCfg.json.config.footerCopyrightText === '2026 Copyright © AIQB 测试站' && footerCfg.json.changedKeys.indexOf('footerCopyrightText') !== -1);
    const footerHome = await req('GET', '/');
    const footerArticle = await req('GET', '/article/' + publicId);
    check('页脚修改即时同步到首页和文章页', footerHome.text.indexOf('2026 Copyright © AIQB 测试站') !== -1 && footerHome.text.indexOf('粤ICP备TEST号') !== -1 && footerArticle.text.indexOf('2026 Copyright © AIQB 测试站') !== -1);
    const footerDisabled = await req('POST', '/api/admin/settings', { headers: H3, body: JSON.stringify({ footerEnabled: false }) });
    const footerDisabledHome = await req('GET', '/');
    const footerDisabledArticle = await req('GET', '/article/' + publicId);
    check('关闭自定义版权后项目来源署名仍不可移除', footerDisabled.status === 200 && footerDisabledHome.text.indexOf('2026 Copyright © AIQB 测试站') === -1 && footerDisabledHome.text.indexOf('设计与开发由') !== -1 && footerDisabledHome.text.indexOf('https://github.com/chenfengyimei/AIQB') !== -1 && footerDisabledArticle.text.indexOf('设计与开发由') !== -1);

    // ---------- 采集（允许外部网络失败） ----------
    console.log('\n[8] 采集控制（外部网络允许失败）');
    const col = await req('POST', '/api/admin/collect', { headers: H3 });
    check('POST collect 返回合法结果', [200, 409, 502].indexOf(col.status) !== -1, 'status=' + col.status);
    const logs = await req('GET', '/api/admin/logs?lines=50', { headers: { 'Cookie': cookie3 } });
    check('GET logs 200 且有采集日志', logs.status === 200 && logs.json.lines && logs.json.lines.length > 0);
    const refresh = await req('GET', '/api/refresh');
    check('公开 GET /api/refresh 已关闭且不会触发采集', refresh.status === 404, 'status=' + refresh.status);
    const refresh2 = await req('GET', '/api/refresh');
    check('重复访问公开刷新入口仍保持关闭', refresh2.status === 404);

    // ---------- 登出与限流 ----------
    console.log('\n[9] 登出与登录限流');
    const crossLogout = await req('POST', '/api/admin/logout', { headers: Object.assign({}, H3, { Origin: 'https://evil.example.com' }) });
    check('跨站注销请求被同源保护拒绝', crossLogout.status === 403);
    const meStill = await req('GET', '/api/admin/me', { headers: { 'Cookie': cookie3 } });
    check('被拒绝的跨站注销不会撤销合法会话', meStill.status === 200);
    const logout = await req('POST', '/api/admin/logout', { headers: H3 });
    check('登出 200 且清除 Cookie', logout.status === 200 && /Max-Age=0/.test(logout.headers.get('set-cookie') || ''));
    const meAfter = await req('GET', '/api/admin/me', { headers: { 'Cookie': cookie3 } });
    check('登出后会话失效 401', meAfter.status === 401);

    let got429 = false;
    let attempts = 0;
    for (let i = 0; i < 12; i++) {
      const r = await req('POST', '/api/admin/login', {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: 'bad-' + i }),
      });
      attempts++;
      if (r.status === 429) { got429 = true; break; }
    }
    check('连续错误登录触发限流 429', got429);

    // ---------- 链接点击统计 ----------
    console.log('\n[10.5] 链接点击统计');
    // [9] 已触发限流（15 分钟窗口）；点击上报本身不受登录影响，直接上报
    const track = await req('POST', '/api/track', {
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://127.0.0.1:3999' },
      body: JSON.stringify({ url: 'https://x.com/Zai_org/status/2093354097122455713', kind: 'item', title: '测试推文' }),
    });
    check('POST /api/track 返回 204', track.status === 204, 'status=' + track.status);
    const trackG = await req('GET', '/api/track?url=' + encodeURIComponent('https://space.bilibili.com/508302628') + '&kind=friend&title=f');
    check('GET /api/track（beacon 兼容）204', trackG.status === 204, 'status=' + trackG.status);
    const trackShare = await req('POST', '/api/track', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://chenqiyuan.cn/article/' + publicId, kind: 'share', title: '测试文章' }),
    });
    check('文章分享事件返回 204', trackShare.status === 204, 'status=' + trackShare.status);
    const trackBad = await req('POST', '/api/track', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'javascript:alert(1)', kind: 'item' }),
    });
    check('非法 url scheme 被忽略（仍 204 不报错）', trackBad.status === 204);
    // 直接读落盘文件验证点击记录（避免登录限流窗口干扰会话接口）
    await sleep(12000); // 等待落盘周期
    const statsDir = path.join(DATA_DIR, 'stats');
    const visitsFiles = fs.readdirSync(statsDir).filter((f) => /^visits-.*\.jsonl$/.test(f));
    let clickRecords = [];
    for (const f of visitsFiles) {
      for (const line of fs.readFileSync(path.join(statsDir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.k === 'click') clickRecords.push(r);
        } catch (e) {}
      }
    }
    check('点击与分享记录已落盘（3 条）', clickRecords.length === 3, JSON.stringify(clickRecords));
    const friendRec = clickRecords.find((r) => r.ck === 'friend');
    const itemRec = clickRecords.find((r) => r.ck === 'item');
    const shareRec = clickRecords.find((r) => r.ck === 'share');
    check('友链点击 kind=friend 且 url 正确', !!(friendRec && String(friendRec.p).indexOf('bilibili.com/508302628') !== -1));
    check('情报点击含 title', !!(itemRec && itemRec.ct === '测试推文'));
    check('文章分享独立记录且不混入情报点击', !!(shareRec && shareRec.ct === '测试文章'));
    const savedStats = JSON.parse(fs.readFileSync(path.join(statsDir, 'daily.json'), 'utf8'));
    const savedToday = savedStats.days && savedStats.days[Object.keys(savedStats.days).sort().slice(-1)[0]];
    check('链接点击与文章分享以 v5 永久日维度口径聚合', savedStats.version === 5 && savedStats.uniqueWindow === 'daily' && savedToday.clicks === 2 && savedToday.itemClicks === 1 && savedToday.friendClicks === 1 && savedToday.articleShares === 1 && savedToday.scopes.click.requests === 3);

    // ---------- 访问统计落盘 ----------
    console.log('\n[10] 访问统计落盘（等待 11s 刷新周期）');
    await sleep(11000);
    const dailyFile = path.join(DATA_DIR, 'stats', 'daily.json');
    check('daily.json 已生成', fs.existsSync(dailyFile));
    if (fs.existsSync(dailyFile)) {
      const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
      const todayKey = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const key = todayKey.getFullYear() + '-' + p(todayKey.getMonth() + 1) + '-' + p(todayKey.getDate());
      const today = daily.days && daily.days[key];
      check('当日统计已按区域和文章口径聚合且永久保留', !!(today && daily.version === 5 && daily.retention === 'forever' && daily.uniqueWindow === 'daily' && today.pv > 0 && today.articlePv >= 1 && today.articleShares === 1 && today.ips >= 1 && today.scopes && today.scopes.frontend && today.scopes.admin && today.scopes.click), JSON.stringify(today || null));
    }
    const visitsFile = path.join(DATA_DIR, 'stats', fs.readdirSync(path.join(DATA_DIR, 'stats')).find((f) => /^visits-.*\.jsonl$/.test(f)));
    const visitLines = fs.readFileSync(visitsFile, 'utf8').split('\n').filter((l) => l.trim());
    const visitRecords = visitLines.map((line) => { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean);
    check('当日流水保存日级哈希、IP 网段与地域且不落完整 IP', visitRecords.length > 0 && visitRecords.some((line) => line.seg === '8.8.8.0/24' && line.g && line.g.regionCode === 'CN-GD') && !/\b(?:127\.0\.0\.1|8\.8\.8\.42)\b/.test(JSON.stringify(visitRecords)));
  } finally {
    child.kill();
    await sleep(300);
    try { if (process.platform === 'win32') child.kill('taskkill', ['/pid', String(child.pid), '/F', '/T']); } catch (e) {}
  }

  console.log('\n================ 结果汇总 ================');
  console.log('PASS: ' + pass + '  FAIL: ' + fail);
  if (failures.length) {
    console.log('失败项:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('数据目录（可手动清理）: ' + DATA_DIR);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('冒烟测试自身异常:', err);
  process.exit(2);
});
