/**
 * Bun preload script for DSH compatibility.
 *
 * Patches:
 * 1. Intercept require("node-addon-require-builtin") → return stub (Bun lacks V8 context symbols)
 * 2. Provide stripTypeScriptTypes via Bun.Transpiler on node:module
 * 3. Set DSH_BUN_COMPAT_DISABLE_HMR=1 to skip Cordis HMR
 */
import { Module } from "node:module";
import { Transpiler } from "bun";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── Helper: resolve bare specifier through node_modules with exports support ──
function _resolveBare(specifier, parentURL) {
  // Try import.meta.resolve first
  try { return import.meta.resolve(specifier); } catch {}
  // Parse bare specifier: @scope/name/subpath or name/subpath
  const m = specifier.match(/^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/);
  if (!m) return null;
  const pkgName = m[1];
  const subpath = m[2] || '';
  const _dshRoot = resolve(dirname(fileURLToPath(import.meta.url)));
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
const _origCreateRequire = Module.createRequire;

Module.createRequire = function _patchedCreateRequire(filename) {
  const origRequire = _origCreateRequire.call(Module, filename);

  function patchedRequire(id) {
    if (id === "node-addon-require-builtin") {
      return createAddonStub(origRequire);
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
function createAddonStub(origRequire) {
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
                    const resolved = _resolveBare(specifier, parentURL);
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
                    const r = _resolveBare(specifier, parent);
                    if (r) return Promise.resolve(r);
                  }
                  try { return Promise.resolve(new URL(specifier, parent).href); } catch { return Promise.resolve(specifier); }
                },
                async import(specifier, parentURL, attributes, ...rest) {
                  if (specifier && specifier.startsWith('.')) {
                    return await import(new URL(specifier, parentURL).href);
                  }
                  try { return await import(specifier); } catch {}
                  const resolved = _resolveBare(specifier, parentURL);
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
                const r = _resolveBare(specifier, parentURL);
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

// ── Patch 7: node-pty shim using Bun.Terminal (built-in ConPTY) ──
// node-pty N-API addon crashes on Bun (needs libnode.dll).
// Bun.spawn({ terminal }) provides native ConPTY on Windows — no FFI needed.
const _nodePty = join(_dshRoot, 'node_modules', 'node-pty', 'lib', 'index.js');
if (existsSync(_nodePty)) {
  const _ptyOriginal = readFileSync(_nodePty, 'utf8');
  _patches.push({ path: _nodePty, original: _ptyOriginal });
  writeFileSync(_nodePty, [
    `// bun-preload: node-pty shim using Bun.spawn({ terminal }) for native ConPTY`,
    `function spawnPty(file, args, options = {}) {`,
    `  const cols = options.cols || 80;`,
    `  const rows = options.rows || 24;`,
    `  const env = { ...options.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' };`,
    `  let onDataCb = null, onExitCb = null;`,
    `  const _td = new TextDecoder('utf-8');`,

    `  const proc = Bun.spawn([file, ...args], {`,
    `    cwd: options.cwd,`,
    `    env,`,
    `    windowsHide: true,`,
    `    terminal: {`,
    `      cols, rows,`,
    `      name: 'xterm-256color',`,
    `      data(term, data) {`,
    `        const _raw = data instanceof Uint8Array ? data : Buffer.from(data);`,
    `        const s = _td.decode(_raw, { stream: true });`,
    `        if (s && onDataCb) {`,
    `          const _cp = [...s].slice(0,20).map(c => c.codePointAt(0)).map(cp => cp > 0x7F ? 'U+'+cp.toString(16).toUpperCase() : String.fromCharCode(cp)).join('');`,
    `          try { require('fs').appendFileSync('C:/Users/l30054055/bun-pty-debug.log', _cp + '\\n'); } catch {}`,
    `          onDataCb(s);`,
    `        }`,
    `      },`,
    `      exit(term, exitCode) { if (onExitCb) onExitCb({ exitCode, signal: null }); },`,
    `    },`,
    `    onExit(proc, exitCode, signalCode) { if (onExitCb) onExitCb({ exitCode, signal: signalCode }); },`,
    `  });`,
    `  return {`,
    `    pid: proc.pid,`,
    `    process: proc,`,
    `    write(data) { try { proc.terminal.write(data); } catch {} return true; },`,
    `    onData(cb) { onDataCb = cb; },`,
    `    onExit(cb) { onExitCb = cb; },`,
    `    kill(signal) { try { proc.kill(signal); } catch {} },`,
    `    resize(cols, rows) { try { proc.terminal.resize(cols, rows); } catch {} },`,
    `  };`,
    `}`,
    `module.exports = { spawn: spawnPty };`
  ].join('\n'));
}

// ── Patch 8: xterm.js headless sync write fix ──
// xterm.js defers non-user-input writes via setTimeout(0), which on Bun may fire
// after I/O events. DSH serializes the buffer before the setTimeout fires, seeing
// empty data. Fix: replace setTimeout with synchronous _innerWrite() call.
const _xtermHeadless = join(_dshRoot, 'node_modules', '@xterm', 'headless', 'lib-headless', 'xterm-headless.js');
if (existsSync(_xtermHeadless)) {
  const _xtermOriginal = readFileSync(_xtermHeadless, 'utf8');
  _patches.push({ path: _xtermHeadless, original: _xtermOriginal });
  // Replace: setTimeout(()=>this._innerWrite()) ... push data ... }
  // With:    0 ... push data ... this._innerWrite() }
  // This forces synchronous processing of terminal output writes.
  const _xtermPatched = _xtermOriginal.replace(
    'setTimeout((()=>this._innerWrite()))}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t)}_innerWrite',
    '0}this._pendingData+=e.length,this._writeBuffer.push(e),this._callbacks.push(t),this._innerWrite()}_innerWrite'
  );
  if (_xtermPatched !== _xtermOriginal) {
    writeFileSync(_xtermHeadless, _xtermPatched);
    console.log('[bun-preload] Patch 8: xterm.js sync write applied');
  } else {
    console.log('[bun-preload] Patch 8: xterm.js sync write pattern not found (may already be patched)');
  }
}
console.log("[bun-preload] Patches applied: stripTypeScriptTypes, node-addon-require-builtin stub, HMR disable, Bun.Terminal PTY");
