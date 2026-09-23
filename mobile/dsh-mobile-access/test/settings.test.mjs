import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettingsKey, readSettingsString, writeSettingsKey, settingsPath, readShellSetting, writeShellSetting } from '../lib/settings.mjs';

function withTempSettings(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-test-'));
  const p = path.join(dir, 'settings.yaml');
  fs.writeFileSync(p, content);
  const real = settingsPath;
  // 用环境变量指向临时目录
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return fn(p);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('settings.mjs：读不存在键返回 null', () => {
  withTempSettings('ui-onboarding:\n  welcomeNoticeVersion: x\n', () => {
    assert.equal(readSettingsKey('cloudflared_bin'), null);
    assert.equal(readSettingsString('cloudflared_bin'), null);
  });
});

test('settings.mjs：不存在顶层块时追加新块并保留原内容/注释', () => {
  withTempSettings('# 注释行\nui-onboarding:\n  welcomeNoticeVersion: 2026-08-13.1\n', () => {
    writeSettingsKey('cloudflared_bin', JSON.stringify('/usr/local/bin/cloudflared'));
    const text = fs.readFileSync(settingsPath(), 'utf8');
    assert.ok(text.includes('# 注释行'));
    assert.ok(text.includes('ui-onboarding:'));
    assert.ok(text.includes('welcomeNoticeVersion: 2026-08-13.1'));
    assert.ok(text.includes('cloudflared_bin: "/usr/local/bin/cloudflared"'));
    assert.equal(readSettingsString('cloudflared_bin'), '/usr/local/bin/cloudflared');
  });
});

test('settings.mjs：顶层块存在时替换已有子键值', () => {
  withTempSettings('dsh-desktop-tauriapp:\n  port: 3080\n  cloudflared_bin: "/old/path"\n  active_profile: web\n', () => {
    writeSettingsKey('cloudflared_bin', JSON.stringify('/new/path'));
    const text = fs.readFileSync(settingsPath(), 'utf8');
    assert.ok(text.includes('cloudflared_bin: "/new/path"'));
    assert.ok(!text.includes('/old/path'));
    assert.ok(text.includes('port: 3080'));
    assert.ok(text.includes('active_profile: web'));
    assert.equal(readSettingsString('cloudflared_bin'), '/new/path');
  });
});

test('settings.mjs：顶层块存在但子键缺失时插入', () => {
  withTempSettings('dsh-desktop-tauriapp:\n  port: 3080\n  active_profile: web\n', () => {
    writeSettingsKey('cloudflared_bin', JSON.stringify('C:\\tools\\cloudflared.exe'));
    const text = fs.readFileSync(settingsPath(), 'utf8');
    assert.ok(text.includes('cloudflared_bin: "C:\\\\tools\\\\cloudflared.exe"'));
    assert.ok(text.includes('port: 3080'));
    assert.equal(readSettingsString('cloudflared_bin'), 'C:\\tools\\cloudflared.exe');
  });
});

test('settings.mjs：清空值（空串）持久化', () => {
  withTempSettings('dsh-desktop-tauriapp:\n  cloudflared_bin: "/old"\n', () => {
    writeSettingsKey('cloudflared_bin', JSON.stringify(''));
    assert.equal(readSettingsString('cloudflared_bin'), '');
  });
});

// #116：壳设置 JSON（desktop-settings.json）读写——手机访问壳专属键的新落点
function withTempShellHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-shell-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    return fn(path.join(dir, 'desktop-settings.json'));
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('#116：壳设置 JSON 写入保留其它字段、读取回原值', () => {
  withTempShellHome((p) => {
    fs.writeFileSync(p, JSON.stringify({ port: 3081, dsh_mode: 'builtin' }, null, 2));
    assert.equal(readShellSetting('tunnel_url'), null);
    writeShellSetting('tunnel_url', 'https://t.example.com');
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(obj.tunnel_url, 'https://t.example.com');
    assert.equal(obj.port, 3081);
    assert.equal(obj.dsh_mode, 'builtin');
    assert.equal(readShellSetting('tunnel_url'), 'https://t.example.com');
    // UI 空串清除语义
    writeShellSetting('tunnel_url', '');
    assert.equal(readShellSetting('tunnel_url'), '');
  });
});

test('#116：壳设置文件缺失/损坏时读 null、写可重建', () => {
  withTempShellHome((p) => {
    assert.equal(readShellSetting('cloudflared_bin'), null); // 文件不存在
    fs.writeFileSync(p, '{ not json');
    assert.equal(readShellSetting('cloudflared_bin'), null); // 损坏
    writeShellSetting('cloudflared_bin', '/opt/homebrew/bin/cloudflared');
    assert.equal(readShellSetting('cloudflared_bin'), '/opt/homebrew/bin/cloudflared');
  });
});