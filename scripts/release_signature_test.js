'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalPayload, keyIdFor, verifyReleaseManifest, verifyPackageFiles } = require('../server/lib/release-signature');
const { validateArchiveListing } = require('./online_update');

function main() {
  let pass = 0;
  const check = (name, fn) => { fn(); pass++; console.log('PASS ' + name); };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-signature-test-'));
  try {
    fs.mkdirSync(path.join(temp, 'server'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'package.json'), '{}');
    fs.writeFileSync(path.join(temp, 'server', 'server.js'), 'module.exports = true;\n');
    const keys = crypto.generateKeyPairSync('ed25519');
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
    const records = ['package.json', 'server/server.js'].map((relative) => {
      const value = fs.readFileSync(path.join(temp, relative));
      return { path: relative, size: value.length, sha256: crypto.createHash('sha256').update(value).digest('hex') };
    });
    const manifest = { schema: 1, product: 'aiqb', version: '9.9.9', algorithm: 'Ed25519', keyId: keyIdFor(publicKey), files: records };
    manifest.signature = crypto.sign(null, Buffer.from(canonicalPayload(manifest), 'utf8'), keys.privateKey).toString('base64');
    fs.writeFileSync(path.join(temp, 'release-signature.json'), JSON.stringify(manifest));

    check('有效 Ed25519 发布签名可验证', () => assert.strictEqual(verifyReleaseManifest(manifest, publicKey).keyId, manifest.keyId));
    check('同一公钥的 LF 与 CRLF PEM 使用同一密钥标识', () => {
      const crlfKey = String(publicKey).replace(/\r?\n/g, '\r\n');
      assert.strictEqual(keyIdFor(crlfKey), keyIdFor(publicKey));
      assert.strictEqual(verifyReleaseManifest(manifest, crlfKey).keyId, manifest.keyId);
    });
    check('签名后的逐文件清单与实际安装包一致', () => assert.strictEqual(verifyPackageFiles(temp, manifest).files, 2));
    check('清单被篡改时签名验证失败', () => assert.throws(() => verifyReleaseManifest(Object.assign({}, manifest, { version: '9.9.8' }), publicKey)));
    check('安装包文件被篡改时拒绝更新', () => {
      fs.appendFileSync(path.join(temp, 'server', 'server.js'), '// tampered');
      assert.throws(() => verifyPackageFiles(temp, manifest));
      fs.writeFileSync(path.join(temp, 'server', 'server.js'), 'module.exports = true;\n');
    });
    check('安装包出现未签名文件时拒绝更新', () => {
      fs.writeFileSync(path.join(temp, 'server', 'extra.js'), 'malicious');
      assert.throws(() => verifyPackageFiles(temp, manifest));
    });
    check('归档预检拒绝路径穿越与符号链接', () => {
      assert.strictEqual(validateArchiveListing('root/\nroot/file.js\n', 'drwxr-xr-x root/root 0 date root/\n-rw-r--r-- root/root 1 date root/file.js\n'), 2);
      assert.throws(() => validateArchiveListing('../escape\n', '-rw-r--r-- root/root 1 date ../escape\n'));
      assert.throws(() => validateArchiveListing('root/link\n', 'lrwxrwxrwx root/root 0 date root/link -> /etc/passwd\n'));
    });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  console.log('RESULT PASS=' + pass + ' FAIL=0');
}

try { main(); } catch (error) { console.error(error.stack || error); process.exit(1); }
