// http-util.js — HTTP 工具集：JSON 响应 / gzip / ETag / cookie / body 解析 / 客户端 IP
// 设计要点：
//   1) 热路径（/api/data）由 server.js 使用预序列化+预压缩缓冲直接写出，不走这里的动态压缩；
//   2) 所有响应统一附加安全头；公开 GET 接口才附加 CORS 头（管理接口同源鉴权，不加 CORS）；
//   3) ETag 为强校验（sha256 截断），支持 If-None-Match 304，降低带宽。

'use strict';

const crypto = require('crypto');
const net = require('net');
const zlib = require('zlib');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Access-Control-Allow-Private-Network': 'true',
};

const GZIP_MIN_BYTES = 512; // 小于该值不压缩（压缩头反而更大）

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

// 解析 JSON 请求体（限制大小，防止滥用）
function parseBody(req, limitBytes) {
  const limit = limitBytes || 64 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject({ status: 413, message: '请求体过大' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject({ status: 400, message: '请求体不是合法 JSON' });
      }
    });
    req.on('error', (e) => reject({ status: 400, message: '读取请求体失败: ' + e.message }));
  });
}

function ipv4Number(value) {
  if (!net.isIPv4(value)) return null;
  return value.split('.').reduce((sum, part) => ((sum << 8) | Number(part)) >>> 0, 0);
}

function addressMatchesRule(address, rule) {
  const normalized = normalizeIp(address);
  const value = String(rule || '').trim();
  if (!value) return false;
  if (!value.includes('/')) return normalizeIp(value) === normalized;
  const parts = value.split('/');
  const base = normalizeIp(parts[0]);
  const bits = Number(parts[1]);
  const ipNum = ipv4Number(normalized);
  const baseNum = ipv4Number(base);
  if (ipNum === null || baseNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function trustedProxyRules() {
  const configured = String(process.env.AIQB_TRUSTED_PROXIES || '').split(',').map((item) => item.trim()).filter(Boolean);
  return ['127.0.0.1', '::1'].concat(configured);
}

function isTrustedProxy(req) {
  const peer = normalizeIp(req && req.socket && req.socket.remoteAddress || '');
  return net.isIP(peer) !== 0 && trustedProxyRules().some((rule) => addressMatchesRule(peer, rule));
}

// 仅在 TCP 对端属于显式可信反向代理时接受它覆盖写入的 X-Real-IP/X-Forwarded-For。
// CDN 厂商头不会直接参与安全决策；应由 Nginx real_ip 模块在受信 CDN CIDR 上转换为 X-Real-IP。
function clientIp(req) {
  const headers = req && req.headers || {};
  const fallback = normalizeIp(req && req.socket && req.socket.remoteAddress || '');
  if (!isTrustedProxy(req)) return net.isIP(fallback) ? fallback : 'unknown';
  const real = normalizeIp(headers['x-real-ip'] || '');
  if (net.isIP(real)) return real;
  const forwarded = String(headers['x-forwarded-for'] || '').split(',').map((item) => normalizeIp(item)).filter((item) => net.isIP(item));
  if (forwarded.length) {
    let candidate = fallback;
    for (let index = forwarded.length - 1; index >= 0; index--) {
      if (!trustedProxyRules().some((rule) => addressMatchesRule(candidate, rule))) break;
      candidate = forwarded[index];
    }
    if (net.isIP(candidate)) return candidate;
  }
  return net.isIP(fallback) ? fallback : 'unknown';
}

function isSecureRequest(req) {
  if (req && req.socket && req.socket.encrypted === true) return true;
  if (!isTrustedProxy(req)) return false;
  return String(req && req.headers && req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  let value = String(ip).trim().replace(/^"|"$/g, '');
  if (value.startsWith('[') && value.indexOf(']') > 0) value = value.slice(1, value.indexOf(']'));
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.replace(/:\d+$/, '');
  if (value.startsWith('::ffff:')) value = value.slice(7); // IPv4-mapped IPv6
  if (value === '::1') return '127.0.0.1';
  return value.split('%')[0];
}

function cleanGeoValue(value, limit) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit || 80);
}

// EdgeOne 可通过网络优化 / 规则引擎把这些字段回源。未配置的字段保持为空，绝不猜测。
function clientGeo(req) {
  if (!isTrustedProxy(req)) return { country: '', regionCode: '', region: '', city: '' };
  const h = req && req.headers || {};
  const first = (names, limit) => {
    for (const name of names) {
      const value = cleanGeoValue(h[name], limit);
      if (value) return value;
    }
    return '';
  };
  const countryRaw = first(['eo-client-ipcountry', 'eo-client-country', 'x-geo-country', 'x-country-code', 'cf-ipcountry', 'cloudfront-viewer-country'], 8).toUpperCase();
  const regionCodeRaw = first(['eo-client-region-code', 'eo-client-ipregion-code', 'x-geo-region-code', 'x-region-code'], 16).toUpperCase();
  return {
    country: /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : '',
    regionCode: /^[A-Z]{2}-[A-Z0-9]{1,4}$/.test(regionCodeRaw) ? regionCodeRaw : '',
    region: first(['eo-client-region', 'eo-client-region-name', 'eo-client-ipregion', 'eo-client-province', 'x-geo-region', 'x-geo-province'], 80),
    city: first(['eo-client-city', 'eo-client-ipcity', 'x-geo-city'], 80),
  };
}

function etagOf(buf) {
  return '"' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24) + '"';
}

function wantsGzip(req) {
  const ae = req.headers['accept-encoding'] || '';
  return ae.toLowerCase().indexOf('gzip') !== -1;
}

function gzip(buf) {
  return new Promise((resolve, reject) => {
    zlib.gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

// 通用 JSON 响应：自动 ETag/304、可选 gzip、可选 CORS
async function sendJSON(req, res, status, obj, opts) {
  const o = opts || {};
  const buf = Buffer.from(JSON.stringify(obj));
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': o.cacheControl || 'no-store',
  }, SECURITY_HEADERS, o.cors ? CORS_HEADERS : {}, o.headers || {});

  if (status === 200 && o.etag !== false) {
    const etag = etagOf(buf);
    headers['ETag'] = etag;
    if (req && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
  }

  let body = buf;
  if (wantsGzip(req) && buf.length >= GZIP_MIN_BYTES && !o.noGzip) {
    try {
      body = await gzip(buf);
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
    } catch (e) { body = buf; /* 压缩失败回退原文 */ }
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

// 低层缓冲输出：用于预序列化/预压缩的热路径（零拷贝到 socket）
function sendBuf(req, res, status, buf, gzipBuf, headers) {
  const h = Object.assign({}, headers, SECURITY_HEADERS);
  let body = buf;
  if (gzipBuf && wantsGzip(req) && gzipBuf.length < buf.length) {
    body = gzipBuf;
    h['Content-Encoding'] = 'gzip';
    h['Vary'] = 'Accept-Encoding';
  } else {
    h['Vary'] = 'Accept-Encoding';
  }
  h['Content-Length'] = body.length;
  res.writeHead(status, h);
  res.end(body);
}

// CSRF 防御（管理写接口）：若请求携带 Origin/Referer，必须与 Host 同源
function sameOriginGuard(req) {
  const host = req.headers.host;
  if (!host) return true; // 无 Host 的非标准客户端，交给后续鉴权
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // 同源 fetch/服务端脚本通常不带 Origin（GET 必不带）
  try {
    const u = new URL(origin);
    const originHost = u.host;
    // 允许缺省端口差异（http:80 / https:443）
    const norm = (s) => s.replace(/:(80|443)$/, '');
    return norm(originHost) === norm(host);
  } catch (e) {
    return false;
  }
}

// 简单内存滑动窗口限流器（单进程场景足够；返回 true 表示放行）
function createRateLimiter() {
  const buckets = new Map(); // key -> number[]（时间戳）
  return {
    allow(key, max, windowMs) {
      const now = Date.now();
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      while (arr.length && now - arr[0] > windowMs) arr.shift();
      if (arr.length >= max) return false;
      arr.push(now);
      // 惰性清理，防止 Map 无限增长
      if (buckets.size > 10000) {
        for (const [k, v] of buckets) {
          if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
        }
      }
      return true;
    },
  };
}

module.exports = {
  SECURITY_HEADERS, CORS_HEADERS,
  parseCookies, parseBody, clientIp, clientGeo, normalizeIp, isTrustedProxy, isSecureRequest,
  etagOf, wantsGzip, gzip, sendJSON, sendBuf,
  sameOriginGuard, createRateLimiter,
};
