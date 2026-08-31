#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { SIGNATURE_FILE, publicKeyFromEnv, verifyReleaseManifest, verifyPackageFiles, readReleaseManifest } = require('../server/lib/release-signature');

function currentFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer' })
    .toString('utf8').split('\0').filter(Boolean).map((item) => item.replace(/\\/g, '/')).filter((item) => item !== SIGNATURE_FILE && fs.existsSync(path.join(root, item))).sort((a, b) => a.localeCompare(b, 'en'));
}

function main() {
  const root = path.resolve(path.join(__dirname, '..'));
  const manifest = verifyReleaseManifest(readReleaseManifest(path.join(root, SIGNATURE_FILE)), publicKeyFromEnv(process.env));
  if (fs.existsSync(path.join(root, '.git'))) {
    const expected = manifest.files.map((item) => item.path);
    const actual = currentFiles(root);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      const missing = expected.filter((item) => !actual.includes(item));
      const unsigned = actual.filter((item) => !expected.includes(item));
      throw new Error('发布文件集合与签名不一致' + (missing.length ? '；缺少：' + missing.slice(0, 5).join('、') : '') + (unsigned.length ? '；未签名：' + unsigned.slice(0, 5).join('、') : ''));
    }
    for (const item of manifest.files) {
      const file = path.join(root, item.path);
      const stat = fs.lstatSync(file);
      const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || digest !== item.sha256) throw new Error('发布文件校验失败：' + item.path);
    }
  } else {
    verifyPackageFiles(root, manifest);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (String(pkg.version) !== manifest.version) throw new Error('package.json 与发布签名版本不一致');
  console.log('Release verification PASS: v' + manifest.version + '  files=' + manifest.files.length + '  key=' + manifest.keyId);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
