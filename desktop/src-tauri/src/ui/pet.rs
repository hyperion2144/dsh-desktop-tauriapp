//! 桌宠（透明置顶小窗）：位置持久化、多屏钳位、显隐/穿透切换。
//!
//! 迁移自 lib.rs 功能区域（pet）。

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Manager};

use crate::runtime::state::DshState;
use crate::show_main;

/// 桌宠窗口尺寸（物理像素），与 tauri.conf.json 中 pet 窗口 width/height 一致，
/// 用于载入位置时的多屏钳位。
pub const PET_W: i32 = 260;
pub const PET_H: i32 = 300;

/// 桌宠持久化状态（存 app_config_dir/pet.json，物理像素坐标）。
#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
pub struct PetState {
    pub x: i32,
    pub y: i32,
    pub enabled: bool,
    pub passthrough: bool,
}

pub fn pet_state_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("pet.json"))
}

pub fn read_pet_state(app: &AppHandle) -> PetState {
    let Some(path) = pet_state_path(app) else {
        return PetState::default();
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_pet_state(app: &AppHandle, st: &PetState) {
    let Some(path) = pet_state_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(st) {
        let _ = std::fs::write(&path, json);
    }
}

/// 载入坐标钳位到可见显示器；全都不在（如拔了外接屏）则回退主屏右下角。
pub fn clamp_pet_to_monitors(pet: &tauri::WebviewWindow, x: i32, y: i32) -> (i32, i32) {
    if let Ok(monitors) = pet.available_monitors() {
        for m in &monitors {
            let wa = m.work_area();
            let (wx, wy) = (wa.position.x, wa.position.y);
            let (ww, wh) = (wa.size.width as i32, wa.size.height as i32);
            if x >= wx && x + PET_W <= wx + ww && y >= wy && y + PET_H <= wy + wh {
                return (x, y);
            }
        }
    }
    if let Ok(Some(m)) = pet.primary_monitor() {
        let wa = m.work_area();
        let (wx, wy) = (wa.position.x, wa.position.y);
        let (ww, wh) = (wa.size.width as i32, wa.size.height as i32);
        return (wx + ww - PET_W - 16, wy + wh - PET_H - 16);
    }
    (x, y)
}

/// 启动时恢复桌宠位置与可见性（窗口由 tauri.conf.json 声明自动创建）。
pub fn setup_pet(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let st = read_pet_state(app);
    let (cx, cy) = clamp_pet_to_monitors(&pet, st.x, st.y);
    let _ = pet.set_position(tauri::PhysicalPosition::new(cx, cy));
    if st.passthrough {
        let _ = pet.set_ignore_cursor_events(true);
    }
    if st.enabled {
        let _ = pet.show();
    }
}

/// 显示/隐藏桌宠（托盘与右键共用），并写回 enabled 状态。
pub fn toggle_pet(app: &AppHandle) {
    let Some(pet) = app.get_webview_window("pet") else {
        return;
    };
    let mut st = read_pet_state(app);
    if pet.is_visible().unwrap_or(false) {
        let _ = pet.hide();
        st.enabled = false;
    } else {
        let _ = pet.show();
        st.enabled = true;
    }
    write_pet_state(app, &st);
}

#[tauri::command]
pub fn pet_show_main(app: AppHandle) {
    show_main(&app);
}

#[tauri::command]
pub fn pet_hide(app: AppHandle) {
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.hide();
    }
    let mut st = read_pet_state(&app);
    st.enabled = false;
    write_pet_state(&app, &st);
}

#[tauri::command]
pub fn pet_quit(app: AppHandle) {
    app.state::<DshState>().quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
pub fn pet_toggle_passthrough(app: AppHandle) -> bool {
    let mut st = read_pet_state(&app);
    st.passthrough = !st.passthrough;
    if let Some(pet) = app.get_webview_window("pet") {
        let _ = pet.set_ignore_cursor_events(st.passthrough);
    }
    write_pet_state(&app, &st);
    st.passthrough
}
