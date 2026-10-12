// 托盘「新建 Profile…」「迁移 Profile…」（F9，旧壳 tray.rs:76-79）的弹框：
// 一个小 CEF 窗口装一张表单，提交到壳自己的 `/__shell__/profile-op`，服务面负责落地。
// 本模块只出 HTML 与校验规则，不 import electrobun（可单测）。
/** F9：托盘弹框提交到 `/__shell__/profile-op` 的请求体 */
export interface ProfileOpRequest {
  op: 'create' | 'migrate'
  /** create = 新名称；migrate = 目标名称 */
  target?: string
  /** migrate = 源 profile */
  source?: string
  /** migrate：目标已存在时是否覆盖 */
  overwrite?: boolean
}

export interface ProfileOpResult {
  ok: boolean
  message: string
  /** 成功时回目标 profile，壳用来开窗/刷新托盘 */
  profile?: string
}

/** profile 名规则：小写字母/数字开头，允许连字符，1-64 字符（旧壳 migrate 用 1-32 的宽松版） */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name)
}

/** 迁移目标与源相同的快速拒绝（服务面还有更全的校验） */
export function isSelfMigrate(source: string, target: string): boolean {
  return source !== '' && source === target
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export type ProfileOpDialogKind = 'create' | 'migrate'

/** 弹框页：创建 = 名称输入；迁移 = 源/目标 + 覆盖确认。提交后按结果显示一句话。 */
export function profileDialogHtml(kind: ProfileOpDialogKind, profiles: readonly string[]): string {
  const title = kind === 'create' ? '新建 Profile' : '迁移 Profile'
  const fields =
    kind === 'create'
      ? `    <label>名称（小写字母、数字、连字符）<input id="target" autofocus></label>`
      : `    <label>源 profile<select id="source">${profiles
          .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
          .join('')}</select></label>
    <label>目标名称<input id="target" placeholder="新 profile 名"></label>
    <label class="check"><input id="overwrite" type="checkbox"> 目标已存在时覆盖</label>`
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { font: 13px -apple-system, sans-serif; margin: 16px; background: #1b1d21; color: #e8e8e8; }
  h1 { font-size: 15px; margin: 0 0 14px; }
  label { display: block; margin: 10px 0; }
  input, select { display: block; width: 100%; box-sizing: border-box; margin-top: 4px;
    padding: 6px 8px; border-radius: 6px; border: 1px solid #3a3d44; background: #26282e; color: inherit; }
  label.check input { display: inline-block; width: auto; margin-right: 6px; }
  button { margin-top: 12px; padding: 7px 18px; border: 0; border-radius: 6px;
    background: #4c6ef5; color: white; cursor: pointer; }
  #msg { margin-top: 10px; min-height: 18px; white-space: pre-wrap; }
  #msg.err { color: #ff8787; }
  #msg.ok { color: #69db7c; }
</style>
</head>
<body>
  <h1>${title}</h1>
  <form id="f">
${fields}
    <button type="submit">${kind === 'create' ? '创建' : '开始迁移'}</button>
    <div id="msg"></div>
  </form>
  <script>
    const f = document.getElementById('f')
    const msg = document.getElementById('msg')
    f.addEventListener('submit', async (event) => {
      event.preventDefault()
      const body = {
        op: '${kind}',
        target: (document.getElementById('target') || {}).value || '',
        source: (document.getElementById('source') || {}).value || '',
        overwrite: !!(document.getElementById('overwrite') || {}).checked,
      }
      msg.className = ''
      msg.textContent = kind === 'create' ? '创建中…' : '迁移中（复制依赖树，可能要一会儿）…'
      try {
        const res = await fetch('/__shell__/profile-op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => ({ ok: false, message: '响应不是 JSON' }))
        msg.className = data.ok ? 'ok' : 'err'
        msg.textContent = data.message || (data.ok ? '完成' : '失败')
        window.__dshProfileOpResult = data
        if (data.ok) setTimeout(() => window.close(), 1200)
      } catch (error) {
        msg.className = 'err'
        msg.textContent = String(error)
      }
    })
  </script>
</body>
</html>
`
}
