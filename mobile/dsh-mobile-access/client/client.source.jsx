// dsh-mobile-access client 半区：注册 settings.section「手机访问」行。
// 与 host 的 lane 走直 fetch（同机 loopback 直连，Host=127.0.0.1:lanePort；CORS 按 Origin 反射放行）。
// 早期尝试过 ctx.connection.rpc.call('/dsh-mobile-access', ...)，carrier 已把 result 解包后客户端再 .result/.value 易错位，
// 故采用直 fetch，与 HEAD 已验证版本一致。
import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from "react";
import qrcodeFactory from "qrcode-generator";

/** 硬依赖：slots（注册 settings.section 槽位）。Cordis Guard 拒绝未声明 ctx.slots 访问。 */
export const inject = ["slots"];

export function apply(ctx) {
  const slots = ctx?.slots;
  if (
    !slots ||
    typeof slots.inject !== "function" ||
    typeof slots.register !== "function"
  ) {
    ctx?.logger?.warn?.("dsh-mobile-access: slots 服务不可用，跳过设置入口");
    return;
  }
  slots.inject("settings.section", () =>
    slots.register(
      {
        name: "settings.section",
        id: "dsh-mobile-access",
        order: 20,
        label: () => "远程访问",
      },
      MobileAccessPanel,
    ),
  );
}

const lanePort = Number(globalThis.__DSH_MOBILE_LANE_PORT__) || 3091;
const LANE = "http://127.0.0.1:" + lanePort;

/** lane 属主通道直 fetch。CORS 由 lane 端按 Origin 反射放行（仅放行回环源）。 */
async function lane(path, opts = {}) {
  const res = await fetch(LANE + path, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error || "";
    } catch {
      /* ignore */
    }
    throw new Error("HTTP " + res.status + (detail ? " " + detail : ""));
  }
  if (res.status === 204) return null;
  return res.json();
}

/** 读 CSS 变量（mount 时取一次），避免每次 render 走 getComputedStyle。 */
function readCssVar(name, fallback) {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

// 按钮交互样式：hover/active/busy/flash。原始 cssText 原样保留，仅重组形式。
// 注入到 <head> 的 <style>（data-mobile-access 标记），面板卸载时随 effect 清理函数移除。
const BUTTON_CSS = `
[data-mobile-access-btn] {
transition: transform .08s ease, filter .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
user-select: none;
}
[data-mobile-access-btn]:hover { filter: brightness(1.18); }
[data-mobile-access-btn]:active {
transform: translateY(1px) scale(0.97);
filter: brightness(0.92);
}
[data-mobile-access-btn][data-busy="1"] {
opacity: 0.55;
cursor: progress;
}
[data-mobile-access-btn][data-flash="ok"] {
background: #2fbf71 !important;
border-color: #2fbf71 !important;
color: #fff !important;
}
[data-mobile-access-btn][data-flash="err"] {
background: #e5484d !important;
border-color: #e5484d !important;
color: #fff !important;
}
`;

/** 面板按钮：data-mobile-access-btn + busy/flash 反馈。
 *  onClick({ flash }) —— 通过 flash(kind, newText?, ms?) 触发瞬时反馈；busy 由内层包装自动管理。
 */
function PanelButton({ text, ghost, cssVars, onClick }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null); // 'ok' | 'err' | null
  const [flashText, setFlashText] = useState(null);
  const flashTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const handleClick = async () => {
    if (busy || !onClick) return;
    setBusy(true);
    try {
      await onClick({
        flash: (kind, newText, ms = 1500) => {
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          if (newText != null) setFlashText(newText);
          setFlash(kind);
          flashTimerRef.current = setTimeout(() => {
            setFlash(null);
            setFlashText(null);
            flashTimerRef.current = null;
          }, ms);
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const style = {
    background: ghost ? "transparent" : cssVars.accent,
    color: ghost ? cssVars.text2 : "#fff",
    border: `1px solid ${ghost ? cssVars.line : "transparent"}`,
    borderRadius: 8,
    padding: "5px 12px",
    fontSize: 12,
    cursor: "pointer",
  };

  return (
    <button
      type="button"
      data-mobile-access-btn="1"
      data-busy={busy ? "1" : undefined}
      data-flash={flash ?? undefined}
      style={style}
      onClick={handleClick}
    >
      {flashText ?? text}
    </button>
  );
}

/** 二维码数据 URL：qrcode-generator createDataURL 不产生 DOM，纯数据 → 直接用于 <img src>。
 *  本文件唯一一个二维码库的产出点；其余 UI 全部 JSX。
 */
function makeQr(link) {
  if (!link) return null;
  try {
    const qr = qrcodeFactory(0, "M");
    qr.addData(link);
    qr.make();
    return qr.createDataURL(4, 8);
  } catch {
    return null;
  }
}

/** 通道卡片：标题 + 描述 + 输入区 + 链接文本 + 二维码 + hint + 操作行。
 *  - beforeLink：插在描述与链接之间的内容（输入框、状态文本等）
 *  - link：mint 后的配对链接
 *  - qrSrc：qrcode.createDataURL 数据（image src）
 *  - hint：{ text, color }
 *  - actions：底部按钮行（Fragment 或元素数组）
 */
function ChannelCard({
  label,
  desc,
  cssVars,
  beforeLink,
  link,
  qrSrc,
  hint,
  actions,
}) {
  return (
    <div
      style={{
        border: `1px solid ${cssVars.line}`,
        borderRadius: 10,
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      {desc && <div style={{ color: cssVars.text2, fontSize: 12 }}>{desc}</div>}
      {beforeLink}
      {link && (
        <code
          style={{
            color: cssVars.text,
            fontSize: 12,
            wordBreak: "break-all",
            background: cssVars.panel,
            border: `1px solid ${cssVars.line}`,
            borderRadius: 6,
            padding: 6,
            display: "block",
          }}
        >
          {link}
        </code>
      )}
      {qrSrc && (
        <img
          alt={label + " 配对二维码"}
          src={qrSrc}
          style={{
            width: 180,
            height: 180,
            imageRendering: "pixelated",
            borderRadius: 8,
            border: `1px solid ${cssVars.line}`,
          }}
        />
      )}
      {hint?.text && (
        <div style={{ color: hint.color, fontSize: 12 }}>{hint.text}</div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>
    </div>
  );
}

/** settings.section 的 React 组件契约：返回 JSX 树，状态由 hooks 维护。 */
function MobileAccessPanel() {
  // 读 CSS 变量一次（mount 时取）
  const cssVars = useMemo(
    () => ({
      text: readCssVar("--dsw-alias-label-primary", "#e7eaf0"),
      text2: readCssVar("--dsw-alias-label-secondary", "#9aa4b2"),
      panel: readCssVar("--dsw-alias-bg-layer-1", "#171a21"),
      line: readCssVar("--dsw-alias-border-l2", "#2a2f3a"),
      accent: readCssVar("--dsw-alias-state-accent-primary", "#4d6bfe"),
    }),
    [],
  );

  // 注入按钮交互 CSS（hover/active/busy/flash），卸载时清理避免 <head> 污染
  useEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-mobile-access", "1");
    styleEl.textContent = BUTTON_CSS;
    document.head.appendChild(styleEl);
    return () => {
      styleEl.remove();
    };
  }, []);

  // ---- LAN state ----
  // lanBase 只在 mint handler 内被读，不参与渲染 → 用 ref 避免触发重渲染
  const lanBaseRef = useRef(null);
  const [lanLink, setLanLink] = useState(null);
  const [lanHint, setLanHint] = useState(null);

  // ---- Tunnel state ----
  const [tunInputValue, setTunInputValue] = useState("");
  const [tunSavedUrl, setTunSavedUrl] = useState("");
  const [tunResult, setTunResult] = useState({ text: "", color: "" });
  const [tunLink, setTunLink] = useState(null);
  const [tunHint, setTunHint] = useState(null);

  // ---- Cloudflared state ----
  const [cfState, setCfState] = useState({
    bin: "",
    url: null,
    running: false,
    reason: null,
    phase: "idle",
    detail: "",
    message: "",
  });
  const [cfInputValue, setCfInputValue] = useState("");
  const [cfInFlight, setCfInFlight] = useState(null); // 异步进行中显示：{ text, color }
  const [cfStatusError, setCfStatusError] = useState(null); // 轮询/动作错误覆盖
  const [cfLink, setCfLink] = useState(null);
  const [cfHint, setCfHint] = useState(null);

  // ---- Devices state ----
  const [devices, setDevices] = useState([]);
  const [devicesError, setDevicesError] = useState(null);
  const [deviceErrors, setDeviceErrors] = useState({}); // deviceId → 行内移除失败信息

  // ---- refresh helpers（stable useCallback，2s 轮询复用）----
  // tunSavedUrl 在 refreshLanBase 中按"首次填充"语义读取，需要读到最新值 → ref
  const tunSavedUrlRef = useRef("");
  tunSavedUrlRef.current = tunSavedUrl;

  const refreshDevices = useCallback(async () => {
    try {
      const st = await lane("/api/pair/devices");
      setDevices(st.devices ?? []);
      setDevicesError(null);
      setDeviceErrors({}); // 刷新成功清掉行内错误（与原版 refresh() 重建 DOM 一致）
    } catch (e) {
      setDevices([]);
      setDevicesError("配对服务不可达：" + e.message);
    }
  }, []);

  const refreshCf = useCallback(async () => {
    try {
      const st = await lane("/api/pair/cloudflared");
      setCfState({
        bin: st.bin ?? "",
        url: st.url ?? null,
        running: !!st.running,
        reason: st.reason ?? null,
        message: st.message,
        phase: st.phase ?? "idle",
        detail: st.detail ?? "",
      });
      setCfStatusError(null);
    } catch (e) {
      setCfStatusError("查询失败：" + e.message);
    }
  }, []);

  const refreshLanBase = useCallback(async () => {
    try {
      const info = await lane("/api/pair/info");
      if (info.lanIp) {
        lanBaseRef.current = {
          base: info.lanIp + ":" + (info.lanePort ?? lanePort),
          scheme: "http",
        };
      } else {
        lanBaseRef.current = {
          base: "127.0.0.1:" + (info.lanePort ?? lanePort),
          scheme: "http",
        };
      }
      if (!tunSavedUrlRef.current && info.customTunnelUrl) {
        setTunSavedUrl(info.customTunnelUrl);
        setTunInputValue(info.customTunnelUrl);
      }
    } catch {
      /* noop */
    }
  }, []);

  // 首次拉取 + 2s 轮询（设备 + cloudflared）；lanBase 仅首次（mint 时按需 refreshLanBase）
  useEffect(() => {
    void refreshDevices();
    void refreshCf();
    void refreshLanBase();
    const id = setInterval(() => {
      void refreshDevices();
      void refreshCf();
    }, 2000);
    return () => clearInterval(id);
  }, [refreshDevices, refreshCf, refreshLanBase]);

  // cfState.bin 由 server 同步到本地 input（与原版 renderCf 行为一致）
  useEffect(() => {
    setCfInputValue(cfState.bin || "");
  }, [cfState.bin]);

  // ---- 派生：CF 状态显示 ----
  // 优先级：in-flight 文本 > 错误覆盖 > cfState 计算结果
  const cfStatus = useMemo(() => {
    if (cfInFlight) return cfInFlight;
    if (cfStatusError) return { text: cfStatusError, color: "#e5484d" };
    const s = cfState;
    if (s.running || s.url) {
      return {
        text: s.url
          ? "运行中 · " + s.url
          : s.detail || "运行中 · 等待隧道地址…",
        color: "#2fbf71",
      };
    }
    if (s.phase === "error") {
      return {
        text: "启动失败：" + (s.message || s.detail || "cloudflared 无法启动"),
        color: "#e5484d",
      };
    }
    if (s.phase === "resolving" || s.phase === "downloading") {
      return {
        text:
          (s.phase === "downloading" ? "下载中 · " : "解析中 · ") +
          (s.detail || "…"),
        color: "#4d6bfe",
      };
    }
    if (s.phase === "starting" || s.phase === "registering") {
      return { text: s.detail || "启动中…", color: "#4d6bfe" };
    }
    if (s.bin) return { text: "已配置 · 未运行", color: cssVars.text2 };
    return { text: "未配置 · 未运行", color: cssVars.text2 };
  }, [cfState, cfStatusError, cfInFlight, cssVars.text2]);

  // ---- 派生：QR data URL ----
  const lanQr = useMemo(() => makeQr(lanLink), [lanLink]);
  const tunQr = useMemo(() => makeQr(tunLink), [tunLink]);
  const cfQr = useMemo(() => makeQr(cfLink), [cfLink]);

  // ---- helpers ----
  const pairLink = (base, scheme, token) =>
    scheme + "://" + base + "/pair?token=" + encodeURIComponent(token);

  /** 铸造一次性配对链接：mint → 写 link/hint；失败写 hint。 */
  const mintFor = async (base, scheme, setLink, setHint) => {
    try {
      const r = await lane("/api/pair/mint", { method: "POST", body: {} });
      const link = pairLink(base, scheme, r.token);
      setLink(link);
      setHint({
        text: "10 分钟有效 · 一次性 · 扫码/打开即配对",
        color: "#2fbf71",
      });
    } catch (e) {
      setHint({ text: "铸造失败：" + e.message, color: "#e5484d" });
    }
  };

  return (
    <div
      data-mobile-access-panel="1"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        maxWidth: 640,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>远程访问</div>
      <div style={{ color: cssVars.text2, fontSize: 13 }}>
        三个通道独立维护配对二维码：扫码/打开链接即可配对（一次性令牌 + 会话
        Cookie）。此页面供手机/其它设备连接本机；若要切换桌面壳自身连接的 dsh
        服务来源，请用桌面设置的「dsh 服务地址」。
      </div>

      {/* 1. 局域网 */}
      <ChannelCard
        label="局域网"
        desc="手机连同一 WiFi，扫此码直连（仅局域网可达）。"
        cssVars={cssVars}
        link={lanLink}
        qrSrc={lanQr}
        hint={lanHint}
        actions={
          <>
            <PanelButton
              text="铸造局域网令牌"
              cssVars={cssVars}
              onClick={async () => {
                if (!lanBaseRef.current) await refreshLanBase();
                if (lanBaseRef.current) {
                  await mintFor(
                    lanBaseRef.current.base,
                    lanBaseRef.current.scheme,
                    setLanLink,
                    setLanHint,
                  );
                } else {
                  setLanHint({ text: "无法确定局域网地址", color: "#e5484d" });
                }
              }}
            />
            <PanelButton
              text="复制链接"
              ghost
              cssVars={cssVars}
              onClick={async ({ flash }) => {
                if (!lanLink) return;
                try {
                  await navigator.clipboard?.writeText(lanLink);
                } catch {
                  /* noop */
                }
                flash("ok", "已复制 ✓");
              }}
            />
          </>
        }
      />

      {/* 2. 第三方隧道（cpolar 等）*/}
      <ChannelCard
        label="第三方隧道（cpolar 等）"
        desc={
          "隧道需指向改写代理端口 127.0.0.1:" +
          lanePort +
          "；粘贴地址校验可达后，用此地址生成自己的配对二维码。"
        }
        cssVars={cssVars}
        link={tunLink}
        qrSrc={tunQr}
        hint={tunHint}
        beforeLink={
          <>
            <input
              type="text"
              placeholder="https://xxxx.cpolar.cn"
              value={tunInputValue}
              onChange={(e) => setTunInputValue(e.target.value)}
              style={{
                background: cssVars.panel,
                border: `1px solid ${cssVars.line}`,
                color: cssVars.text,
                borderRadius: 8,
                padding: "7px 10px",
                fontSize: 13,
              }}
            />
            {tunResult.text && (
              <div style={{ color: tunResult.color, fontSize: 12 }}>
                {tunResult.text}
              </div>
            )}
          </>
        }
        actions={
          <>
            <PanelButton
              text="校验并保存"
              ghost
              cssVars={cssVars}
              onClick={async () => {
                setTunResult({ text: "校验中…", color: cssVars.text2 });
                const url = tunInputValue.trim();
                if (!url) {
                  setTunResult({ text: "请输入隧道地址", color: "#e5484d" });
                  return;
                }
                try {
                  const r = await lane(
                    "/api/pair/probe?url=" + encodeURIComponent(url),
                  );
                  if (r.ok) {
                    await lane("/api/pair/tunnel", {
                      method: "POST",
                      body: { url },
                    });
                    setTunSavedUrl(url);
                    setTunResult({
                      text: "✓ 可达已保存（HTTP " + (r.status ?? "") + "）",
                      color: "#2fbf71",
                    });
                    await refreshLanBase();
                  } else {
                    setTunResult({
                      text: "✗ 不可达：" + (r.reason ?? ""),
                      color: "#e5484d",
                    });
                  }
                } catch (e) {
                  setTunResult({
                    text: "校验失败：" + e.message,
                    color: "#e5484d",
                  });
                }
              }}
            />
            <PanelButton
              text="铸造隧道令牌"
              cssVars={cssVars}
              onClick={async () => {
                if (!tunSavedUrl) await refreshLanBase();
                if (tunSavedUrl) {
                  const u = new URL(tunSavedUrl);
                  await mintFor(
                    u.host,
                    u.protocol === "https:" ? "https" : "http",
                    setTunLink,
                    setTunHint,
                  );
                } else {
                  setTunHint({
                    text: "请先校验并保存隧道地址",
                    color: "#e5484d",
                  });
                }
              }}
            />
            <PanelButton
              text="复制链接"
              ghost
              cssVars={cssVars}
              onClick={async ({ flash }) => {
                if (!tunLink) return;
                try {
                  await navigator.clipboard?.writeText(tunLink);
                } catch {
                  /* noop */
                }
                flash("ok", "已复制 ✓");
              }}
            />
          </>
        }
      />

      {/* 3. cloudflared 公网隧道 */}
      <ChannelCard
        label="cloudflared 公网隧道"
        desc="PATH 有 cloudflared 就直接用；否则 ~/.dsh/bin 缓存命中复用；都没有就一键从 GitHub/ghproxy 等多镜像下载到缓存。"
        cssVars={cssVars}
        link={cfLink}
        qrSrc={cfQr}
        hint={cfHint}
        beforeLink={
          <>
            <input
              type="text"
              placeholder="cloudflared 完整路径（留空 = 一键启动）"
              value={cfInputValue}
              onChange={(e) => setCfInputValue(e.target.value)}
              style={{
                background: cssVars.panel,
                border: `1px solid ${cssVars.line}`,
                color: cssVars.text,
                borderRadius: 8,
                padding: "7px 10px",
                fontSize: 13,
              }}
            />
            <div style={{ color: cfStatus.color, fontSize: 12 }}>
              {cfStatus.text}
            </div>
          </>
        }
        actions={
          <>
            <PanelButton
              text="一键启动（无依赖）"
              cssVars={cssVars}
              onClick={async () => {
                // 不读 input.value —— 一键模式固定 auto
                setCfInFlight({
                  text: "解析中 · 检查 PATH 与本地缓存…",
                  color: "#4d6bfe",
                });
                setCfStatusError(null);
                try {
                  const r = await lane("/api/pair/cloudflared", {
                    method: "POST",
                    body: { bin: "", action: "apply" },
                  });
                  setCfState({
                    bin: r.bin ?? "",
                    url: r.url ?? null,
                    running: !!r.running,
                    reason: r.running ? null : (r.reason ?? null),
                    message: r.message,
                    phase: r.phase ?? "resolving",
                    detail: "",
                  });
                  setCfStatusError(null);
                  setCfInFlight(null);
                } catch (e) {
                  setCfInFlight(null);
                  setCfStatusError("一键启动失败：" + e.message);
                }
              }}
            />
            <PanelButton
              text="停止"
              ghost
              cssVars={cssVars}
              onClick={async () => {
                try {
                  await lane("/api/pair/cloudflared", {
                    method: "POST",
                    body: { action: "stop" },
                  });
                  // 立即清空所有"运行中"相关字段，避免下一次 2s 轮询前 UI 还显示旧 url/phase
                  setCfState((prev) => ({
                    bin: prev.bin,
                    url: null,
                    running: false,
                    reason: null,
                    phase: "idle",
                    detail: "已停止",
                    message: "",
                  }));
                  setCfStatusError(null);
                } catch (e) {
                  setCfStatusError("停止失败：" + e.message);
                }
              }}
            />
            <PanelButton
              text="应用并启动"
              cssVars={cssVars}
              onClick={async () => {
                setCfInFlight({ text: "应用中…", color: cssVars.text2 });
                setCfStatusError(null);
                try {
                  const r = await lane("/api/pair/cloudflared", {
                    method: "POST",
                    body: { bin: cfInputValue.trim(), action: "apply" },
                  });
                  setCfState({
                    bin: r.bin ?? "",
                    url: r.url ?? null,
                    running: !!r.running,
                    reason: r.running ? null : (r.reason ?? null),
                    message: r.message,
                    phase: r.phase ?? "resolving",
                    detail: "",
                  });
                  setCfStatusError(null);
                  setCfInFlight(null);
                } catch (e) {
                  setCfInFlight(null);
                  setCfStatusError("应用失败：" + e.message);
                }
              }}
            />
            <PanelButton
              text="铸造隧道令牌"
              cssVars={cssVars}
              onClick={async () => {
                if (!cfState.url) {
                  setCfHint({
                    text: "隧道未运行或无地址，请先启动 cloudflared",
                    color: "#e5484d",
                  });
                  return;
                }
                await mintFor(
                  cfState.url.replace(/^https?:\/\//, ""),
                  cfState.url.startsWith("https") ? "https" : "http",
                  setCfLink,
                  setCfHint,
                );
              }}
            />
            <PanelButton
              text="复制链接"
              ghost
              cssVars={cssVars}
              onClick={async ({ flash }) => {
                if (!cfLink) return;
                try {
                  await navigator.clipboard?.writeText(cfLink);
                } catch {
                  /* noop */
                }
                flash("ok", "已复制 ✓");
              }}
            />
          </>
        }
      />

      {/* 4. 已配对设备 */}
      <div
        style={{
          border: `1px solid ${cssVars.line}`,
          borderRadius: 10,
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>已配对设备</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {devicesError ? (
            <div style={{ color: "#e5484d", fontSize: 12 }}>{devicesError}</div>
          ) : devices.length === 0 ? (
            <div style={{ color: cssVars.text2, fontSize: 12 }}>
              暂无配对设备
            </div>
          ) : (
            devices.map((d) => (
              <div
                key={d.deviceId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span style={{ color: cssVars.text, fontSize: 13 }}>
                  {d.name} · {d.online ? "在线" : "离线"}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <PanelButton
                    text="移除"
                    ghost
                    cssVars={cssVars}
                    onClick={async () => {
                      try {
                        await lane("/api/pair/remove", {
                          method: "POST",
                          body: { deviceId: d.deviceId },
                        });
                        await refreshDevices();
                      } catch (e) {
                        // 失败信息行末追加（与原版行为一致：append 到 row DOM）
                        setDeviceErrors((prev) => ({
                          ...prev,
                          [d.deviceId]: "移除失败：" + e.message,
                        }));
                      }
                    }}
                  />
                  {deviceErrors[d.deviceId] && (
                    <span style={{ color: "#e5484d", fontSize: 12 }}>
                      {deviceErrors[d.deviceId]}
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
