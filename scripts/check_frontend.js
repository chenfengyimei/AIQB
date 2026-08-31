// check_frontend.js — 前端语法与资源引用检查
// 用法：node scripts/check_frontend.js [文件...]（默认检查 frontend/index.html 与 frontend/admin.html）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['frontend/index.html', 'frontend/admin.html'];

let fail = 0;
for (const rel of files) {
  const file = path.join(root, rel);
  const html = fs.readFileSync(file, 'utf8');
  console.log('---- ' + rel + ' ----');

  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  blocks.forEach((s, i) => {
    try { new Function(s.replace(/<\/?script>/g, '')); console.log('script block' + i + ': JS OK'); }
    catch (e) { fail++; console.log('script block' + i + ': ERROR', e.message); }
  });

  // 不应引用外部资源（保持单文件自包含）
  ['stylesheet', '<link rel="icon" href="http', '<img src', '@import', '<script src'].forEach(p => {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const found = html.match(re);
    if (found) { fail++; console.log(p, '-> FOUND', found.length); }
  });

  // HTML 结构闭合粗检
  ['</html>', '</body>', '</head>'].forEach(tag => {
    if (html.indexOf(tag) === -1) { fail++; console.log('missing', tag); }
  });

  console.log('size:', (html.length / 1024).toFixed(1), 'KB');
}
process.exit(fail ? 1 : 0);
