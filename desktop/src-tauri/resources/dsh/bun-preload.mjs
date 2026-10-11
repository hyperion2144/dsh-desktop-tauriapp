/**
 * Bun preload script for DSH compatibility.
 *
 * Patches:
 * 1. Intercept require("node-addon-require-builtin") → return stub (Bun lacks V8 context symbols)
 * 2. Provide stripTypeScriptTypes via Bun.Transpiler on node:module
 * 3. Set DSH_BUN_COMPAT_DISABLE_HMR=1 to skip Cordis HMR
 * 4. Shim node-pty onto Bun.spawn({ terminal }) — the N-API addon spawns but never delivers output on Bun
 */
import { Module } from "node:module";
import { Transpiler } from "bun";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";

// ── Helper: resolve bare specifier through node_modules with exports support ──
function _resolveBare(specifier, parentURL, H) {
  const { join, dirname, resolve, fileURLToPath, pathToFileURL, existsSync, readFileSync } = H;
  // Try import.meta.resolve first
  try { return H.esmResolve(specifier); } catch {}
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
const _patches = [];
function patchFile(filePath, find, replace) {
  if (!existsSync(filePath)) return;
  const src = readFileSync(filePath, 'utf8');
  if (!src.includes(find)) return;
  _patches.push({ path: filePath, original: src });
  writeFileSync(filePath, src.replace(find, replace));
}
function restoreFiles() {
  for (const p of _patches) {
    try { writeFileSync(p.path, p.original); } catch {}
    for (const extra of p.remove ?? []) { try { rmSync(extra, { force: true }); } catch {} }
  }
}
process.on('exit', restoreFiles);
process.on('SIGINT', () => { restoreFiles(); process.exit(130); });
process.on('SIGTERM', () => { restoreFiles(); process.exit(143); });

// Find DSH root from preload location
const _dshRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const _ptcRuntime = join(_dshRoot, 'node_modules', '@deepseek-ai', 'dsh-ptc-runtime-node', 'lib', 'index.js');
patchFile(_ptcRuntime,
  'import { stripTypeScriptTypes } from "node:module";',
  'import { Module } from "node:module"; const stripTypeScriptTypes = Module.stripTypeScriptTypes;'
);

// ── Patch 6: Disable koffi (dsh-win32-process) on Bun ──
// koffi loads but produces broken N-API bindings on Bun (JavaScriptCore, not V8).
// Make loadWin32ProcessBindings throw → probeWindowsJob returns false → fallback to child_process.spawn.
const _win32Process = join(_dshRoot, 'node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js');
patchFile(_win32Process,
  'function loadWin32ProcessBindings() {',
  'function loadWin32ProcessBindings() { if (typeof Bun !== \'undefined\') throw new Error(\'koffi not available on Bun runtime\');'
);

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
  '// bun-preload: node-pty shim over Bun.spawn({ terminal }); the N-API addon never delivers output on Bun.',
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
  '// bun-preload: node-pty dispatcher — Bun gets the Bun.Terminal shim, every other runtime the real addon.',
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
  for (const extra of (process.env.DSH_BUN_PRELOAD_TREES ?? '').split(':')) {
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
  // A dispatcher left behind by a crashed run still holds the real addon next to it.
  const dispatched = existsSync(originalPath);
  const original = readFileSync(dispatched ? originalPath : target, 'utf8');
  _patches.push({ path: target, original, remove: [shimPath, originalPath] });
  if (!dispatched) writeFileSync(originalPath, original);
  writeFileSync(shimPath, PTY_SHIM_SOURCE);
  writeFileSync(target, PTY_DISPATCHER_SOURCE);
  console.log(`[bun-preload] Patch 7: node-pty shim applied to ${target}`);
}

// ── Patch 8: xterm.js headless sync write fix ──
// xterm.js defers non-user-input writes via setTimeout(0), which on Bun may fire
// after I/O events. DSH serializes the buffer before the setTimeout fires, seeing
// empty data. Fix: replace setTimeout with synchronous _innerWrite() call.
const XTERM_SYNC_WRITE_FROM = 'setTimeout((()=>this._innerWrite()))}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t)}_innerWrite';
const XTERM_SYNC_WRITE_TO = '0}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t),this._innerWrite()}_innerWrite';
for (const target of packageTargets('@xterm/headless/lib-headless/xterm-headless.js')) {
  const source = readFileSync(target, 'utf8');
  const patched = source.replace(XTERM_SYNC_WRITE_FROM, XTERM_SYNC_WRITE_TO);
  if (patched === source) {
    console.log(`[bun-preload] Patch 8: xterm.js sync write pattern not found in ${target} (may already be patched)`);
    continue;
  }
  _patches.push({ path: target, original: source });
  writeFileSync(target, patched);
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
  const directory = dirname(target);
  const originalPath = join(directory, 'index.original.js');
  const dispatched = existsSync(originalPath);
  const original = readFileSync(dispatched ? originalPath : target, 'utf8');
  _patches.push({ path: target, original, remove: [originalPath] });
  if (!dispatched) writeFileSync(originalPath, original);
  writeFileSync(target, ADDON_DISPATCHER_SOURCE);
  console.log(`[bun-preload] Patch 9: node-addon-require-builtin stub applied to ${target}`);
}
console.log("[bun-preload] Patches applied: stripTypeScriptTypes, node-addon-require-builtin stub, HMR disable, Bun.Terminal PTY");
