// 配对令牌生命周期 + 设备会话 + SSE 事件编码（自实现）。
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describeClient } from './client-info.mjs';

export const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 文件存储适配器（默认）：$DSH_HOME 下 0600 文件，重启后设备会话/令牌恢复。
 * @param {string} [file] 存储文件路径；默认 $DSH_HOME/storages/mobile-access/pairing.json
 */
export function createFileStorage(file) {
  const resolved = file ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'mobile-access', 'pairing.json');
  return {
    path: resolved,
    load() {
      try {
        const text = fs.readFileSync(resolved, 'utf8');
        return JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(state));
        try { fs.chmodSync(resolved, 0o600); } catch { /* noop */ }
      } catch { /* 持久化失败不阻塞运行（仅下次重启需重配对） */ }
    },
  };
}

/** 内存存储适配器（测试用／不持久化）。 */
export function createMemoryStorage() {
  let mem = null;
  return {
    load: () => mem,
    save: (state) => { mem = state; },
  };
}

export class PairingStore {
  /**
   * @param {object} [opts]
   * @param {number} [opts.tokenTtlMs]
   * @param {{load:()=>any|null, save:(state:any)=>void}} [opts.storage] 持久化适配器
   */
  constructor({ tokenTtlMs = TOKEN_TTL_MS, storage = null } = {}) {
    this.tokenTtlMs = tokenTtlMs;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.devices = new Map();
    this.listeners = [];
    this.storage = storage;
    if (storage) this._restore();
  }
  // 从持久化状态恢复（进程重启后设备会话/令牌不丢）。
  _restore() {
    try {
      const state = this.storage.load();
      if (!state || typeof state !== 'object') return;
      this.token = typeof state.token === 'string' ? state.token : null;
      this.tokenExpiresAt = Number(state.tokenExpiresAt ?? 0);
      if (Array.isArray(state.devices)) {
        for (const d of state.devices) {
          if (d && typeof d.deviceId === 'string' && typeof d.cookie === 'string') {
            this.devices.set(d.deviceId, {
              name: typeof d.name === 'string' ? d.name : '未知设备',
              pairedAt: Number(d.pairedAt ?? Date.now()),
              cookie: d.cookie,
              lastSeen: Number(d.lastSeen ?? Date.now()),
              online: d.online !== false,
              // 展示字段（#145 延伸）：老记录没有这些键，取空串即可，
              // 设备下次发请求时 isDevice() 会用最新 UA/IP 把它们补上。
              platform: typeof d.platform === 'string' ? d.platform : '',
              platformLabel: typeof d.platformLabel === 'string' ? d.platformLabel : '',
              browser: typeof d.browser === 'string' ? d.browser : '',
              browserLabel: typeof d.browserLabel === 'string' ? d.browserLabel : '',
              model: typeof d.model === 'string' ? d.model : '',
              ip: typeof d.ip === 'string' ? d.ip : '',
              entry: typeof d.entry === 'string' ? d.entry : '',
              entryLabel: typeof d.entryLabel === 'string' ? d.entryLabel : '',
              ua: typeof d.ua === 'string' ? d.ua : '',
            });
          }
        }
      }
    } catch { /* 损坏/不可读 → 按空开始 */ }
  }
  _persist() {
    if (!this.storage) return;
    try {
      this.storage.save({
        token: this.token,
        tokenExpiresAt: this.tokenExpiresAt,
        devices: [...this.devices.entries()].map(([deviceId, d]) => ({
          deviceId, name: d.name, pairedAt: d.pairedAt, cookie: d.cookie,
          lastSeen: d.lastSeen, online: d.online,
        })),
      });
    } catch { /* noop */ }
  }
  // 铸一枚新令牌（旧令牌自动作废）。
  mint() {
    const raw = randomBytes(16).toString('hex');
    this.token = raw;
    this.tokenExpiresAt = Date.now() + this.tokenTtlMs;
    this._persist();
    this.emit('token', { ref: this.ref(), expiresAt: this.tokenExpiresAt });
    return raw;
  }
  // 令牌引用（展示用，非完整令牌）。
  ref() {
    return this.token ? '••••' + this.token.slice(-4) : '';
  }
  // 令牌有效：存在、未过期、且与输入一致。
  validate(token) {
    if (!this.token || Date.now() > this.tokenExpiresAt || token !== this.token) return false;
    return true;
  }
  // 使当前令牌失效（旧链接作废）。
  revoke() {
    if (this.token) {
      this.emit('token', { ref: this.ref(), revoked: true });
    }
    this.token = null;
    this.tokenExpiresAt = 0;
    this._persist();
  }
  // 接受配对：令牌正确 & 未过期 → 创建设备会话；接受后令牌作废（一次性）。

  // `meta`（ua/ip/entry）由调用方从请求里取：面板要展示「什么设备・从哪连进来的」，
  // 解析规则集中在 client-info.mjs（纯函数、单测锁死各家 UA 形态）。
  accept(token, { name, ua = '', ip = '', entry = '' } = {}) {
    if (!this.validate(token)) return null;
    const deviceId = randomBytes(8).toString('hex');
    const cookie = randomBytes(16).toString('hex');
    const info = describeClient({ ua, ip, entry });
    this.devices.set(deviceId, {
      name: name || info.name,
      pairedAt: Date.now(),
      cookie,
      lastSeen: Date.now(),
      online: true,
      platform: info.platform,
      platformLabel: info.platformLabel,
      browser: info.browser,
      browserLabel: info.browserLabel,
      model: info.model,
      ip: info.ip,
      entry: info.entry,
      entryLabel: info.entryLabel,
      ua: String(ua),
    });
    this.revoke();
    this._persist();
    this.emit('devices', this.snapshotDevices());
    this.emit('state', { paired: true });
    return { deviceId, cookie };
  }
  // 会话 cookie 是否仍然有效。
  // 会话 cookie 是否仍然有效；带上 `meta` 时顺手把 IP/UA/入口刷新到该设备上。
  // 这一步让**已配对的老设备**也能被富化（不用重新配对）。
  isDevice(authCookie, meta = null) {
    if (!authCookie) return false;
    for (const d of this.devices.values()) {
      if (d.cookie === authCookie) {
        d.lastSeen = Date.now();
        if (meta) {
          const info = describeClient({ ua: meta.ua ?? '', ip: meta.ip ?? '', entry: meta.entry ?? '' });
          // 名字：之前已识别出机型/平台就不覆盖（避免同一台机器在两种入口下名字跳来跳去）。
          if (!d.name || d.name === '未知设备') d.name = info.name;
          // 壳自己的记录（配对时无 UA）保持「桌面壳」身份：它后续经代理发来的请求带的是
          // **页面**的 UA（macOS Safari 之类），拿它当真会把桌壳标成 Mac。
          if (d.platform !== 'shell') {
            d.platform = info.platform;
            d.platformLabel = info.platformLabel;
            d.browser = info.browser;
            d.browserLabel = info.browserLabel;
            if (info.model) d.model = info.model;
          }
          if (info.ip) d.ip = info.ip;
          if (info.entry) { d.entry = info.entry; d.entryLabel = info.entryLabel; }
          if (meta.ua) d.ua = String(meta.ua);
        }
        return true;
      }
    }
    return false;
  }

  // 取消单个设备配对。
  removeDevice(deviceId) {
    const had = this.devices.delete(deviceId);
    if (had) {
      this._persist();
      this.emit('devices', this.snapshotDevices());
    }
    return had;
  }
  // 撤销全部设备与令牌（停止访问）。
  stopAll() {
    this.devices.clear();
    this.revoke();
    this._persist();
    this.emit('state', { paired: false });
    this.emit('devices', this.snapshotDevices());
  }
  snapshotDevices() {
    return [...this.devices.entries()].map(([deviceId, d]) => ({
      deviceId, name: d.name, pairedAt: d.pairedAt, lastSeen: d.lastSeen, online: d.online,
      platform: d.platform ?? '', platformLabel: d.platformLabel ?? '',
      browser: d.browser ?? '', browserLabel: d.browserLabel ?? '',
      model: d.model ?? '', ip: d.ip ?? '',
      entry: d.entry ?? '', entryLabel: d.entryLabel ?? '', ua: d.ua ?? '',
    }));
  }
  // SSE 事件帧编码（event/data 两行）。
  sse(event, data) {
    return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  }
  on(listener) { this.listeners.push(listener); return () => this._off(listener); }
  _off(listener) { this.listeners = this.listeners.filter(l => l !== listener); }
  emit(event, data) { for (const l of this.listeners) { try { l(event, data); } catch {} } }
}

// 稳定设备名（供测试断言与 UI 展示）。
export function deviceNameFromUA(ua = '') {
  const known = ['iPhone', 'Android', 'iPad', 'HarmonyOS', 'Windows', 'Macintosh', 'Linux'];
  for (const k of known) if (ua.includes(k)) return k;
  return '未知设备';
}

// 内容寻址：给链接/令牌拍指纹（测试友好）。
export function fingerprint(s) { return createHash('sha256').update(s).digest('hex').slice(0, 12); }