// 采样 spike 页面状态（一行 JSON），供长跑监控调用
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page" && /127\.0\.0\.1:\d+/.test(t.url) && !t.url.includes("9222"));
if (!page) { console.log(JSON.stringify({ error: "no-page-target" })); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((r) => { const i = ++seq; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise((r) => ws.addEventListener("open", r));
const r = await send("Runtime.evaluate", {
	expression: `(() => {
	  const root = document.getElementById("root");
	  const text = (document.body.innerText || "");
	  return {
	    url: location.href,
	    title: document.title,
	    rootChildren: root ? root.childElementCount : -1,
	    chars: text.replace(/\\s+/g, " ").length,
	    blocks: document.querySelectorAll("[data-chat-anchor-key],[data-chat-flow-key]").length,
	    transport: globalThis.__DSH_TRANSPORT__ ? globalThis.__DSH_TRANSPORT__.streamBaseUrl : null,
	  };
	})()`,
	returnByValue: true,
});
console.log(JSON.stringify(r.result?.result?.value ?? { error: "eval-failed" }));
ws.close();
