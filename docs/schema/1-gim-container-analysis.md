# GIM 容器结构分析

## 1. 样本范围

| 样本 ID         | 类型 | GIM 魔数 | 压缩格式 | 压缩数据偏移 |
| --------------- | ---- | -------- | -------- | ------------ |
| demo-line       | 线路 | GIMPKGT  | 7z       | 784          |
| demo-line1      | 线路 | GIMPKGT  | 7z       | 784          |
| demo-substation | 变电 | GIMPKGS  | 7z       | 784          |

## 2. Header 可读内容

- 两个 demo 都不是直接标准压缩包，而是 `GIMPKG*` 自定义头部 + 压缩数据。
- 2个线路工程的文件头魔数均为 `GIMPKGT`。
- `demo-substation.gim` 文件头魔数为 `GIMPKGS`。
- 3个 demo 的压缩数据均为 7z。
- 3个 demo 的 7z 签名偏移均为 784。
- header 中包含可读的原始工程文件名或项目名片段，随后为零填充。当前3个样本的 GIM header 中都包含可读的工程文件名或项目名片段。

| 样本            | Header 可读片段                                              |
| --------------- | ------------------------------------------------------------ |
| demo-line       | `500千伏喜苏II线.gim`                                        |
| demo-line1      | `雁城-船山（船山侧）双回改接衡阳西（喜阳）500kV线路工程.gim` |
| demo-substation | `4301-BA446501Z-资兴东220kV变电站新建-竣工图-20260402.gim`   |

当前判断：

- Header 不是纯魔数区，还包含工程文件名或项目名信息。
- 文件名之后存在零填充。
- 当前两个样本 7z 偏移均为 784，但不能据此假设所有 GIM 固定为 784。

## 3. 样本推断

- `GIMPKGT` 可作为线路工程候选标识。
- `GIMPKGS` 可作为变电工程候选标识。
- 当前两个样本都使用 7z，但不能排除其他工程使用 ZIP。
- 当前两个样本压缩偏移均为 784，但不能假设所有 GIM 都固定为 784。

## 4. 对解析器的影响

当前解析器继续采用“在头部之后 1MB 窗口内搜索 7z 或 ZIP 签名”的方式更稳妥，不应改成固定 offset=784。

## 5. 待验证问题

- 更多线路 GIM 是否都使用 `GIMPKGT`。
- 更多变电 GIM 是否都使用 `GIMPKGS`。
- 更多 GIM 是否都使用 7z，还是存在 ZIP。
- 压缩数据偏移是否始终为 784，还是随文件名长度、导出工具或版本变化。

## 脚本

### 检查 GIM 文件外壳

```powershell
cd D:\vibe-coding\gim_viewer

$sampleId = "demo-line1"
$gimPath = ".\demo\$sampleId.gim"
$sampleRoot = ".\demo\$sampleId"
$outDir = ".\docs\schema\_generated\$sampleId"

New-Item -ItemType Directory -Force $outDir | Out-Null

Get-FileHash $gimPath -Algorithm SHA256

Get-Item $gimPath |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize

function Read-HeaderHex($path, $bytes = 128) {
  $data = [System.IO.File]::ReadAllBytes((Resolve-Path $path))
  $take = [Math]::Min($bytes, $data.Length)

  for ($i = 0; $i -lt $take; $i += 16) {
    $chunk = $data[$i..([Math]::Min($i + 15, $take - 1))]
    ($chunk | ForEach-Object { $_.ToString("X2") }) -join " "
  }
}

function Find-SignatureOffset($path) {
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $path))
  $limit = [Math]::Min($bytes.Length - 6, 1024 * 1024)

  $sevenZip = [byte[]](0x37,0x7A,0xBC,0xAF,0x27,0x1C)
  $zip = [byte[]](0x50,0x4B,0x03,0x04)

  for ($i = 0; $i -lt $limit; $i++) {
    $match7z = $true
    for ($j = 0; $j -lt $sevenZip.Length; $j++) {
      if ($bytes[$i + $j] -ne $sevenZip[$j]) {
        $match7z = $false
        break
      }
    }
    if ($match7z) {
      return [PSCustomObject]@{
        Path = $path
        Format = "7z"
        Offset = $i
      }
    }

    $matchZip = $true
    for ($j = 0; $j -lt $zip.Length; $j++) {
      if ($bytes[$i + $j] -ne $zip[$j]) {
        $matchZip = $false
        break
      }
    }
    if ($matchZip) {
      return [PSCustomObject]@{
        Path = $path
        Format = "zip"
        Offset = $i
      }
    }
  }

  return [PSCustomObject]@{
    Path = $path
    Format = "unknown"
    Offset = $null
  }
}

"=== HEADER HEX ==="
Read-HeaderHex $gimPath 128

"=== ARCHIVE SIGNATURE ==="
Find-SignatureOffset $gimPath
```

