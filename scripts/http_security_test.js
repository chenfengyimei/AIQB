'use strict';

const assert = require('assert');
const { clientIp, clientGeo, isSecureRequest, sameOriginGuard } = require('../server/lib/http-util');

let pass = 0;
function check(name, fn) { fn(); pass++; console.log('PASS ' + name); }
function request(remoteAddress, headers, encrypted) { return { headers: headers || {}, socket: { remoteAddress, encrypted: encrypted === true } }; }

check('不可信 TCP 对端不能用转发头伪造限流身份', () => {
  const req = request('203.0.113.9', { 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '1.1.1.1', 'eo-connecting-ip': '9.9.9.9' });
  assert.strictEqual(clientIp(req), '203.0.113.9');
});

check('本机 Nginx 覆盖的 X-Real-IP 可作为客户端身份', () => {
  const req = request('127.0.0.1', { 'x-real-ip': '8.8.8.8', 'eo-connecting-ip': '127.0.0.1' });
  assert.strictEqual(clientIp(req), '8.8.8.8');
});

check('地域请求头也只接受可信反向代理来源', () => {
  const spoofed = clientGeo(request('203.0.113.9', { 'eo-client-ipcountry': 'CN', 'eo-client-region-code': 'CN-GD' }));
  const trusted = clientGeo(request('127.0.0.1', { 'eo-client-ipcountry': 'CN', 'eo-client-region-code': 'CN-GD' }));
  assert.strictEqual(spoofed.country, '');
  assert.strictEqual(trusted.regionCode, 'CN-GD');
});

check('不可信对端不能伪造 HTTPS 协议头影响 Cookie', () => {
  assert.strictEqual(isSecureRequest(request('203.0.113.9', { 'x-forwarded-proto': 'https' })), false);
  assert.strictEqual(isSecureRequest(request('127.0.0.1', { 'x-forwarded-proto': 'https' })), true);
  assert.strictEqual(isSecureRequest(request('203.0.113.9', {}, true)), true);
});

check('管理写请求拒绝不同源 Origin', () => {
  assert.strictEqual(sameOriginGuard(request('127.0.0.1', { host: 'example.com', origin: 'https://evil.example' })), false);
  assert.strictEqual(sameOriginGuard(request('127.0.0.1', { host: 'example.com', origin: 'https://example.com' })), true);
});

console.log('RESULT PASS=' + pass + ' FAIL=0');
