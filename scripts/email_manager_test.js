'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EmailManager, validAddress, privateIp } = require('../server/lib/email-manager');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiqb-email-test-'));
let pass = 0, fail = 0;
function check(name, condition) {
  console.log((condition ? 'PASS ' : 'FAIL ') + name);
  if (condition) pass++; else fail++;
}

try {
  check('邮箱格式验证阻止换行注入与无效地址', validAddress('owner@example.com') && !validAddress('bad\r\nBcc:x@example.com') && !validAddress('missing-at.example.com'));
  check('SMTP 网络安全识别常见内网与回环地址', privateIp('127.0.0.1') && privateIp('192.168.1.2') && privateIp('10.0.0.1') && !privateIp('8.8.8.8'));

  const manager = new EmailManager(dir);
  manager.init();
  const saved = manager.save({
    enabled: false,
    providerName: '测试邮箱',
    host: 'smtp.example.com',
    port: 465,
    security: 'tls',
    username: 'notice@example.com',
    password: 'smtp-secret-value',
    fromName: 'AI圈报',
    fromAddress: 'notice@example.com',
    replyTo: 'reply@example.com',
    recipients: 'owner@example.com, second@example.com',
    rules: { collectFailure: true, collectRecovery: true },
  });
  check('完整 SMTP 设置可在关闭状态下预先保存', saved.hasPassword && saved.recipients.length === 2 && saved.rules.collectFailure && !saved.enabled);
  const raw = fs.readFileSync(path.join(dir, 'email', 'config.json'), 'utf8');
  check('SMTP 密码仅以 AES-GCM 密文保存且独立密钥存在', !raw.includes('smtp-secret-value') && raw.includes('v1:') && fs.existsSync(path.join(dir, 'email', '.key')));
  check('后台公开配置不返回密码密文或明文', !Object.prototype.hasOwnProperty.call(saved, 'passwordEncrypted') && !JSON.stringify(manager.overview()).includes('smtp-secret-value'));

  const preserved = manager.save({
    enabled: true,
    providerName: saved.providerName,
    host: saved.host,
    port: saved.port,
    security: saved.security,
    username: saved.username,
    password: '',
    fromName: saved.fromName,
    fromAddress: saved.fromAddress,
    replyTo: saved.replyTo,
    recipients: saved.recipients,
    rules: saved.rules,
  });
  check('密码输入留空时保留密文并可启用通知', preserved.enabled && preserved.hasPassword && preserved.passwordHint === '已加密保存');
  const reloaded = new EmailManager(dir);
  reloaded.init();
  check('邮箱设置、收件人与规则可跨重启恢复', reloaded.overview().settings.enabled && reloaded.overview().settings.recipients.length === 2 && reloaded.overview().settings.rules.collectRecovery);

  let invalidPort = false, invalidHost = false, invalidRecipient = false;
  try { manager.save(Object.assign({}, saved, { port: 25, password: '' })); } catch (error) { invalidPort = /端口/.test(error.message); }
  try { manager.save(Object.assign({}, saved, { host: '127.0.0.1', password: '' })); } catch (error) { invalidHost = /公开域名/.test(error.message); }
  try { manager.save(Object.assign({}, saved, { recipients: ['bad-address'], password: '' })); } catch (error) { invalidRecipient = /收件人/.test(error.message); }
  check('配置校验阻止 25 端口、IP 主机与无效收件人', invalidPort && invalidHost && invalidRecipient);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {}
}

console.log('RESULT PASS=' + pass + ' FAIL=' + fail);
process.exit(fail ? 1 : 0);
