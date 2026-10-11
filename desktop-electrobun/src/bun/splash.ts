// 启动界面（splash）：壳还在起宿主的那 10–60 秒里，用户看到的是它，而不是空白窗口。
//
// 这里只有**纯的 HTML 与注入脚本**（不 import electrobun）——窗口在 index.ts 里建，
// 这样缝 ② 能直接断言文案/转义/进度，无显示器也能跑。
//
// 与页面的接口：HTML 里挂 `window.__dshSplash = { stage(text, percent), fail(message) }`；
// 主进程用 webview.executeJavascript 推阶段（见 splashStageScript / splashFailScript）。

import { APP_NAME } from '../shared/app.ts'
import { FAILED_LABEL, stageLabel, stagePercent, type ShellStage } from './stages.ts'

export const SPLASH_WIDTH = 420
export const SPLASH_HEIGHT = 236

/** 把任意文案塞进 JS 字符串字面量（阶段/错误信息都可能带引号）。 */
function jsString(value: string): string {
  return JSON.stringify(value)
}

export function splashStageScript(stage: ShellStage): string {
  return `window.__dshSplash && window.__dshSplash.stage(${jsString(stageLabel(stage))}, ${String(stagePercent(stage))})`
}

export function splashFailScript(message: string): string {
  return `window.__dshSplash && window.__dshSplash.fail(${jsString(message)})`
}

export function splashHtml(): string {
  // 深色、居中、无边框——与产品主题一致；失败时把红字与提示露出来，别静默转圈。
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${APP_NAME}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 14px; background: #16161a; color: #e7e7ea;
    font: 13px/1.5 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  .name { font-size: 15px; font-weight: 600; letter-spacing: .02em; }
  .stage { color: #9a9aa2; min-height: 20px; }
  .track { width: 260px; height: 4px; border-radius: 2px; background: #2a2a31; overflow: hidden; }
  .bar { height: 100%; width: 4%; border-radius: 2px; background: #6c7bff; transition: width .18s ease; }
  .error { display: none; max-width: 340px; text-align: center; color: #ff8b8b; white-space: pre-wrap; }
  .hint { display: none; max-width: 340px; text-align: center; color: #7c7c85; font-size: 12px; }
  body.failed .track { display: none; }
  body.failed .error, body.failed .hint { display: block; }
</style>
</head>
<body>
  <div class="name">${APP_NAME}</div>
  <div class="stage" id="stage">正在启动…</div>
  <div class="track"><div class="bar" id="bar"></div></div>
  <div class="error" id="error"></div>
  <div class="hint" id="hint">可退出后重试；日志在 ~/.dsh/shell.log</div>
  <script>
    window.__dshSplash = {
      stage: function (text, percent) {
        var stage = document.getElementById('stage')
        var bar = document.getElementById('bar')
        if (stage) stage.textContent = text
        if (bar && typeof percent === 'number') bar.style.width = Math.max(4, Math.min(100, percent)) + '%'
      },
      fail: function (message) {
        document.body.classList.add('failed')
        var stage = document.getElementById('stage')
        var error = document.getElementById('error')
        if (stage) stage.textContent = ${jsString(FAILED_LABEL)}
        if (error) error.textContent = message
      },
    }
  </script>
</body>
</html>`
}
