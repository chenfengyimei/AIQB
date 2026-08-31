// email-manager.js — SMTP 配置、密钥加密、测试发送与通知日志（零第三方依赖）
'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { atomicWrite } = require('./config');

const DEFAULTS = {
  enabled: false,
  providerName: '',
  host: '',
  port: 465,
  security: 'tls',
  username: '',
  fromName: 'AI圈报',
  fromAddress: '',
  replyTo: '',
  recipients: [],
  rules: { collectFailure: false, collectRecovery: false },
};

function nowIso() { return new Date().toISOString(); }
function clean(value, max) { return String(value == null ? '' : value).replace(/[\u0000\r\n]/g, '').trim().slice(0, max || 500); }
function validAddress(value) {
  const address = clean(value, 320);
  return /^(?=.{3,320}$)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(address);
}
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v);
  }
  return true;
}
function encodeHeader(value) { return '=?UTF-8?B?' + Buffer.from(clean(value, 300), 'utf8').toString('base64') + '?='; }
function maskAddress(value) {
  const address = clean(value, 320);
  const parts = address.split('@');
  if (parts.length !== 2) return address;
  return (parts[0].slice(0, 2) || '*') + '***@' + parts[1];
}

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('timeout', onTimeout); socket.off('close', onClose); };
    const onError = (error) => { cleanup(); reject(error); };
    const onTimeout = () => { cleanup(); reject(new Error('SMTP 响应超时')); };
    const onClose = () => { cleanup(); reject(new Error('SMTP 连接已关闭')); };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (/^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: lines.join('\n') });
      }
    };
    socket.on('data', onData); socket.once('error', onError); socket.once('timeout', onTimeout); socket.once('close', onClose);
  });
}

async function command(socket, line, expected) {
  const response = readResponse(socket);
  socket.write(line + '\r\n');
  const got = await response;
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(got.code)) throw new Error('SMTP ' + got.code + ': ' + got.text.slice(0, 500));
  return got;
}

async function publicDns(host) {
  if (net.isIP(host)) throw new Error('SMTP 主机必须使用公开域名，不能直接填写 IP');
  let rows;
  try { rows = await dns.lookup(host, { all: true, verbatim: true }); } catch (error) { throw new Error('SMTP 域名解析失败: ' + error.message); }
  if (!rows.length || rows.some((row) => privateIp(row.address))) throw new Error('SMTP 域名解析到内网或保留地址，已拒绝连接');
  return rows;
}

async function connectSocket(settings) {
  const addresses = await publicDns(settings.host);
  const address = addresses[0].address;
  let socket;
  if (settings.security === 'tls') {
    socket = tls.connect({ host: address, port: settings.port, servername: settings.host, rejectUnauthorized: true });
    socket.setTimeout(15000);
    const greeting = readResponse(socket);
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    const hello = await greeting;
    if (hello.code !== 220) throw new Error('SMTP 服务未就绪: ' + hello.text);
    return socket;
  }

  socket = net.connect({ host: address, port: settings.port });
  socket.setTimeout(15000);
  const greeting = readResponse(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const hello = await greeting;
  if (hello.code !== 220) throw new Error('SMTP 服务未就绪: ' + hello.text);
  await command(socket, 'EHLO aiqb.local', 250);
  await command(socket, 'STARTTLS', 220);
  const secure = tls.connect({ socket, servername: settings.host, rejectUnauthorized: true });
  secure.setTimeout(15000);
  await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
  return secure;
}

async function sendSmtp(settings, password, message) {
  const started = Date.now();
  let socket;
  try {
    socket = await connectSocket(settings);
    const ehlo = await command(socket, 'EHLO aiqb.local', 250);
    const authLine = ehlo.text.toUpperCase();
    if (/AUTH[^\n]*PLAIN/.test(authLine)) {
      const token = Buffer.from('\u0000' + settings.username + '\u0000' + password, 'utf8').toString('base64');
      await command(socket, 'AUTH PLAIN ' + token, 235);
    } else {
      await command(socket, 'AUTH LOGIN', 334);
      await command(socket, Buffer.from(settings.username, 'utf8').toString('base64'), 334);
      await command(socket, Buffer.from(password, 'utf8').toString('base64'), 235);
    }
    await command(socket, 'MAIL FROM:<' + settings.fromAddress + '>', 250);
    for (const recipient of message.to) await command(socket, 'RCPT TO:<' + recipient + '>', [250, 251]);
    await command(socket, 'DATA', 354);
    const domain = settings.fromAddress.split('@')[1] || 'localhost';
    const messageId = '<' + crypto.randomBytes(12).toString('hex') + '@' + domain + '>';
    const headers = [
      'Date: ' + new Date().toUTCString(),
      'Message-ID: ' + messageId,
      'From: ' + encodeHeader(settings.fromName || 'AI圈报') + ' <' + settings.fromAddress + '>',
      'To: ' + message.to.join(', '),
      'Subject: ' + encodeHeader(message.subject),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ];
    if (settings.replyTo) headers.splice(5, 0, 'Reply-To: ' + settings.replyTo);
    const encodedBody = Buffer.from(String(message.text || ''), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n').trim();
    const payload = headers.join('\r\n') + '\r\n\r\n' + encodedBody;
    const response = readResponse(socket);
    socket.write(payload.replace(/^\./gm, '..') + '\r\n.\r\n');
    const accepted = await response;
    if (accepted.code !== 250) throw new Error('SMTP ' + accepted.code + ': ' + accepted.text.slice(0, 500));
    try { await command(socket, 'QUIT', 221); } catch (error) {}
    return { messageId, durationMs: Date.now() - started };
  } finally {
    if (socket && !socket.destroyed) socket.destroy();
  }
}

class EmailManager {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'email');
    this.configFile = path.join(this.dir, 'config.json');
    this.keyFile = path.join(this.dir, '.key');
    this.logsFile = path.join(this.dir, 'logs.json');
    this.stateFile = path.join(this.dir, 'state.json');
    this.config = Object.assign({}, DEFAULTS, { rules: Object.assign({}, DEFAULTS.rules), passwordEncrypted: '' });
    this.logs = [];
    this.state = { lastCollectOk: null, lastFailureNotifiedAt: null };
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      if (saved && typeof saved === 'object') this.config = Object.assign(this.config, saved, { rules: Object.assign({}, DEFAULTS.rules, saved.rules || {}) });
    } catch (error) {}
    try { const rows = JSON.parse(fs.readFileSync(this.logsFile, 'utf8')); if (Array.isArray(rows)) this.logs = rows.slice(-500); } catch (error) {}
    try { this.state = Object.assign(this.state, JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))); } catch (error) {}
  }

  _key() {
    try {
      const key = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'base64');
      if (key.length === 32) return key;
    } catch (error) {}
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyFile, key.toString('base64') + '\n', { mode: 0o600 });
    try { fs.chmodSync(this.keyFile, 0o600); } catch (error) {}
    return key;
  }

  _encrypt(password) {
    if (!password) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this._key(), iv);
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join(':');
  }

  _decrypt(value) {
    if (!value) return '';
    const parts = String(value).split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('邮箱密码密文格式无效');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this._key(), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  }

  _publicConfig() {
    const cfg = this.config;
    return {
      enabled: cfg.enabled === true,
      providerName: cfg.providerName || '',
      host: cfg.host || '',
      port: cfg.port || 465,
      security: cfg.security || 'tls',
      username: cfg.username || '',
      fromName: cfg.fromName || 'AI圈报',
      fromAddress: cfg.fromAddress || '',
      replyTo: cfg.replyTo || '',
      recipients: Array.isArray(cfg.recipients) ? cfg.recipients : [],
      rules: Object.assign({}, DEFAULTS.rules, cfg.rules || {}),
      hasPassword: !!cfg.passwordEncrypted,
      passwordHint: cfg.passwordEncrypted ? '已加密保存' : '尚未设置',
      updatedAt: cfg.updatedAt || null,
    };
  }

  overview() {
    const recent = this.logs.slice(-50);
    return {
      settings: this._publicConfig(),
      summary: {
        configured: !!(this.config.host && this.config.username && this.config.fromAddress && this.config.passwordEncrypted),
        enabled: this.config.enabled === true,
        recipients: Array.isArray(this.config.recipients) ? this.config.recipients.length : 0,
        sent: recent.filter((row) => row.status === 'sent').length,
        failed: recent.filter((row) => row.status === 'failed').length,
        last: recent.length ? recent[recent.length - 1] : null,
      },
      logs: this.logs.slice(-100).reverse(),
    };
  }

  save(input) {
    const patch = input || {};
    const next = Object.assign({}, this.config);
    next.enabled = patch.enabled === true;
    next.providerName = clean(patch.providerName, 100);
    next.host = clean(patch.host, 253).toLowerCase();
    if (next.host && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(next.host)) throw new Error('SMTP 主机必须是有效公开域名');
    next.port = Math.round(Number(patch.port) || 0);
    if (![465, 587, 2525].includes(next.port)) throw new Error('SMTP 端口仅支持 465、587 或 2525');
    next.security = patch.security === 'starttls' ? 'starttls' : 'tls';
    if (next.port === 465 && next.security !== 'tls') throw new Error('465 端口必须使用 SSL/TLS');
    if ((next.port === 587 || next.port === 2525) && next.security !== 'starttls') throw new Error('587/2525 端口必须使用 STARTTLS');
    next.username = clean(patch.username, 320);
    next.fromName = clean(patch.fromName, 100) || 'AI圈报';
    next.fromAddress = clean(patch.fromAddress, 320).toLowerCase();
    next.replyTo = clean(patch.replyTo, 320).toLowerCase();
    if (next.fromAddress && !validAddress(next.fromAddress)) throw new Error('发件邮箱格式无效');
    if (next.replyTo && !validAddress(next.replyTo)) throw new Error('Reply-To 邮箱格式无效');
    const recipients = Array.isArray(patch.recipients) ? patch.recipients : String(patch.recipients || '').split(/[\s,，;；]+/);
    next.recipients = Array.from(new Set(recipients.map((row) => clean(row, 320).toLowerCase()).filter(Boolean)));
    if (next.recipients.length > 20 || next.recipients.some((row) => !validAddress(row))) throw new Error('管理员收件人最多 20 个，且必须是有效邮箱');
    next.rules = {
      collectFailure: !!(patch.rules && patch.rules.collectFailure),
      collectRecovery: !!(patch.rules && patch.rules.collectRecovery),
    };
    if (patch.clearPassword === true) next.passwordEncrypted = '';
    else if (patch.password) {
      const password = String(patch.password);
      if (password.length < 2 || password.length > 500) throw new Error('SMTP 密码长度必须为 2–500 个字符');
      next.passwordEncrypted = this._encrypt(password);
    }
    if (next.enabled && (!next.host || !next.username || !next.fromAddress || !next.passwordEncrypted || !next.recipients.length)) throw new Error('启用邮件前请完整填写 SMTP、账号、发件邮箱、密码和管理员收件人');
    next.updatedAt = nowIso();
    this.config = next;
    atomicWrite(this.configFile, JSON.stringify(next, null, 2) + '\n');
    return this._publicConfig();
  }

  _log(row) {
    this.logs.push(Object.assign({ at: nowIso() }, row));
    this.logs = this.logs.slice(-500);
    atomicWrite(this.logsFile, JSON.stringify(this.logs, null, 1) + '\n');
  }

  async send(subject, text, recipients, kind) {
    const cfg = this.config;
    const to = Array.from(new Set((recipients || cfg.recipients || []).map((row) => clean(row, 320).toLowerCase()).filter(validAddress)));
    if (!cfg.host || !cfg.username || !cfg.fromAddress || !cfg.passwordEncrypted) throw new Error('SMTP 配置不完整');
    if (!to.length) throw new Error('没有有效收件人');
    const logBase = { kind: clean(kind || 'manual', 50), subject: clean(subject, 300), recipients: to.map(maskAddress) };
    try {
      const result = await sendSmtp(cfg, this._decrypt(cfg.passwordEncrypted), { subject, text, to });
      this._log(Object.assign({}, logBase, { status: 'sent', durationMs: result.durationMs, messageId: result.messageId }));
      return result;
    } catch (error) {
      this._log(Object.assign({}, logBase, { status: 'failed', error: clean(error.message || error, 1000) }));
      throw error;
    }
  }

  async sendTest(recipient, siteUrl) {
    const target = clean(recipient, 320).toLowerCase() || (this.config.recipients || [])[0];
    if (!validAddress(target)) throw new Error('测试收件邮箱格式无效');
    return this.send('AI圈报邮箱配置测试', '这是一封来自 AI圈报管理后台的 SMTP 测试邮件。\n\n站点：' + clean(siteUrl, 500) + '\n时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '\n\n如果收到此邮件，说明 SMTP 配置可以正常发送。', [target], 'test');
  }

  notifyCollect(result, siteUrl) {
    const previous = this.state.lastCollectOk;
    this.state.lastCollectOk = !!(result && result.ok);
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2) + '\n');
    if (!this.config.enabled) return;
    if (!result || !result.ok) {
      if (!this.config.rules.collectFailure) return;
      const last = Date.parse(this.state.lastFailureNotifiedAt || '') || 0;
      if (Date.now() - last < 60 * 60 * 1000) return;
      this.state.lastFailureNotifiedAt = nowIso();
      atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2) + '\n');
      this.send('AI圈报采集失败通知', 'AI圈报数据采集失败。\n\n错误：' + clean(result && result.error || '未知错误', 1000) + '\n时间：' + nowIso() + '\n后台：' + clean(siteUrl, 500) + '/chenfengadmin', null, 'collect_failure').catch(() => {});
    } else if (previous === false && this.config.rules.collectRecovery) {
      this.send('AI圈报采集恢复通知', 'AI圈报数据采集已经恢复正常。\n\n时间：' + nowIso() + '\n站点：' + clean(siteUrl, 500), null, 'collect_recovery').catch(() => {});
    }
  }
}

module.exports = { EmailManager, validAddress, privateIp, sendSmtp };
