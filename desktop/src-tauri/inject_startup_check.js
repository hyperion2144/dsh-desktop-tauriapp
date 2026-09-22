(async () => {
  // 等待 Tauri IPC + DOM 就绪（最多 5s）
  for (let i = 0; i < 50; i++) {
    const inv = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
    if (inv && document.body) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const invoke = window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke;
  if (!invoke || !document.body) { console.error('[startup-check] IPC/DOM not ready after 5s'); return; }
  try {
    const res = await invoke('check_startup_needed');
    if (!res || res.action === 'none') return;

    const css = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);font-family:system-ui,sans-serif';
    const cardCss = 'background:#16181d;border:1px solid #ffffff1f;border-radius:12px;padding:24px;min-width:320px;max-width:400px';
    const titleCss = 'font-size:15px;font-weight:600;margin-bottom:16px;color:#e7eaf0';
    const btnCss = 'padding:10px 14px;border-radius:8px;border:1px solid #ffffff1f;background:transparent;color:#e7eaf0;font-size:13px;cursor:pointer;text-align:left';
    const btnHover = 'rgba(255,255,255,.07)';
    const startCss = 'margin-top:8px;padding:8px 14px;border-radius:8px;border:none;background:#4176e6;color:#fff;font-size:13px;cursor:pointer;width:100%;box-sizing:border-box';
    const inputCss = 'margin-top:12px;padding:8px;border-radius:8px;border:1px solid #ffffff1f;background:#151517;color:#e7eaf0;font-size:13px;width:100%;box-sizing:border-box';

    if (res.action === 'profile-selection') {
      const el = document.createElement('div'); el.style.cssText = css;
      const card = document.createElement('div'); card.style.cssText = cardCss;
      const title = document.createElement('div'); title.style.cssText = titleCss; title.textContent = '选择要启动的 Profile';
      card.appendChild(title);
      const list = document.createElement('div'); list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
      for (const p of (res.profiles || [])) {
        const btn = document.createElement('button'); btn.style.cssText = btnCss; btn.textContent = p;
        btn.onmouseenter = () => btn.style.background = btnHover;
        btn.onmouseleave = () => btn.style.background = 'transparent';
        btn.onclick = () => { el.remove(); invoke('confirm_startup_profile', { name: p, repair: false }).catch(e => console.error('[startup]', e)); };
        list.appendChild(btn);
      }
      const input = document.createElement('input'); input.style.cssText = inputCss; input.placeholder = '或输入新 profile 名称';
      const startBtn = document.createElement('button'); startBtn.style.cssText = startCss; startBtn.textContent = '新建并启动';
      startBtn.onclick = () => { const n = input.value.trim(); if (!n) return; el.remove(); invoke('confirm_startup_profile', { name: n, repair: true }).catch(e => console.error('[startup]', e)); };
      card.appendChild(list); card.appendChild(input); card.appendChild(startBtn);
      el.appendChild(card); document.body.appendChild(el);
      return;
    }

    if (res.action === 'profile-incomplete') {
      const profile = res.profile || ''; if (!profile) return;
      const d = res.details || {};
      const missing = [...(d.missing_files || []), ...(d.node_modules_exists ? [] : ['node_modules']), ...(d.dir_exists ? [] : ['profile 目录'])].join(', ');
      const el = document.createElement('div'); el.style.cssText = css;
      const card = document.createElement('div'); card.style.cssText = cardCss + ';text-align:center';
      const title = document.createElement('div'); title.style.cssText = titleCss; title.textContent = 'Profile「' + profile + '」不完整';
      const desc = document.createElement('div'); desc.style.cssText = 'font-size:12px;color:#9aa4b2;margin-bottom:20px'; desc.textContent = '缺失：' + missing + '。是否修复？';
      const btns = document.createElement('div'); btns.style.cssText = 'display:flex;gap:10px';
      const noBtn = document.createElement('button'); noBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:1px solid #ffffff1f;background:transparent;color:#e7eaf0;font-size:13px;cursor:pointer'; noBtn.textContent = '直接启动';
      noBtn.onclick = () => { el.remove(); invoke('confirm_startup_profile', { name: profile, repair: false }).catch(e => console.error('[startup]', e)); };
      const yesBtn = document.createElement('button'); yesBtn.style.cssText = 'flex:1;padding:10px;border-radius:8px;border:none;background:#4176e6;color:#fff;font-size:13px;cursor:pointer'; yesBtn.textContent = '修复并启动';
      yesBtn.onclick = () => { el.remove(); invoke('confirm_startup_profile', { name: profile, repair: true }).catch(e => console.error('[startup]', e)); };
      btns.appendChild(noBtn); btns.appendChild(yesBtn);
      card.appendChild(title); card.appendChild(desc); card.appendChild(btns);
      el.appendChild(card); document.body.appendChild(el);
    }
  } catch (e) { console.error('[startup-check]', e); }
})();
