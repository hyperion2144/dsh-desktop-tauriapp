# Project Memory 变更日志（CHANGELOG-MEMORY）

本文件是 Project Memory 变更的**只追加**审计日志：记录改了什么、为什么、置信度与证据来源。
由 Project Memory 工作流（knowledge-discovery → repository-audit → classification → memory-edit）
在每次记忆编辑后追加；历史条目只追加、不修改，供漂移检测与回滚参考。

### 2026-09-26 — Update（AGENTS.md 对齐 v0.10.0 / #141 事实）

- **Path:** `AGENTS.md`
- **Operation:** Update
- **Reason:** 对齐 v0.10.0 之后的事实：补齐 `process/worker.rs`（per-profile worker 架构，#136：句柄唯一持有者 + 唯一 spawn 入口 + latest-wins）、状态机收敛为两态（#135）、mobile 子模块真实路径（`mobile/dsh-mobile-nav`，上游 dsh-web-mobile v3.0.3，不再是 `vendor/` + gh contents）、测试实测数（cargo 94 / mobile-access 53 / shell-web 3 / dsh-mobile-nav 191 / expo 8）；新增血泪坑 9（webview 会话建立链与导航根路径不变量 #136）与 10（pnpm 11 只认 pnpm-workspace.yaml + node 垫片 #135），补强 Windows 条目（cfg 分支编译盲区 #141）；新增 Project memory 导航段。
- **Confidence:** High
- **Evidence Source:** `desktop/src-tauri/src/process/worker.rs:1-21,42-55`、`runtime/state.rs:19-21`、`runtime/registry.rs:340-424`、`runtime/builtin.rs:48-52`、`.gitmodules`、`navigation/mod.rs:23-31`、`cargo test -- --list`（94 tests）、`npm test`（mobile-access 53 / shell-web 3 / dsh-mobile-nav test:core 191 / expo vitest 8）、commit `2ed8455`
- **Verified By:** repository-audit
- **Affected typed relationships:** none

### 2026-09-26 — Supersede / Delete（README.md 过时描述）

- **Path:** `README.md`
- **Operation:** Update / Delete
- **Reason:** ①「插件保险丝」子系统已整体移除（#127；Rust 源码、permissions、capabilities、client 均无残留）→ 删除特性条目；②「壳启动时后台检查并自动重建」已改为仅提示（#124）→ 更正；③「自愈 3 次封顶、冷却 60s」无对应实现（探测间隔 5s，持续健康 ≥2 分钟才重置计数）→ 更正；④ #118 侧边栏浏览器 guest 载体已随 v0.10.0 落地 → 由「方案见 issue」改为已实现。
- **Confidence:** High
- **Evidence Source:** `desktop/src-tauri/src/lib.rs:242-245`（仅提示不重建）、`lib.rs:503-575`（守护器规则）、grep `quarantine|fuse` 于 `desktop/src-tauri/**` 与 `src/client/**` 无匹配、`CHANGELOG.md`（v0.10.0 / #127 / #124）、`desktop/src-tauri/src/process/worker.rs`
- **Verified By:** repository-audit
- **Affected typed relationships:** none

### 2026-09-26 — Preserve as Historical（TODO.md）

- **Path:** `TODO.md`
- **Operation:** Update（历史状态标注，原文保留）
- **Reason:** 0.4.0 时代清单（最后维护 2026-08-20）仍以「当前路线图」口吻呈现，其中 Rust 单测、Windows 合流与 Releases Windows 产物等条目已完成/已变化，存在被当作当前待办的风险；保留原文并标注历史状态与现行来源。
- **Confidence:** High
- **Evidence Source:** `git log -- TODO.md`（b555220，2026-08-20）、`.github/workflows/release.yml`（双平台 + build-mobile）、`cargo test -- --list`（94 tests）、`CHANGELOG.md`
- **Verified By:** repository-audit
- **Affected typed relationships:** none

### 2026-09-26 — Update（memory-verification 发现的遗漏修复）

- **Path:** `AGENTS.md`
- **Operation:** Update
- **Reason:** 终验发现两处遗漏：`src/client/` 清单缺 `desktop-browser-bridge.ts`（#118 桥 + webview 标签兼容层，壳侧对应的另一半在 `ui/browser_guests/`）；`runtime/phase.rs` 描述未注明 #135 已删除 `DshPhase` 状态机、该文件仅剩说明注释（否则读者会以为状态机还在那里）。
- **Confidence:** High
- **Evidence Source:** `src/client/desktop-browser-bridge.ts` 存在、`CHANGELOG.md` v0.10.0（#118）与 #135 条目（“phase.rs 仅留说明注释”）、`runtime/state.rs:19-21`
- **Verified By:** memory-verification
- **Affected typed relationships:** none

### 2026-09-26 — Update（注入链路包名对齐）

- **Path:** `AGENTS.md`
- **Operation:** Update
- **Reason:** 手机访问「三包注入链路」仍写旧包名 `@dsh-external/dsh-mobile-nav`，与代码不符：build.rs staging 与 `tauri.conf.json` 的 resources 映射均按 `dsh-web-mobile`（上游 v2.3.0 起更名）；并补注 `desktop-plugin-inject.yml` 是运行时写入 app 数据目录、不是仓库文件。
- **Confidence:** High
- **Evidence Source:** `desktop/src-tauri/build.rs:30-38`、`desktop/src-tauri/tauri.conf.json:64-66`、`src/process/plugin.rs:55-73,243-261`
- **Verified By:** memory-verification
- **Affected typed relationships:** none

### 2026-09-26 — Preserve as Historical（docs 两篇历史快照标注）

- **Path:** `docs/editor-plugin-injection-audit.md`、`docs/next-tasks.md`
- **Operation:** Update（加历史/范围标注，正文保留）
- **Reason:** 两篇文档仍以「当前依据」口吻描述已变的仓库形态：审计稿引用的 `mobile/vendor/dsh-mobile-nav` 与 `vendor.test.mjs`（1 例）已不存在（改为子模块 `mobile/dsh-mobile-nav`，包名 `dsh-web-mobile`，`npm run test:core` 191 例）；交接稿自称「唯一交接依据」且环境信息停留在 0.6.0（`/Users/Admin/...`），与 `AGENTS.md` 构成入口歧义。
- **Confidence:** High
- **Evidence Source:** `.gitmodules`、`mobile/dsh-mobile-nav/package.json`（dsh-web-mobile 3.0.3）、`desktop/src-tauri/build.rs:30-38`、`AGENTS.md`（Project memory 段）
- **Verified By:** repository-audit
- **Affected typed relationships:** none
