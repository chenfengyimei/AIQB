'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { FriendLinkStore } = require('../server/lib/friend-links');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-friends-'));
let pass = 0;
function check(name, value) {
  console.log((value ? 'PASS ' : 'FAIL ') + name);
  if (!value) process.exitCode = 1;
  else pass++;
}

try {
  const store = new FriendLinkStore(dir);
  store.init();
  check('新友链库默认为空', store.list().summary.total === 0);

  let unsafe = false;
  try { store.create({ name: '危险链接', url: 'javascript:alert(1)' }); } catch (error) { unsafe = true; }
  check('阻止非 HTTP 协议', unsafe);

  const second = store.create({ name: '第二站', url: 'https://two.example.com/path#section', sort: 20, enabled: true });
  const first = store.create({ name: '第一站', url: 'https://one.example.com/', description: '示例说明', sort: 10, enabled: true });
  check('按排序值从小到大返回', store.list().items.map((item) => item.id).join(',') === [first.id, second.id].join(','));
  check('保存时移除 URL hash', second.url === 'https://two.example.com/path');

  let duplicate = false;
  try { store.create({ name: '重复', url: 'https://one.example.com/' }); } catch (error) { duplicate = true; }
  check('拒绝重复链接地址', duplicate);

  store.update(first.id, { name: '第一站新名称', enabled: false, sort: 30 });
  check('支持编辑、停用和排序', store.get(first.id).name === '第一站新名称' && store.get(first.id).enabled === false && store.get(first.id).sort === 30);
  check('公开列表只返回启用项', store.publicItems().length === 1 && store.publicItems()[0].id === second.id);

  const reloaded = new FriendLinkStore(dir);
  reloaded.init();
  check('友链数据可以重新加载', reloaded.list().summary.total === 2 && reloaded.get(first.id).enabled === false);
  check('删除友链即时生效', reloaded.remove(second.id) && reloaded.list().summary.total === 1);
  console.log('RESULT PASS=' + pass + ' FAIL=' + (process.exitCode ? 1 : 0));
} finally {
  const root = path.resolve(os.tmpdir()) + path.sep;
  if (path.resolve(dir).startsWith(root)) fs.rmSync(dir, { recursive: true, force: true });
}
