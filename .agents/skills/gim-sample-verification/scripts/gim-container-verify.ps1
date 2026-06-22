# Round 1.1: GIM 容器结构验证
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File gim-container-verify.ps1 -GimPath "D:\path\to\sample.gim"
# 输出：头部魔数 / 文件名 / 压缩格式 / 偏移

param(
  [Parameter(Mandatory = $true)]
  [string]$GimPath
)

if (-not (Test-Path -LiteralPath $GimPath)) {
  throw "GIM file not found: $GimPath"
}

$gimItem = Get-Item -LiteralPath $GimPath
$sha256 = (Get-FileHash -LiteralPath $GimPath -Algorithm SHA256).Hash

Write-Host "=== GIM Container Verification ==="
Write-Host ("Path:         {0}" -f $GimPath)
Write-Host ("Size:         {0} bytes" -f $gimItem.Length)
Write-Host ("LastWrite:    {0}" -f $gimItem.LastWriteTime)
Write-Host ("SHA256:       {0}" -f $sha256)
Write-Host ""

# 读取前 128 字节
$bytes = [System.IO.File]::ReadAllBytes($GimPath)
$take = [Math]::Min(128, $bytes.Length)

Write-Host "=== Header Hex (first 128 bytes) ==="
for ($i = 0; $i -lt $take; $i += 16) {
  $end = [Math]::Min($i + 15, $take - 1)
  $chunk = $bytes[$i..$end]
  $hex = ($chunk | ForEach-Object { $_.ToString("X2") }) -join " "
  $ascii = -join ($chunk | ForEach-Object {
    if ($_ -ge 32 -and $_ -lt 127) { [char]$_ } else { "." }
  })
  Write-Host ("{0:X4}: {1,-48}  {2}" -f $i, $hex, $ascii)
}
Write-Host ""

# 解析头部魔数（前 6 字节 ASCII）
$magicBytes = $bytes[0..5]
$magic = [Text.Encoding]::ASCII.GetString($magicBytes).Trim([char]0)

$typeName = "未知"
if ($magic -eq "GIMPKGT") { $typeName = "线路工程" }
elseif ($magic -eq "GIMPKGS") { $typeName = "变电工程" }

Write-Host "=== Header Parsing ==="
Write-Host ("Magic:        {0}  ({1})" -f $magic, $typeName)
Write-Host ""

# 解析文件名（UTF-8，零填充，从 offset 16 开始）
if ($bytes.Length -gt 16) {
  $nameBytes = $bytes[16..([Math]::Min(127, $bytes.Length - 1))]
  $nameEnd = [Array]::IndexOf($nameBytes, [byte]0)
  if ($nameEnd -ge 0) {
    $nameBytes = $nameBytes[0..($nameEnd - 1)]
  }
  $name = [Text.Encoding]::UTF8.GetString($nameBytes)
  Write-Host ("Embedded name: {0}" -f $name)
}
Write-Host ""

# 搜索 7z / ZIP 签名
Write-Host "=== Archive Signature Search (1MB window) ==="
$limit = [Math]::Min($bytes.Length - 6, 1024 * 1024)

$sevenZip = [byte[]](0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C)
$zip = [byte[]](0x50, 0x4B, 0x03, 0x04)

$found7z = -1
$foundZip = -1

for ($i = 0; $i -lt $limit; $i++) {
  if ($found7z -lt 0) {
    $match = $true
    for ($j = 0; $j -lt 6; $j++) {
      if ($bytes[$i + $j] -ne $sevenZip[$j]) { $match = $false; break }
    }
    if ($match) { $found7z = $i }
  }
  if ($foundZip -lt 0) {
    $match = $true
    for ($j = 0; $j -lt 4; $j++) {
      if ($bytes[$i + $j] -ne $zip[$j]) { $match = $false; break }
    }
    if ($match) { $foundZip = $i }
  }
  if ($found7z -ge 0 -and $foundZip -ge 0) { break }
}

if ($found7z -ge 0) {
  Write-Host ("Format:       7z")
  Write-Host ("Offset:       {0}" -f $found7z)
} elseif ($foundZip -ge 0) {
  Write-Host ("Format:       ZIP")
  Write-Host ("Offset:       {0}" -f $foundZip)
} else {
  Write-Host "Format:       UNKNOWN (no 7z/ZIP signature in 1MB window)"
}
Write-Host ""

# 关键判断
Write-Host "=== Verification ==="
$ok = $true
if ($magic -ne "GIMPKGT" -and $magic -ne "GIMPKGS") {
  Write-Host ("FAIL: magic {0} is not GIMPKGT / GIMPKGS" -f $magic)
  $ok = $false
} else {
  Write-Host ("PASS: magic {0} matches expected GIMPKG* prefix" -f $magic)
}
if ($found7z -lt 0 -and $foundZip -lt 0) {
  Write-Host "FAIL: no 7z/ZIP signature found in 1MB window"
  $ok = $false
} else {
  Write-Host "PASS: archive signature located within 1MB window"
}
Write-Host ""

if ($ok) {
  Write-Host "=== Overall: PASS ==="
} else {
  Write-Host "=== Overall: FAIL ==="
}
