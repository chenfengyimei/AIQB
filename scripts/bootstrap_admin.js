#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Auth } = require('../server/lib/auth');
const { StateDatabase } = require('../server/lib/state-db');
const { load } = require('../server/lib/config');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--password-stdin') out.passwordStdin = true;
    else if (argv[i] === '--data-dir' && argv[i + 1]) out.dataDir = argv[++i];
  }
  return out;
}

function hasExistingUser(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth', 'users.json'), 'utf8'));
    if (value && value.user && value.user.passHash) return true;
  } catch (_) {}
  let db;
  try {
    db = new StateDatabase(dataDir).init();
    const value = db.getJSON('auth', 'user');
    return !!(value && value.passHash);
  } finally {
    if (db) db.close();
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; if (value.length > 1024) reject(new Error('输入过长')); });
    process.stdin.on('end', () => resolve(value.replace(/[\r\n]+$/, '')));
    process.stdin.on('error', reject);
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output, terminal: true });
    rl._writeToOutput = function (text) { if (!this.stdoutMuted) this.output.write(text); };
    rl.stdoutMuted = true;
    rl.question(question, (answer) => {
      rl.close();
      output.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.dataDir || process.env.AIQB_DATA_DIR || path.join(__dirname, '..', 'server', 'data'));
  if (hasExistingUser(dataDir)) {
    console.log('管理员账号已存在，未作修改。');
    return;
  }
  let password;
  if (args.passwordStdin) password = await readStdin();
  else if (process.stdin.isTTY) {
    password = await promptHidden('设置管理员密码（12–128 位，不回显）: ');
    const confirm = await promptHidden('再次输入管理员密码: ');
    if (password !== confirm) throw new Error('两次输入的密码不一致');
  } else {
    throw new Error('非交互环境请通过 --password-stdin 从标准输入提供密码');
  }
  if (password.length < 12 || password.length > 128) throw new Error('管理员密码必须为 12–128 位');
  process.env.AIQB_INITIAL_ADMIN_PASSWORD = password;
  password = '';
  const db = new StateDatabase(dataDir).init();
  const auth = new Auth(dataDir, load(dataDir), db);
  try {
    auth.init();
    await auth.shutdown();
  } finally {
    db.close();
  }
  console.log('管理员账号已初始化；用户名 admin，明文密码未写入文件或日志。');
}

if (require.main === module) main().catch((error) => { console.error('管理员初始化失败: ' + error.message); process.exitCode = 1; });

module.exports = { parseArgs, hasExistingUser };
