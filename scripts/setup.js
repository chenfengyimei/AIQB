#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { DEFAULTS, load, save } = require('../server/lib/config');

const PRESETS = new Set(['community', 'empty', 'full']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--non-interactive') out.nonInteractive = true;
    else if (arg === '--force') out.force = true;
    else if (arg.startsWith('--') && i + 1 < argv.length) out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

function cleanSiteUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (error) { throw new Error('站点地址必须是有效 URL，例如 https://ai.example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '')) throw new Error('站点地址必须是无账号信息的域名根地址');
  return url.origin;
}

function cleanSiteName(value) {
  const name = String(value || '').replace(/\u0000/g, '').trim();
  if (name.length < 2 || name.length > 24) throw new Error('站点名称长度必须为 2–24 个字符');
  return name;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function initialize(options) {
  const opts = options || {};
  const dataDir = path.resolve(opts.dataDir || process.env.AIQB_DATA_DIR || path.join(__dirname, '..', 'server', 'data'));
  const configFile = path.join(dataDir, 'config.json');
  const endpointFile = path.join(dataDir, 'endpoints', 'config.json');
  const configExists = fs.existsSync(configFile);
  const endpointExists = fs.existsSync(endpointFile);
  if (configExists && endpointExists && opts.force !== true) {
    return { changed: false, preserved: true, dataDir, message: '检测到现有安装，已保留站点设置、接口和历史数据' };
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  const siteUrl = cleanSiteUrl(opts.siteUrl || 'http://127.0.0.1:3001');
  const siteName = cleanSiteName(opts.siteName || 'AI圈报');
  const preset = PRESETS.has(String(opts.preset || '').toLowerCase()) ? String(opts.preset).toLowerCase() : 'community';
  if (!configExists || opts.force === true) {
    const current = configExists ? load(dataDir) : Object.assign({}, DEFAULTS);
    const year = new Date().getFullYear();
    Object.assign(current, {
      seoSiteUrl: siteUrl,
      seoShortTitle: siteName,
      siteBrandAlias: siteName === 'AI圈报' ? 'AIQB' : siteName.slice(0, 24),
      footerCopyrightText: 'Copyright © ' + year + ' ' + siteName,
      footerIcpNumber: '',
      footerIcpUrl: '',
    });
    if (siteName !== 'AI圈报') {
      current.seoSiteTitle = siteName + ' - 每日 AI 资讯、大模型动态与行业情报';
      current.seoDescription = siteName + ' 自动聚合并整理每日 AI 资讯、大模型发布、AI 产品、行业动态、论文与实用教程。';
    }
    save(dataDir, current);
  }
  if (!endpointExists || opts.force === true) writeJsonAtomic(endpointFile, { version: 3, preset, updatedAt: new Date().toISOString(), overrides: {}, custom: [] });
  writeJsonAtomic(path.join(dataDir, 'install.json'), {
    version: 1,
    installedAt: new Date().toISOString(),
    siteUrl,
    siteName,
    endpointPreset: preset,
  });
  return { changed: true, preserved: false, dataDir, siteUrl, siteName, preset };
}

function ask(rl, question, fallback) {
  return new Promise((resolve) => rl.question(question + (fallback ? ' [' + fallback + ']' : '') + ': ', (answer) => resolve(answer.trim() || fallback)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更高版本');
  if (!args.nonInteractive && process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      args.siteUrl = await ask(rl, '站点根地址', args.siteUrl || 'http://127.0.0.1:3001');
      args.siteName = await ask(rl, '站点名称', args.siteName || 'AI圈报');
      args.preset = await ask(rl, '接口预设 community（AI圈报 RSS）/ empty / full', args.preset || 'community');
      args.dataDir = await ask(rl, '运行数据目录', args.dataDir || path.join('server', 'data'));
    } finally { rl.close(); }
  }
  const result = initialize(args);
  if (result.preserved) {
    console.log('✓ ' + result.message);
  } else {
    console.log('✓ 首次配置已生成');
    console.log('  站点: ' + result.siteUrl);
    console.log('  数据: ' + result.dataDir);
    console.log('  接口预设: ' + result.preset + (result.preset === 'community' ? '（仅 AI圈报 RSS）' : ''));
  }
  console.log('下一步: 先运行 npm run admin:bootstrap 设置后台密码，再运行 npm start。');
}

if (require.main === module) main().catch((error) => { console.error('安装配置失败: ' + error.message); process.exitCode = 1; });

module.exports = { initialize, parseArgs, cleanSiteUrl, cleanSiteName };
