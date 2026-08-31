// collect_test.js — 采集分区容错、校验与去重测试（不访问外网）
'use strict';

const { collect } = require('../server/lib/collect');

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' :: ' + detail : '')); }
}

function item(id, title) {
  return { id, title, summary: title + ' 摘要', source: { name: '测试源' }, links: { original: 'https://example.com/' + id } };
}

function response(value, status) {
  return new Response(JSON.stringify(value), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
}

function fallbackData(size) {
  const rows = Array.from({ length: size || 3 }, (_, index) => item('old-' + index, '旧情报 ' + index));
  return { window7d: rows, window24h: rows.slice(0, 2), hot: rows.slice(0, 2), daily: { report: { sections: [] } } };
}

async function main() {
  const originalFetch = global.fetch;
  try {
    console.log('[1] 正常采集与批内去重');
    global.fetch = async (url) => {
      if (url.includes('hot-topics')) return response({ items: [item('h1', '热点一'), item('h1', '热点一')] });
      if (url.includes('/dailies?')) return response({ items: [{ date: '2026-08-29', leadTitle: '测试日报' }] });
      if (url.includes('dailies')) return response({ report: { sections: [] } });
      return response({ items: [item('a', '情报 A'), item('a', '情报 A'), item('b', '情报 B')] });
    };
    const fresh = await collect({ retries: 0 });
    check('全部分区采集成功', fresh.ok && Object.values(fresh.freshness).every((value) => value === 'fresh'));
    check('上游完全重复条目在采集入口合并', fresh.counts.w7 === 2 && fresh.counts.hot === 1);

    console.log('[2] 单分区失败回退');
    const fallback = fallbackData(4);
    global.fetch = async (url) => {
      if (url.includes('window=7d')) throw new Error('simulated timeout');
      if (url.includes('hot-topics')) return response({ items: [item('h2', '热点二')] });
      if (url.includes('/dailies?')) return response({ items: [{ date: '2026-08-29', leadTitle: '测试日报' }] });
      if (url.includes('dailies')) return response({ report: { sections: [] } });
      return response({ items: [item('n1', '新情报')] });
    };
    const partial = await collect({ retries: 0, fallback });
    check('单分区失败不拖垮整批采集', partial.ok && partial.freshness.window7d === 'fallback' && partial.freshness.window24h === 'fresh');
    check('失败分区沿用最近有效内容并记录警告', partial.data.window7d.length === fallback.window7d.length && partial.warnings.some((warning) => warning.startsWith('items7d:')));

    console.log('[3] 异常数据量保护与全失败判定');
    const largeFallback = fallbackData(20);
    global.fetch = async (url) => {
      if (url.includes('window=7d')) return response({ items: [item('only', '异常少量')] });
      if (url.includes('hot-topics')) return response({ items: [item('h3', '热点三')] });
      if (url.includes('/dailies?')) return response({ items: [{ date: '2026-08-29', leadTitle: '测试日报' }] });
      if (url.includes('dailies')) return response({ report: { sections: [] } });
      return response({ items: [item('n2', '新情报二')] });
    };
    const guarded = await collect({ retries: 0, fallback: largeFallback });
    check('数据量断崖下降时自动保留旧分区', guarded.ok && guarded.freshness.window7d === 'fallback' && guarded.data.window7d.length === 20);

    global.fetch = async () => { throw new Error('all unavailable'); };
    const failed = await collect({ retries: 0, fallback });
    check('核心接口全部失败时不生成伪成功快照', !failed.ok && /核心接口均未刷新/.test(failed.error));
  } finally {
    global.fetch = originalFetch;
  }

  console.log('\nPASS: ' + pass + '  FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(2); });
