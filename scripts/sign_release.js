#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  SIGNATURE_FILE,
  DEFAULT_PUBLIC_KEY,
  keyIdFor,
  canonicalPayload,
  verifyReleaseManifest,
} = require('../server/lib/release-signature');

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function trackedAndNewFiles(root) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer' });
  return output.toString('utf8').split('\0').filter(Boolean).map((item) => item.replace(/\\/g, '/')).filter((item) => item !== SIGNATURE_FILE && fs.existsSync(path.join(root, item))).sort((a, b) => a.localeCompare(b, 'en'));
}

function fileRecords(root, files) {
  return files.map((relative) => {
    if (relative.startsWith('/') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('发布文件路径不安全：' + relative);
    if (/^(?:server\/data|node_modules|release|\.git)(?:\/|$)/.test(relative) || relative === '.baidu-push-state.json') throw new Error('发布清单包含运行数据或构建产物：' + relative);
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('发布清单只允许普通文件：' + relative);
    return { path: relative, size: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
}

function atomicWrite(file, content) {
  const temp = file + '.tmp-' + process.pid;
  fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function main() {
  const root = path.resolve(path.join(__dirname, '..'));
  const output = path.join(root, SIGNATURE_FILE);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const keyInput = String(option('--key') || process.env.AIQB_RELEASE_SIGNING_KEY || '').trim();
  if (!keyInput) throw new Error('请使用 --key 指定 Ed25519 发布私钥');
  const keyFile = path.resolve(keyInput);
  if (!fs.existsSync(keyFile) || !fs.statSync(keyFile).isFile()) throw new Error('Ed25519 发布私钥文件不存在或不是普通文件');
  const privateKey = fs.readFileSync(keyFile, 'utf8');
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  const keyId = keyIdFor(publicKey);
  if (!process.argv.includes('--allow-custom-key') && keyId !== keyIdFor(DEFAULT_PUBLIC_KEY)) throw new Error('签名私钥与 AIQB 内置发布公钥不匹配');
  const manifest = {
    schema: 1,
    product: 'aiqb',
    version: String(packageJson.version),
    algorithm: 'Ed25519',
    keyId,
    files: fileRecords(root, trackedAndNewFiles(root)),
  };
  manifest.signature = crypto.sign(null, Buffer.from(canonicalPayload(manifest), 'utf8'), privateKey).toString('base64');
  verifyReleaseManifest(manifest, publicKey);
  atomicWrite(output, JSON.stringify(manifest, null, 2) + '\n');
  console.log('Release signature written: ' + output);
  console.log('Version: ' + manifest.version + '  Files: ' + manifest.files.length + '  Key: ' + manifest.keyId);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
