/**
 * Bun preload script for DSH compatibility.
 *
 * Patches:
 * 1. Intercept require("node-addon-require-builtin") → return stub (Bun lacks V8 context symbols)
 * 2. Provide stripTypeScriptTypes via Bun.Transpiler on node:module
 * 3. Set DSH_BUN_COMPAT_DISABLE_HMR=1 to skip Cordis HMR
 * 4. Shim node-pty onto Bun.spawn({ terminal }) — the N-API addon spawns but never delivers output on Bun
 * 5. Fix the stripTypeScriptTypes named import inside @deepseek-ai/dsh-ptc-runtime-node
 * 6. Disable koffi bindings in @deepseek-ai/dsh-win32-process (Bun loads koffi but its N-API binding is broken)
 * 7. node-pty dispatcher + Bun.Terminal shim (see Patch 7 below)
 * 8. @xterm/headless synchronous write (Bun fires the deferred write after DSH serializes the buffer)
 * 9. node-addon-require-builtin dispatcher — the stub must exist in worker contexts too (#205)
 *
 * 补丁落盘策略（#210）：物化后**不还原**，带 rev 指纹幂等——运行时树是被多个 dsh 进程共享的，
 * 任何进程退出时回写原文件都会把别的进程正在用的补丁抹掉（实测会把终端与 inspector 打回失败态）。
 */
import { Module } from "node:module";
import { Transpiler } from "bun";
import { resolve, dirname, join, delimiter } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";

// ── Helper: resolve bare specifier through node_modules with exports support ──
function _resolveBare(specifier, parentURL, H) {
  const { join, dirname, resolve, fileURLToPath, pathToFileURL, existsSync, readFileSync } = H;
  // Try import.meta.resolve first
  try { return H.esmResolve(specifier); } catch {}
  // 真正的 Node 语义优先：createRequire(parentURL).resolve 会读 exports 映射；
  // Bun 下同样可用。缺了这一步，只有 exports['.'] 而没有 main 的包（billion-context）
  // 会走下面的目录猜测，得到空模块或 MODULE_NOT_FOUND。
  if (parentURL) {
    try {
      const viaNode = require("node:module").createRequire(parentURL).resolve(specifier);
      return viaNode.startsWith("node:") ? viaNode : H.pathToFileURL(viaNode).href;
    } catch {}
  }
  // Parse bare specifier: @scope/name/subpath or name/subpath
  const m = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
  if (!m) return null;
  const pkgName = m[1];
  const subpath = m[2] || '';
  const _dshRoot = resolve(dirname(fileURLToPath(H.selfUrl)));
  const dirs = [
    join(_dshRoot, 'node_modules'),
    parentURL ? join(fileURLToPath(parentURL), 'node_modules') : '',
  ].filter(Boolean);
  for (const dir of dirs) {
    const pkgDir = join(dir, pkgName);
    if (!existsSync(pkgDir)) continue;
    // Try direct file path (e.g. /locale/en.json)
    if (subpath) {
      const fullPath = join(pkgDir, subpath);
      if (existsSync(fullPath)) return pathToFileURL(fullPath).href;
    }
    // Try exports field lookup (e.g. /tools → ./tools in exports)
    const pjPath = join(pkgDir, 'package.json');
    if (existsSync(pjPath)) {
      try {
        const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
        if (subpath && pj.exports) {
          const exportKey = '.' + subpath;
          const exp = pj.exports[exportKey];
          if (exp) {
            const target = typeof exp === 'string' ? exp : (exp.import || exp.default || exp.require || exp.node);
            if (target && existsSync(join(pkgDir, target))) return pathToFileURL(join(pkgDir, target)).href;
          }
        }
        if (!subpath) {
          if (pj.main && existsSync(join(pkgDir, pj.main))) return pathToFileURL(join(pkgDir, pj.main)).href;
          if (pj.exports && pj.exports['.']) {
            const exp = pj.exports['.'];
            const target = typeof exp === 'string' ? exp : (exp.import || exp.default || exp.require || exp.node);
            if (target && existsSync(join(pkgDir, target))) return pathToFileURL(join(pkgDir, target)).href;
          }
        }
      } catch {}
    }
  }
  return null;
}


// ── Patch 1: stripTypeScriptTypes ──
if (typeof Module.stripTypeScriptTypes !== "function") {
  const transpiler = new Transpiler({ loader: "ts" });
  Module.stripTypeScriptTypes = function stripTypeScriptTypes(code, options = {}) {
    if (typeof code !== "string") throw new TypeError("code must be a string");
    let stripped;
    try {
      stripped = transpiler.transformSync(code);
    } catch (err) {
      throw new SyntaxError(err instanceof Error ? err.message : String(err));
    }
    return options.sourceUrl
      ? `${stripped}\n//# sourceURL=${options.sourceUrl}`
      : stripped;
  };
}

// ── Patch 2: Intercept node-addon-require-builtin ──
// Dependencies the stub needs when it is stringified into the package entry (Patch 9).
const _stubDeps = {
  join, dirname, resolve, fileURLToPath, pathToFileURL, existsSync, readFileSync,
  esmResolve: (specifier) => import.meta.resolve(specifier),
  selfUrl: import.meta.url,
};
const _origCreateRequire = Module.createRequire;

Module.createRequire = function _patchedCreateRequire(filename) {
  const origRequire = _origCreateRequire.call(Module, filename);

  function patchedRequire(id) {
    if (id === "node-addon-require-builtin") {
      return createAddonStub(origRequire, Module, _stubDeps);
    }
    return origRequire(id);
  }

  // Preserve require properties
  patchedRequire.resolve = origRequire.resolve;
  patchedRequire.extensions = origRequire.extensions;
  patchedRequire.cache = origRequire.cache;
  patchedRequire.main = origRequire.main;
"  patchedRequire.paths = origRequire.paths;"

  return patchedRequire;
};

/**
 * Create a stub for node-addon-require-builtin that provides fake Node internal modules.
 * DSH uses these to intercept require/import for profile-specific resolution.
 * Under Bun, we provide stubs that pass validation but make installRuntimeInterception a no-op.
 */
function createAddonStub(origRequire, nodeModule, H) {
  const { join, dirname } = H;
  const Module = nodeModule;
  // Try to get the real Module constructor for _resolveFilename
  let RealModule;
  try {
    RealModule = origRequire("module");
  } catch {
    RealModule = Module;
  }

  return {
    requireBuiltin(name) {
      switch (name) {
        case "internal/modules/esm/loader":
          return {
            getOrInitializeCascadedLoader() {
              return {
                loadCache: new Map(),
                resolveSync(parentURL_or_specifier, request_or_parentURL, ...rest) {
                  let specifier, parentURL;
                  if (typeof request_or_parentURL === 'object' && request_or_parentURL !== null && 'specifier' in request_or_parentURL) {
                    parentURL = parentURL_or_specifier;
                    specifier = request_or_parentURL.specifier;
                  } else {
                    specifier = parentURL_or_specifier;
                    parentURL = request_or_parentURL;
                  }
                  // For relative/file specifiers, resolve against parentURL
                  if (specifier && (specifier.startsWith('.') || specifier.startsWith('file:') || specifier.startsWith('http'))) {
                    try { return { url: new URL(specifier, parentURL).href, format: undefined, shortCircuit: true }; } catch { return { url: specifier, format: undefined, shortCircuit: true }; }
                  }
                  // For bare specifiers, use _resolveBare helper
                  if (specifier) {
                    const resolved = _resolveBare(specifier, parentURL, H);
                    if (resolved) return { url: resolved, format: undefined, shortCircuit: true };
                  }
                  // For bare specifiers that couldn't be resolved, throw MODULE_NOT_FOUND
                  // so optionalResourcePath can handle it gracefully
                  if (specifier && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('http')) {
                    const err = new Error(`Cannot find module '${specifier}'`);
                    err.code = 'MODULE_NOT_FOUND';
                    throw err;
                  }
                  // For relative specifiers, fall back to URL resolution
                  try { return { url: new URL(specifier, parentURL).href, format: undefined, shortCircuit: true }; } catch { return { url: specifier, format: undefined, shortCircuit: true }; }
                },
                getOrCreateModuleJob(parentURL, request, ...args) {
                  let specifier = typeof request === 'object' && request !== null ? request.specifier : request;
                  return undefined;
                },
                getModuleJobForImport(specifier, parentURL, ...args) {
                  return undefined;
                },
                resolve(specifier, parent, ...args) {
                  if (specifier && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('http')) {
                    const r = _resolveBare(specifier, parent, H);
                    if (r) return Promise.resolve(r);
                  }
                  try { return Promise.resolve(new URL(specifier, parent).href); } catch { return Promise.resolve(specifier); }
                },
                async import(specifier, parentURL, attributes, ...rest) {
                  if (specifier && specifier.startsWith('.')) {
                    return await import(new URL(specifier, parentURL).href);
                  }
                  // Bun 的 NODE_PATH 兜底对「有 exports['.'] 但没有 main」的包会把包根解析成
                  // 空模块（实测 billion-context）⇒ cordis 拿到的插件没有 apply/name，entry 永远
                  // 没有 fiber，dsh 只报 “failed to import”。所以先按 parentURL 做一次真正的
                  // Node 解析（createRequire 会读 exports），失败再退回裸 import。
                  if (parentURL) {
                    try {
                      const viaNode = origRequire("node:module").createRequire(parentURL).resolve(specifier);
                      return await import(viaNode.startsWith("node:") ? viaNode : H.pathToFileURL(viaNode).href);
                    } catch {}
                  }
                  try { return await import(specifier); } catch {}
                  const resolved = _resolveBare(specifier, parentURL, H);
                  if (resolved) return await import(resolved);
                  throw new Error(`Cannot find package '${specifier}'`);
                },
                async load(url, context) {
                  return await import(url);
                },
                register() {}
              };
            },
          };

        case "internal/modules/cjs/loader":
          return {
            Module: {
              _resolveFilename(request, parent, isMain, options) {
                try {
                  return origRequire.resolve(request);
                } catch {
                  // Fall back to returning the request as-is
                  return request;
                }
              },
              _nodeModulePaths(from) {
                if (typeof from !== "string") return [];
                let paths = [];
                let dir = from;
                for (let i = 0; i < 50; i++) {
                  paths.push(join(dir, "node_modules"));
                  const parent = dirname(dir);
                  if (parent === dir) break;
                  dir = parent;
                }
                return paths;
              },
              _cache: {},
              _pathCache: {},
            },
          };

        case "internal/modules/helpers":
          return {
            getCjsConditions() {
              return ["node", "require"];
            },
          };

        case "internal/modules/esm/utils":
          return {
            getDefaultConditions() {
              return ["node", "import"];
            },
          };

        case "internal/modules/esm/resolve":
          return {
            defaultResolve(specifier, context, conditions) {
              const parentURL = context?.parentURL;
              if (specifier && !specifier.startsWith('.') && !specifier.startsWith('file:') && !specifier.startsWith('http')) {
                const r = _resolveBare(specifier, parentURL, H);
                if (r) return { url: r, format: undefined, shortCircuit: true };
              }
              try {
                const url = parentURL
                  ? new URL(specifier, parentURL).href
                  : new URL(specifier).href;
                return { url, format: undefined, shortCircuit: true };
              } catch {
                return { url: specifier, format: undefined, shortCircuit: true };
              }
            },
          };

        default:
          // For any other internal module, return an empty object
          // This may cause issues but lets us see what's actually needed
          console.warn(`[bun-preload] stub: unhandled internal module: ${name}`);
          return {};
      }
    },
    isAllowedInternalId() {
      return true;
    },
    getBindingInfo() {
      return { binding: "bun-preload-stub" };
    },
  };
}

// ── Patch 3: HMR disable ──
process.env.DSH_BUN_COMPAT_DISABLE_HMR = "1";

// ── Patch 5: Fix stripTypeScriptTypes named import in dsh-ptc-runtime-node ──
// Bun doesn't export stripTypeScriptTypes from node:module as a named export.
// Patch the file to use Module.stripTypeScriptTypes instead.
// ── 补丁落盘策略（#210 决策）：物化后不还原，带 rev 指纹幂等 ──
// 早期版本在 exit/SIGINT/SIGTERM 上把文件写回原样。但运行时树被同一台机器上多个 dsh 进程
// 共享（应用宿主 + 缝①黑盒测试的第二实例），任何一个进程退出都会把别的进程正在用的补丁
// 抹掉——实测：黑盒测试宿主退出后，运行中的窗口终端立刻变回「进程已退出（1）」、inspector
// 也起不来。改为「打上就不动」：目标文件是 dispatcher 形态（Bun 走 shim、其它运行时转
// index.original.js），对 Node 无害；每条补丁带 rev 指纹，rev 变了才重写。
const PATCH_REV = 6;
const REV_MARK = `bun-preload-rev:${PATCH_REV}`;
/** 已处理的文件，仅用于结尾汇总日志。 */
const _patches = new Set();
/** 幂等写入：内容一致就不动（多进程同跑时避免来回覆写）。 */
function writePatch(filePath, content) {
  try { if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) { _patches.add(filePath); return false; } } catch {}
  writeFileSync(filePath, content);
  _patches.add(filePath);
  return true;
}
/** 该文件是否已经是当前 rev 的产物。 */
function hasCurrentRev(filePath) {
  try { return readFileSync(filePath, 'utf8').includes(REV_MARK); } catch { return false; }
}

// Find DSH root from preload location
const _dshRoot = resolve(dirname(fileURLToPath(import.meta.url)));
// 和 Patch 7/9 一样按「所有可能被解析到的树」找目标：运行时树往往不是 preload 所在的树
// （随包运行时、下载运行时、profile 树）。只打 preload 旁边那份 = 实际生效的那份没打上，
// 实测后果就是 ptc-runtime 起不来 → workflow-ptc/tool-workflow 一直等它 → 新建会话失败。
const PTC_IMPORT_FROM = 'import { stripTypeScriptTypes } from "node:module";';
const PTC_IMPORT_TO = `// ${REV_MARK}\nimport { Module } from "node:module"; const stripTypeScriptTypes = Module.stripTypeScriptTypes;`;
for (const target of packageTargets('@deepseek-ai/dsh-ptc-runtime-node/lib/index.js')) {
  if (hasCurrentRev(target)) {
    console.log(`[bun-preload] Patch 5: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const src = readFileSync(target, 'utf8');
  if (!src.includes(PTC_IMPORT_FROM)) {
    // 已经是我们写过的形态（只是 rev 指纹陈旧）⇒ 刷新指纹，不要误报「上游版本不符」
    if (src.includes('const stripTypeScriptTypes = Module.stripTypeScriptTypes;')) {
      writePatch(target, src.replace(/\/\/ bun-preload-rev:\d+/g, `// ${REV_MARK}`));
      console.log(`[bun-preload] Patch 5: ${REV_MARK} 已就位（刷新指纹）${target}`);
      continue;
    }
    console.warn(`[bun-preload] Patch 5: 上游版本不符（找不到具名导入）：${target}`);
    continue;
  }
  writePatch(target, src.replace(PTC_IMPORT_FROM, PTC_IMPORT_TO));
  console.log(`[bun-preload] Patch 5: stripTypeScriptTypes 具名导入改写 applied to ${target}`);
}

// ── Patch 6: Disable koffi (dsh-win32-process) on Bun ──
// koffi loads but produces broken N-API bindings on Bun (JavaScriptCore, not V8).
// Make loadWin32ProcessBindings throw → probeWindowsJob returns false → fallback to child_process.spawn.
const KOFFI_GUARD_FROM = 'function loadWin32ProcessBindings() {';
const KOFFI_GUARD_TO = `function loadWin32ProcessBindings() { if (typeof Bun !== 'undefined') throw new Error('koffi not available on Bun runtime'); // ${REV_MARK}`;
for (const target of packageTargets('@deepseek-ai/dsh-win32-process/lib/index.js')) {
  if (hasCurrentRev(target)) {
    console.log(`[bun-preload] Patch 6: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const src = readFileSync(target, 'utf8');
  if (!src.includes(KOFFI_GUARD_FROM)) {
    // 同上：已是打过补丁的形态，只刷新 rev 指纹
    if (src.includes('koffi not available on Bun runtime')) {
      writePatch(target, src.replace(/\/\/ bun-preload-rev:\d+/g, `// ${REV_MARK}`));
      console.log(`[bun-preload] Patch 6: ${REV_MARK} 已就位（刷新指纹）${target}`);
      continue;
    }
    console.warn(`[bun-preload] Patch 6: 上游版本不符（找不到 loadWin32ProcessBindings）：${target}`);
    continue;
  }
  writePatch(target, src.replace(KOFFI_GUARD_FROM, KOFFI_GUARD_TO));
  console.log(`[bun-preload] Patch 6: koffi 禁用 applied to ${target}`);
}

// ── Patch 4: module.register no-op shim ──
// Bun treats module.register as no-op, but some code may expect it to work.
// We leave it as-is (Bun's no-op) and hope for the best.

// ── Patch 7: node-pty shim over Bun.spawn({ terminal }) ──
// The node-pty N-API addon spawns its child under Bun but never delivers the output
// (measured on Bun 1.4.0/macOS: `/bin/echo hello` yields 0 chunks where Node yields 1),
// so DSH sees a live process that never talks and reports the terminal as exited(1).
// Bun.spawn({ terminal }) carries the same bytes, so node-pty is replaced by a shim.
//
// The shim has to land on the copy the *active* runtime resolves — a downloaded runtime
// tree is not the tree this preload ships in, and patching only the latter silently
// does nothing. The patched file becomes a dispatcher so a crash can never leave a
// Bun-only shim in front of a Node run.
const PTY_SHIM_SOURCE = [
  `// bun-preload: node-pty shim over Bun.spawn({ terminal }); the N-API addon never delivers output on Bun. ${REV_MARK}`,
  'function spawnPty(file, args, options = {}) {',
  '  const cols = options.cols || 80;',
  '  const rows = options.rows || 24;',
  '  const name = options.name || "xterm-256color";',
  '  const env = { ...options.env, TERM: name, LANG: "en_US.UTF-8" };',
  '  let onDataCb = null, onExitCb = null, paused = false;',
  '  const buffered = [];',
  '  const decoder = new TextDecoder("utf-8");',
  '  const proc = Bun.spawn([file, ...args], {',
  '    cwd: options.cwd,',
  '    env,',
  '    windowsHide: true,',
  '    terminal: {',
  '      cols, rows, name,',
  '      data(_term, data) {',
  '        const text = decoder.decode(data instanceof Uint8Array ? data : Buffer.from(data), { stream: true });',
  '        if (text === "") return;',
  '        if (paused) { buffered.push(text); return; }',
  '        if (onDataCb !== null) onDataCb(text);',
  '      },',
  '      exit(_term, exitCode) { if (onExitCb !== null) onExitCb({ exitCode, signal: null }); },',
  '    },',
  '    onExit(_proc, exitCode, signalCode) { if (onExitCb !== null) onExitCb({ exitCode, signal: signalCode }); },',
  '  });',
  '  return {',
  '    pid: proc.pid,',
  '    process: proc,',
  '    write(data) { try { proc.terminal.write(data); } catch { return false; } return true; },',
  '    onData(cb) { onDataCb = cb; return { dispose() { if (onDataCb === cb) onDataCb = null; } }; },',
  '    onExit(cb) { onExitCb = cb; return { dispose() { if (onExitCb === cb) onExitCb = null; } }; },',
  '    pause() { paused = true; },',
  '    resume() {',
  '      paused = false;',
  '      for (const text of buffered.splice(0)) if (onDataCb !== null) onDataCb(text);',
  '    },',
  '    clear() {},',
  '    kill(signal) { try { proc.kill(signal); } catch {} },',
  '    resize(cols, rows) { try { proc.terminal.resize(cols, rows); } catch {} },',
  '  };',
  '}',
  'module.exports = { spawn: spawnPty };',
  ''
].join('\n');
const PTY_DISPATCHER_SOURCE = [
  `// bun-preload: node-pty dispatcher — Bun gets the Bun.Terminal shim, every other runtime the real addon. ${REV_MARK}`,
  'if (typeof Bun === "undefined") module.exports = require("./index.original.js");',
  'else module.exports = require("./bun-shim.js");',
  ''
].join('\n');
/**
 * node_modules roots this process could resolve a patched package from: the tree this
 * preload ships in, any tree named in DSH_BUN_PRELOAD_TREES, then upwards from the entry
 * script and the working directory (a downloaded runtime is entered through its launcher).
 */
function nodeModulesRoots() {
  const seen = new Set();
  const roots = [];
  const add = (dir) => {
    const root = resolve(dir);
    if (seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };
  add(join(_dshRoot, 'node_modules'));
  for (const extra of (process.env.DSH_BUN_PRELOAD_TREES ?? '').split(delimiter)) {
    if (extra !== '') add(join(resolve(extra), 'node_modules'));
  }
  for (const start of [process.argv[1], process.cwd()]) {
    if (start === undefined) continue;
    let dir = dirname(resolve(start));
    for (let depth = 0; depth < 8; depth += 1) {
      add(join(dir, 'node_modules'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return roots;
}
/** Every existing copy of `relativePath` under those roots. */
function packageTargets(relativePath) {
  const targets = [];
  const seen = new Set();
  for (const root of nodeModulesRoots()) {
    const file = join(root, relativePath);
    if (!existsSync(file)) continue;
    // One file can be reachable by several roots (/tmp and /private/tmp are the same
    // node_modules); patch it once, or it is patched twice in the same run.
    let key = file;
    try { key = realpathSync(file); } catch {}
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(key);
  }
  return targets;
}
for (const target of packageTargets('node-pty/lib/index.js')) {
  const directory = dirname(target);
  const originalPath = join(directory, 'index.original.js');
  const shimPath = join(directory, 'bun-shim.js');
  if (hasCurrentRev(shimPath) && hasCurrentRev(target)) {
    console.log(`[bun-preload] Patch 7: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  // A dispatcher left behind by an earlier run still holds the real addon next to it.
  const dispatched = existsSync(originalPath);
  const original = readFileSync(dispatched ? originalPath : target, 'utf8');
  if (!dispatched) writePatch(originalPath, original);
  writePatch(shimPath, PTY_SHIM_SOURCE);
  writePatch(target, PTY_DISPATCHER_SOURCE);
  console.log(`[bun-preload] Patch 7: node-pty shim applied to ${target}`);
}

// ── Patch 8: xterm.js headless sync write fix ──
// xterm.js defers non-user-input writes via setTimeout(0), which on Bun may fire
// after I/O events. DSH serializes the buffer before the setTimeout fires, seeing
// empty data. Fix: replace setTimeout with synchronous _innerWrite() call.
const XTERM_SYNC_WRITE_FROM = 'setTimeout((()=>this._innerWrite()))}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t)}_innerWrite';
const XTERM_SYNC_WRITE_TO = '0}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t),this._innerWrite()}_innerWrite';
for (const target of packageTargets('@xterm/headless/lib-headless/xterm-headless.js')) {
  if (hasCurrentRev(target)) {
    console.log(`[bun-preload] Patch 8: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const source = readFileSync(target, 'utf8');
  const patched = source.replace(XTERM_SYNC_WRITE_FROM, XTERM_SYNC_WRITE_TO);
  if (patched === source) {
    // 早期版本打过补丁但没留指纹（或者上游换了写法）：能认出已是补丁体就补写指纹
    if (source.includes(XTERM_SYNC_WRITE_TO)) {
      writePatch(target, `${source}\n/* ${REV_MARK} */\n`);
      console.log(`[bun-preload] Patch 8: 已是同步写形态，补写 ${REV_MARK} 指纹 ${target}`);
    } else {
      console.warn(`[bun-preload] Patch 8: 目标里没有可替换的写入模式（上游版本变了？）${target}`);
    }
    continue;
  }
  writePatch(target, `${patched}\n/* ${REV_MARK} */\n`);
  console.log(`[bun-preload] Patch 8: xterm.js sync write applied to ${target}`);
}

// ── Patch 9: node-addon-require-builtin dispatcher (works in every context) ──
// Patch 2 only covers this process: Bun does not run --preload scripts in worker threads
// (measured), and a worker's ESM `createRequire` binding ignores the monkey patch, so a
// worker loading this package reaches the native addon and dies with
// "node-addon-require-builtin unsupported: Unsupported/no-context" (experimental-inspector).
// Rewriting the package entry makes the stub available to every consumer and context.
const ADDON_STUB_MODULE_SOURCE = [_resolveBare.toString(), createAddonStub.toString()].join('\n');
const ADDON_DISPATCHER_SOURCE = [
  '"use strict";',
  `// ${REV_MARK}`,
  'Object.defineProperty(exports, "__esModule", { value: true });',
  'const H = {',
  '  join: require("node:path").join,',
  '  dirname: require("node:path").dirname,',
  '  resolve: require("node:path").resolve,',
  '  fileURLToPath: require("node:url").fileURLToPath,',
  '  pathToFileURL: require("node:url").pathToFileURL,',
  '  existsSync: require("node:fs").existsSync,',
  '  readFileSync: require("node:fs").readFileSync,',
  '  esmResolve() { throw new Error("import.meta.resolve is unavailable in this context"); },',
  `  selfUrl: ${JSON.stringify(import.meta.url)},`,
  '};',
  'if (typeof Bun === "undefined") {',
  '  const original = require("./index.original.js");',
  '  exports.requireBuiltin = original.requireBuiltin;',
  '  exports.isAllowedInternalId = original.isAllowedInternalId;',
  '  exports.getBindingInfo = original.getBindingInfo;',
  '  exports.default = original.default;',
  '} else {',
  ADDON_STUB_MODULE_SOURCE,
  '  const nodeModule = require("node:module").Module ?? require("node:module");',
  '  const impl = createAddonStub(require, nodeModule, H);',
  '  exports.requireBuiltin = (moduleId) => impl.requireBuiltin(moduleId);',
  '  exports.isAllowedInternalId = () => impl.isAllowedInternalId();',
  '  exports.getBindingInfo = () => impl.getBindingInfo();',
  '  exports.default = { requireBuiltin: exports.requireBuiltin, isAllowedInternalId: exports.isAllowedInternalId, getBindingInfo: exports.getBindingInfo };',
  '}',
  ''
].join('\n');
for (const target of packageTargets('node-addon-require-builtin/lib/index.js')) {
  if (hasCurrentRev(target)) {
    console.log(`[bun-preload] Patch 9: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  const directory = dirname(target);
  const originalPath = join(directory, 'index.original.js');
  const dispatched = existsSync(originalPath);
  const original = readFileSync(dispatched ? originalPath : target, 'utf8');
  if (!dispatched) writePatch(originalPath, original);
  writePatch(target, ADDON_DISPATCHER_SOURCE);
  console.log(`[bun-preload] Patch 9: node-addon-require-builtin stub applied to ${target}`);
}

// ── Patch 10: 插件展示元数据（名称/描述/图标）在 Bun 下解析不到 ──
// dsh 自带的插件页通过 dsh-app-boot 的 readPluginMeta 读每个插件的 locale/en.json、
// package.json 与 icon，而 resolvePluginResource 走的是 Node 内部 ESM resolver
// （ModuleLoader.fromInternal() + loader.resolveSync）。Bun 的这个入口对上述三个子路径
// 一律答 MODULE_NOT_FOUND ⇒ readPluginMeta 返回 undefined ⇒ 插件页只剩裸包名+默认图标。
// 这里补一层兜底：先试公共 resolver（createRequire），再按 Node 的查找顺序手查文件系统
// （不看 exports 映射——元数据读取只读文件，从不 import 它们），都找不到时抛 MODULE_NOT_FOUND
// 以保持 optionalResourcePath 的「缺失即 undefined」语义。
const APP_BOOT_RESOLVER_FROM = [
  '\tif (loader === void 0) throw new Error("Plugin metadata requires the Node module resolver");',
  '\treturn fileURLToPath((loader.version === "v2" ? loader.resolveSync(parentURL, {',
  '\t\tspecifier,',
  '\t\tattributes: {}',
  '\t}) : loader.resolveSync(specifier, parentURL, {})).url);',
].join('\n');
const APP_BOOT_FALLBACK_SOURCE = [
  `// ${REV_MARK}`,
  'function pluginResourceFallback(specifier, parentURL) {',
  '\tconst request = createRequire(parentURL);',
  '\ttry {',
  '\t\treturn request.resolve(specifier);',
  '\t} catch {}',
  '\tconst parts = specifier.split("/");',
  '\tconst packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];',
  '\tconst subpath = specifier.slice(packageName.length).replace(/^\\/+/, "");',
  '\tlet directory = dirname(fileURLToPath(parentURL));',
  '\tfor (let depth = 0; depth < 12; depth += 1) {',
  '\t\tconst packageDir = join(directory, "node_modules", packageName);',
  '\t\tif (subpath !== "" && existsSync(join(packageDir, "package.json"))) {',
  '\t\t\tconst target = join(packageDir, subpath);',
  '\t\t\tfor (const probe of [target, `${target}.js`, join(target, "index.js")]) {',
  '\t\t\t\tif (existsSync(probe)) return realpathSync(probe);',
  '\t\t\t}',
  '\t\t\tbreak;',
  '\t\t}',
  '\t\tconst parent = dirname(directory);',
  '\t\tif (parent === directory) break;',
  '\t\tdirectory = parent;',
  '\t}',
  "\tconst error = new Error(`Cannot find module '${specifier}' from '${parentURL}'`);",
  '\terror.code = "MODULE_NOT_FOUND";',
  '\tthrow error;',
  '}',
].join('\n');
const APP_BOOT_RESOLVER_TO = [
  `\tif (loader === void 0) return pluginResourceFallback(specifier, parentURL); // ${REV_MARK}`,
  '\ttry {',
  '\t\treturn fileURLToPath((loader.version === "v2" ? loader.resolveSync(parentURL, {',
  '\t\t\tspecifier,',
  '\t\t\tattributes: {}',
  '\t\t}) : loader.resolveSync(specifier, parentURL, {})).url);',
  '\t} catch (error) {',
  '\t\tif (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;',
  '\t\treturn pluginResourceFallback(specifier, parentURL);',
  '\t}',
  APP_BOOT_FALLBACK_SOURCE
].join('\n');
for (const target of packageTargets('@deepseek-ai/dsh-app-boot/lib/index.js')) {
  const source = readFileSync(target, 'utf8');
  if (source.includes('pluginResourceFallback')) {
    if (!hasCurrentRev(target)) writePatch(target, source.replace(/\/\/ bun-preload-rev:\d+/g, `// ${REV_MARK}`));
    console.log(`[bun-preload] Patch 10: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  if (!source.includes(APP_BOOT_RESOLVER_FROM)) {
    console.warn(`[bun-preload] Patch 10: 未找到上游 resolvePluginResource 文本，跳过 ${target}（上游版本不符）`);
    continue;
  }
  writePatch(target, source.replace(APP_BOOT_RESOLVER_FROM, APP_BOOT_RESOLVER_TO));
  console.log(`[bun-preload] Patch 10: 插件展示元数据解析兜底 applied to ${target}`);
}

// ── Patch 11: 插件说明符按 Loader 的 baseUrl 解析（Bun 没有 Node 内部 loader）──
// cordis 的 Loader.import() 在 Node 下走 internal.import(name, baseUrl)；Bun 下 internal 缺失
// （ModuleLoader.fromInternal() 返回 undefined），退化成「从本文件位置裸 import(name)」。
// 于是 profile 里带子路径的插件（billion-context/dsh）解析不到 ⇒ 该 entry 的 fiber 永远建不起来，
// dsh 只报「bili-native (billion-context): failed to import」。这里补上与 Node 同语义的解析：
// 用 createRequire(baseUrl) 解析后 import 文件 URL；解析不了时原样返回（node: 内建、相对路径照旧）。
const LOADER_RESOLVE_IMPORT_FROM = [
  '\t\t\telse return await import(__rewriteRelativeImportExtension(',
  '\t\t\t\t/* @vite-ignore */',
  '\t\t\t\tname',
  '\t\t\t));'
].join('\n');
const LOADER_RESOLVE_IMPORT_TO = [
  '\t\t\telse return await __bunImportFromBase(name, this.ctx.baseUrl, __rewriteRelativeImportExtension);'
].join('\n');
const LOADER_URL_IMPORT_FROM = 'import { createRequire } from "node:module";';
const LOADER_URL_IMPORT_TO = [
  'import { createRequire } from "node:module";',
  'import { pathToFileURL as __bunPathToFileURL } from "node:url";'
].join('\n');
const LOADER_RESOLVE_HELPER = [
  `// ${REV_MARK} — Bun 下把插件说明符解析到 Loader baseUrl（与 Node 的 internal.import(name, baseUrl) 同语义）`,
  'function __bunResolveFromBase(name, baseUrl) {',
  '\ttry {',
  '\t\tif (name.startsWith("node:")) return name;',
  '\t\tconst resolved = createRequire(baseUrl).resolve(name);',
  '\t\treturn resolved.startsWith("node:") ? resolved : __bunPathToFileURL(resolved).href;',
  '\t} catch {',
  '\t\treturn name;',
  '\t}',
  '}',
  'async function __bunImportFromBase(name, baseUrl, rewrite) {',
  '\tconst target = __bunResolveFromBase(name, baseUrl);',
  '\ttry {',
  '\t\treturn await import(/* @vite-ignore */ rewrite(target));',
  '\t} catch (error) {',
  '\t\tconsole.error(`[bun-preload] 插件导入失败：${name} ← ${target}`, error);',
  '\t\tthrow error;',
  '\t}',
  '}',
  ''
].join('\n');
for (const target of packageTargets('@deepseek-ai/cordis-plugin-loader/lib/index.js')) {
  const source = readFileSync(target, 'utf8');
  if (source.includes('__bunResolveFromBase')) {
    if (!hasCurrentRev(target)) writePatch(target, source.replace(/\/\/ bun-preload-rev:\d+/g, `// ${REV_MARK}`));
    console.log(`[bun-preload] Patch 11: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  if (!source.includes(LOADER_RESOLVE_IMPORT_FROM) || !source.includes(LOADER_URL_IMPORT_FROM)) {
    console.warn(`[bun-preload] Patch 11: 未找到上游 Loader.import 文本，跳过 ${target}（上游版本不符）`);
    continue;
  }
  const patched = source
    .replace(LOADER_URL_IMPORT_FROM, LOADER_URL_IMPORT_TO)
    .replace(LOADER_RESOLVE_IMPORT_FROM, LOADER_RESOLVE_IMPORT_TO);
  writePatch(target, `${patched}\n${LOADER_RESOLVE_HELPER}`);
  console.log(`[bun-preload] Patch 11: 插件说明符按 baseUrl 解析 applied to ${target}`);
}

// ── Patch 12: experimental-inspector 容忍 fetch 访问器 ──
// 缘起：「@deepseek-ai/dsh-experimental-inspector 内置插件启动失败」——第三方插件
// billion-context（bili-native）为了在别的插件替换掉 fetch 后重新爬到链顶，把
// `globalThis.fetch` 装成带 get/set 的**访问器**；而 inspector 取保守策略：描述符不是数据属性
// 就直接拒绝启动（lib/index.js 的 installFetchObserver 开头）。两边单看都有道理，凑在一起就是内置
// 插件永远起不来。这里把那一行改成「先归一成数据属性再观察」：值就是当时的 fetch（也就是
// billion-context 的链），跟 Node 下 fetch 本来就是数据属性的形态一致。
// 上游文本一旦变了（没命中），只警告不报错，后续版本自会回到「拒绝启动」的原生行为。
const INSPECTOR_FETCH_GUARD =
  '\tif (descriptor !== void 0 && !("value" in descriptor)) throw new Error("inspector: globalThis.fetch is an accessor and cannot be observed safely");';
const INSPECTOR_FETCH_MARK = 'bun-preload: fetch 访问器归一';
const INSPECTOR_FETCH_NORMALIZE = [
  `\t// ${INSPECTOR_FETCH_MARK}（billion-context 装的是访问器，inspector 原本会硬拒）`,
  '\tif (descriptor !== void 0 && !("value" in descriptor)) {',
  '\t\tObject.defineProperty(globalThis, "fetch", { value: original, writable: true, configurable: true, enumerable: descriptor.enumerable ?? true });',
  '\t}',
].join('\n');
for (const target of packageTargets('@deepseek-ai/dsh-experimental-inspector/lib/index.js')) {
  const source = readFileSync(target, 'utf8');
  if (source.includes(INSPECTOR_FETCH_MARK)) {
    console.log(`[bun-preload] Patch 12: ${REV_MARK} 已就位 ${target}`);
    continue;
  }
  if (!source.includes(INSPECTOR_FETCH_GUARD)) {
    console.warn(`[bun-preload] Patch 12: 未找到上游 accessor 检查文本，跳过 ${target}（上游版本不符）`);
    continue;
  }
  writePatch(target, source.replace(INSPECTOR_FETCH_GUARD, INSPECTOR_FETCH_NORMALIZE));
  console.log(`[bun-preload] Patch 12: fetch 访问器归一 applied to ${target}`);
}

console.log(`[bun-preload] ${REV_MARK} 应用完成：stripTypeScriptTypes / node-addon-require-builtin 桩 / HMR 关闭 / Bun.Terminal PTY / xterm 同步写 / 插件展示元数据解析 / 插件说明符 baseUrl 解析 / inspector fetch 访问器归一（不还原）`);
