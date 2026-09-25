//! stderr 累积缓冲：spawn 时创建的共享环形缓冲，转发线程写、退出通知读。
//!
//! 原属启动保险丝（#57/#58，#127 废弃保险丝后保留）：多窗口「实例已退出」
//! 通知仍用它展示 stderr 尾部，让用户在通知里直接看到退出原因。
//! 512KiB 上限，超出丢最旧的——失败输出在末尾，保新弃旧。

#[derive(Default)]
pub struct StderrBuffer {
    lines: Vec<String>,
    bytes: usize,
    truncated: bool,
}

impl StderrBuffer {
    const CAP: usize = 512 * 1024;

    pub fn push(&mut self, line: &str) {
        let n = line.len() + 1;
        self.lines.push(line.to_string());
        self.bytes += n;
        while self.bytes > Self::CAP && self.lines.len() > 1 {
            let removed = self.lines.remove(0);
            self.bytes = self.bytes.saturating_sub(removed.len() + 1);
            self.truncated = true;
        }
    }

    /// 尾部 n 行（供退出通知 / 重放场景取最近输出）。
    pub fn tail_lines(&self, n: usize) -> Vec<String> {
        let start = self.lines.len().saturating_sub(n);
        self.lines[start..].to_vec()
    }
}

/// 共享缓冲句柄（spawn 时创建，线程写，退出通知读）。
pub type SharedStderr = std::sync::Arc<std::sync::Mutex<StderrBuffer>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stderr_buffer_caps_at_512k_keeping_newest() {
        let mut buf = StderrBuffer::default();
        let long = "x".repeat(4096);
        for i in 0..200 {
            buf.push(&format!("{i}:{long}"));
        }
        assert!(buf.bytes <= StderrBuffer::CAP + 8192);
        let tail = buf.tail_lines(1);
        assert!(tail[0].starts_with("199:"), "最新行必须保留：{:?}", tail);
    }
}
