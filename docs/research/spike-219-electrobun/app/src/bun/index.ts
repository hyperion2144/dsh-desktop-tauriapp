import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { BrowserWindow, BuildConfig } from "electrobun/bun";

const LOG = "/tmp/spike-219/run.log";
mkdirSync("/tmp/spike-219", { recursive: true });
const log = (...a: unknown[]) => {
	const line = `[spike ${new Date().toISOString()}] ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
	console.log(line);
	try { appendFileSync(LOG, line + "\n"); } catch {}
};

// ---- 1) CEF 断言：没打 CEF 时 renderer:"cef" 会静默回落系统 webview ----
const bc = BuildConfig.getSync();
log("channel =", bc.channel, "| defaultRenderer =", bc.defaultRenderer, "| availableRenderers =", bc.availableRenderers);
if (!bc.availableRenderers.includes("cef")) {
	log("FATAL: availableRenderers 不含 cef —— 会静默回落系统 webview，spike 中止");
	process.exit(3);
}

// ---- 2) 官方同构 Host：Bun 起 dsh，拿 {url, injections}（对齐 apps/desktop-host/src/index.ts）----
const DIST =
	process.env.SPIKE_DIST ??
	"/Users/mutou/Library/Application Support/com.arcreel.dsh-desktop-tauriapp/runtimes/0.2.1-alpha.2/node_modules/@deepseek-ai/dsh-web-frontend/dist";
const APP = "/Users/mutou/Library/Application Support/com.arcreel.dsh-desktop-tauriapp";
const BUN = process.env.SPIKE_BUN ?? "/Users/mutou/.hutch/toolchains/bun/1.4.0/macos-arm64/bun";
const HOST_SCRIPT = "/tmp/spike-219/host-official-style.mjs";
const DSH_HOME = process.env.SPIKE_DSH_HOME ?? "/tmp/spike-219/dsh-home";
const PRELOAD = process.env.SPIKE_PRELOAD ?? "/tmp/spike-rt/0.2.1-alpha.2/bun-preload.mjs";
const LIBDIR = `${APP}/runtimes/0.2.1-alpha.2/node_modules/@deepseek-ai/dsh/lib`;
const PROFILE = process.env.SPIKE_PROFILE ?? "desktop";
const TOKEN = process.env.SPIKE_TOKEN ?? `tok-${Math.random().toString(36).slice(2, 10)}`;
if (!existsSync(join(DIST, "index.html"))) {
	log("FATAL: dist 里没有 index.html：", DIST);
	process.exit(4);
}

const host = Bun.spawn([BUN, "--no-install", "--preload", PRELOAD, HOST_SCRIPT, LIBDIR, PROFILE, "existing"], {
	env: { ...process.env, DSH_HOME },
	stdout: "pipe",
	stderr: "pipe",
});
(async () => {
	const dec = new TextDecoder();
	for await (const chunk of host.stderr) {
		const text = dec.decode(chunk).trim();
		if (text !== "") log("[host stderr]", text.slice(0, 400));
	}
})();

type Ready = { url: string; injections: unknown[] };
const ready = await (async (): Promise<Ready> => {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of host.stdout) {
		buf += dec.decode(chunk, { stream: true });
		let at = buf.indexOf("\n");
		while (at >= 0) {
			const line = buf.slice(0, at);
			buf = buf.slice(at + 1);
			if (line.startsWith("HOST-READY ")) return JSON.parse(line.slice("HOST-READY ".length)) as Ready;
			if (line.trim() !== "") log("[host]", line.slice(0, 300));
			at = buf.indexOf("\n");
		}
	}
	throw new Error("host stdout 结束，未拿到 HOST-READY");
})();
const dshOrigin = new URL(ready.url).origin;
log("host ready | dsh =", dshOrigin, "| injections =", ready.injections.length);

// ---- 3) 取 cookie：官方 authenticateWebHost 语义（303 + set-cookie）----
const authRes = await fetch(ready.url, { redirect: "manual" });
const setCookies = (authRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
const cookie = setCookies[0]?.split(";")[0] ?? "";
log("auth:", authRes.status, authRes.headers.get("location") ?? "", "| cookie =", cookie === "" ? "(none)" : `${cookie.slice(0, 20)}…`);
if (cookie === "") throw new Error("没拿到 dsh cookie（303 + set-cookie 流程失败）");

// ---- 4) 反代：删 host/origin/cookie/sec-fetch-site，塞 cookie；剥 hop-by-hop 头 ----
const HOP = new Set([
	"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
	"transfer-encoding", "upgrade", "set-cookie", "content-encoding", "content-length",
]);
async function proxy(pathname: string, search: string, req: Request): Promise<Response> {

	const headers = new Headers(req.headers);
	for (const h of ["host", "origin", "cookie", "sec-fetch-site", "accept-encoding", "content-length"]) headers.delete(h);
	headers.set("cookie", cookie);
	const init: RequestInit = { method: req.method, headers, redirect: "manual" };
	if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
	const up = await fetch(dshOrigin + pathname + search, init);
	const out = new Headers();
	up.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) out.set(k, v); });
	if (pathname.startsWith("/plugins") || pathname.startsWith("/api")) out.set("cache-control", "no-store");
	const body = up.status === 204 || up.status === 304 ? null : up.body;
	return new Response(body, { status: up.status, headers: out });
}

const PROBE = `<script>(async()=>{const r={};try{r.ua=navigator.userAgent;r.chrome=(navigator.userAgent.match(/Chrom(?:e|ium)\\/(\\d+)/)||[])[1]??null;r.subtle=!!(globalThis.crypto&&globalThis.crypto.subtle);r.bootBridge=typeof globalThis.dshDesktopBoot;r.bootReady=typeof globalThis.__DSH_BOOT_READY__;r.transport=globalThis.__DSH_TRANSPORT__?{ownsHost:globalThis.__DSH_TRANSPORT__.ownsHost,streamBaseUrl:globalThis.__DSH_TRANSPORT__.streamBaseUrl}:null;r.lsPrev=localStorage.getItem("spike-ls");localStorage.setItem("spike-ls",String(Date.now()));r.lsNow=localStorage.getItem("spike-ls");}catch(e){r.err=String(e)}try{await fetch("/__probe__",{method:"POST",body:JSON.stringify({phase:"boot",...r})})}catch{}
setTimeout(async()=>{const q=(s)=>document.querySelectorAll(s).length;try{await fetch("/__probe__",{method:"POST",body:JSON.stringify({phase:"after8s",rootChildren:(document.getElementById("root")?.childElementCount)??-1,elements:q("*"),scripts:q("script"),styles:q("style,link[rel=stylesheet]"),title:document.title,bodyText:(document.body.innerText||"").slice(0,240)})})}catch{}},8000)})()</script>`;

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".jpg": "image/jpeg",
	".ico": "image/x-icon", ".map": "application/json; charset=utf-8", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env["SPIKE_PORT"] ?? 0),
	async fetch(req, srv) {
		const url = new URL(req.url);
		const prefix = `/${TOKEN}/`;
		const raw = url.pathname;
		// 页面内的相对请求（如 fetch("./plugins")）会带上 token 前缀，先剥掉再路由
		const rel = raw.startsWith(prefix) ? `/${raw.slice(prefix.length)}` : raw;
		if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
			const ok = srv.upgrade(req, { data: { url: rel + url.search } });
			if (ok) return undefined as unknown as Response;
		}
		if (rel === "/__probe__") {
			log("PROBE", await req.text());
			return new Response("ok");
		}
		if (rel === "/__renderer__") {
			return Response.json({ renderer: bc.defaultRenderer, availableRenderers: bc.availableRenderers, channel: bc.channel, dsh: dshOrigin, injections: ready.injections });
		}
		// 静态优先：dist 里确实有就从磁盘出（对齐官方 protocol.handle），否则一律转发给 dsh
		const relPath = decodeURIComponent(rel === "/" || rel === "" ? "/index.html" : rel);
		const target = resolve(join(DIST, normalize(relPath)));
		if (target.startsWith(resolve(DIST) + sep) && existsSync(target) && statSync(target).isFile()) {
			const file = Bun.file(target);
			const ext = target.slice(target.lastIndexOf("."));
			if (relPath === "/index.html") {
				// 官方 web-document.ts：本地文档 + 一行 __DSH_BOOT_READY__，等异步注入
				const boot = `<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>`;
				const html = (await file.text()).replace("</head>", boot + PROBE + "</head>");
				return new Response(html, { headers: { "content-type": MIME[".html"]!, "cache-control": "no-store" } });
			}
			return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
		}
		try { return await proxy(rel, url.search, req); } catch (e) { log("PROXY FAIL", rel, String(e)); return new Response("proxy error", { status: 502 }); }
	},
	websocket: {
		open(ws) {
			const data = ws.data as { url: string; up?: WebSocket; queue?: (string | ArrayBuffer)[] };
			data.queue = [];
			const up = new WebSocket(`ws://${new URL(dshOrigin).host}${data.url}`, { headers: { cookie } } as unknown as string[]);
			data.up = up;
			up.addEventListener("open", () => { for (const m of data.queue ?? []) up.send(m as string); data.queue = []; });
			up.addEventListener("message", (ev) => ws.send((ev as MessageEvent).data));
			up.addEventListener("close", () => ws.close());
			up.addEventListener("error", () => ws.close());
		},
		message(ws, msg) {
			const data = ws.data as { up?: WebSocket; queue?: (string | ArrayBuffer)[] };
			if (data.up?.readyState === WebSocket.OPEN) data.up.send(msg as string);
			else data.queue?.push(msg as string);
		},
		close(ws) { (ws.data as { up?: WebSocket }).up?.close(); },
	},
});

// ---- 5) 页面桥：官方 preload-app.ts 的 dshDesktopBoot 等价物（payload 由主进程直接内联）----
const bootPayload = { injections: ready.injections, streamBaseUrl: server.url.origin };
const preloadJs = `globalThis.dshDesktopBoot = { ready: () => Promise.resolve(${JSON.stringify(bootPayload)}), failed: (e) => { console.error("desktop boot failed", e) } };`;
log("boot payload | injections =", ready.injections.length, "| streamBaseUrl =", server.url.origin);

const pageUrl = `${server.url.origin}/${TOKEN}/`;
log("loopback origin =", server.url.origin, "| token =", TOKEN, "| 页面 =", pageUrl);

const win = new BrowserWindow({
	title: "spike-cef（Electrobun + CEF + 官方同构 Host）",
	url: pageUrl,
	renderer: "cef",
	preload: preloadJs,
	frame: { width: 1280, height: 860, x: 80, y: 60 },
});

log("window 已创建（renderer=cef）");
