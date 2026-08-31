'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { Readable } = require('stream');
const { fetchText, isPublicIp, resolvePublicAddress, pinnedLookup } = require('../server/lib/safe-fetch');

let pass = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('PASS ' + name); });
}

function response(chunks, status, headers) {
  const stream = Readable.from(Array.isArray(chunks) ? chunks : [chunks]);
  stream.statusCode = status || 200;
  stream.headers = Object.assign({}, headers || {});
  return stream;
}

async function main() {
  await check('拒绝 IPv4/IPv6 本机、内网、链路本地、保留和映射地址', () => {
    for (const value of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '198.51.100.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.strictEqual(isPublicIp(value), false, value);
    }
    assert.strictEqual(isPublicIp('8.8.8.8'), true);
    assert.strictEqual(isPublicIp('2606:4700:4700::1111'), true);
  });

  await check('DNS 结果包含任何非公网地址时整体拒绝', async () => {
    await assert.rejects(() => resolvePublicAddress('https://feed.example/data', async () => [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ]), /非公网/);
  });

  await check('实际 TLS 请求使用已验证并固定的 DNS 地址', async () => {
    let pinned = '';
    const got = await fetchText('https://feed.example/data?secret=hidden', {
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (url, resolved) => {
        pinned = resolved.address;
        assert.strictEqual(url.hostname, 'feed.example');
        return response('{"ok":true}', 200, { 'content-type': 'application/json' });
      },
    });
    assert.strictEqual(pinned, '8.8.8.8');
    assert.strictEqual(got.body, '{"ok":true}');
    assert.ok(!got.finalUrl.includes('secret='));
  });

  await check('Node 多地址连接模式仍只返回已验证地址', async () => {
    const lookup = pinnedLookup('feed.example', { address: '8.8.8.8', family: 4 });
    const rows = await new Promise((resolve, reject) => lookup('feed.example', { all: true }, (error, value) => error ? reject(error) : resolve(value)));
    assert.deepStrictEqual(rows, [{ address: '8.8.8.8', family: 4 }]);
  });

  await check('重定向目标重新做 DNS 校验并阻止转向内网', async () => {
    let requests = 0;
    await assert.rejects(() => fetchText('https://feed.example/start', {
      resolver: async (host) => host === 'feed.example' ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '127.0.0.1', family: 4 }],
      request: async () => { requests++; return response('', 302, { location: 'https://internal.example/admin' }); },
    }), /非公网/);
    assert.strictEqual(requests, 1);
  });

  await check('分块响应在读取期间超过上限即中止', async () => {
    await assert.rejects(() => fetchText('https://feed.example/large', {
      maxBytes: 1024,
      maxWireBytes: 1024,
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async () => response([Buffer.alloc(700), Buffer.alloc(700)], 200, {}),
    }), /大小限制/);
  });

  await check('压缩响应解码膨胀超过上限时中止', async () => {
    const compressed = zlib.gzipSync(Buffer.alloc(4096, 65));
    await assert.rejects(() => fetchText('https://feed.example/bomb', {
      maxBytes: 1024,
      maxWireBytes: 1024,
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async () => response(compressed, 200, { 'content-encoding': 'gzip', 'content-length': String(compressed.length) }),
    }), /解码后响应超过大小限制/);
  });

  console.log('RESULT PASS=' + pass + ' FAIL=0');
}

main().catch((error) => { console.error(error.stack || error); process.exit(1); });
