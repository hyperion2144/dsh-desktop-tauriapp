// 应用更新（#220 决策 11：旧壳没有这个能力，是新增件；走框架自带的 Updater）。
//
// 守的是三件事：
//   1. **纯逻辑**：Electrobun 的 29 个状态 → 壳的 9 个阶段、版本比较（含预发布段）、进度与
//      字节数的翻译、三个按钮的可点性——客户端卡片完全照这个渲染；
//   2. **不静默降级**：拿不到更新源（dev 构建、没配 `release.baseUrl`、被开关关掉、
//      框架 import 失败、读本地版本抛错）时，视图里必须写清楚「为什么不可用」；
//   3. **IO 外壳**（`createUpdater`）在假 Updater 上的行为：check/download/apply 三条路、
//      状态订阅、失败落到 `error` 而不是抛出去。

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_UPDATE_BASE_URL,
  UPDATE_BASE_URL_ENV,
  UPDATE_DISABLE_ENV,
  compareVersions,
  feedFileName,
  feedUrl,
  formatBytes,
  isNewerVersion,
  phaseOfStatus,
  platformPrefixOf,
  progressOf,
  updateActions,
  updateView,
} from '../src/shared/update.ts'
import type { StatusLike } from '../src/shared/update.ts'
import { createUpdater, isFlagOn, type UpdaterLike } from '../src/bun/updater.ts'

describe('平台前缀与清单 URL', () => {
  test('前缀是 <buildEnvironment>-<os>-<arch>', () => {
    expect(platformPrefixOf({ buildEnv: 'stable', os: 'macos', arch: 'arm64' })).toBe(
      'stable-macos-arm64'
    )
    expect(platformPrefixOf({ buildEnv: 'dev', os: 'win', arch: 'x64' })).toBe('dev-win-x64')
  })

  test('清单名带前缀，baseUrl 尾斜杠可有可无', () => {
    expect(feedFileName('stable-macos-arm64')).toBe('stable-macos-arm64-update.json')
    expect(feedUrl('https://example.com/rel', 'stable-macos-arm64')).toBe(
      'https://example.com/rel/stable-macos-arm64-update.json'
    )
    expect(feedUrl('https://example.com/rel/', 'stable-macos-arm64')).toBe(
      'https://example.com/rel/stable-macos-arm64-update.json'
    )
    // 空 baseUrl 不拼出半截 URL（面板显示空串比显示 `/xxx-update.json` 诚实）
    expect(feedUrl('', 'stable-macos-arm64')).toBe('')
  })

  test('默认源是 GitHub Releases 的 latest/download 别名', () => {
    expect(DEFAULT_UPDATE_BASE_URL).toContain('github.com/hyperion2144/dsh-desktop-tauriapp')
    expect(DEFAULT_UPDATE_BASE_URL.endsWith('/releases/latest/download')).toBe(true)
  })
})

describe('版本比较', () => {
  test('数字段按数值（不是字典序）', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
  })

  test('预发布段：数字按数值，预发布比正式版小', () => {
    expect(compareVersions('0.2.1-alpha.10', '0.2.1-alpha.2')).toBe(1)
    expect(compareVersions('0.2.1-alpha.2', '0.2.1')).toBe(-1)
    expect(compareVersions('0.2.1', '0.2.1-alpha.2')).toBe(1)
    expect(compareVersions('0.2.1-rc.1', '0.2.1-alpha.2')).toBe(1)
  })

  test('容忍 v 前缀与空白', () => {
    expect(compareVersions(' v0.2.0 ', '0.2.0')).toBe(0)
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '')).toBe(false)
  })
})

describe('状态 → 阶段', () => {
  test('Electrobun 的状态映射到 9 个阶段', () => {
    expect(phaseOfStatus('idle')).toBe('idle')
    expect(phaseOfStatus('')).toBe('idle')
    expect(phaseOfStatus('checking')).toBe('checking')
    expect(phaseOfStatus('check-complete')).toBe('checking')
    expect(phaseOfStatus('no-update')).toBe('up-to-date')
    expect(phaseOfStatus('update-available')).toBe('available')
    expect(phaseOfStatus('download-progress')).toBe('downloading')
    expect(phaseOfStatus('downloading-full-bundle')).toBe('downloading')
    // patch-failed 的语义是「补丁失败，会回落整包」⇒ 仍然算在下载里
    expect(phaseOfStatus('patch-failed')).toBe('downloading')
    expect(phaseOfStatus('replacing-app')).toBe('preparing')
    expect(phaseOfStatus('complete')).toBe('ready')
    expect(phaseOfStatus('launching-new-version')).toBe('ready')
    expect(phaseOfStatus('error')).toBe('error')
    expect(phaseOfStatus('something-new')).toBe('checking')
  })
})

describe('进度与字节数', () => {
  test('progress 是 0..1 的比例，越界被夹住', () => {
    expect(progressOf({ progress: 0.5 })).toBe(50)
    expect(progressOf({ progress: 0 })).toBe(0)
    expect(progressOf({ progress: 1 })).toBe(100)
    expect(progressOf({ progress: 1.5 })).toBe(100)
    expect(progressOf({ progress: -1 })).toBe(0)
    expect(progressOf(undefined)).toBe(null)
  })

  test('没有 progress 时用字节数兜底，两者都没有就 null', () => {
    expect(progressOf({ bytesDownloaded: 512, totalBytes: 1024 })).toBe(50)
    expect(progressOf({ bytesDownloaded: 512, totalBytes: 0 })).toBe(null)
    expect(progressOf({ bytesDownloaded: 512 })).toBe(null)
    expect(progressOf({})).toBe(null)
  })

  test('字节数格式化', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12_582_912)).toBe('12.0 MB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
  })
})

describe('视图合成', () => {
  test('不可用时带上原因，阶段固定是 unavailable', () => {
    const view = updateView({
      available: false,
      reason: '当前构建没有更新源',
      prefix: 'dev-macos-arm64',
      local: { version: '0.1.0', channel: 'dev' },
    })
    expect(view.phase).toBe('unavailable')
    expect(view.label).toBe('不可用')
    expect(view.reason).toBe('当前构建没有更新源')
    expect(view.current).toBe('0.1.0')
  })

  test('远端版本更新时即使还没检查也标出「可更新」', () => {
    const view = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
      remote: { version: '0.2.0' },
    })
    expect(view.phase).toBe('idle')
    expect(view.updateAvailable).toBe(true)
    expect(view.feedUrl).toBe('https://example.com/r/stable-macos-arm64-update.json')
  })

  test('状态里的错误信息与进度都进视图', () => {
    const downloading = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
      remote: { version: '0.2.0', updateAvailable: true },
      status: {
        status: 'download-progress',
        message: '下载中',
        timestamp: 1234,
        details: { progress: 0.25, bytesDownloaded: 1024, totalBytes: 4096 },
      },
    })
    expect(downloading.phase).toBe('downloading')
    expect(downloading.progress).toBe(25)
    expect(downloading.at).toBe(1234)

    const failed = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0' },
      status: { status: 'error', details: { errorMessage: '磁盘满了' } },
    })
    expect(failed.phase).toBe('error')
    expect(failed.error).toBe('磁盘满了')
  })

  test('install 完成 ⇒ updateReady（按钮该变成「重启并安装」）', () => {
    const view = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0' },
      status: { status: 'complete', message: '已替换' },
    })
    expect(view.phase).toBe('ready')
    expect(view.updateReady).toBe(true)
  })
})

describe('按钮可点性', () => {
  const base = {
    available: true,
    reason: '',
    prefix: 'stable-macos-arm64',
    local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
  }

  test('不可用 ⇒ 三个都点不了，hint 就是不可用原因', () => {
    const view = updateView({ ...base, available: false, reason: '没有更新源' })
    const actions = updateActions(view)
    expect(actions).toEqual({
      canCheck: false,
      canDownload: false,
      canApply: false,
      hint: '没有更新源',
    })
  })

  test('空闲 ⇒ 只能检查', () => {
    const actions = updateActions(updateView(base))
    expect(actions.canCheck).toBe(true)
    expect(actions.canDownload).toBe(false)
    expect(actions.canApply).toBe(false)
  })

  test('有新版本 ⇒ 能下载；安装完 ⇒ 能重启安装', () => {
    const available = updateActions(
      updateView({ ...base, remote: { version: '0.2.0' }, status: { status: 'update-available' } })
    )
    expect(available.canDownload).toBe(true)
    expect(available.hint).toContain('0.2.0')

    const ready = updateActions(updateView({ ...base, status: { status: 'complete' } }))
    expect(ready.canApply).toBe(true)
    expect(ready.hint).toContain('重启')
  })

  test('忙的时候三个都点不了，hint 是当前阶段', () => {
    const view = updateView({ ...base, status: { status: 'downloading-full-bundle' } })
    const actions = updateActions(view)
    expect(actions.canCheck).toBe(false)
    expect(actions.canDownload).toBe(false)
    expect(actions.canApply).toBe(false)
    expect(actions.hint).toBe('正在下载…')
  })

  test('已是最新 ⇒ 提示写当前版本', () => {
    const actions = updateActions(updateView({ ...base, status: { status: 'no-update' } }))
    expect(actions.hint).toContain('0.1.0')
    expect(actions.canDownload).toBe(false)
  })
})

describe('开关解析', () => {
  test('只有 1/true/yes/on 才算开', () => {
    expect(isFlagOn('1')).toBe(true)
    expect(isFlagOn('true')).toBe(true)
    expect(isFlagOn(' YES ')).toBe(true)
    expect(isFlagOn('on')).toBe(true)
    expect(isFlagOn('0')).toBe(false)
    expect(isFlagOn('false')).toBe(false)
    expect(isFlagOn('')).toBe(false)
    expect(isFlagOn(undefined)).toBe(false)
  })
})

/** 假 Updater：按脚本发状态，并记录被调用的动作。 */
function fakeUpdater(input: {
  local?: Record<string, unknown>
  info?: Record<string, unknown>
  check?: () => void | Promise<void>
  download?: () => void | Promise<void>
  apply?: () => void | Promise<void>
}): { updater: UpdaterLike; calls: string[]; emit: (status: string, details?: StatusLike['details']) => void } {
  const calls: string[] = []
  let listener: ((entry: StatusLike) => void) | null = null
  let info = { version: '0.2.0', hash: 'h2', updateAvailable: true, updateReady: false, error: '', ...input.info }
  return {
    updater: {
      getLocalInfo: async () => ({
        version: '0.1.0',
        hash: 'h1',
        channel: 'stable',
        baseUrl: 'https://example.com/r',
        identifier: 'com.arcreel.dsh-desktop-tauriapp',
        ...input.local,
      }),
      checkForUpdate: async () => {
        calls.push('check')
        await input.check?.()
        return info
      },
      downloadUpdate: async () => {
        calls.push('download')
        await input.download?.()
      },
      applyUpdate: async () => {
        calls.push('apply')
        await input.apply?.()
      },
      updateInfo: () => info,
      onStatusChange: (callback) => {
        listener = callback
      },
    },
    calls,
    emit: (status, details) => listener?.({ status, details }),
  }
}

describe('createUpdater（IO 外壳）', () => {
  const logLines: string[] = []
  const log = (line: string): void => {
    logLines.push(line)
  }

  test('被开关关掉 ⇒ 不可用且写明是哪个环境变量', async () => {
    const updater = createUpdater({
      log,
      env: { [UPDATE_DISABLE_ENV]: '1' },
      importUpdater: async () => null,
    })
    await updater.check()
    const snapshot = updater.snapshot()
    expect(snapshot.available).toBe(false)
    expect(snapshot.view.phase).toBe('unavailable')
    expect(snapshot.view.reason).toContain(UPDATE_DISABLE_ENV)
    expect(snapshot.actions.canCheck).toBe(false)
  })

  test('框架里没有 Updater ⇒ 不可用但不说成崩溃', async () => {
    const updater = createUpdater({ log, env: {}, importUpdater: async () => null })
    await updater.check()
    expect(updater.available).toBe(false)
    expect(updater.reason).toContain('没有框架更新器')
  })

  test('读不到本地版本信息 ⇒ 不可用（错误进 reason）', async () => {
    const updater = createUpdater({
      log,
      env: {},
      importUpdater: async () => {
        throw new Error('boom')
      },
    })
    await updater.check()
    expect(updater.available).toBe(false)
    expect(updater.reason).toBeTruthy()
  })

  test('baseUrl 为空 ⇒ 不可用，并提示默认源', async () => {
    const fake = fakeUpdater({ local: { baseUrl: '' } })
    const updater = createUpdater({ log, env: {}, importUpdater: async () => fake.updater })
    await updater.check()
    expect(updater.available).toBe(false)
    expect(updater.reason).toContain('release.baseUrl')
    expect(updater.reason).toContain(DEFAULT_UPDATE_BASE_URL)
  })

  test('没给构建环境时按 version.json 的 channel 推清单前缀', async () => {
    const fake = fakeUpdater({ local: { channel: 'canary' } })
    const updater = createUpdater({
      log,
      env: {},
      importUpdater: async () => fake.updater,
      os: 'darwin',
      arch: 'arm64',
    })
    const snapshot = await updater.check()
    expect(snapshot.view.feedUrl).toBe('https://example.com/r/canary-macos-arm64-update.json')
  })

  test('env 覆盖更新源：视图里的 feedUrl 跟着覆盖走', async () => {
    const fake = fakeUpdater({ local: { baseUrl: '' } })
    const updater = createUpdater({
      log,
      env: { [UPDATE_BASE_URL_ENV]: 'http://127.0.0.1:8899/feed/' },
      importUpdater: async () => fake.updater,
      os: 'darwin',
      arch: 'arm64',
      buildEnv: 'stable',
    })
    const snapshot = await updater.check()
    expect(snapshot.available).toBe(true)
    expect(snapshot.view.feedUrl).toBe('http://127.0.0.1:8899/feed/stable-macos-arm64-update.json')
    expect(fake.calls).toEqual(['check'])
  })

  test('检查 → 下载 → 安装：状态订阅把阶段与进度带进视图', async () => {
    const fake = fakeUpdater({})
    const updater = createUpdater({
      log,
      env: {},
      importUpdater: async () => fake.updater,
      os: 'darwin',
      arch: 'arm64',
      buildEnv: 'stable',
    })

    const checked = await updater.check()
    expect(checked.view.updateAvailable).toBe(true)
    fake.emit('update-available', {})
    expect(updater.snapshot().view.phase).toBe('available')
    expect(updater.snapshot().actions.canDownload).toBe(true)

    // downloadUpdate 期间框架会发 download-progress（这里手动发一条）
    fake.emit('download-progress', { progress: 0.5, bytesDownloaded: 512, totalBytes: 1024 })
    const downloading = await updater.download()
    expect(downloading.view.phase).toBe('downloading')
    expect(downloading.view.progress).toBe(50)
    expect(downloading.actions.canCheck).toBe(false)

    fake.emit('complete', {})
    const applied = await updater.apply()
    expect(applied.view.updateReady).toBe(true)
    expect(applied.actions.canApply).toBe(true)
    expect(fake.calls).toEqual(['check', 'download', 'apply'])
  })

  test('框架抛错 ⇒ 落到 error 而不是抛给调用方', async () => {
    const fake = fakeUpdater({
      check: () => {
        throw new Error('网络不通')
      },
    })
    const updater = createUpdater({ log, env: {}, importUpdater: async () => fake.updater })
    const snapshot = await updater.check()
    expect(snapshot.view.phase).toBe('error')
    expect(snapshot.view.error).toContain('网络不通')
    expect(snapshot.view.label).toBe('更新失败')
  })

  test('start/stop：订阅与退订（退订后回调不再打到壳里）', async () => {
    const fake = fakeUpdater({})
    const updater = createUpdater({ log, env: {}, importUpdater: async () => fake.updater })
    updater.start()
    await Bun.sleep(10)
    fake.emit('checking', {})
    expect(updater.snapshot().view.phase).toBe('checking')
    updater.stop()
    fake.emit('error', { errorMessage: '停掉之后不该再记' })
    expect(updater.snapshot().view.phase).toBe('checking')
    expect(updater.snapshot().view.error).toBe('')
  })
})
