#!/usr/bin/env node
/**
 * ensure-windows-syntax.mjs —— cfg(windows) 源文件本地语法守卫。
 *
 * 背景：mod 声明带 #[cfg(windows)] 的文件在 macOS 上完全不参与编译
 * （rustc 对 cfg 掉的 mod 不做解析），语法错误本地 cargo check 抓不到，
 * 只会在 Windows CI 上爆（本次 #177 windows.rs:187 多余 `}` 即此坑）。
 *
 * 原理：rustc 单文件编译的 parse 阶段覆盖全文件——只要文件能在
 * 「仅语法」层面通过（无 delimiter/未闭合类错误）即视为通过；
 * 符号解析类错误（E0425/E0433 等）忽略（单文件编译正常现象）。
 * 交叉 check（--target x86_64-pc-windows-gnu）因 Homebrew rust 无
 * Windows std（E0463）不可用，故走此轻量方案；CI 仍是最终把关。
 *
 * 可check文件清单按需追加：凡 #[cfg(windows)] mod 皆可加进来。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
// 相对 src-tauri 的 cfg(windows) 源文件清单
// 相对 src-tauri 的 cfg(windows) 源文件清单；可传 argv[2] 覆盖（自测用）
const FILES = process.argv[2] ? [process.argv[2]] : ["src/register/windows.rs"];

const SYNTAX_ERROR = /(unexpected (closing )?delimiter|unclosed|mismatched closing|expected .*, found `}`)/i;

let failed = false;
for (const rel of FILES) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) {
    console.warn(`[ensure-windows-syntax] 跳过（不存在）：${rel}`);
    continue;
  }
  const out = join(root, "target", "windows-syntax-check.rmeta");
  let stderr = "";
  try {
    execFileSync("rustc", ["--edition", "2021", "--crate-type", "lib", "--emit=metadata", "-o", out, abs], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    stderr = String(e.stderr || e.stdout || e);
  }
  const bad = stderr.split("\n").filter((l) => SYNTAX_ERROR.test(l));
  if (bad.length > 0) {
    failed = true;
    console.error(`[ensure-windows-syntax] 语法错误（cfg(windows) 文件本地不可编译，CI 才会抓到）：${rel}`);
    for (const l of bad) console.error("  " + l.trim());
  } else {
    console.log(`[ensure-windows-syntax] OK：${rel}`);
  }
}
if (failed) {
  console.error("[ensure-windows-syntax] 修复上述语法错误后再构建。");
  process.exit(1);
}
