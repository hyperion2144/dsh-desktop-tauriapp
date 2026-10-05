#!/usr/bin/env node
// ACL 源变更防护（#181 反馈实锤的构建坑）：tauri-build 对 capabilities/permissions 的
// 增量编译不可靠——修改 capabilities/*.json 或 permissions/*.toml 后，普通构建生成的
// 运行时 ACL 仍可能是旧的（新命令 invoke 报「not allowed by ACL」）。
// 本脚本对比 ACL 源文件联合哈希：变化则 cargo clean 本 crate，强制 tauri-build
// 全量重编 ACL；未变化则跳过（不影响增量编译速度）。build/dev 前各挂一次。
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const srcTauri = resolve(scriptDir, "..", "src-tauri");
const marker = join(srcTauri, "target", ".acl-source-hash");

/** ACL 源文件联合哈希（capabilities/*.json + permissions/*.toml，按文件名稳定排序）。 */
const aclSourceHash = () => {
  const h = createHash("sha256");
  for (const dir of ["capabilities", "permissions"]) {
    const base = join(srcTauri, dir);
    if (!existsSync(base)) continue;
    for (const f of readdirSync(base).sort()) {
      h.update(dir);
      h.update(f);
      h.update(readFileSync(join(base, f)));
    }
  }
  return h.digest("hex").slice(0, 16);
};

const current = aclSourceHash();
const last = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";

if (current === last) {
  console.log(`[acl] ACL 源未变化（${current}），跳过清理`);
} else {
  console.log(
    `[acl] ACL 源变化（${last || "无记录"} → ${current}），cargo clean 本 crate 强制重编 ACL…`,
  );
  execSync(`cargo clean -p dsh-desktop-tauriapp`, {
    cwd: srcTauri,
    stdio: "inherit",
  });
  writeFileSync(marker, current);
}
