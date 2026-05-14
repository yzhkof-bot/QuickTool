#Requires -Version 5.0
<#
.SYNOPSIS  OpenHarmony .har 包解包与内容探查工具

.DESCRIPTION
  OpenHarmony 的 .har 本质是 gzip 压缩的 tar 包（magic: 1F 8B 08 00）。
  此脚本用 Windows 自带的 tar（bsdtar）把一个或一批 .har 解包到目录，
  并可额外：
    - 打印每个 har 的顶层结构、oh-package.json5 关键字段（name/version/
      dependencies/runtimeOnly）、Index.d.ets 的导出列表
    - 在解出的文本/二进制文件（modules.abc 等）里按关键字搜索，帮你快速
      确认一个符号（类名、桥接方法名）到底落在哪个 har

.PARAMETER Path
  必填。可以是：
    1) 单个 .har 文件路径
    2) 包含 .har 的目录（会遍历该目录下所有 *.har）

.PARAMETER OutputDir
  可选。解包输出目录。
    - 指定目录：每个 har 解包到  <OutputDir>\<harBaseName>\
    - 不指定  ：解包到          <har同目录>\<harBaseName>_extracted\

.PARAMETER Summary
  可选开关。解完后额外打印摘要：
    - 顶层目录/文件列表（前若干项）
    - oh-package.json5 的 name / version / dependencies / runtimeOnly
    - Index.d.ets 的 export 语句

.PARAMETER SearchText
  可选。一个或多个要搜索的关键字。会在解出来的所有文件里按 ASCII 可打印
  字符串方式扫描（能覆盖 modules.abc 这类方舟字节码里的标识符），输出命
  中该关键字的文件及命中次数。非常适合追踪 "BoxOpenCommSendToUIThread"
  这种桥接方法位于哪个 har。

.PARAMETER Force
  输出目录已存在时先清空再解包。默认保留已有内容，tar 覆盖文件。

.PARAMETER NoExtract
  只读模式：不解包，只在已有的 OutputDir（或约定目录）上做 -Summary /
  -SearchText。通常用于二次查询，免得重复解包。

.EXAMPLE
  # 解包单个 har
  .\Extract-HarPackage.ps1 -Path 'E:\sdkmini\Project\Assets\Plugins\OpenHarmony\lib\boxsdk.har'

.EXAMPLE
  # 批量解包并打印摘要
  .\Extract-HarPackage.ps1 -Path 'E:\sdkmini\Project\Assets\Plugins\OpenHarmony\lib' `
                           -OutputDir 'D:\har_probe' -Summary

.EXAMPLE
  # 追踪桥接方法落在哪个 har
  .\Extract-HarPackage.ps1 -Path 'E:\sdkmini\Project\Assets\Plugins\OpenHarmony\lib' `
                           -OutputDir 'D:\har_probe' `
                           -SearchText 'BoxOpenCommSendToUIThread','BoxSdkManager','openCommunityUrl'
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,

    [string]$OutputDir = '',

    [switch]$Summary,

    [string[]]$SearchText = @(),

    [switch]$Force,

    [switch]$NoExtract
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# ─────────────────────────────────────────────────────────────
# Logging helpers
# ─────────────────────────────────────────────────────────────
function Log-Step { param($m) Write-Host "`n[STEP] $m" -ForegroundColor Cyan }
function Log-OK   { param($m) Write-Host "  [OK] $m"   -ForegroundColor Green }
function Log-Warn { param($m) Write-Host "  [!!] $m"   -ForegroundColor Yellow }
function Log-Err  { param($m) Write-Host "  [XX] $m"   -ForegroundColor Red }
function Log-Info { param($m) Write-Host "       $m" }

# ─────────────────────────────────────────────────────────────
# Check prerequisites
# ─────────────────────────────────────────────────────────────
function Test-TarAvailable {
    try {
        $null = & tar --version 2>&1
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

# ─────────────────────────────────────────────────────────────
# Verify it's a gzip-tar (.har magic: 1F 8B 08 00)
# ─────────────────────────────────────────────────────────────
function Test-HarGzipMagic {
    param([string]$File)

    try {
        $fs = [System.IO.File]::Open($File, 'Open', 'Read', 'Read')
        try {
            $buf = New-Object byte[] 4
            $n = $fs.Read($buf, 0, 4)
            if ($n -lt 4) { return $false }
            return ($buf[0] -eq 0x1F -and $buf[1] -eq 0x8B -and $buf[2] -eq 0x08)
        }
        finally {
            $fs.Close()
        }
    }
    catch {
        return $false
    }
}

# ─────────────────────────────────────────────────────────────
# Extract a single .har
# ─────────────────────────────────────────────────────────────
function Expand-HarFile {
    param(
        [string]$HarFile,
        [string]$DestDir,
        [switch]$Force
    )

    if ($Force -and (Test-Path $DestDir)) {
        Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $DestDir | Out-Null

    if (-not (Test-HarGzipMagic -File $HarFile)) {
        Log-Warn "Not a gzip-tar (skipped): $HarFile"
        return $false
    }

    # bsdtar on Windows 10+ accepts -xzf
    $out = & tar -xzf $HarFile -C $DestDir 2>&1
    if ($LASTEXITCODE -ne 0) {
        Log-Err "tar failed ($LASTEXITCODE) for $HarFile"
        if ($out) { Log-Info ($out -join "`n       ") }
        return $false
    }
    return $true
}

# ─────────────────────────────────────────────────────────────
# Print a brief structural summary of an extracted har
# ─────────────────────────────────────────────────────────────
function Show-HarSummary {
    param([string]$ExtractedDir, [string]$HarName)

    Write-Host ''
    Write-Host "--- Summary: $HarName ---" -ForegroundColor Magenta

    # Most DevEco-built .har put everything under "package/"
    $root = $ExtractedDir
    $pkgSub = Join-Path $ExtractedDir 'package'
    if (Test-Path $pkgSub) { $root = $pkgSub }

    # 1) Top-level contents
    Write-Host "Top-level of $root :" -ForegroundColor Gray
    Get-ChildItem $root -Force -ErrorAction SilentlyContinue |
        Select-Object -First 30 |
        ForEach-Object {
            $size = if ($_.PSIsContainer) { '<DIR>' } else { [string]$_.Length }
            '  {0,-12}  {1}' -f $size, $_.Name
        }

    # 2) oh-package.json5 key fields
    $pkgJson = Join-Path $root 'oh-package.json5'
    if (Test-Path $pkgJson) {
        Write-Host "`noh-package.json5 (key fields):" -ForegroundColor Gray
        $raw = Get-Content $pkgJson -Raw -ErrorAction SilentlyContinue
        if ($raw) {
            foreach ($key in @('name', 'version', 'dependencies', 'runtimeOnly', 'nativeComponents', 'types')) {
                if ($raw -match ('"{0}"\s*:\s*(.+?)(?=(,\s*"[a-zA-Z_]+"\s*:|\s*\}}))' -f [regex]::Escape($key))) {
                    $val = $matches[1].Trim().TrimEnd(',').Trim()
                    if ($val.Length -gt 300) { $val = $val.Substring(0, 300) + '...' }
                    '  {0,-18} = {1}' -f $key, $val
                }
            }
        }
    }

    # 3) Index.d.ets exports
    $indexFile = Join-Path $root 'Index.d.ets'
    if (Test-Path $indexFile) {
        Write-Host "`nIndex.d.ets exports:" -ForegroundColor Gray
        Get-Content $indexFile | Where-Object { $_ -match '^\s*export' } |
            ForEach-Object { '  ' + $_.Trim() }
    }
}

# ─────────────────────────────────────────────────────────────
# Extract ASCII printable runs and count keyword hits
# (Works for modules.abc / any binary)
# ─────────────────────────────────────────────────────────────
function Measure-KeywordsInFile {
    param(
        [string]$FilePath,
        [string[]]$Keywords,
        [int]$MinRun = 4
    )

    $result = @{}
    foreach ($k in $Keywords) { $result[$k] = 0 }

    if (-not (Test-Path $FilePath)) { return $result }
    if ((Get-Item $FilePath).Length -eq 0) { return $result }

    try {
        $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    }
    catch {
        return $result
    }

    $sb = [System.Text.StringBuilder]::new(256)
    $flush = {
        if ($sb.Length -ge $MinRun) {
            $s = $sb.ToString()
            foreach ($k in $Keywords) {
                if ($s.Contains($k)) { $result[$k]++ }
            }
        }
        [void]$sb.Clear()
    }

    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $b = $bytes[$i]
        if ($b -ge 0x20 -and $b -lt 0x7F) {
            [void]$sb.Append([char]$b)
        }
        else {
            & $flush
        }
    }
    & $flush

    return $result
}

# ─────────────────────────────────────────────────────────────
# Walk an extracted directory and search keywords
# ─────────────────────────────────────────────────────────────
function Search-KeywordsInExtracted {
    param(
        [string]$ExtractedDir,
        [string[]]$Keywords
    )

    Write-Host ''
    Write-Host "Searching $($Keywords.Count) keyword(s) in $ExtractedDir ..." -ForegroundColor Magenta

    $files = Get-ChildItem $ExtractedDir -Recurse -File -ErrorAction SilentlyContinue
    if (-not $files) {
        Log-Warn "No files under $ExtractedDir"
        return
    }

    $perKwTotal = @{}
    foreach ($k in $Keywords) { $perKwTotal[$k] = 0 }

    $hitFiles = [System.Collections.ArrayList]::new()
    $idx = 0
    $total = $files.Count

    foreach ($f in $files) {
        $idx++
        if ($total -gt 0 -and ($idx % 25 -eq 0)) {
            Write-Progress -Activity 'Searching' -Status "$idx/$total" `
                -PercentComplete ([math]::Min(100, $idx * 100 / $total))
        }

        # Skip huge files to keep it snappy
        if ($f.Length -gt 200MB) { continue }

        $r = Measure-KeywordsInFile -FilePath $f.FullName -Keywords $Keywords
        $anyHit = $false
        foreach ($k in $Keywords) {
            if ($r[$k] -gt 0) {
                $anyHit = $true
                $perKwTotal[$k] += $r[$k]
            }
        }
        if ($anyHit) {
            [void]$hitFiles.Add([PSCustomObject]@{
                File = $f.FullName
                Hits = $r
            })
        }
    }
    Write-Progress -Activity 'Searching' -Completed

    Write-Host ''
    Write-Host 'Keyword totals:' -ForegroundColor Yellow
    foreach ($k in $Keywords) {
        '  {0,-35} : {1}' -f $k, $perKwTotal[$k]
    }

    if ($hitFiles.Count -gt 0) {
        Write-Host ''
        Write-Host 'Hit files:' -ForegroundColor Yellow
        foreach ($hf in $hitFiles) {
            $parts = foreach ($k in $Keywords) {
                if ($hf.Hits[$k] -gt 0) { "$k x$($hf.Hits[$k])" }
            }
            '  {0}' -f $hf.File
            '      [{0}]' -f ($parts -join ', ')
        }
    }
    else {
        Log-Info 'No files matched any keyword.'
    }
}

# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  OpenHarmony .har Extractor / Inspector' -ForegroundColor White
Write-Host '========================================' -ForegroundColor Cyan

if (-not (Test-Path $Path)) { Log-Err "Path not found: $Path"; exit 1 }

if (-not (Test-TarAvailable)) {
    Log-Err 'tar.exe not found. Requires Windows 10 1803+ built-in bsdtar.'
    exit 1
}

# Collect target har files
$harFiles = @()
$item = Get-Item $Path
if ($item.PSIsContainer) {
    $harFiles = @(Get-ChildItem $Path -Filter '*.har' -File -ErrorAction SilentlyContinue)
    if ($harFiles.Count -eq 0) {
        Log-Err "No .har files in directory: $Path"
        exit 1
    }
    Log-Info "Found $($harFiles.Count) .har file(s) in directory."
}
else {
    if ($item.Extension -ne '.har') {
        Log-Warn "File does not have .har extension: $Path (continuing anyway)"
    }
    $harFiles = @($item)
}

# Decide output root
$outputRootProvided = -not [string]::IsNullOrWhiteSpace($OutputDir)
if ($outputRootProvided) {
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $OutputDir = (Resolve-Path $OutputDir).Path
}

$summaries = [System.Collections.ArrayList]::new()

foreach ($har in $harFiles) {
    $harPath = $har.FullName
    $baseName = [System.IO.Path]::GetFileNameWithoutExtension($harPath)

    if ($outputRootProvided) {
        $destDir = Join-Path $OutputDir $baseName
    }
    else {
        $destDir = Join-Path $har.DirectoryName ("{0}_extracted" -f $baseName)
    }

    if ($NoExtract) {
        if (-not (Test-Path $destDir)) {
            Log-Warn "-NoExtract set but no existing dir: $destDir (skip)"
            continue
        }
        Log-Step "Skipping extract (using existing): $destDir"
    }
    else {
        Log-Step "Extracting $harPath"
        Log-Info "Dest: $destDir"
        $ok = Expand-HarFile -HarFile $harPath -DestDir $destDir -Force:$Force
        if (-not $ok) { continue }
        Log-OK "Extracted -> $destDir"
    }

    if ($Summary) {
        Show-HarSummary -ExtractedDir $destDir -HarName $baseName
    }

    [void]$summaries.Add([PSCustomObject]@{
        Har     = $harPath
        DestDir = $destDir
    })
}

# Search after all extractions so we can aggregate across hars
# Tolerate "a,b,c" passed as a single string (common when invoked from cmd.exe
# or QuickTool where PowerShell array syntax isn't always preserved).
$effectiveSearch = @()
foreach ($kw in $SearchText) {
    if ($kw -match ',') {
        $effectiveSearch += ($kw -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    else {
        $effectiveSearch += $kw
    }
}

if ($effectiveSearch.Count -gt 0 -and $summaries.Count -gt 0) {
    foreach ($s in $summaries) {
        Search-KeywordsInExtracted -ExtractedDir $s.DestDir -Keywords $effectiveSearch
    }
}

Write-Host ''
Write-Host '===== Done =====' -ForegroundColor Green
Write-Host ("  Processed : {0} har file(s)" -f $summaries.Count)
foreach ($s in $summaries) {
    '    {0}  ->  {1}' -f (Split-Path $s.Har -Leaf), $s.DestDir
}
Write-Host ''
