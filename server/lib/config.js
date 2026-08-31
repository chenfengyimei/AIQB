// config.js — 运行时配置（持久化到 data/config.json，可在后台「系统设置」中修改）
// 保持零依赖：Node 18+，仅使用内置模块。

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  collectIntervalHours: 12,   // 自动采集间隔（小时），1–168
  retentionDays: 0,           // 历史快照保留天数，0 = 永久保留
  sessionTtlHours: 24 * 7,    // 后台会话有效期（小时），1–720
  customHeaderEnabled: false, // 前台自定义公告是否启用
  customHeaderMode: 'banner', // banner 顶部横幅 / popup 弹窗
  customHeaderCode: '',       // 安全 HTML 子集，前端会过滤脚本与危险属性
  footerEnabled: true,        // 前台与文章页显示版权 / 备案信息
  footerCopyrightText: '2025–2026 Copyright © AI圈报',
  footerIcpNumber: '粤ICP备2025432484号',
  footerIcpUrl: 'https://beian.miit.gov.cn/',
  siteBrandAlias: 'AIQB',
  siteTagline: '每天看懂 AI 圈正在发生什么',
  siteEnglishTagline: 'Understand what is happening in AI, every day',
  siteLogoUrl: '/favicon.svg',
  siteFaviconUrl: '/favicon.ico',
  defaultTheme: 'light',       // light / dark / system，仅用于用户尚未保存偏好时
  showLanguageSwitcher: true,
  showStatusStrip: true,
  healthWidgetEnabled: true,
  healthWidgetRefreshMinutes: 10,
  homeLatestCount: 10,
  seoSiteTitle: 'AI圈报（AIQB）- 每日AI资讯、大模型动态、AI产品与行业热点',
  seoShortTitle: 'AI圈报',
  seoDescription: 'AI圈报（AIQB）每天整理全球 AI 资讯，覆盖 OpenAI、DeepSeek、Qwen、Claude、Gemini 等大模型，以及 AI 产品、行业、论文、教程、热点与日报。',
  seoKeywords: 'AIQB,AI圈报,AI资讯,人工智能资讯,AI新闻,大模型,大模型动态,AI产品,AI热点,AI日报,生成式AI,AI论文,AI教程,OpenAI,DeepSeek,Qwen,Claude,Gemini',
  seoEnglishTitle: 'AIQB - Daily AI News, Model Releases and Industry Intelligence',
  seoEnglishDescription: 'AIQB (AI圈报) tracks daily AI news, model releases, AI products, industry developments, research papers, practical tutorials and emerging technology trends from trusted sources worldwide.',
  seoEnglishKeywords: 'AIQB,AI圈报,AI news,artificial intelligence news,large language models,LLM news,AI model releases,AI products,AI research,AI papers,AI tutorials,OpenAI,DeepSeek,Qwen,Claude,Gemini',
  seoSiteUrl: 'https://chenqiyuan.cn',
  seoIndexingEnabled: true,
};

const RANGES = {
  collectIntervalHours: { min: 1, max: 168, int: true },
  retentionDays: { min: 0, max: 3650, int: true },
  sessionTtlHours: { min: 1, max: 720, int: true },
  healthWidgetRefreshMinutes: { min: 10, max: 60, int: true },
  homeLatestCount: { min: 5, max: 20, int: true },
};

function cleanAssetUrl(value, fallback, fieldName) {
  const input = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  if (!input) return fallback;
  if (/^\/(?!\/)/.test(input) && !/[\\\r\n]/.test(input)) return input.slice(0, 500);
  let url;
  try { url = new URL(input); } catch (e) { throw new Error(fieldName + ' 必须是站内 / 路径或 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(fieldName + ' 仅允许站内 / 路径或无账号信息的 HTTPS 地址');
  return url.toString().slice(0, 500);
}

function cleanSiteOrigin(value, fallback) {
  const input = String(value || '').trim();
  let site;
  try { site = new URL(input); } catch (e) { if (fallback !== undefined) return fallback; throw new Error('seoSiteUrl 必须是有效站点地址'); }
  const localHttp = site.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  if ((site.protocol !== 'https:' && !localHttp) || site.username || site.password || (site.pathname !== '/' && site.pathname !== '')) {
    if (fallback !== undefined) return fallback;
    throw new Error('seoSiteUrl 仅允许 HTTPS 域名根地址；本机开发可使用 http://localhost');
  }
  return site.origin;
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function load(dataDir) {
  const file = path.join(dataDir, 'config.json');
  const cfg = Object.assign({}, DEFAULTS);
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(DEFAULTS)) {
        if (obj[k] !== undefined) cfg[k] = obj[k];
      }
    }
  } catch (e) { /* 首次启动或文件损坏：使用默认值 */ }
  // 升级旧版默认标题；仅匹配系统曾使用的精确默认值，不覆盖后台自定义标题。
  if (cfg.seoSiteTitle === 'AI圈报 - 每日AI资讯、大模型动态与人工智能情报' || cfg.seoSiteTitle === 'AI圈报 - 每日AI资讯、大模型动态、AI产品、论文研究与行业热点') cfg.seoSiteTitle = DEFAULTS.seoSiteTitle;
  if (cfg.seoDescription === 'AI圈报每天整理全球 AI 资讯，覆盖 OpenAI、DeepSeek、Qwen、Claude、Gemini 等大模型，以及 AI 产品、行业、论文、教程、热点与日报。') cfg.seoDescription = DEFAULTS.seoDescription;
  if (cfg.seoEnglishDescription === 'AIQB tracks daily AI news, model releases, AI products, industry developments, research papers, practical tutorials and emerging technology trends from trusted sources worldwide.') cfg.seoEnglishDescription = DEFAULTS.seoEnglishDescription;
  // 越界/类型容错
  for (const k of Object.keys(RANGES)) {
    const r = RANGES[k];
    let v = Number(cfg[k]);
    if (!isFinite(v)) v = DEFAULTS[k];
    if (r.int) v = Math.round(v);
    cfg[k] = Math.min(r.max, Math.max(r.min, v));
  }
  cfg.customHeaderEnabled = cfg.customHeaderEnabled === true;
  cfg.customHeaderMode = cfg.customHeaderMode === 'popup' ? 'popup' : 'banner';
  cfg.customHeaderCode = String(cfg.customHeaderCode || '').replace(/\u0000/g, '').slice(0, 20000);
  cfg.footerEnabled = cfg.footerEnabled !== false;
  cfg.footerCopyrightText = String(cfg.footerCopyrightText || '').replace(/\u0000/g, '').trim().slice(0, 160);
  cfg.footerIcpNumber = String(cfg.footerIcpNumber || '').replace(/\u0000/g, '').trim().slice(0, 100);
  if (cfg.footerIcpUrl) {
    try { const footerUrl = new URL(String(cfg.footerIcpUrl)); cfg.footerIcpUrl = footerUrl.protocol === 'https:' && !footerUrl.username && !footerUrl.password ? footerUrl.toString() : DEFAULTS.footerIcpUrl; }
    catch (e) { cfg.footerIcpUrl = DEFAULTS.footerIcpUrl; }
  } else cfg.footerIcpUrl = '';
  cfg.siteBrandAlias = String(cfg.siteBrandAlias || DEFAULTS.siteBrandAlias).replace(/\u0000/g, '').trim().slice(0, 24);
  cfg.siteTagline = String(cfg.siteTagline || DEFAULTS.siteTagline).replace(/\u0000/g, '').trim().slice(0, 80);
  cfg.siteEnglishTagline = String(cfg.siteEnglishTagline || DEFAULTS.siteEnglishTagline).replace(/\u0000/g, '').trim().slice(0, 100);
  try { cfg.siteLogoUrl = cleanAssetUrl(cfg.siteLogoUrl, DEFAULTS.siteLogoUrl, 'siteLogoUrl'); } catch (e) { cfg.siteLogoUrl = DEFAULTS.siteLogoUrl; }
  try { cfg.siteFaviconUrl = cleanAssetUrl(cfg.siteFaviconUrl, DEFAULTS.siteFaviconUrl, 'siteFaviconUrl'); } catch (e) { cfg.siteFaviconUrl = DEFAULTS.siteFaviconUrl; }
  cfg.defaultTheme = ['light', 'dark', 'system'].includes(cfg.defaultTheme) ? cfg.defaultTheme : DEFAULTS.defaultTheme;
  cfg.showLanguageSwitcher = cfg.showLanguageSwitcher !== false;
  cfg.showStatusStrip = cfg.showStatusStrip !== false;
  cfg.healthWidgetEnabled = cfg.healthWidgetEnabled !== false;
  cfg.seoSiteTitle = String(cfg.seoSiteTitle || DEFAULTS.seoSiteTitle).replace(/\u0000/g, '').trim().slice(0, 100);
  cfg.seoShortTitle = String(cfg.seoShortTitle || DEFAULTS.seoShortTitle).replace(/\u0000/g, '').trim().slice(0, 80);
  cfg.seoDescription = String(cfg.seoDescription || DEFAULTS.seoDescription).replace(/\u0000/g, '').trim().slice(0, 300);
  cfg.seoKeywords = String(cfg.seoKeywords || DEFAULTS.seoKeywords).replace(/\u0000/g, '').trim().slice(0, 1000);
  cfg.seoEnglishTitle = String(cfg.seoEnglishTitle || DEFAULTS.seoEnglishTitle).replace(/\u0000/g, '').trim().slice(0, 120);
  cfg.seoEnglishDescription = String(cfg.seoEnglishDescription || DEFAULTS.seoEnglishDescription).replace(/\u0000/g, '').trim().slice(0, 320);
  cfg.seoEnglishKeywords = String(cfg.seoEnglishKeywords || DEFAULTS.seoEnglishKeywords).replace(/\u0000/g, '').trim().slice(0, 1200);
  if (!/(^|[,，\s])AIQB([,，\s]|$)/i.test(cfg.seoKeywords)) cfg.seoKeywords = ('AIQB,AI圈报,' + cfg.seoKeywords).slice(0, 1000);
  if (!/(^|[,，\s])AI圈报([,，\s]|$)/i.test(cfg.seoEnglishKeywords)) cfg.seoEnglishKeywords = ('AIQB,AI圈报,' + cfg.seoEnglishKeywords).slice(0, 1200);
  cfg.seoSiteUrl = cleanSiteOrigin(cfg.seoSiteUrl || DEFAULTS.seoSiteUrl, DEFAULTS.seoSiteUrl);
  cfg.seoIndexingEnabled = cfg.seoIndexingEnabled !== false;
  return cfg;
}

function save(dataDir, cfg) {
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = cfg[k];
  atomicWrite(path.join(dataDir, 'config.json'), JSON.stringify(clean, null, 2) + '\n');
}

// 后台提交的增量更新：校验并返回 {config, changedKeys}
function apply(current, patch) {
  const next = Object.assign({}, current);
  const changed = [];
  if (!patch || typeof patch !== 'object') return { config: next, changedKeys: changed };
  for (const k of Object.keys(RANGES)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const r = RANGES[k];
    let v = Number(patch[k]);
    if (!isFinite(v)) throw new Error(k + ' 必须是数字');
    if (r.int) v = Math.round(v);
    if (v < r.min || v > r.max) throw new Error(k + ' 超出允许范围 ' + r.min + '–' + r.max);
    if (v !== next[k]) { next[k] = v; changed.push(k); }
  }
  if (patch.customHeaderEnabled !== undefined) {
    const v = patch.customHeaderEnabled === true;
    if (v !== next.customHeaderEnabled) { next.customHeaderEnabled = v; changed.push('customHeaderEnabled'); }
  }
  if (patch.customHeaderMode !== undefined) {
    const v = String(patch.customHeaderMode);
    if (v !== 'banner' && v !== 'popup') throw new Error('customHeaderMode 仅支持 banner 或 popup');
    if (v !== next.customHeaderMode) { next.customHeaderMode = v; changed.push('customHeaderMode'); }
  }
  if (patch.customHeaderCode !== undefined) {
    const v = String(patch.customHeaderCode || '').replace(/\u0000/g, '');
    if (v.length > 20000) throw new Error('customHeaderCode 不能超过 20000 个字符');
    if (v !== next.customHeaderCode) { next.customHeaderCode = v; changed.push('customHeaderCode'); }
  }
  if (patch.footerEnabled !== undefined) {
    const v = patch.footerEnabled === true;
    if (v !== next.footerEnabled) { next.footerEnabled = v; changed.push('footerEnabled'); }
  }
  const footerText = { footerCopyrightText: 160, footerIcpNumber: 100 };
  for (const k of Object.keys(footerText)) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] || '').replace(/\u0000/g, '').trim();
    if (v.length > footerText[k]) throw new Error(k + ' 不能超过 ' + footerText[k] + ' 个字符');
    if (v !== next[k]) { next[k] = v; changed.push(k); }
  }
  if (patch.footerIcpUrl !== undefined) {
    const input = String(patch.footerIcpUrl || '').trim();
    let v = '';
    if (input) {
      let url; try { url = new URL(input); } catch (e) { throw new Error('footerIcpUrl 必须是有效 HTTPS 地址'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('footerIcpUrl 仅允许无账号信息的 HTTPS 地址');
      v = url.toString();
    }
    if (v !== next.footerIcpUrl) { next.footerIcpUrl = v; changed.push('footerIcpUrl'); }
  }
  const brandText = { siteBrandAlias: [2, 24], siteTagline: [2, 80], siteEnglishTagline: [2, 100] };
  for (const k of Object.keys(brandText)) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] || '').replace(/\u0000/g, '').trim();
    const range = brandText[k];
    if (v.length < range[0] || v.length > range[1]) throw new Error(k + ' 长度必须为 ' + range[0] + '–' + range[1] + ' 个字符');
    if (v !== next[k]) { next[k] = v; changed.push(k); }
  }
  for (const k of ['siteLogoUrl', 'siteFaviconUrl']) {
    if (patch[k] === undefined) continue;
    const v = cleanAssetUrl(patch[k], DEFAULTS[k], k);
    if (v !== next[k]) { next[k] = v; changed.push(k); }
  }
  if (patch.defaultTheme !== undefined) {
    const v = String(patch.defaultTheme || '');
    if (!['light', 'dark', 'system'].includes(v)) throw new Error('defaultTheme 仅支持 light、dark 或 system');
    if (v !== next.defaultTheme) { next.defaultTheme = v; changed.push('defaultTheme'); }
  }
  for (const k of ['showLanguageSwitcher', 'showStatusStrip', 'healthWidgetEnabled']) {
    if (patch[k] === undefined) continue;
    const v = patch[k] === true;
    if (v !== next[k]) { next[k] = v; changed.push(k); }
  }
  const seoText = { seoSiteTitle: [2, 100], seoShortTitle: [2, 80], seoDescription: [20, 300], seoKeywords: [2, 1000], seoEnglishTitle: [10, 120], seoEnglishDescription: [30, 320], seoEnglishKeywords: [10, 1200] };
  for (const k of Object.keys(seoText)) {
    if (patch[k] === undefined) continue;
    const v = String(patch[k] || '').replace(/\u0000/g, '').trim();
    const range = seoText[k];
    if (v.length < range[0] || v.length > range[1]) throw new Error(k + ' 长度必须为 ' + range[0] + '–' + range[1] + ' 个字符');
    if (v !== next[k]) { next[k] = v; changed.push(k); }
  }
  if (patch.seoSiteUrl !== undefined) {
    const v = cleanSiteOrigin(patch.seoSiteUrl);
    if (v !== next.seoSiteUrl) { next.seoSiteUrl = v; changed.push('seoSiteUrl'); }
  }
  if (patch.seoIndexingEnabled !== undefined) {
    const v = patch.seoIndexingEnabled === true;
    if (v !== next.seoIndexingEnabled) { next.seoIndexingEnabled = v; changed.push('seoIndexingEnabled'); }
  }
  return { config: next, changedKeys: changed };
}

module.exports = { DEFAULTS, load, save, apply, atomicWrite, cleanSiteOrigin };
