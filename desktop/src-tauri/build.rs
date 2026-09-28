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
use std::path::PathBuf;

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
        _ => {
            println!("cargo:warning=embed-plugin: 无法从 {} 定位仓库根，跳过打包", manifest.display());
            return;
        }
    };
    let dest = manifest.join("embedded");

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

    for (name, rel, files, dirs) in packages {
        let pkg_dest = dest.join(name);
        let _ = std::fs::remove_dir_all(&pkg_dest);
        if let Err(e) = std::fs::create_dir_all(&pkg_dest) {
            println!("cargo:warning=embed-plugin: 创建打包目录失败 {name}: {e}");
            continue;
        }
        let src_root = repo_root.join(rel);
        for f in files {
            let src = src_root.join(f);
            println!("cargo:rerun-if-changed={}", src.display());
            match std::fs::copy(&src, pkg_dest.join(f)) {
                Ok(_) => {}
                Err(e) => println!("cargo:warning=embed-plugin: 复制 {name}/{f} 失败：{e}"),
            }
        }
        for d in dirs {
            let src = src_root.join(d);
            println!("cargo:rerun-if-changed={}", src.display());
            let ddest = pkg_dest.join(d);
            let _ = std::fs::create_dir_all(&ddest);
            if let Ok(entries) = std::fs::read_dir(&src) {
                for entry in entries.flatten() {
                    let _ = std::fs::copy(entry.path(), ddest.join(entry.file_name()));
                }
            }
        }
        println!("cargo:warning=embed-plugin: 已打包 {name} -> {}", pkg_dest.display());
    }
}

