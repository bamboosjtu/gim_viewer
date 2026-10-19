//! 使用随包分发的 7-Zip 命令行解码器做流式解压。
//!
//! 纯 Rust sevenz-rust 的单线程解码在本项目目标样本上约 95 s（327 MB），
//! 7-Zip 原生解码到管道约 2.5 s。为保持发布版只有一个 `GIM-Reader.exe`，
//! `7z.exe` / `7z.dll` 以字节形式嵌入主程序，首次使用时释放到临时目录再
//! 调用；LGPL 许可说明见 README 与 `License.txt`（嵌入资源）。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

const EMBEDDED_7Z_EXE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/third_party/7zip/7z.exe"
));
const EMBEDDED_7Z_DLL: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/third_party/7zip/7z.dll"
));

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn embedded_hashes() -> (&'static str, &'static str) {
    static HASHES: OnceLock<(String, String)> = OnceLock::new();
    let (exe, dll) = HASHES.get_or_init(|| {
        (
            sha256_hex(EMBEDDED_7Z_EXE),
            sha256_hex(EMBEDDED_7Z_DLL),
        )
    });
    (exe.as_str(), dll.as_str())
}

/// 文件内容必须与嵌入副本的 SHA-256 完全一致；大小相同不再视为可信。
fn file_matches(path: &Path, expected: &str) -> bool {
    if !path.is_file() {
        return false;
    }
    fs::read(path)
        .map(|bytes| sha256_hex(&bytes) == expected)
        .unwrap_or(false)
}

fn write_verified(path: &Path, bytes: &[u8], expected: &str) -> Result<(), String> {
    if file_matches(path, expected) {
        return Ok(());
    }
    // 先写同目录临时文件并校验，再替换；避免中途失败留下“大小相同”的半文件。
    let temp = path.with_extension("tmp");
    fs::write(&temp, bytes).map_err(|e| format!("写入 {} 失败: {e}", temp.display()))?;
    if !file_matches(&temp, expected) {
        let _ = fs::remove_file(&temp);
        return Err(format!("{} 写入后 SHA-256 校验失败", temp.display()));
    }
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("替换 {} 失败: {e}", path.display()))?;
    }
    fs::rename(&temp, path).map_err(|e| format!("提交 {} 失败: {e}", path.display()))?;
    if !file_matches(path, expected) {
        return Err(format!("{} 提交后 SHA-256 校验失败", path.display()));
    }
    Ok(())
}

/// 定位可用的 7z.exe：同目录 sidecar 必须与嵌入副本哈希一致；否则释放嵌入副本。
pub fn locate_7z() -> Option<PathBuf> {
    static RESOLVED: OnceLock<Option<PathBuf>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            let (exe_hash, dll_hash) = embedded_hashes();
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    let candidate = dir.join("7z.exe");
                    // 不信任“存在且大小相同”的 sidecar；来源不明但哈希一致才可用。
                    if file_matches(&candidate, exe_hash) && file_matches(&dir.join("7z.dll"), dll_hash) {
                        return Some(candidate);
                    }
                }
            }
            extract_embedded().ok()
        })
        .clone()
}

fn extract_embedded() -> Result<PathBuf, String> {
    let (exe_hash, dll_hash) = embedded_hashes();
    // 目录按内容哈希命名：不同版本/不同二进制不会复用同一可预测路径。
    let dir = std::env::temp_dir()
        .join("gim-viewer-7zip")
        .join(format!("{}-{}", &exe_hash[..16], &dll_hash[..16]));
    fs::create_dir_all(&dir).map_err(|e| format!("创建 7z 临时目录失败: {e}"))?;
    let exe = dir.join("7z.exe");
    let dll = dir.join("7z.dll");
    write_verified(&exe, EMBEDDED_7Z_EXE, exe_hash)?;
    write_verified(&dll, EMBEDDED_7Z_DLL, dll_hash)?;
    // 执行前最后再确认一次，覆盖释放期间被替换的窗口。
    if !file_matches(&exe, exe_hash) || !file_matches(&dll, dll_hash) {
        return Err("随包 7z.exe/7z.dll 完整性校验失败".to_string());
    }
    Ok(exe)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_hashes_are_sha256_hex() {
        let (exe, dll) = embedded_hashes();
        assert_eq!(exe.len(), 64);
        assert_eq!(dll.len(), 64);
        assert!(exe.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(dll.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(exe, sha256_hex(EMBEDDED_7Z_EXE));
    }

    #[test]
    fn tampered_sidecar_is_not_trusted_even_with_same_size() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("gim-7z-integrity-{}-{nonce}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("7z.dll");
        fs::write(&path, vec![0u8; EMBEDDED_7Z_DLL.len()]).unwrap();
        let (_, dll_hash) = embedded_hashes();
        let actual = sha256_hex(&fs::read(&path).unwrap());
        assert_ne!(actual, dll_hash, "tampered file unexpectedly matches embedded hash");
        assert!(!file_matches(&path, dll_hash), "hash comparison accepted tampered file");
        let _ = fs::remove_dir_all(dir);
    }
}
