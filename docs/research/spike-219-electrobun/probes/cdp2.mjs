// CDP 探针：读 CEF 页面的运行时状态 + 控制台/异常
// 用法：node /tmp/spike-219/cdp2.mjs [端口片段]
const needle = process.argv[2] ?? "127.0.0.1";
const list = await (await fetch("http://127.0.0.1:9222/json")).json();
const page =
	list.find((t) => t.type === "page" && /127\.0\.0\.1:\d+/.test(t.url) && !t.url.includes("9222")) ??
	list.find((t) => t.type === "page");
if (!page) {
	console.log("没有 page target：", JSON.stringify(list.map((t) => [t.type, t.url]), null, 1));
	process.exit(1);
}
console.log("target:", page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
	new Promise((res) => {
		const id = ++seq;
		pending.set(id, res);
		ws.send(JSON.stringify({ id, method, params }));
	});

const logs = [];
ws.addEventListener("message", (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)(m);
		pending.delete(m.id);
		return;
	}
	if (m.method === "Runtime.consoleAPICalled") {
		logs.push(`console.${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300));
	}
	if (m.method === "Runtime.exceptionThrown") {
		logs.push(`EXCEPTION: ` + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text ?? "").slice(0, 500));
	}
	if (m.method === "Log.entryAdded") {
		const e = m.params.entry;
		if (e.level === "error" || e.level === "warning") logs.push(`log.${e.level}: ${e.text}`.slice(0, 300));
	}
});

await new Promise((r) => ws.addEventListener("open", r));
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await new Promise((r) => setTimeout(r, 1500));

const expr = `(async () => {
  const out = {};
  out.url = location.href;
  out.title = document.title;
  out.transport = globalThis.__DSH_TRANSPORT__ ? { ownsHost: globalThis.__DSH_TRANSPORT__.ownsHost, streamBaseUrl: globalThis.__DSH_TRANSPORT__.streamBaseUrl } : null;
  out.types = { bootBridge: typeof globalThis.dshDesktopBoot, bootReady: typeof globalThis.__DSH_BOOT_READY__, moduleLoader: typeof globalThis.__ModuleLoader__ };
  out.body = (document.body.innerText || "").slice(0, 300);
  out.scripts = [...document.querySelectorAll("script[src]")].map((s) => s.src).slice(0, 20);
  out.stylesheets = [...document.querySelectorAll("link[rel=stylesheet]")].map((l) => l.href).slice(0, 8);
  out.injectMeta = (document.head.innerHTML.match(/dsh-desktop|__DSH_|boot/g) || []).length;
  try { const r = await fetch("/plugins"); out.pluginsIndex = { status: r.status, ct: r.headers.get("content-type"), head: (await r.text()).slice(0, 120) }; } catch (e) { out.pluginsIndex = String(e); }
  try { const r = await fetch("/api/session/modelCatalog", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); out.api = { status: r.status, ct: r.headers.get("content-type"), head: (await r.text()).slice(0, 120) }; } catch (e) { out.api = String(e); }
  return out;
})()`;

const res = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
console.log("=== evaluate ===");
console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 1));
if (res.result?.exceptionDetails) console.log("EVAL EXC:", JSON.stringify(res.result.exceptionDetails).slice(0, 800));
console.log("=== console/log（最近，最多 40 条）===");
for (const l of logs.slice(-40)) console.log(l);
ws.close();
