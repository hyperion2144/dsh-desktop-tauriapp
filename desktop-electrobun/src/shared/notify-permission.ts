/**
 * 通知授权状态的纯映射（旧壳 `desktop/src-tauri/src/network/notify_un.rs` 的
 * `permission_state()` 等价物）。
 *
 * 原生桥（`native/notify_un.m`）只回一个整数码，这里把它翻成面板用的状态字符串；
 * 纯函数，无 IO，可单测。
 */

/** 面板与日志使用的授权状态。 */
export type NotifyPermission = 'granted' | 'denied' | 'not_determined' | 'unavailable'

/** 原生桥的状态码 → 状态字符串（0 未知/不可用，1 未决定，2 已拒绝，3 已授权）。 */
export function permissionFromCode(code: number): NotifyPermission {
  if (code === 3) return 'granted'
  if (code === 2) return 'denied'
  if (code === 1) return 'not_determined'
  return 'unavailable'
}

/** 是否已经拿到系统授权（面板据此显示徽标、决定是否值得投递）。 */
export function isPermissionGranted(permission: NotifyPermission): boolean {
  return permission === 'granted'
}

/** 申请权限后的按钮文案（旧壳：申请后引导用户去系统设置）。 */
export function permissionLabel(permission: NotifyPermission): string {
  switch (permission) {
    case 'granted':
      return '已授权'
    case 'denied':
      return '已拒绝'
    case 'not_determined':
      return '未决定'
    default:
      return '不可用'
  }
}

/**
 * 被拒绝/不可用时的引导文案（旧壳 `notify_un.rs` 的原话：
 * 「可在系统设置→通知中手动开启」；新壳的「打开系统设置」按钮走同一个去处）。
 */
export function permissionHint(permission: NotifyPermission, platform: NodeJS.Platform = 'darwin'): string {
  if (permission === 'granted') return '系统允许本应用发送通知。'
  if (permission === 'denied') {
    return platform === 'darwin'
      ? '系统已拒绝本应用的通知；可在「系统设置 → 通知 → DeepSeek Harness Desktop」里手动开启。'
      : '系统已拒绝本应用的通知，请在系统设置里手动开启。'
  }
  if (permission === 'not_determined') return '尚未申请通知权限（第一次投递或点「申请权限」时系统会弹窗）。'
  return '当前平台没有可用的系统通知通道（开发模式下裸进程无应用身份，打包后可用）。'
}

/** GitHub 风格的设置面板深链：直接跳到本应用的「通知」设置页。 */
export const MACOS_NOTIFICATION_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.notifications'
