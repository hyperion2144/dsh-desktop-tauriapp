// 插件**随安装包发布**（#154）：`build.rs` 把三个插件包 stage 到 `src-tauri/embedded/`，
// 由 `bundle.resources` 打进 `.app/Contents/Resources/plugins/<name>`。
//   - dsh-desktop-tauriapp（仓库根：桌面插件）
//   - dsh-mobile-access（mobile/dsh-mobile-access：手机访问 host+client 半区）
//   - dsh-web-mobile（mobile/dsh-mobile-nav：git 子模块 mexsqwq/dsh-web-mobile）
//
// 运行期的**生效路径**是运行 profile 的 `node_modules`：壳从**安装路径**
// （`resource_dir()/plugins/<name>`）解析包体，挂进
// `$DSH_HOME/profiles/<profile>/node_modules/<pkg-name>`（`process/plugin.rs`），
// 再由 `--patch`（`desktop-plugin-inject.yml`，**按包名**启用）加载；
// 开发运行（裸二进制）回退仓库源码路径 `mobile/<pkg>`。
// #212：staging 缺件**直接构建失败**——以前只打 `cargo:warning` 就继续，于是一个没有
// 子模块的 worktree 也能正常出包，产物里静默缺插件（0.12.0 事故的根因之一）。
use std::path::PathBuf;

// staging 核心（递归拷贝 + 缺件收集）抽到独立文件，并让 `src/runtime/embed_plugins_test.rs`
// 以同一份源码把它拉进 `cargo test` —— build script 自身不是测试目标，
// 共用源码才能让「空 lib/ ⇒ 构建失败」这类行为真正可回归（#212 独立复核的建议）。
#[path = "build_support/embed_plugins.rs"]
mod embed_plugins;
use embed_plugins::stage_package;

fn main() {
    stage_embedded_plugins();
    tauri_build::build()
}

/// 把三个插件包 stage 进 `src-tauri/embedded/`（供 `bundle.resources` 打包）。
/// 用 CARGO_MANIFEST_DIR 定位仓库根，与执行时的 cwd 无关。
fn stage_embedded_plugins() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // src-tauri -> desktop -> 仓库根（package.json.name == dsh-desktop-tauriapp）
    let repo_root = match (manifest.parent(), manifest.parent().and_then(|p| p.parent())) {
        (Some(_d), Some(r)) => r.to_path_buf(),
        _ => panic!(
            "embed-plugin: 无法从 {} 定位仓库根，无法打包内嵌插件",
            manifest.display()
        ),
    };
    let dest = manifest.join("embedded");
    // 先整体清掉上一次的 staging（`embedded/` 是生成目录）：否则已从 packages 表里移除的包
    // 会因 `tauri.conf.json` 仍映射而留在产物里，与「清掉残留」的口径对齐。
    let _ = std::fs::remove_dir_all(&dest);

    // 每包：源相对仓库根的路径 + 目标目录名 + 需要复制的文件与子目录
    let packages: [(&str, &str, &[&str], &[&str]); 3] = [
        ("dsh-desktop-tauriapp", ".", &["package.json", "index.js", "cordis.patch.yml", "README.md", "LICENSE"], &["lib"]),
        ("dsh-mobile-access", "mobile/dsh-mobile-access", &["package.json", "cordis.patch.yml", "README.md", "LICENSE"], &["lib", "client"]),
        (
            "dsh-web-mobile",
            "mobile/dsh-mobile-nav",
            &["package.json", "cordis.patch.yml", "README.md", "LICENSE"],
            &["lib"],
        ),
    ];

    // 先把所有缺件收集齐再报错：一次把问题说清，比只报第一个更有用。
    let mut failures: Vec<String> = Vec::new();
    for (name, rel, files, dirs) in packages {
        let src_root = repo_root.join(rel);
        let pkg_dest = dest.join(name);
        // 逐项登记 rerun-if-changed：源文件变了要重新 staging
        for f in files {
            println!("cargo:rerun-if-changed={}", src_root.join(f).display());
        }
        for d in dirs {
            println!("cargo:rerun-if-changed={}", src_root.join(d).display());
        }

        let report = stage_package(&src_root, &pkg_dest, files, dirs);
        if !report.is_complete() {
            failures.push(format!(
                "{name}：源 {} 缺 {} 项 —— {}",
                src_root.display(),
                report.missing.len(),
                report.missing.join("、")
            ));
        } else if !pkg_dest.join("package.json").exists() {
            // 运行期按 package.json 定位包体（process/plugin.rs），这里把同一条件也守住
            failures.push(format!("{name}：staging 完成但没有 package.json"));
        } else {
            println!(
                "cargo:warning=embed-plugin: 已打包 {name}（{} 项）-> {}",
                report.copied,
                pkg_dest.display()
            );
        }
    }

    if !failures.is_empty() {
        let mut hint = String::new();
        if !repo_root.join("mobile/dsh-mobile-nav/package.json").exists() {
            hint.push_str(
                "\n提示：mobile/dsh-mobile-nav 是 git 子模块（worktree 里默认为空目录）。请先执行\n  \
                 git submodule update --init --recursive\n再重新构建；否则会产出缺插件的安装包。",
            );
        }
        panic!(
            "embed-plugin: 插件包 staging 未通过，构建中止（防止产出缺插件的安装包）：\n  - {}{hint}",
            failures.join("\n  - ")
        );
    }
}

