// check_frontend.js — 前端语法与资源引用检查
// 用法：node scripts/check_frontend.js [文件...]（默认检查 frontend/index.html 与 frontend/admin.html）
// 检查项：内联/构建产物 JS 语法、禁止外链资源（自托管原则）、引用的本地静态文件必须存在、HTML 结构闭合。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const frontendDir = path.join(root, 'frontend');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['frontend/index.html', 'frontend/admin.html'];

let fail = 0;
function bad(message) { fail++; console.log('ERROR ' + message); }

for (const rel of files) {
  const file = path.join(root, rel);
  const html = fs.readFileSync(file, 'utf8');
  console.log('---- ' + rel + ' ----');

  // 内联脚本语法
  const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
  blocks.forEach((s, i) => {
    try { new Function(s.replace(/<\/?script>/g, '')); }
    catch (e) { bad('script block ' + i + ' 语法错误: ' + e.message); }
  });

  // 资源引用：只约束 <link>/<script>/<img>/<source>/<use>（<a href> 指向站外属正常导航）。
  // rel=canonical/alternate 等是 SEO 元数据声明而非资源加载（如 /rss.xml 为服务端运行时路由），豁免。
  const METADATA_REL = new Set(['canonical', 'alternate', 'author', 'license', 'shortlink', 'search', 'prerender', 'prefetch', 'dns-prefetch', 'preconnect']);
  const seen = new Set();
  for (const tag of (html.match(/<(?:link|script|img|source|use)\b[^>]*>/gi) || [])) {
    const ref = tag.match(/(?:href|src)\s*=\s*["']([^"']+)["']/i);
    if (!ref) continue;
    const relMatch = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
    const relTokens = relMatch ? relMatch[1].trim().toLowerCase().split(/\s+/) : [];
    if (relTokens.some((token) => METADATA_REL.has(token))) continue;
    const target = ref[1].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    if (target.startsWith('#') || /^(?:data|blob):/i.test(target)) continue;
    if (/^(?:https?:)?\/\//i.test(target)) { bad('外链资源被禁止（应自托管）: ' + target); continue; }
    if (!target.startsWith('/')) continue; // 相对路径资源少见，不强制校验
    const local = path.join(frontendDir, target.replace(/^\/+/, '').split(/[?#]/)[0]);
    if (!fs.existsSync(local)) bad('引用的本地资源不存在: ' + target);
  }

  // HTML 结构闭合粗检
  ['</html>', '</body>', '</head>'].forEach((tag) => {
    if (html.indexOf(tag) === -1) bad('missing ' + tag);
  });

  console.log('size:', (html.length / 1024).toFixed(1), 'KB');
}

// 构建产物 CSS：不得引用外部字体/图片（XML 命名空间声明如 @namespace url(...w3.org...) 不是资源加载，豁免）
for (const name of fs.readdirSync(frontendDir)) {
  if (!/\.css$/i.test(name)) continue;
  const css = fs.readFileSync(path.join(frontendDir, name), 'utf8');
  if (/@import\s+(?:url\()?["']?(?:https?:)?\/\//i.test(css)) bad(name + ' 含外部 @import');
  const urlRefs = css.match(/url\(\s*["']?[^)"']*["']?\s*\)/gi) || [];
  for (const ref of urlRefs) {
    const value = ref.replace(/^url\(\s*["']?/i, '').replace(/["']?\s*\)$/, '');
    if (/^(?:https?:)?\/\//i.test(value) && !/\.w3\.org\//i.test(value)) { bad(name + ' 含外部 url() 资源: ' + value); break; }
  }
}

// 构建产物 JS 语法：HTML 只是壳，页面逻辑都在内容哈希命名的 bundle 里
for (const name of fs.readdirSync(frontendDir)) {
  if (!/^(?:admin|index)\.[a-f0-9]{12}\.js$/i.test(name)) continue;
  try { new Function(fs.readFileSync(path.join(frontendDir, name), 'utf8')); console.log(name + ': JS OK'); }
  catch (e) { bad(name + ' 语法错误: ' + e.message); }
}

console.log(fail ? 'RESULT FAIL=' + fail : 'RESULT PASS');
process.exit(fail ? 1 : 0);
