# 通知音三分语义：自定义音走应用侧播放，OS 通知渠道只承载默认音

通知音效分三档：`default`（走 OS 通知渠道自带音——macOS UNNotificationSound 默认声 / Windows toast 默认声，应用侧零播放代码，跟用户系统通知设置走）、`none`（通知本体 silent）、`custom:<file>`（**通知本体发 silent，音频由应用进程内 rodio 播放**）。之所以 custom 不交给 OS 渠道：macOS 只认 .app bundle 内 Library/Sounds 的声音文件、Windows toast 只认 ms-appx 打包资产，运行时用户选择的文件两者都塞不进去，而往已签名 .app 包内写文件会破坏签名——应用侧播放是被平台约束逼出来的唯一可行路径，不是偏好。播放库选 rodio 0.22（`default-features = false, features = ["playback", "wav", "mp3", "vorbis"]`，实测二进制增量 +1.68MB；默认全量 +2.08MB 因含 symphonia-aac/isomp4/flac/recording，主动裁掉）；否决系统命令方案（Windows 无像样内置 CLI，wav 之外要 WMP COM，spawn 延迟 200–500ms 且错误不可观测）。播放失败降级为系统默认音并落日志；单文件 ≤5MB、播放端 10s 截断。Linux 不在发布矩阵（release 仅 macOS-aarch64/Windows-x86_64），源码层 `cfg(linux)` 走 paplay 尽力而为。

## Status

accepted（2026-09-27，wayfinder map #128 / issue #133 决议）

## Considered Options

- 系统命令（afplay / PowerShell SoundPlayer+WMP COM / paplay）：零依赖，但 Windows mp3 支持糙、进程启动延迟、错误不可观测——否决
- kira：游戏音频库，依赖重于需求——否决
- 自定义音交给 OS 通知渠道：平台只认包内资产且写入签名包会破坏签名——不可行
