// 驱动 spike 页面跑一次真实会话（用于 #219 的流式/长跑验收）
// 用法：node drive.mjs "要发送的文本"
const text = process.argv[2] ?? "用 300 字左右介绍一下你自己，分成多段，慢慢输出。";
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page" && /127\.0\.0\.1:\d+/.test(t.url) && !t.url.includes("9222"));
if (!page) { console.log("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const evalJs = async (expression) => {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.result?.exceptionDetails) return { error: (r.result.exceptionDetails.exception?.description ?? "").slice(0, 300) };
	return r.result?.result?.value;
};

// 1) 若还没有会话，先在工作区里新建一个
const created = await evalJs(`(() => {
  const btns = [...document.querySelectorAll("button")];
  const nb = btns.find(b => (b.innerText||"").includes("New session in dsh-desktop-tauriapp"));
  if (!nb) return "no-new-session-button";
  nb.click();
  return "clicked:" + nb.innerText.trim().slice(0,40);
})()`);
console.log("新建会话:", JSON.stringify(created));
await new Promise((r) => setTimeout(r, 2500));

// 2) 聚焦输入框并插入文本（真实输入事件）
const focus = await evalJs(`(() => { const el = document.querySelector("[contenteditable=true]"); if(!el) return "no-composer"; el.focus(); return "focused:" + (el.getAttribute("data-placeholder")||"").slice(0,40); })()`);
console.log("输入框:", JSON.stringify(focus));
await send("Input.insertText", { text });
await new Promise((r) => setTimeout(r, 600));

// 3) 点发送
const clicked = await evalJs(`(() => {
  const b = [...document.querySelectorAll("button")].find(b => (b.getAttribute("aria-label")||"").includes("Send message"));
  if (!b) return "no-send-button";
  b.click();
  return "sent";
})()`);
console.log("发送:", JSON.stringify(clicked));

// 4) 采样 40s，看正文是否在增长（流式）
for (const t of [5, 12, 20, 30, 40]) {
	await new Promise((r) => setTimeout(r, t === 5 ? 5000 : 7000 + t));
	const snap = await evalJs(`(() => {
	  const nodes = [...document.querySelectorAll("[data-chat-anchor-key], [data-chat-flow-key]")];
	  const text = (document.body.innerText||"").replace(/\\s+/g," ").trim();
	  return { blocks: nodes.length, chars: text.length, tail: text.slice(-160) };
	})()`);
	console.log(`t≈${t}s`, JSON.stringify(snap));
}
ws.close();
