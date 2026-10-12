// 「桌面通知」tab 的数据面（缝 ② 纯逻辑 + 真文件）。
//
// 守的是什么：客户端 `src/client/notifications-tab.tsx` 一次 `get_notifications_state` 拉全
// （permission / config / **scenarios** / **groups** / **sounds**）。少任何一个字段，面板就
// 渲染不出来——实机症状是「桌面通知页整片空白」（2026-10-11 维护者报）。这一层必须把 14 条
// 场景元数据、分组表与音效列表**一次给全**，否则空白会重现。

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCommandTable, type CommandDeps } from '../src/bun/commands.ts'
import type { RpcContext } from '../src/bun/rpc.ts'
import { importSound, listSounds, systemDefaultSoundCommand } from '../src/bun/notifications.ts'
import { SOUND_FORMATS, soundFormatMatches } from '../src/shared/notify-policy.ts'
import {
  defaultSettings,
  NOTIFICATION_GROUPS,
  NOTIFICATION_SCENARIOS,
  type DesktopSettings,
} from '../src/shared/settings.ts'
import { loadSettings, saveSettings, updateSettings } from '../src/bun/settings-store.ts'

interface Harness {
  deps: CommandDeps
  home: string
  table: Record<string, (args: Record<string, unknown>, context?: RpcContext) => unknown | Promise<unknown>>
  calls: { logs: string[]; sounds: string[]; systemSounds: number; picked: () => string | null }
  cleanup: () => void
}

function harness(overrides: Partial<CommandDeps> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), 'dsh-notify-'))
  saveSettings(home, defaultSettings())
  let settings: DesktopSettings = loadSettings({ home }).settings
  const calls = {
    logs: [] as string[],
    sounds: [] as string[],
    systemSounds: 0,
    picked: (): string | null => null,
  }
  const deps: CommandDeps = {
    home,
    profile: 'desktop',
    platform: 'darwin',
    log: (line) => calls.logs.push(line),
    settings: () => settings,
    save: (patch) => {
      settings = updateSettings(home, patch)
      return settings
    },
    playSound: (name) => calls.sounds.push(name),
    playSystemSound: () => {
      calls.systemSounds += 1
    },
    pickSoundFile: async () => calls.picked(),
    importSound: (path) => importSound(home, path),
    ...overrides,
  }
  return {
    deps,
    home,
    table: createCommandTable(deps),
    calls,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** 写一个「魔数正确」的假音频：wav 的 RIFF 头 + 少量数据。 */
function writeWav(path: string): void {
  const head = Buffer.from('RIFF....WAVEfmt ', 'binary')
  writeFileSync(path, Buffer.concat([head, Buffer.alloc(16)]))
}

describe('桌面通知 tab 的数据面', () => {
  test('一次拉全：14 条场景 + 6 组 + 音效列表（少一个字段面板就空白）', async () => {
    const h = harness()
    try {
      const state = (await h.table.get_notifications_state?.({})) as Record<string, unknown>
      // 没有原生桥（非 macOS / 没打包 / 库缺失）时如实说 unavailable，不再像以前那样写死 granted
      expect(state.permission).toBe('unavailable')
      expect(typeof state.config).toBe('object')

      const scenarios = state.scenarios as Array<Record<string, unknown>>
      expect(scenarios).toHaveLength(NOTIFICATION_SCENARIOS.length)
      expect(scenarios).toHaveLength(14)
      for (const row of scenarios) {
        expect(typeof row.id).toBe('string')
        expect(typeof row.group).toBe('string')
        expect(typeof row.name).toBe('string')
        expect(typeof row.desc).toBe('string')
        expect(typeof row.defaultOn).toBe('boolean')
        expect(row).toHaveProperty('config') // null 或用户配置，两种情况客户端都认
      }
      // 顺序与 id 全对齐（客户端按 scenarios 渲染，缺一行就少一个场景）
      expect(scenarios.map((row) => row.id)).toEqual(NOTIFICATION_SCENARIOS.map((meta) => meta.id))
      expect(state.groups).toEqual(NOTIFICATION_GROUPS)
      expect(state.sounds).toEqual([])
    } finally {
      h.cleanup()
    }
  })

  test('sounds 列出 $DSH_HOME/sounds 里白名单内的文件（排序、忽略目录与野扩展名）', async () => {
    const h = harness()
    try {
      const dir = join(h.home, 'sounds')
      mkdirSync(dir, { recursive: true })
      writeWav(join(dir, 'b-tone.wav'))
      writeWav(join(dir, 'a-tone.wav'))
      writeFileSync(join(dir, 'note.txt'), 'not a sound')
      mkdirSync(join(dir, 'sub.wav'), { recursive: true }) // 目录名叫 .wav 也不算
      const state = (await h.table.get_notifications_state?.({})) as Record<string, unknown>
      expect(state.sounds).toEqual(['a-tone.wav', 'b-tone.wav'])
      expect(listSounds(h.home)).toEqual(['a-tone.wav', 'b-tone.wav'])
    } finally {
      h.cleanup()
    }
  })

  test('用户选过的音效反映到 config.scenarios[].config（回填给下拉）', async () => {
    const h = harness()
    try {
      const config = {
        enabled: true,
        dnd: { on: false, from: '22:00', to: '08:00', suppress_fullscreen: true },
        scenarios: { 'task.complete': { enabled: true, sound: 'custom:a-tone.wav' } },
      }
      await h.table.set_notifications_config?.({ config })
      const state = (await h.table.get_notifications_state?.({})) as Record<string, unknown>
      const rows = state.scenarios as Array<Record<string, unknown>>
      const row = rows.find((item) => item.id === 'task.complete')
      expect(row?.config).toEqual({ enabled: true, sound: 'custom:a-tone.wav' })
      const untouched = rows.find((item) => item.id === 'startup.error')
      expect(untouched?.config).toEqual({ enabled: true, sound: 'default' })
    } finally {
      h.cleanup()
    }
  })
})

describe('试听：旧壳 preview_notification_sound(sound) 的语义', () => {
  test('none 不响、default 播系统音、custom:<名> 剥前缀后播自定义音', async () => {
    const h = harness()
    try {
      expect(await h.table.preview_notification_sound?.({ sound: 'none' })).toEqual({
        played: null,
        sound: 'none',
      })
      await h.table.preview_notification_sound?.({ sound: 'default' })
      expect(h.calls.systemSounds).toBe(1)
      expect(h.calls.sounds).toEqual([])
      await h.table.preview_notification_sound?.({ sound: 'custom:a-tone.wav' })
      expect(h.calls.sounds).toEqual(['a-tone.wav'])
      // 兼容旧调用方的 { name } 形状
      await h.table.preview_notification_sound?.({ name: 'b-tone.wav' })
      expect(h.calls.sounds).toEqual(['a-tone.wav', 'b-tone.wav'])
    } finally {
      h.cleanup()
    }
  })

  test('没有原生桥时如实回答：不假装查过系统，也不假装申请过', async () => {
    const h = harness()
    try {
      const result = (await h.table.request_notification_permission_cmd?.({})) as Record<string, unknown>
      expect(result.granted).toBe(false)
      expect(result.permission).toBe('unavailable')
      expect(result.prompted).toBe(false)
      expect(h.calls.logs.some((line) => line.includes('没有可用的授权申请通道'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  test('有原生桥时：申请前后状态都报真值，并写日志（旧壳 notify_un.rs 的 permission_state）', async () => {
    // 桩：第一次 status() 回 notDetermined，request() 之后回 granted
    let permission: 'not_determined' | 'granted' = 'not_determined'
    const h = harness({
      notifyPermission: () => permission,
      notifyRequestPermission: () => {
        permission = 'granted'
        return permission
      },
    })
    try {
      const before = (await h.table.get_notifications_state?.({})) as Record<string, unknown>
      expect(before.permission).toBe('not_determined')

      const result = (await h.table.request_notification_permission_cmd?.({})) as Record<string, unknown>
      expect(result).toEqual({ granted: true, permission: 'granted', prompted: true })
      expect(h.calls.logs.some((line) => line.includes('申请通知权限：not_determined → granted'))).toBe(true)

      const after = (await h.table.get_notifications_state?.({})) as Record<string, unknown>
      expect(after.permission).toBe('granted')
    } finally {
      h.cleanup()
    }
  })
})

describe('自定义音效：选文件 → 入库', () => {
  test('choose 返回路径，import 拷贝进 sounds/ 并回文件名', async () => {
    const h = harness()
    try {
      const source = join(h.home, 'picked.wav')
      writeWav(source)
      h.calls.picked = (): string => source
      expect(await h.table.choose_notification_sound?.({})).toBe(source)
      expect(await h.table.import_notification_sound?.({ path: source })).toBe('picked.wav')
      expect(listSounds(h.home)).toEqual(['picked.wav'])
    } finally {
      h.cleanup()
    }
  })

  test('没接选择器时 choose 回 null（面板不会炸），import 空路径/未接线报错', async () => {
    const h = harness({ pickSoundFile: undefined, importSound: undefined })
    try {
      expect(await h.table.choose_notification_sound?.({})).toBeNull()
      await expect(
        Promise.resolve().then(() => h.table.import_notification_sound?.({ path: '' })),
      ).rejects.toThrow('path 不能为空')
      await expect(
        Promise.resolve().then(() => h.table.import_notification_sound?.({ path: '/tmp/a.wav' })),
      ).rejects.toThrow('未接音效导入')
    } finally {
      h.cleanup()
    }
  })

  test('入库校验：野扩展名、魔数不符、超 5MB 都拒绝，且不落盘', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-import-'))
    try {
      const badExt = join(home, 'note.txt')
      writeFileSync(badExt, 'x')
      expect(() => importSound(home, badExt)).toThrow('不支持的音效格式')

      const fakeWav = join(home, 'fake.wav')
      writeFileSync(fakeWav, 'not really a wav')
      expect(() => importSound(home, fakeWav)).toThrow('魔数校验失败')

      const huge = join(home, 'huge.wav')
      writeFileSync(huge, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(5 * 1024 * 1024)]))
      expect(() => importSound(home, huge)).toThrow('上限')

      expect(listSounds(home)).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('音效格式表与系统音', () => {
  test('SOUND_FORMATS 覆盖 wav/mp3/ogg，魔数按扩展名判', () => {
    expect(SOUND_FORMATS.map(([ext]) => ext)).toEqual(['wav', 'mp3', 'ogg'])
    expect(soundFormatMatches('a.wav', new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(true)
    expect(soundFormatMatches('a.mp3', new Uint8Array([0x49, 0x44, 0x33, 0x03]))).toBe(true)
    expect(soundFormatMatches('a.ogg', new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe(true)
    expect(soundFormatMatches('a.wav', new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe(false)
    expect(soundFormatMatches('a.m4a', new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false)
    expect(soundFormatMatches('wav', new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe(false)
  })

  test('系统默认提示音（D7）：三平台各有命令，Linux 无主题音则静默', () => {
    expect(systemDefaultSoundCommand('darwin')?.[0]).toBe('afplay')
    expect(systemDefaultSoundCommand('win32')?.[0]).toBe('powershell')
    // Linux：有 freedesktop 主题音则给 aplay 命令，没有则静默（null）——两种都合法，
    // runner 镜像是否带音效文件不受我们控制（ubuntu-26 已自带），不能断言具体值。
    const linux = systemDefaultSoundCommand('linux')
    expect(linux === null || linux[0] === 'aplay').toBe(true)
  })
})
