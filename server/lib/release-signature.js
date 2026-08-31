'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SIGNATURE_FILE = 'release-signature.json';
const DEFAULT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlqM3+hCG20HHzlvSVh/rUNoLQAHXhFaX3d5/RkbNzNg=
-----END PUBLIC KEY-----
`;

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function keyIdFor(publicKey) {
  let der;
  try {
    der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  } catch (_) {
    throw new Error('在线更新公钥格式无效');
  }
  return sha256Buffer(der).slice(0, 16);
}

function publicKeyFromEnv(env) {
  const vars = env || process.env;
  const file = String(vars.AIQB_UPDATE_PUBLIC_KEY_FILE || '').trim();
  if (file) {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024) throw new Error('在线更新公钥文件无效');
    return fs.readFileSync(file, 'utf8');
  }
  const inline = String(vars.AIQB_UPDATE_PUBLIC_KEY || '').trim();
  return inline ? inline.replace(/\\n/g, '\n') + (inline.endsWith('\n') ? '' : '\n') : DEFAULT_PUBLIC_KEY;
}

function normalizeRelative(value) {
  const input = String(value || '').replace(/\\/g, '/');
  if (!input || input.startsWith('/') || input.includes('\0') || input.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('发布清单包含不安全路径');
  }
  return input;
}

function normalizeFiles(value) {
  if (!Array.isArray(value) || !value.length || value.length > 20000) throw new Error('发布清单文件列表无效');
  const seen = new Set();
  const files = value.map((item) => {
    const relative = normalizeRelative(item && item.path);
    const digest = String(item && item.sha256 || '').toLowerCase();
    const size = Number(item && item.size);
    if (relative === SIGNATURE_FILE || seen.has(relative) || !/^[0-9a-f]{64}$/.test(digest) || !Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024) {
      throw new Error('发布清单文件记录无效：' + relative);
    }
    seen.add(relative);
    return { path: relative, size, sha256: digest };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return files;
}

function canonicalPayload(value) {
  const manifest = value || {};
  return JSON.stringify({
    schema: 1,
    product: 'aiqb',
    version: String(manifest.version || ''),
    algorithm: 'Ed25519',
    keyId: String(manifest.keyId || ''),
    files: normalizeFiles(manifest.files),
  });
}

function verifyReleaseManifest(value, publicKey) {
  const manifest = value || {};
  if (manifest.schema !== 1 || manifest.product !== 'aiqb' || manifest.algorithm !== 'Ed25519' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))) {
    throw new Error('发布签名清单格式无效');
  }
  const key = String(publicKey || '');
  const keyId = keyIdFor(key);
  if (manifest.keyId !== keyId) throw new Error('发布签名密钥不受信任');
  let signature;
  try { signature = Buffer.from(String(manifest.signature || ''), 'base64'); } catch (_) { signature = Buffer.alloc(0); }
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(canonicalPayload(manifest), 'utf8'), key, signature)) {
    throw new Error('发布签名验证失败');
  }
  return Object.assign({}, manifest, { files: normalizeFiles(manifest.files) });
}

function hashFile(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function verifyPackageFiles(root, manifest) {
  const base = path.resolve(root);
  const prefix = base + path.sep;
  const expected = new Map(normalizeFiles(manifest.files).map((item) => [item.path, item]));
  const actual = [];
  const pending = [base];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('更新包包含符号链接：' + path.relative(base, current));
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) {
        const child = path.resolve(current, name);
        if (child !== base && !child.startsWith(prefix)) throw new Error('更新包路径越界');
        pending.push(child);
      }
      continue;
    }
    if (!stat.isFile()) throw new Error('更新包包含不支持的文件类型：' + path.relative(base, current));
    const relative = path.relative(base, current).replace(/\\/g, '/');
    if (relative === SIGNATURE_FILE) continue;
    actual.push(relative);
    const record = expected.get(relative);
    if (!record) throw new Error('更新包包含未签名文件：' + relative);
    if (record.size !== stat.size || record.sha256 !== hashFile(current)) throw new Error('更新包文件校验失败：' + relative);
  }
  if (actual.length !== expected.size) {
    const missing = Array.from(expected.keys()).filter((item) => !actual.includes(item));
    throw new Error('更新包缺少签名文件：' + missing.slice(0, 5).join('、'));
  }
  return { files: actual.length, bytes: Array.from(expected.values()).reduce((sum, item) => sum + item.size, 0), keyId: manifest.keyId };
}

function readReleaseManifest(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('发布签名清单过大或无效');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  SIGNATURE_FILE,
  DEFAULT_PUBLIC_KEY,
  keyIdFor,
  publicKeyFromEnv,
  canonicalPayload,
  verifyReleaseManifest,
  verifyPackageFiles,
  readReleaseManifest,
  normalizeFiles,
};
