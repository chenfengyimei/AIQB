#!/usr/bin/env node
/**
 * AI圈报 - 百度普通收录每日提交
 * 站点: https://chenqiyuan.cn
 *
 * 从 sitemap 提取最新中文文章详情页，逐条预检后提交到百度普通收录接口。
 * 安全: Token 从环境变量 BAIDU_PUSH_TOKEN 读取，全程不出现在任何输出/日志/文件中。
 *
 * 用法:
 *   node baidu-push.js            正式提交
 *   node baidu-push.js --dry-run  仅测试 sitemap 解析/过滤/预检，不调用百度接口
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const SITEMAP_URL = 'https://chenqiyuan.cn/sitemap.xml';
const BAIDU_API_BASE = 'http://data.zz.baidu.com/urls';
const BAIDU_SITE = 'chenqiyuan.cn';
const STATE_FILE_PATH = path.join(__dirname, '..', '.baidu-push-state.json');
const ARTICLE_PREFIX = 'https://chenqiyuan.cn/article/';
const EXCLUDE_PATTERNS = [/\/en\//i, /\/rss/i, /\/admin/i, /\/api\//i, /[?#]/];
const MAX_DAILY_SUCCESS = 10;
const HTTP500_RETRY_WAIT_MS = 5000;
const FETCH_TIMEOUT_MS = 20000;

// Token: 仅从环境变量读取，绝不输出/写入文件
const TOKEN = process.env.BAIDU_PUSH_TOKEN || '';

// ==================== 工具函数 ====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  // 以北京时间 (UTC+8) 的日期为准
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return bj.toISOString().slice(0, 10);
}

function normalizeUrl(u) {
  return u.replace(/[#?].*$/, '').replace(/\/$/, '');
}

function log(msg) {
  console.log(msg);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ==================== Sitemap 获取与解析 ====================
async function fetchSitemap(url, depth = 0) {
  if (depth > 3) return [];
  let res;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    if (depth === 0) throw new Error('Sitemap 获取失败: ' + e.message);
    return [];
  }
  if (!res.ok) {
    if (depth === 0) throw new Error('Sitemap HTTP ' + res.status);
    return [];
  }
  const xml = await res.text();
  return parseSitemapXml(xml, depth);
}

async function parseSitemapXml(xml, depth) {
  const results = [];
  const locRe = /<loc>(?:<!\[CDATA\[)?\s*([\s\S]*?)\s*(?:\]\]>)?<\/loc>/i;
  const lastmodRe = /<lastmod>([\s\S]*?)<\/lastmod>/i;

  // 1. 检查子 sitemap (sitemapindex)
  const subRe = /<sitemap>([\s\S]*?)<\/sitemap>/gi;
  let m;
  const subs = [];
  while ((m = subRe.exec(xml)) !== null) {
    const loc = m[1].match(locRe);
    if (loc) subs.push(loc[1].trim());
  }
  if (subs.length > 0) {
    for (const sub of subs) {
      const subResults = await fetchSitemap(sub, depth + 1);
      results.push(...subResults);
    }
    return results;
  }

  // 2. 解析 url 条目
  const urlRe = /<url>([\s\S]*?)<\/url>/gi;
  while ((m = urlRe.exec(xml)) !== null) {
    const block = m[1];
    const loc = block.match(locRe);
    const lastmod = block.match(lastmodRe);
    if (loc) {
      results.push({
        url: loc[1].trim(),
        lastmod: lastmod ? lastmod[1].trim() : null,
        index: results.length,
      });
    }
  }
  return results;
}

// ==================== 过滤与排序 ====================
function filterArticles(entries) {
  return entries.filter((e) => {
    if (!e.url.startsWith(ARTICLE_PREFIX)) return false;
    for (const pat of EXCLUDE_PATTERNS) {
      if (pat.test(e.url)) return false;
    }
    return true;
  });
}

function sortArticles(entries) {
  // lastmod 从新到旧; 无 lastmod 的保留原始顺序排在后面
  const withMod = entries.filter((e) => e.lastmod);
  const withoutMod = entries.filter((e) => !e.lastmod);
  withMod.sort((a, b) => (b.lastmod < a.lastmod ? -1 : b.lastmod > a.lastmod ? 1 : 0));
  return [...withMod, ...withoutMod];
}

// ==================== 状态文件管理 ====================
function loadState() {
  if (!fs.existsSync(STATE_FILE_PATH)) return [];
  const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.submitted) ? parsed.submitted : [];
}

function saveState(submitted) {
  const dir = path.dirname(STATE_FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = {
    site: 'chenqiyuan.cn',
    note: '百度普通收录提交状态 - 不含 Token',
    lastRun: new Date().toISOString(),
    submitted: submitted,
  };
  fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function isAlreadySubmitted(url, submittedList) {
  return submittedList.some((s) => s.url === url);
}

function getTodaySuccessCount(submittedList) {
  const today = todayStr();
  return submittedList.filter((s) => s.date === today).length;
}

// ==================== 文章预检 ====================
async function preCheckArticle(url) {
  try {
    const res = await fetchWithTimeout(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, reason: '页面跳转 (HTTP ' + res.status + ')' };
    }
    if (res.status === 404) {
      return { ok: false, reason: '页面 404' };
    }
    if (res.status !== 200) {
      return { ok: false, reason: 'HTTP ' + res.status };
    }
    const html = await res.text();

    // noindex 检查
    const robotsMatch = html.match(/<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["']/i);
    if (robotsMatch && /noindex/i.test(robotsMatch[1])) {
      return { ok: false, reason: '页面 noindex' };
    }

    // canonical 检查: 若存在则必须指向自身
    const canonMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (canonMatch) {
      const canon = normalizeUrl(canonMatch[1].trim());
      const self = normalizeUrl(url);
      if (canon !== self) {
        return { ok: false, reason: 'canonical 指向 ' + canonMatch[1].trim() };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: '预检异常: ' + e.message };
  }
}

// ==================== 百度提交 ====================
async function submitToBaidu(url) {
  if (!TOKEN) {
    return { status: 'error', reason: '环境变量 BAIDU_PUSH_TOKEN 未设置', stop: true };
  }
  const apiUrl = BAIDU_API_BASE + '?site=' + encodeURIComponent(BAIDU_SITE) + '&token=' + TOKEN;

  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: url,
      });
    } catch (e) {
      if (attempt === 0) {
        await sleep(HTTP500_RETRY_WAIT_MS);
        continue;
      }
      return { status: 'error', reason: '网络异常: ' + e.message, stop: true };
    }

    // HTTP 500: 重试一次
    if (res.status === 500) {
      if (attempt === 0) {
        await sleep(HTTP500_RETRY_WAIT_MS);
        continue;
      }
      return { status: 'error', reason: '百度接口 HTTP 500 (重试后仍失败)', stop: true };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return { status: 'error', reason: '百度响应解析失败 (HTTP ' + res.status + ')', stop: true };
    }

    // Token 错误
    if (res.status === 401 || data.error === 401) {
      return { status: 'error', reason: 'Token 错误或失效', stop: true };
    }
    // 站点未注册
    if (res.status === 404 || data.error === 404) {
      return { status: 'error', reason: '百度站点未注册或 site 参数错误', stop: true };
    }
    // not_same_site
    if (data.not_same_site && data.not_same_site.length > 0) {
      return { status: 'error', reason: 'not_same_site (URL 不属于本站)', stop: true };
    }
    // not_valid
    if (data.not_valid && data.not_valid.length > 0) {
      return { status: 'error', reason: 'not_valid (URL 格式无效)', stop: true };
    }

    // 成功
    if (res.status === 200 && data.success === 1) {
      return {
        status: 'success',
        remain: typeof data.remain === 'number' ? data.remain : null,
        response: { success: data.success, remain: data.remain },
      };
    }

    // success=0 且 remain=0: 配额用尽
    if (data.remain === 0) {
      return { status: 'quota_exhausted', reason: '配额已用尽 (remain=0)', remain: 0, stop: true };
    }
    // 其他未成功情况
    return {
      status: 'error',
      reason: '提交未成功 (success=' + data.success + ', remain=' + data.remain + ')',
      remain: data.remain,
      stop: true,
    };
  }
  return { status: 'error', reason: '重试耗尽', stop: true };
}

// ==================== 主流程 ====================
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const report = {
    sitemapTotal: 0,
    articleFiltered: 0,
    newArticlesFound: 0,
    successCount: 0,
    remain: null,
    skipped: [],
    failed: [],
    submittedUrls: [],
  };

  log('');
  log('=== AI圈报 - 百度普通收录每日提交 ===');
  log('运行时间: ' + new Date().toISOString() + ' (北京时间 ' + todayStr() + ')');
  log('模式: ' + (dryRun ? 'DRY-RUN (不调用百度接口)' : '正式提交'));
  log('');

  // 1. 加载状态文件
  let submitted;
  try {
    submitted = loadState();
  } catch (e) {
    log('状态文件读取失败: ' + e.message);
    printReport(report);
    return;
  }
  const todayCount = getTodaySuccessCount(submitted);
  log('状态文件已记录提交数: ' + submitted.length + ' 条');
  log('今日已成功提交(脚本记录): ' + todayCount + ' 条');
  log('');

  // 2. 获取 sitemap
  let entries;
  try {
    log('正在获取 Sitemap: ' + SITEMAP_URL);
    entries = await fetchSitemap(SITEMAP_URL);
  } catch (e) {
    log('Sitemap 获取失败: ' + e.message);
    printReport(report);
    return;
  }
  report.sitemapTotal = entries.length;
  log('Sitemap URL 总数: ' + entries.length);

  // 3. 过滤 + 排序
  const articles = filterArticles(entries);
  report.articleFiltered = articles.length;
  log('过滤后中文文章数: ' + articles.length);
  const sorted = sortArticles(articles);

  // 4. 筛选未提交的
  const newArticles = sorted.filter((a) => !isAlreadySubmitted(a.url, submitted));
  report.newArticlesFound = newArticles.length;
  log('未提交的新文章数: ' + newArticles.length);
  log('');

  // 5. 没有新 URL 时不发请求
  if (newArticles.length === 0) {
    log('没有新文章需要提交，不发送请求。');
    printReport(report);
    return;
  }

  // 今日已达上限也不提交
  if (todayCount >= MAX_DAILY_SUCCESS) {
    log('今日已成功提交 ' + todayCount + ' 条，达到每日上限 ' + MAX_DAILY_SUCCESS + '，不提交。');
    printReport(report);
    return;
  }

  // 6. 逐条预检 + 提交
  let dailySuccess = todayCount;
  let stopAll = false;

  for (const article of newArticles) {
    if (stopAll) break;
    if (dailySuccess >= MAX_DAILY_SUCCESS) {
      log('已达到每日上限 ' + MAX_DAILY_SUCCESS + '，停止。');
      break;
    }

    log('--- 预检: ' + article.url + (article.lastmod ? ' (lastmod: ' + article.lastmod + ')' : ''));

    // 预检
    const check = await preCheckArticle(article.url);
    if (!check.ok) {
      log('  跳过: ' + check.reason);
      report.skipped.push({ url: article.url, reason: check.reason });
      continue;
    }
    log('  预检通过');

    if (dryRun) {
      log('  [DRY-RUN] 模拟提交成功');
      report.submittedUrls.push(article.url);
      report.successCount++;
      dailySuccess++;
      continue;
    }

    // 正式提交
    const result = await submitToBaidu(article.url);
    if (result.status === 'success') {
      report.successCount++;
      report.submittedUrls.push(article.url);
      report.remain = result.remain;
      log('  提交成功! remain=' + result.remain);
      // 写入状态文件
      submitted.push({
        url: article.url,
        date: todayStr(),
        success: result.response.success,
        remain: result.response.remain,
      });
      try {
        saveState(submitted);
      } catch (e) {
        log('  警告: 状态文件保存失败: ' + e.message);
      }
      dailySuccess++;

      if (result.remain === 0) {
        log('  百度剩余配额为 0，停止提交。');
        stopAll = true;
        break;
      }
    } else if (result.status === 'quota_exhausted') {
      report.failed.push({ url: article.url, reason: result.reason });
      report.remain = 0;
      log('  ' + result.reason + '，停止。');
      stopAll = true;
      break;
    } else {
      report.failed.push({ url: article.url, reason: result.reason });
      log('  失败: ' + result.reason);
      if (result.stop) {
        log('  遇到致命错误，停止提交。');
        stopAll = true;
        break;
      }
    }
  }

  printReport(report);
}

function printReport(report) {
  log('');
  log('========== 执行报告 ==========');
  log('Sitemap URL 总数: ' + report.sitemapTotal);
  log('过滤后中文文章数: ' + report.articleFiltered);
  log('本次发现新文章数: ' + report.newArticlesFound);
  log('成功提交数: ' + report.successCount);
  log('百度剩余配额: ' + (report.remain !== null ? report.remain : '未知'));
  log('跳过数量: ' + report.skipped.length);
  if (report.skipped.length > 0) {
    log('跳过详情:');
    for (const s of report.skipped) {
      log('  - ' + s.url + ' -> ' + s.reason);
    }
  }
  log('失败数量: ' + report.failed.length);
  if (report.failed.length > 0) {
    log('失败详情:');
    for (const f of report.failed) {
      log('  - ' + f.url + ' -> ' + f.reason);
    }
  }
  log('本次成功提交的文章 URL:');
  if (report.submittedUrls.length === 0) {
    log('  (无)');
  } else {
    for (const u of report.submittedUrls) {
      log('  - ' + u);
    }
  }
  log('==============================');
}

main().catch((e) => {
  log('程序异常: ' + e.message);
  process.exit(1);
});
