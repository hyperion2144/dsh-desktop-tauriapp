import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPlatform,
  detectBrowser,
  detectModel,
  clientIp,
  entryKind,
  describeClient,
} from '../lib/client-info.mjs';

// UA 形态逐个锁死：这些串都是从真实设备/厂商文档抄的形态，改动解析规则必须同步改这里。
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  androidWebview:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36',
  harmonyArkWeb:
    'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile',
  wechatIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003127) NetType/WIFI Language/zh_CN',
  qqAndroid:
    'Mozilla/5.0 (Linux; U; Android 13; zh-cn; V2218A Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/111.0.0.0 Mobile Safari/537.36 MQQBrowser/14.6',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  chromeos:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36',
};

test('平台识别：苹果/安卓/鸿蒙/桌面三平台/iPad 桌面模式', () => {
  assert.equal(detectPlatform(UA.iphoneSafari), 'ios');
  assert.equal(detectPlatform(UA.ipadDesktopMode), 'ipados', 'iPad 桌面模式伪装 Macintosh + Mobile/ 仍应判 ipados');
  assert.equal(detectPlatform(UA.androidChrome), 'android');
  assert.equal(detectPlatform(UA.androidWebview), 'android');
  assert.equal(detectPlatform(UA.harmonyArkWeb), 'harmony', 'ArkWeb 的 UA 含 Linux/Android 字样，必须先判鸿蒙');
  assert.equal(detectPlatform(UA.windowsEdge), 'windows');
  assert.equal(detectPlatform(UA.macSafari), 'macos');
  assert.equal(detectPlatform(UA.linuxChrome), 'linux');
  assert.equal(detectPlatform(UA.chromeos), 'chromeos');
  assert.equal(detectPlatform(''), 'shell', '空 UA = 桌面壳自己的裸 TCP 换会话');
});

test('浏览器/WebView 识别：套壳 App 标记优先于通用 Chrome/Safari', () => {
  assert.equal(detectBrowser(UA.iphoneSafari), 'safari');
  assert.equal(detectBrowser(UA.androidChrome), 'chrome');
  assert.equal(detectBrowser(UA.androidWebview), 'androidWebview', '; wv) 是 Android WebView 的标志');
  assert.equal(detectBrowser(UA.harmonyArkWeb), 'arkweb');
  assert.equal(detectBrowser(UA.wechatIos), 'wechat');
  assert.equal(detectBrowser(UA.qqAndroid), 'qq');
  assert.equal(detectBrowser(UA.windowsEdge), 'edge');
  assert.equal(detectBrowser(UA.macSafari), 'safari');
  assert.equal(detectBrowser(''), 'unknown');
});

test('安卓机型提取：真实机型留下，泛称丢弃', () => {
  assert.equal(detectModel(UA.androidChrome), 'SM-S918B');
  assert.equal(detectModel(UA.androidWebview), 'Pixel 7');
  assert.equal(detectModel(UA.qqAndroid), 'V2218A');
  assert.equal(detectModel(UA.iphoneSafari), '', 'iPhone 不在 Android 段里');
  // 只有 wv 占位的 UA 不算机型
  const generic = 'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0 Mobile Safari/537.36';
  assert.equal(detectModel(generic), '');
});

test('IP 与接入路径：XFF 第一跳=隧道，回环=本机，其余=局域网', () => {
  const loopback = { headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  assert.equal(clientIp(loopback), '127.0.0.1', 'IPv6 映射前缀要去掉');
  assert.equal(entryKind(loopback), 'local');

  const lan = { headers: {}, socket: { remoteAddress: '192.168.3.77' } };
  assert.equal(clientIp(lan), '192.168.3.77');
  assert.equal(entryKind(lan), 'lan');

  const tunnel = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(clientIp(tunnel), '203.0.113.9', '隧道取第一跳真实客户端');
  assert.equal(entryKind(tunnel), 'tunnel');
});

test('describeClient：面板一句话信息（机型/平台 + 浏览器 + IP + 入口）', () => {
  const android = describeClient({ ua: UA.androidChrome, ip: '192.168.3.77', entry: 'lan' });
  assert.equal(android.platform, 'android');
  assert.equal(android.platformLabel, '安卓');
  assert.equal(android.model, 'SM-S918B');
  assert.equal(android.name, 'SM-S918B · Chrome');
  assert.equal(android.entryLabel, '局域网');

  const iphone = describeClient({ ua: UA.iphoneSafari, ip: '192.168.3.90', entry: 'lan' });
  assert.equal(iphone.name, '苹果手机 · Safari', 'iPhone 没有机型段，用平台当名字');

  const harmony = describeClient({ ua: UA.harmonyArkWeb, ip: '203.0.113.9', entry: 'tunnel' });
  assert.equal(harmony.platform, 'harmony');
  assert.equal(harmony.browserLabel, 'ArkWeb');
  assert.equal(harmony.entryLabel, '隧道');

  const shell = describeClient({ ua: '', ip: '127.0.0.1', entry: 'local' });
  assert.equal(shell.name, '桌面壳（本机）', '壳没有 UA，直接标成桌面壳');
});
