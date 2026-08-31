#!/usr/bin/env node
'use strict';

// AIQB 无外部依赖的闭环用户旅程压测。
// 示例：node scripts/perf_test.js --base=http://127.0.0.1:3001 --users=50 --seconds=60 --think=500

const { setTimeout: delay } = require('timers/promises');

function args() {
  const out = {};
  for (const entry of process.argv.slice(2)) {
    const match = entry.match(/^--([^=]+)=(.*)$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function main() {
  const o = args();
  const base = String(o.base || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const users = Math.max(1, Math.min(1000, Number(o.users) || 25));
  const seconds = Math.max(5, Math.min(1800, Number(o.seconds) || 30));
  const think = Math.max(0, Math.min(10000, Number(o.think) || 500));
  const token = String(o.token || process.env.AIQB_BENCHMARK_TOKEN || '');
  const deadline = Date.now() + seconds * 1000;
  const results = [];
  let articleIds = [];

  const request = async (pathname) => {
    const started = performance.now();
    let status = 0, bytes = 0, error = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const headers = { Accept: pathname.startsWith('/api/') ? 'application/json' : 'text/html', 'Accept-Encoding': 'gzip' };
      if (token) headers['X-AIQB-Benchmark'] = token;
      const response = await fetch(base + pathname, { headers, signal: controller.signal });
      status = response.status;
      const body = await response.arrayBuffer();
      bytes = body.byteLength;
      if (pathname.startsWith('/api/home') && response.ok) {
        try {
          const payload = JSON.parse(Buffer.from(body).toString('utf8'));
          articleIds = (payload.latest && payload.latest.items || []).map((item) => item._intelId).filter(Boolean).slice(0, 30);
        } catch (_) {}
      }
    } catch (e) { error = String(e && e.name || e); }
    finally { clearTimeout(timer); }
    results.push({ pathname, status, bytes, ms: performance.now() - started, error });
  };

  await request('/health/live');
  await request('/api/home');
  const paths = () => {
    const roll = Math.random();
    if (roll < 0.28) return '/api/home';
    if (roll < 0.62) return '/api/history?range=24h&tier=all&page=1&size=40';
    if (roll < 0.76) return '/api/history?range=7d&tier=selected&page=1&size=40';
    if (roll < 0.86) return '/articles';
    if (roll < 0.92) return '/api/hot';
    if (articleIds.length) return '/article/' + articleIds[Math.floor(Math.random() * articleIds.length)];
    return '/articles';
  };

  const worker = async () => {
    while (Date.now() < deadline) {
      await request(paths());
      if (think) await delay(Math.max(25, think * (0.65 + Math.random() * 0.7)));
    }
  };
  await Promise.all(Array.from({ length: users }, worker));

  const measured = results.filter((row) => row.pathname !== '/health/live');
  const times = measured.map((row) => row.ms);
  const errors = measured.filter((row) => row.status < 200 || row.status >= 400 || row.error);
  const byPath = {};
  for (const row of measured) {
    const key = row.pathname.replace(/\/article\/intel-[a-f0-9]+/, '/article/:id').split('?')[0];
    (byPath[key] ||= []).push(row);
  }
  const summary = {
    base, users, seconds, thinkMs: think,
    requests: measured.length,
    requestsPerSecond: Math.round(measured.length / seconds * 100) / 100,
    errors: errors.length,
    errorRate: Math.round(errors.length / Math.max(1, measured.length) * 10000) / 100,
    latencyMs: {
      p50: Math.round(percentile(times, 0.50) * 10) / 10,
      p95: Math.round(percentile(times, 0.95) * 10) / 10,
      p99: Math.round(percentile(times, 0.99) * 10) / 10,
      // 长时间浸泡会产生十万级样本，避免数组展开超过 V8 调用参数上限。
      max: Math.round(times.reduce((highest, value) => value > highest ? value : highest, 0) * 10) / 10,
    },
    paths: Object.fromEntries(Object.entries(byPath).map(([key, rows]) => {
      const values = rows.map((row) => row.ms);
      return [key, { count: rows.length, p95Ms: Math.round(percentile(values, 0.95) * 10) / 10, errors: rows.filter((row) => row.status < 200 || row.status >= 400 || row.error).length }];
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.errorRate >= 0.1 || summary.latencyMs.p95 >= 800 ? 2 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
