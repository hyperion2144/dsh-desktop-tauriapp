// F12：壳注入到页面里的确认弹窗（旧壳 register/mod.rs confirm_modal_js 的等价物）。
// 旧壳用 Tauri IPC `ui_input_confirm` 回填；新壳页面没有 Tauri，改 POST 壳自答端点
// `/__shell__/input-confirm`。本模块只产 JS 文本与端点常量（纯逻辑，可单测）。

export const INPUT_CONFIRM_ENDPOINT = '/__shell__/input-confirm'

export interface ConfirmModalSpec {
  /** 回填的流标识（旧壳 register 用固定 flow 判别） */
  flow: string
  title: string
  body: string
  /** 确认按钮文案（旧壳「仍要注册（覆盖）」） */
  okLabel?: string
  cancelLabel?: string
}

/** 确认弹窗 JS：确认回填 value='force'，取消/ESC 回填空串；POST 后自移除。 */
export function confirmModalScript(spec: ConfirmModalSpec): string {
  const flow = JSON.stringify(spec.flow)
  const title = JSON.stringify(spec.title)
  const body = JSON.stringify(spec.body)
  const okLabel = JSON.stringify(spec.okLabel ?? '仍要注册（覆盖）')
  const cancelLabel = JSON.stringify(spec.cancelLabel ?? '取消')
  const endpoint = JSON.stringify(INPUT_CONFIRM_ENDPOINT)
  return `(function(){
  var key = 'dshDesktopConfirmModal';
  var old = document.getElementById(key);
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.id = key;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
  var card = document.createElement('div');
  card.style.cssText = 'background:var(--dsw-alias-bg-layer-1,#1e1e1e);border:1px solid var(--dsw-alias-border-l2,#444);border-radius:12px;padding:18px 20px;min-width:360px;max-width:80vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);color:var(--dsw-alias-label-primary,#eee);';
  var titleEl = document.createElement('div');
  titleEl.textContent = ${title};
  titleEl.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:10px;';
  var bodyEl = document.createElement('div');
  bodyEl.textContent = ${body};
  bodyEl.style.cssText = 'font-size:12.5px;line-height:1.6;white-space:pre-wrap;color:var(--dsw-alias-label-secondary,#bbb);word-break:break-all;';
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
  var cancel = document.createElement('button');
  cancel.textContent = ${cancelLabel};
  cancel.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#444);background:transparent;color:var(--dsw-alias-label-primary,#eee);font-size:13px;cursor:default;';
  var ok = document.createElement('button');
  ok.textContent = ${okLabel};
  ok.style.cssText = 'padding:6px 14px;border-radius:8px;border:none;background:var(--dsw-alias-state-accent-primary,#3b82f6);color:#fff;font-size:13px;cursor:default;';
  var done = false;
  function submit(value) {
    if (done) return;
    done = true;
    try {
      fetch(${endpoint}, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: ${flow}, value: value }),
      }).catch(function(){});
    } catch (e) {}
    overlay.remove();
  }
  ok.addEventListener('click', function(){ submit('force') });
  cancel.addEventListener('click', function(){ submit('') });
  overlay.addEventListener('keydown', function(e){ if (e.key === 'Escape') submit('') });
  row.appendChild(cancel);
  row.appendChild(ok);
  card.appendChild(titleEl);
  card.appendChild(bodyEl);
  card.appendChild(row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  ok.focus();
})()`
}
