# Round 8: STL 静态分析
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File stl-static-survey.ps1 -SampleId "demo-line" -SampleRoot "D:\path\to\demo-line"
# 输出 CSV：{sampleId}-stl-summary.csv / {sampleId}-stl-phm-refs.csv / {sampleId}-stl-upstream.csv

param(
  [Parameter(Mandatory = $true)]
  [string]$SampleId,
  [Parameter(Mandatory = $true)]
  [string]$SampleRoot,
  [string]$OutDir = ""
)

if (-not (Test-Path -LiteralPath $SampleRoot)) {
  throw "Sample root not found: $SampleRoot"
}

if ($OutDir -eq "") {
  $OutDir = Join-Path $PSScriptRoot $SampleId
}
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Get-GimDir($root, $name) {
  $dir = Get-ChildItem $root -Directory |
    Where-Object { $_.Name -ieq $name } |
    Select-Object -First 1
  if (-not $dir) { throw "Cannot find directory: $name under $root" }
  return $dir.FullName
}

function Read-TextFileLoose($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -eq 0) { return "" }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $bytes = $bytes[3..($bytes.Length - 1)]
  }
  try { return [System.Text.Encoding]::UTF8.GetString($bytes) }
  catch { return [System.Text.Encoding]::Default.GetString($bytes) }
}

# ============ Detect STL format: ASCII vs binary ============
# Binary STL: 80-byte header + 4-byte triangle count (LE) + N * 50 bytes
# ASCII STL: starts with "solid" keyword
function Test-StlFormat($path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  if ($bytes.Length -lt 84) {
    return @{ format = "unknown"; triangles = 0; expectedBinSize = 0; actualSize = $bytes.Length; header = "" }
  }
  $first5 = [System.Text.Encoding]::ASCII.GetString($bytes[0..4])
  $headerStr = [System.Text.Encoding]::ASCII.GetString($bytes[0..79])
  $tri = [BitConverter]::ToInt32($bytes, 80)
  $expectedBin = 84 + $tri * 50
  $actualSize = $bytes.Length

  # 判定：size 匹配 84 + 50*N，或首 5 字节不是 "solid"
  # 注意：binary STL header 也可能以 "solid" 开头（某些工具），所以 size 匹配优先
  if ($expectedBin -eq $actualSize) {
    # 进一步确认不是 ASCII（ASCII 文件 size 通常远大于 84 + 50*N）
    return @{ format = "binary"; triangles = $tri; expectedBinSize = $expectedBin; actualSize = $actualSize; header = $headerStr }
  }
  if ($first5 -eq "solid") {
    # ASCII STL
    $triCount = 0
    foreach ($line in ($headerStr -split "`r?`n")) {
      if ($line -match "facet") { $triCount++ }
    }
    # 重新读全文统计
    $text = Read-TextFileLoose $path
    $triCount = ($text -split "`r?`n" | Where-Object { $_ -match "^\s*facet\s" }).Count
    return @{ format = "ascii"; triangles = $triCount; expectedBinSize = 0; actualSize = $actualSize; header = $first5 }
  }
  # 不明格式
  return @{ format = "unknown"; triangles = 0; expectedBinSize = $expectedBin; actualSize = $actualSize; header = $first5 }
}

$cbmDir = Get-GimDir $SampleRoot "Cbm"
$devDir = Get-GimDir $SampleRoot "Dev"
$phmDir = Get-GimDir $SampleRoot "Phm"
$modDir = Get-GimDir $SampleRoot "Mod"

$cbmFiles = Get-ChildItem $cbmDir -File -Filter *.cbm
$devFiles = Get-ChildItem $devDir -File -Filter *.dev
$phmFiles = Get-ChildItem $phmDir -File -Filter *.phm
$modFiles = Get-ChildItem $modDir -File -Filter *.mod
$stlFiles = Get-ChildItem $modDir -File -Filter *.stl

Write-Host "=== STL Static Survey: $SampleId ==="
Write-Host ("CBM files: {0}" -f $cbmFiles.Count)
Write-Host ("DEV files: {0}" -f $devFiles.Count)
Write-Host ("PHM files: {0}" -f $phmFiles.Count)
Write-Host ("MOD files: {0}" -f $modFiles.Count)
Write-Host ("STL files: {0}" -f $stlFiles.Count)
Write-Host ""

# ============ 1. STL format detection ============
Write-Host "============================================================"
Write-Host "  1. STL format detection (ASCII vs binary)"
Write-Host "============================================================"

$stlStats = @()
$formatDist = @{}
$triCounts = @()
$sizes = @()

foreach ($f in $stlFiles) {
  $info = Test-StlFormat $f.FullName
  if (-not $formatDist.ContainsKey($info.format)) { $formatDist[$info.format] = 0 }
  $formatDist[$info.format]++
  $triCounts += $info.triangles
  $sizes += $info.actualSize
  $stlStats += [PSCustomObject]@{
    file = $f.Name
    format = $info.format
    size = $info.actualSize
    triangles = $info.triangles
    header = ($info.header -replace "\s+", " ").Trim().Substring(0, [Math]::Min(40, ($info.header -replace "\s+", " ").Trim().Length))
  }
}

$stlCsv = Join-Path $OutDir "$SampleId-stl-summary.csv"
$stlStats | Export-Csv $stlCsv -NoTypeInformation -Encoding UTF8
Write-Host ("STL summary CSV: {0}" -f $stlCsv)
Write-Host ""

Write-Host "---- Format distribution ----"
$formatDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
  Write-Host ("  {0}: {1} files" -f $_.Key, $_.Value)
}
Write-Host ""

if ($triCounts.Count -gt 0) {
  $tcMin = ($triCounts | Measure-Object -Minimum).Minimum
  $tcMax = ($triCounts | Measure-Object -Maximum).Maximum
  $tcAvg = ($triCounts | Measure-Object -Average).Average
  $tcSum = ($triCounts | Measure-Object -Sum).Sum
  Write-Host "---- Triangle count stats ----"
  Write-Host ("  min:    {0}" -f $tcMin)
  Write-Host ("  max:    {0}" -f $tcMax)
  Write-Host ("  mean:   {0:F2}" -f $tcAvg)
  Write-Host ("  total:  {0}" -f $tcSum)
  Write-Host ""

  $szMin = ($sizes | Measure-Object -Minimum).Minimum
  $szMax = ($sizes | Measure-Object -Maximum).Maximum
  $szAvg = ($sizes | Measure-Object -Average).Average
  $szSum = ($sizes | Measure-Object -Sum).Sum
  Write-Host "---- File size stats ----"
  Write-Host ("  min:    {0} bytes ({1:F2} KB)" -f $szMin, ($szMin/1024))
  Write-Host ("  max:    {0} bytes ({1:F2} KB)" -f $szMax, ($szMax/1024))
  Write-Host ("  mean:   {0:F2} bytes ({1:F2} KB)" -f $szAvg, ($szAvg/1024))
  Write-Host ("  total:  {0} bytes ({1:F2} MB)" -f $szSum, ($szSum/1024/1024))
  Write-Host ""
}

Write-Host "---- First 3 STL file headers ----"
foreach ($s in ($stlStats | Select-Object -First 3)) {
  Write-Host ("  {0}: format={1} size={2} triangles={3}" -f $s.file, $s.format, $s.size, $s.triangles)
  Write-Host ("    header: '{0}'" -f $s.header)
}
Write-Host ""

# ============ 2. PHM -> STL reference scan ============
Write-Host "============================================================"
Write-Host "  2. PHM -> STL reference scan"
Write-Host "============================================================"

# Build PHM -> SOLIDMODEL refs (both .mod and .stl)
$phmRefs = @{}   # phmName -> list of solidmodel targets (with ext)
foreach ($pf in $phmFiles) {
  $text = Read-TextFileLoose $pf.FullName
  $lines = $text -split "`r?`n"
  $refs = @()
  foreach ($line in $lines) {
    if ($line -match "^\s*SOLIDMODEL\d+\s*=\s*(.+\.(mod|stl))\s*$") {
      $refs += $matches[1].Trim()
    }
  }
  $phmRefs[$pf.Name.ToLower()] = $refs
}

# Count PHM that reference STL
$phmWithStl = 0
$phmWithOnlyStl = 0
$phmWithStlAndMod = 0
$phmWithModOnly = 0
$phmWithNoRef = 0
$stlRefCount = @{}   # stlName -> count of PHM referencing it

foreach ($phmName in $phmRefs.Keys) {
  $refs = $phmRefs[$phmName]
  $hasStl = $false
  $hasMod = $false
  foreach ($r in $refs) {
    if ($r -match "\.stl$") {
      $hasStl = $true
      $lowerR = $r.ToLower()
      if (-not $stlRefCount.ContainsKey($lowerR)) { $stlRefCount[$lowerR] = 0 }
      $stlRefCount[$lowerR]++
    }
    if ($r -match "\.mod$") {
      $hasMod = $true
    }
  }
  if ($hasStl) { $phmWithStl++ }
  if ($hasStl -and -not $hasMod) { $phmWithOnlyStl++ }
  if ($hasStl -and $hasMod) { $phmWithStlAndMod++ }
  if (-not $hasStl -and $hasMod) { $phmWithModOnly++ }
  if (-not $hasStl -and -not $hasMod) { $phmWithNoRef++ }
}

Write-Host "---- PHM reference mode distribution ----"
Write-Host ("  PHM total:                   {0}" -f $phmFiles.Count)
Write-Host ("  PHM with STL (any):          {0}" -f $phmWithStl)
Write-Host ("  PHM with ONLY STL (no MOD):  {0}" -f $phmWithOnlyStl)
Write-Host ("  PHM with STL + MOD:          {0}" -f $phmWithStlAndMod)
Write-Host ("  PHM with MOD only:           {0}" -f $phmWithModOnly)
Write-Host ("  PHM with no SOLIDMODEL ref:  {0}" -f $phmWithNoRef)
Write-Host ""

# STL coverage: % of STL files referenced by at least one PHM
$stlReferencedCount = 0
$stlUnreferenced = @()
foreach ($f in $stlFiles) {
  if ($stlRefCount.ContainsKey($f.Name.ToLower())) {
    $stlReferencedCount++
  } else {
    $stlUnreferenced += $f.Name
  }
}
Write-Host "---- STL coverage ----"
Write-Host ("  STL total:        {0}" -f $stlFiles.Count)
Write-Host ("  STL referenced:   {0} ({1:P1})" -f $stlReferencedCount, ($stlReferencedCount / $stlFiles.Count))
Write-Host ("  STL unreferenced: {0}" -f $stlUnreferenced.Count)
if ($stlUnreferenced.Count -gt 0 -and $stlUnreferenced.Count -le 30) {
  Write-Host "  Unreferenced files:"
  foreach ($u in $stlUnreferenced) { Write-Host ("    {0}" -f $u) }
}
Write-Host ""

# STL reuse distribution (how many PHMs reference each STL)
$reuseDist = @{}
foreach ($stlName in $stlRefCount.Keys) {
  $c = $stlRefCount[$stlName]
  if (-not $reuseDist.ContainsKey($c)) { $reuseDist[$c] = 0 }
  $reuseDist[$c]++
}
Write-Host "---- STL reuse distribution (PHM ref count -> STL count) ----"
$reuseDist.GetEnumerator() | Sort-Object Name | ForEach-Object {
  Write-Host ("  ref-count={0}: {1} STL files" -f $_.Key, $_.Value)
}
Write-Host ""

# Output PHM-ref CSV
$phmRefRows = @()
foreach ($phmName in $phmRefs.Keys) {
  $refs = $phmRefs[$phmName]
  $stlList = ($refs | Where-Object { $_ -match "\.stl$" }) -join ";"
  $modList = ($refs | Where-Object { $_ -match "\.mod$" }) -join ";"
  $phmRefRows += [PSCustomObject]@{
    phm = $phmName
    totalRefs = $refs.Count
    stlRefs = ($refs | Where-Object { $_ -match "\.stl$" }).Count
    modRefs = ($refs | Where-Object { $_ -match "\.mod$" }).Count
    stlList = $stlList
    modList = $modList
  }
}
$phmRefCsv = Join-Path $OutDir "$SampleId-stl-phm-refs.csv"
$phmRefRows | Export-Csv $phmRefCsv -NoTypeInformation -Encoding UTF8
Write-Host ("PHM refs CSV: {0}" -f $phmRefCsv)
Write-Host ""

# ============ 3. CBM -> STL upstream trace ============
Write-Host "============================================================"
Write-Host "  3. CBM -> STL upstream trace (entityName mapping)"
Write-Host "============================================================"

# Build DEV -> PHM map and DEV -> DEV map
$devToPhmMap = @{}
$devToDevMap = @{}
foreach ($df in $devFiles) {
  $text = Read-TextFileLoose $df.FullName
  $lines = $text -split "`r?`n"
  $phmRefs = @()
  $devRefs = @()
  foreach ($line in $lines) {
    if ($line -match "^SOLIDMODEL\d+\s*=\s*(.+)") {
      $val = $matches[1].Trim()
      if ($val -match "\.phm$") { $phmRefs += $val }
      elseif ($val -match "\.dev$") { $devRefs += $val }
    }
  }
  $devToPhmMap[$df.Name.ToLower()] = $phmRefs
  $devToDevMap[$df.Name.ToLower()] = $devRefs
}

# Build PHM -> STL map (and PHM -> MOD map)
$phmToStlMap = @{}
$phmToModMap = @{}
foreach ($pf in $phmFiles) {
  $text = Read-TextFileLoose $pf.FullName
  $lines = $text -split "`r?`n"
  $stlRefs = @()
  $modRefs = @()
  foreach ($line in $lines) {
    if ($line -match "^SOLIDMODEL\d+\s*=\s*(.+\.(stl|mod))\s*$") {
      $val = $matches[1].Trim()
      if ($val -match "\.stl$") { $stlRefs += $val }
      elseif ($val -match "\.mod$") { $modRefs += $val }
    }
  }
  $phmToStlMap[$pf.Name.ToLower()] = $stlRefs
  $phmToModMap[$pf.Name.ToLower()] = $modRefs
}

# Build MOD name -> kind map (reuse from mod-static-profile.ps1)
function Classify-ModText($text) {
  if ($null -eq $text -or $text.Trim().Length -eq 0) { return "EMPTY" }
  $trimmed = $text.TrimStart()
  if ($trimmed -match "^<\?xml" -or $trimmed -match "^<Device") {
    if ($trimmed -match "<Entities\s*/>") { return "XML_EMPTY_DEVICE" }
    if ($trimmed -match "<Entity") { return "XML_WITH_ENTITIES" }
    return "XML_OTHER"
  }
  if ($text -match "(?m)^CODE\s*=" -and $text -match "(?m)^POINTNUM\s*=" -and $text -match "(?m)^LINENUM\s*=") {
    return "TEXT_POINT_LINE"
  }
  if ($text -match "(?m)^HNum\s*,") { return "TEXT_HNUM_COMMA_RECORD" }
  $lines = $text -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
  if ($lines.Count -eq 0) { return "EMPTY" }
  $firstLine = $lines[0]
  $kvLineCount = ($lines | Where-Object { $_ -match "^[A-Za-z0-9_.-]+\s*=" }).Count
  if ($firstLine -notmatch "=" -and $kvLineCount -gt 0) { return "TEXT_SECTION_KV_RECORD" }
  if ($kvLineCount -gt 0) { return "TEXT_KEY_VALUE" }
  if ($text -match "," -and $text -match "[0-9]") { return "TEXT_COMMA_NUMERIC" }
  return "TEXT_UNKNOWN"
}

$modKindMap = @{}
foreach ($mf in $modFiles) {
  $text = Read-TextFileLoose $mf.FullName
  $kind = Classify-ModText $text
  $modKindMap[$mf.Name.ToLower()] = $kind
}

# Scan ALL CBM files for OBJECTMODELPOINTER + ENTITYNAME
$cbmDevEntries = @{}   # devName -> list of entityNames
foreach ($cf in $cbmFiles) {
  $text = Read-TextFileLoose $cf.FullName
  $lines = $text -split "`r?`n"
  $entityName = ""
  $objModelPointer = ""
  foreach ($line in $lines) {
    if ($line -match "^ENTITYNAME\s*=\s*(.+)") { $entityName = $matches[1].Trim() }
    if ($line -match "^OBJECTMODELPOINTER\s*=\s*(.+)") { $objModelPointer = $matches[1].Trim() }
  }
  if ($objModelPointer -and $objModelPointer -match "\.dev$") {
    $devName = $objModelPointer.ToLower()
    if (-not $cbmDevEntries.ContainsKey($devName)) { $cbmDevEntries[$devName] = @() }
    $cbmDevEntries[$devName] += $entityName
  }
}

# Recursively collect all PHMs reachable from a DEV (through DEV -> DEV)
function Get-AllPhmFromDev($devName, $visited) {
  if ($visited.ContainsKey($devName)) { return @() }
  $visited[$devName] = $true
  $phms = @()
  $key = $devName.ToLower()
  if ($devToPhmMap.ContainsKey($key)) {
    $phms += $devToPhmMap[$key]
  }
  if ($devToDevMap.ContainsKey($key)) {
    foreach ($childDev in $devToDevMap[$key]) {
      $phms += Get-AllPhmFromDev $childDev $visited
    }
  }
  return $phms | Sort-Object -Unique
}

# For each CBM-referenced DEV, find all reachable STL (and MOD kinds)
$cbmEntityNameStlCounts = @{}   # "entityName, stl" -> { refs, unique, mods }
$entityNameStlCount = @{}       # entityName -> count of STL refs
$entityNameModOnlyCount = @{}   # entityName -> count of MOD-only refs (no STL)
$entityNameStlAndModCount = @{} # entityName -> count of (STL+MOD) refs
$entityNameStlOnlyCount = @{}   # entityName -> count of STL-only refs (no MOD)

foreach ($devName in $cbmDevEntries.Keys) {
  $entityNames = $cbmDevEntries[$devName]
  $vis = @{}
  $allPhms = Get-AllPhmFromDev $devName $vis
  $stlRefs = @()
  $modRefs = @()
  $modKinds = @()
  foreach ($phmName in $allPhms) {
    $key = $phmName.ToLower()
    if ($phmToStlMap.ContainsKey($key)) {
      $stlRefs += $phmToStlMap[$key]
    }
    if ($phmToModMap.ContainsKey($key)) {
      $modRefs += $phmToModMap[$key]
    }
  }
  $uniqueStls = $stlRefs | Sort-Object -Unique
  $uniqueMods = $modRefs | Sort-Object -Unique

  foreach ($en in $entityNames) {
    # entityName × STL presence
    if ($uniqueStls.Count -gt 0) {
      if (-not $entityNameStlCount.ContainsKey($en)) { $entityNameStlCount[$en] = 0 }
      $entityNameStlCount[$en]++
    } else {
      if (-not $entityNameModOnlyCount.ContainsKey($en)) { $entityNameModOnlyCount[$en] = 0 }
      $entityNameModOnlyCount[$en]++
    }
    # entityName × STL+MOD combo
    if ($uniqueStls.Count -gt 0 -and $uniqueMods.Count -gt 0) {
      if (-not $entityNameStlAndModCount.ContainsKey($en)) { $entityNameStlAndModCount[$en] = 0 }
      $entityNameStlAndModCount[$en]++
    } elseif ($uniqueStls.Count -gt 0 -and $uniqueMods.Count -eq 0) {
      if (-not $entityNameStlOnlyCount.ContainsKey($en)) { $entityNameStlOnlyCount[$en] = 0 }
      $entityNameStlOnlyCount[$en]++
    }

    # collect mod kinds reachable from this DEV (for combo analysis)
    $kinds = @()
    foreach ($modName in $uniqueMods) {
      $lowerMod = $modName.ToLower()
      if ($modKindMap.ContainsKey($lowerMod)) {
        $kinds += $modKindMap[$lowerMod]
      }
    }
    $kindsStr = ($kinds | Sort-Object -Unique) -join ";"
    $comboKey = "$en | stl=$($uniqueStls.Count) | modKinds=$kindsStr"
    if (-not $cbmEntityNameStlCounts.ContainsKey($comboKey)) {
      $cbmEntityNameStlCounts[$comboKey] = @{ refs = 0; uniqueStls = @{}; uniqueMods = @{} }
    }
    $cbmEntityNameStlCounts[$comboKey].refs++
    foreach ($s in $uniqueStls) { $cbmEntityNameStlCounts[$comboKey].uniqueStls[$s.ToLower()] = $true }
    foreach ($m in $uniqueMods) { $cbmEntityNameStlCounts[$comboKey].uniqueMods[$m.ToLower()] = $true }
  }
}

Write-Host "---- entityName × STL presence ----"
$entityAll = @{}
foreach ($en in $entityNameStlCount.Keys) { $entityAll[$en] = $true }
foreach ($en in $entityNameModOnlyCount.Keys) { $entityAll[$en] = $true }
$entityAll.GetEnumerator() | Sort-Object Name | ForEach-Object {
  $en = $_.Key
  $stlC = if ($entityNameStlCount.ContainsKey($en)) { $entityNameStlCount[$en] } else { 0 }
  $modOnlyC = if ($entityNameModOnlyCount.ContainsKey($en)) { $entityNameModOnlyCount[$en] } else { 0 }
  $stlAndModC = if ($entityNameStlAndModCount.ContainsKey($en)) { $entityNameStlAndModCount[$en] } else { 0 }
  $stlOnlyC = if ($entityNameStlOnlyCount.ContainsKey($en)) { $entityNameStlOnlyCount[$en] } else { 0 }
  $total = $stlC + $modOnlyC
  Write-Host ("  {0}: total={1}, hasSTL={2} (STL-only={3}, STL+MOD={4}), MOD-only={5}" -f $en, $total, $stlC, $stlOnlyC, $stlAndModC, $modOnlyC)
}
Write-Host ""

# Output upstream CSV
$upstreamRows = @()
foreach ($comboKey in $cbmEntityNameStlCounts.Keys) {
  $upstreamRows += [PSCustomObject]@{
    signature = $comboKey
    refs = $cbmEntityNameStlCounts[$comboKey].refs
    uniqueStls = $cbmEntityNameStlCounts[$comboKey].uniqueStls.Keys.Count
    uniqueMods = $cbmEntityNameStlCounts[$comboKey].uniqueMods.Keys.Count
  }
}
$upstreamCsv = Join-Path $OutDir "$SampleId-stl-upstream.csv"
$upstreamRows | Sort-Object refs -Descending | Export-Csv $upstreamCsv -NoTypeInformation -Encoding UTF8
Write-Host ("Upstream CSV: {0}" -f $upstreamCsv)
Write-Host ""

Write-Host "---- entityName × MOD-kind combos (top 30 by refs) ----"
$cbmEntityNameStlCounts.GetEnumerator() | Sort-Object { $_.Value.refs } -Descending | Select-Object -First 30 | ForEach-Object {
  $uniqueStlCount = $_.Value.uniqueStls.Keys.Count
  $uniqueModCount = $_.Value.uniqueMods.Keys.Count
  Write-Host ("  refs={0,5} | uniqueSTLs={1,4} | uniqueMODs={2,5} | {3}" -f $_.Value.refs, $uniqueStlCount, $uniqueModCount, $_.Key)
}
Write-Host ""

# ============ 4. STL vs MOD relationship per PHM ============
Write-Host "============================================================"
Write-Host "  4. STL vs MOD relationship per PHM"
Write-Host "============================================================"

# Already counted above:
Write-Host ("  PHM with ONLY STL (no MOD):  {0} ({1:P1})" -f $phmWithOnlyStl, ($phmWithOnlyStl / $phmFiles.Count))
Write-Host ("  PHM with STL + MOD:          {0} ({1:P1})" -f $phmWithStlAndMod, ($phmWithStlAndMod / $phmFiles.Count))
Write-Host ("  PHM with MOD only:           {0} ({1:P1})" -f $phmWithModOnly, ($phmWithModOnly / $phmFiles.Count))
Write-Host ""

# ============ 5. STL size distribution by entityName ============
Write-Host "============================================================"
Write-Host "  5. STL size / triangle distribution by entityName"
Write-Host "============================================================"

# Build STL name -> stats map
$stlStatMap = @{}
foreach ($s in $stlStats) {
  $stlStatMap[$s.file.ToLower()] = $s
}

# For each entityName, collect STL sizes/triangles
$entityNameStlSizes = @{}
$entityNameStlTris = @{}

# Re-trace: for each CBM-DEV, collect unique STL names per entityName
foreach ($devName in $cbmDevEntries.Keys) {
  $entityNames = $cbmDevEntries[$devName]
  $vis = @{}
  $allPhms = Get-AllPhmFromDev $devName $vis
  $stlRefs = @()
  foreach ($phmName in $allPhms) {
    $key = $phmName.ToLower()
    if ($phmToStlMap.ContainsKey($key)) {
      $stlRefs += $phmToStlMap[$key]
    }
  }
  $uniqueStls = $stlRefs | Sort-Object -Unique
  foreach ($en in $entityNames) {
    if (-not $entityNameStlSizes.ContainsKey($en)) { $entityNameStlSizes[$en] = @(); $entityNameStlTris[$en] = @() }
    foreach ($s in $uniqueStls) {
      $lower = $s.ToLower()
      if ($stlStatMap.ContainsKey($lower)) {
        $entityNameStlSizes[$en] += $stlStatMap[$lower].size
        $entityNameStlTris[$en] += $stlStatMap[$lower].triangles
      }
    }
  }
}

Write-Host "---- STL size/triangles per entityName ----"
$entityNameStlSizes.Keys | Sort-Object | ForEach-Object {
  $en = $_
  $sizes = $entityNameStlSizes[$en]
  $tris = $entityNameStlTris[$en]
  if ($sizes.Count -gt 0) {
    $szAvg = ($sizes | Measure-Object -Average).Average
    $szMax = ($sizes | Measure-Object -Maximum).Maximum
    $trAvg = ($tris | Measure-Object -Average).Average
    $trMax = ($tris | Measure-Object -Maximum).Maximum
    Write-Host ("  {0}: stlRefs={1}, size avg={2:F0} KB max={3:F0} KB, tri avg={4:F0} max={5}" -f $en, $sizes.Count, ($szAvg/1024), ($szMax/1024), $trAvg, $trMax)
  }
}
Write-Host ""

Write-Host "=== Analysis complete ==="
