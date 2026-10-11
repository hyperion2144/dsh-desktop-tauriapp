// 应用名（单一来源）：构建配置、窗口标题、macOS 应用菜单都用它。
//
// 「BUN」后缀是**临时**的区分手段：Bun 运行时壳与旧 Node/Tauri 壳会并存一段时间，
// 名字不同才能在 Dock、菜单栏、/Applications 里一眼分得开（bundle id 不变，仍共用
// ~/.dsh 与运行时树）。等旧壳下线后去掉后缀。
export const APP_NAME = 'DeepSeek Harness Desktop BUN'
