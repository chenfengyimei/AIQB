'use strict';

const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const blocked = new net.BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001:10::', 28], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

class SafeFetchError extends Error {
  constructor(code, message, options) {
    super(message);
    this.code = code;
    this.status = options && options.status || 0;
    this.retryable = !!(options && options.retryable);
  }
}

function isPublicIp(value) {
  const ip = String(value || '').split('%')[0];
  const family = net.isIP(ip);
  if (!family) return false;
  if (family === 6 && /^::ffff:/i.test(ip)) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function validateOutboundUrl(value) {
  let url;
  try { url = value instanceof URL ? new URL(value.toString()) : new URL(String(value || '')); } catch (_) {
    throw new SafeFetchError('invalid_url', '外部接口 URL 无效');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new SafeFetchError('unsafe_url', '外部接口只允许无账号信息的标准 HTTPS 地址');
  }
  const host = url.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new SafeFetchError('unsafe_host', '外部接口禁止本机或内网主机名');
  }
  if (net.isIP(host) && !isPublicIp(host)) throw new SafeFetchError('unsafe_address', '外部接口解析到非公网地址');
  return url;
}

async function resolvePublicAddress(value, resolver) {
  const url = validateOutboundUrl(value);
  let rows;
  try {
    rows = await (resolver || dns.lookup)(url.hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new SafeFetchError('dns_failed', '外部接口 DNS 解析失败', { retryable: true });
  }
  if (!Array.isArray(rows) || !rows.length) throw new SafeFetchError('dns_empty', '外部接口 DNS 未返回地址', { retryable: true });
  const normalized = rows.map((row) => ({ address: String(row && row.address || ''), family: Number(row && row.family) || net.isIP(row && row.address) }));
  if (normalized.some((row) => !isPublicIp(row.address))) throw new SafeFetchError('unsafe_address', '外部接口 DNS 包含非公网地址');
  return { url, address: normalized[0].address, family: normalized[0].family };
}

function headersView(headers) {
  const source = headers || {};
  return {
    get(name) {
      const value = source[String(name || '').toLowerCase()];
      return Array.isArray(value) ? value.join(', ') : value == null ? null : String(value);
    },
  };
}

function pinnedLookup(expectedHostname, resolved) {
  return (hostname, lookupOptions, callback) => {
    if (hostname !== expectedHostname) return callback(new SafeFetchError('dns_mismatch', 'TLS 连接主机与已验证主机不一致'));
    if (lookupOptions && lookupOptions.all) return callback(null, [{ address: resolved.address, family: resolved.family }]);
    callback(null, resolved.address, resolved.family);
  };
}

function requestPinned(url, resolved, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      headers: Object.assign({ 'Accept-Encoding': 'gzip, deflate, br' }, options.headers || {}),
      servername: url.hostname,
      lookup: pinnedLookup(url.hostname, resolved),
    }, resolve);
    request.setTimeout(options.timeoutMs, () => request.destroy(new SafeFetchError('timeout', '外部接口请求超时', { retryable: true })));
    request.on('error', (error) => reject(error instanceof SafeFetchError ? error : new SafeFetchError('network_error', '外部接口网络请求失败', { retryable: true })));
    request.end();
  });
}

function decoderFor(value) {
  const encoding = String(value || '').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return null;
  if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.createGunzip();
  if (encoding === 'deflate') return zlib.createInflate();
  if (encoding === 'br') return zlib.createBrotliDecompress();
  throw new SafeFetchError('unsupported_encoding', '外部接口使用了不支持的内容编码');
}

async function readLimitedBody(response, maxBytes, maxWireBytes) {
  const decodedLimit = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const wireLimit = Math.max(1024, Number(maxWireBytes) || decodedLimit);
  const declared = Number(response.headers && response.headers['content-length']) || 0;
  if (declared > wireLimit) {
    response.destroy();
    throw new SafeFetchError('response_too_large', '外部接口响应超过大小限制');
  }
  let wireBytes = 0;
  let decodedBytes = 0;
  const chunks = [];
  const wireLimiter = new Transform({ transform(chunk, encoding, callback) {
    wireBytes += chunk.length;
    callback(wireBytes > wireLimit ? new SafeFetchError('response_too_large', '外部接口响应超过大小限制') : null, chunk);
  } });
  const collector = new Writable({ write(chunk, encoding, callback) {
    decodedBytes += chunk.length;
    if (decodedBytes > decodedLimit) return callback(new SafeFetchError('response_too_large', '外部接口解码后响应超过大小限制'));
    chunks.push(Buffer.from(chunk));
    callback();
  } });
  let decoder;
  try { decoder = decoderFor(response.headers && response.headers['content-encoding']); }
  catch (error) { response.destroy(); throw error; }
  if (decoder) await pipeline(response, wireLimiter, decoder, collector);
  else await pipeline(response, wireLimiter, collector);
  return { body: Buffer.concat(chunks).toString('utf8'), bytes: decodedBytes, wireBytes };
}

async function fetchText(value, options) {
  const opts = Object.assign({ timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: DEFAULT_MAX_BYTES, maxWireBytes: DEFAULT_MAX_BYTES, maxRedirects: 3 }, options || {});
  const resolver = opts.resolver || dns.lookup;
  const request = opts.request || requestPinned;
  let current = validateOutboundUrl(value);
  for (let redirects = 0; redirects <= opts.maxRedirects; redirects++) {
    const resolved = await resolvePublicAddress(current, resolver);
    const response = await request(resolved.url, resolved, opts);
    const status = Number(response.statusCode) || 0;
    const responseHeaders = headersView(response.headers);
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = responseHeaders.get('location');
      response.resume();
      if (!location || redirects >= opts.maxRedirects) throw new SafeFetchError('redirect_rejected', '外部接口重定向次数超过限制');
      current = validateOutboundUrl(new URL(location, current));
      continue;
    }
    const body = await readLimitedBody(response, opts.maxBytes, opts.maxWireBytes);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: responseHeaders,
      body: body.body,
      bytes: body.bytes,
      wireBytes: body.wireBytes,
      finalUrl: current.origin + current.pathname,
    };
  }
  throw new SafeFetchError('redirect_rejected', '外部接口重定向次数超过限制');
}

module.exports = {
  DEFAULT_MAX_BYTES,
  SafeFetchError,
  isPublicIp,
  validateOutboundUrl,
  resolvePublicAddress,
  pinnedLookup,
  readLimitedBody,
  fetchText,
};
