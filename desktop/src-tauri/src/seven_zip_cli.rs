//! 使用随包分发的 7-Zip 命令行解码器做流式解压。
//!
//! 纯 Rust sevenz-rust 的单线程解码在本项目目标样本上约 95 s（327 MB），
//! 而 7-Zip 原生解码到管道约 2.5 s。这里把归档载荷切片写入临时 .7z，
//! 由 `7z e -so` 输出连续的条目字节流，再按归档顺序和声明大小切分后交给
//! 现有 sink（pack/IFC 落盘）。7z.exe/7z.dll 以 LGPL 随包分发，见 README。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 定位随包的 7z.exe：优先 exe 同目录，其次开发目录 third_party。
pub fn locate_7z() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("7z.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("third_party/7zip/7z.exe");
    if dev.is_file() {
        return Some(dev);
    }
    None
}

pub fn is_available() -> bool {
    locate_7z().is_some()
}

/// 将 `archive_path[offset..]` 流式解压，并按 `entries` 顺序切分后调用 sink。
///
/// `entries` 必须来自同一归档的只读检查（路径已校验、顺序为归档物理顺序）。
pub fn extract_stream<F>(
    archive_path: &Path,
    offset: u64,
    entries: &[(String, u64)],
    temp_dir: &Path,
    mut sink: F,
) -> Result<(), String>
where
    F: FnMut(String, Vec<u8>) -> Result<(), String>,
{
    let seven_zip = locate_7z().ok_or_else(|| "随包 7z.exe 不可用".to_string())?;
    let temp_archive = temp_dir.join(".gim-archive-stream.7z");
    let _ = fs::remove_file(&temp_archive);
    {
        let mut source = File::open(archive_path).map_err(|e| format!("打开 GIM 失败: {e}"))?;
        source
            .seek(SeekFrom::Start(offset))
            .map_err(|e| format!("定位归档偏移失败: {e}"))?;
        let mut target = File::create(&temp_archive).map_err(|e| format!("创建临时归档失败: {e}"))?;
        std::io::copy(&mut source, &mut target).map_err(|e| format!("复制归档载荷失败: {e}"))?;
        target.flush().map_err(|e| format!("刷新临时归档失败: {e}"))?;
    }

    let result = (|| -> Result<(), String> {
        let mut command = Command::new(&seven_zip);
        command
            .arg("e")
            .arg(&temp_archive)
            .args(["-so", "-bso0", "-bsp0", "-bd", "-y"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| format!("启动 7z.exe 失败: {e}"))?;
        let mut stdout = child.stdout.take().ok_or_else(|| "7z stdout 不可用".to_string())?;
        let mut buffer = vec![0u8; 1 << 20];
        let mut pending: Vec<u8> = Vec::new();
        let mut entry_index = 0usize;
        while entry_index < entries.len() {
            let (path, size) = &entries[entry_index];
            let size_usize = usize::try_from(*size).map_err(|_| format!("条目过大: {path}"))?;
            let mut bytes = Vec::new();
            while bytes.len() < size_usize {
                if pending.is_empty() {
                    let read = stdout
                        .read(&mut buffer)
                        .map_err(|e| format!("读取 7z 输出失败: {e}"))?;
                    if read == 0 {
                        return Err(format!(
                            "7z 输出提前结束（{entry_index}/{}，缺少 {path}）",
                            entries.len()
                        ));
                    }
                    pending.extend_from_slice(&buffer[..read]);
                }
                let take = (size_usize - bytes.len()).min(pending.len());
                bytes.extend_from_slice(&pending[..take]);
                pending.drain(..take);
            }
            entry_index += 1;
            sink(path.clone(), bytes)?;
        }
        // 归档中不应还有额外条目；读取剩余输出以确认 EOF。
        let mut tail = [0u8; 4096];
        loop {
            let read = stdout
                .read(&mut tail)
                .map_err(|e| format!("读取 7z 尾部失败: {e}"))?;
            if read == 0 {
                break;
            }
        }
        let status = child.wait().map_err(|e| format!("等待 7z 退出失败: {e}"))?;
        if !status.success() {
            return Err(format!("7z 解压失败（{status}）"));
        }
        Ok(())
    })();

    let _ = fs::remove_file(&temp_archive);
    result
}
