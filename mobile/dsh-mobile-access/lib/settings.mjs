// settings.yaml 行级 merge（仅用于桌面壳专属键）：保留注释、原子写。
// 顶层键 `dsh-desktop-tauriapp:` 下的子键读取/写入，只动目标行，不动其它内容。
// 值始终以 JSON 字符串形式写（YAML 双引号标量合法，且能表达 Windows 反斜杠路径）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOP_KEY = 'dsh-desktop-tauriapp';

export function settingsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'settings.yaml');
}

// 读子键：返回原始字符串值（未解析），不存在返回 null。
export function readSettingsKey(subKey) {
  const p = settingsPath();
  let lines;
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n');
  } catch {
    return null;
  }
  const top = lines.findIndex((l) => /^dsh-desktop-tauriapp:\s*$/.test(l));
  if (top < 0) return null;
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim()) break; // 下一个顶层键
    const m = l.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1] === subKey) return m[2].trim();
  }
  return null;
}

// 写子键（行级插入/替换，保留注释），原子写（先 tmp 后 rename）。
// 顶层块不存在则追加；子键不存在则在块头行后插入。
export function writeSettingsKey(subKey, rawValue) {
  const p = settingsPath();
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split('\n');
  const top = lines.findIndex((l) => /^dsh-desktop-tauriapp:\s*$/.test(l));
  const line = `  ${subKey}: ${rawValue}`;

  if (top >= 0) {
    // 块内已有该子键 → 替换值
    let replaced = false;
    for (let i = top + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S/.test(l) && l.trim()) break; // 下一个顶层键
      if (l.startsWith('  ' + subKey + ':')) {
        lines[i] = line;
        replaced = true;
        break;
      }
    }
    if (!replaced) lines.splice(top + 1, 0, line);
  } else {
    // 顶层块不存在 → 追加
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(TOP_KEY + ':');
    lines.push(line);
  }
  const out = lines.join('\n') + '\n';
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, p);
  return out;
}

// 子键值为 YAML 字符串标量（JSON 双引号形式），读取时剥掉包围引号。
export function readSettingsString(subKey) {
  const raw = readSettingsKey(subKey);
  if (raw == null) return null;
  const m = String(raw).match(/^"(.*)"$/s);
  if (m) {
    try { return JSON.parse(m[0]); } catch { return m[1]; }
  }
  return String(raw);
}

// 读取任意顶层块下的子键标量（如 `ui-theme:` 块的 `preference: dark`）。
// 只做「顶层块 + 二级键」的简单文本解析，不动 YAML 复杂结构。
export function readTopLevelBlockKey(block, subKey) {
  let lines;
  try {
    lines = fs.readFileSync(settingsPath(), 'utf8').split('\n');
  } catch {
    return null;
  }
  const top = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l));
  if (top < 0) return null;
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l) && l.trim()) break; // 下一个顶层键
    const m = l.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m && m[1] === subKey) return m[2].trim();
  }
  return null;
}

// ── #116：壳设置（desktop-settings.json）读写 ──────────────────────────────
// #95 v0.1.7 后壳设置的权威落点是 $DSH_HOME/desktop-settings.json（dsh settings 的插件
// 命名空间与 settings.yaml 均已废除）。手机访问的壳专属键（tunnel_url/cloudflared_bin/ws_*）
// 走这里读写；字段名与 Rust 侧 DesktopSettings 一致（Rust 未知字段会在其读改写时被丢弃）。
// 读改写 + 原子写（tmp+rename），保留文件内其它字段。

export function shellSettingsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'desktop-settings.json');
}

/** 读壳设置字段；文件缺失/损坏/字段不存在 → null。 */
export function readShellSetting(subKey) {
  try {
    const obj = JSON.parse(fs.readFileSync(shellSettingsPath(), 'utf8'));
    const v = obj?.[subKey];
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

/** 写壳设置字段（读改写 + 原子写）；返回写入值。 */
export function writeShellSetting(subKey, value) {
  const p = shellSettingsPath();
  let obj = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed;
  } catch { /* 首次写入或文件损坏 → 新建 */ }
  obj[subKey] = value;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return value;
}