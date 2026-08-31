// friend-links.js — 友情链接持久化与校验（零依赖）

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { atomicWrite } = require('./config');

function text(value, max) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').trim().slice(0, max);
}

function cleanUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch (error) { throw new Error('链接地址格式不正确'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('链接地址只允许 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('链接地址不能包含账号或密码');
  url.hash = '';
  return url.href;
}

function cleanSort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < -9999 || number > 9999) throw new Error('排序值必须是 -9999 到 9999 之间的整数');
  return number;
}

class FriendLinkStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'friend-links');
    this.file = path.join(this.dir, 'items.json');
    this.items = [];
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const rows = Array.isArray(saved) ? saved : saved && saved.items;
      if (Array.isArray(rows)) this.items = rows.filter((item) => item && /^friend-[a-f0-9]{16}$/.test(String(item.id || '')));
    } catch (error) { this.items = []; }
    this.items = this.items.map((item, index) => {
      try {
        return {
          id: item.id,
          name: text(item.name, 60) || '未命名友链',
          url: cleanUrl(item.url),
          description: text(item.description, 160),
          sort: cleanSort(item.sort, (index + 1) * 10),
          enabled: item.enabled !== false,
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || item.createdAt || new Date().toISOString(),
        };
      } catch (error) { return null; }
    }).filter(Boolean);
  }

  _persist() {
    atomicWrite(this.file, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: this.items }, null, 2) + '\n');
  }

  _sorted(items) {
    return items.slice().sort((a, b) => a.sort - b.sort || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  summary() {
    const enabled = this.items.filter((item) => item.enabled).length;
    return { total: this.items.length, enabled, disabled: this.items.length - enabled };
  }

  list() {
    return { summary: this.summary(), items: this._sorted(this.items) };
  }

  publicItems() {
    return this._sorted(this.items.filter((item) => item.enabled)).map((item) => ({
      id: item.id,
      name: item.name,
      url: item.url,
      description: item.description,
    }));
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  _duplicate(url, exceptId) {
    return this.items.some((item) => item.id !== exceptId && item.url.toLowerCase() === url.toLowerCase());
  }

  create(input) {
    const now = new Date().toISOString();
    const name = text(input && input.name, 60);
    if (!name) throw new Error('友链名称不能为空');
    const url = cleanUrl(input && input.url);
    if (this._duplicate(url)) throw new Error('该链接地址已经存在');
    const maxSort = this.items.reduce((max, item) => Math.max(max, item.sort), 0);
    const item = {
      id: 'friend-' + crypto.randomBytes(8).toString('hex'),
      name,
      url,
      description: text(input && input.description, 160),
      sort: cleanSort(input && input.sort, maxSort + 10),
      enabled: !input || input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    this.items.push(item);
    this._persist();
    return item;
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    const input = patch || {};
    if (input.name !== undefined) {
      const name = text(input.name, 60);
      if (!name) throw new Error('友链名称不能为空');
      item.name = name;
    }
    if (input.url !== undefined) {
      const url = cleanUrl(input.url);
      if (this._duplicate(url, id)) throw new Error('该链接地址已经存在');
      item.url = url;
    }
    if (input.description !== undefined) item.description = text(input.description, 160);
    if (input.sort !== undefined) item.sort = cleanSort(input.sort, item.sort);
    if (input.enabled !== undefined) item.enabled = input.enabled === true;
    item.updatedAt = new Date().toISOString();
    this._persist();
    return item;
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this._persist();
    return true;
  }
}

module.exports = { FriendLinkStore, cleanUrl };
