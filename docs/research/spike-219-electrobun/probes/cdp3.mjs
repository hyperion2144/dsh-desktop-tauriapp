// CDP 网络失败/4xx 捕获：reload 页面，收集失败请求与 4xx/5xx 响应
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = list.find((t) => t.type === "page" && /127\.0\.0\.1:\d+/.test(t.url) && !t.url.includes("9222"));
if (!page) { console.log("no page target"); process.exit(1); }
console.log("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const urls = new Map(); const bad = []; const failed = [];
ws.addEventListener("message", (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
	if (m.method === "Network.requestWillBeSent") urls.set(m.params.requestId, m.params.request.url);
	if (m.method === "Network.responseReceived" && m.params.response.status >= 400) bad.push(`${m.params.response.status} ${m.params.response.url}`.slice(0, 200));
	if (m.method === "Network.loadingFailed") failed.push(`${m.params.errorText} ${(urls.get(m.params.requestId) ?? "?").slice(0, 160)}`);
});
await new Promise((r) => ws.addEventListener("open", r));
await send("Network.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 15000));
const uniq = (a) => [...new Set(a)];
console.log("=== 4xx/5xx（去重）===");
for (const l of uniq(bad)) console.log(l);
console.log("=== loadingFailed（去重）===");
for (const l of uniq(failed)) console.log(l);
ws.close();
