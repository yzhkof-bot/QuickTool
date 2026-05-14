#Requires -Version 5.0
<#
.SYNOPSIS  QtsVFS Package Analyzer
.DESCRIPTION
  Analyze QtsVFS package directory. Two modes:
  - Fast scan (default): uses --debugdump, finishes in seconds
  - Detailed (-DetailedAnalysis): exports files and detects types via magic bytes
.EXAMPLE
  .\Analyze-QtsPackage.ps1 -PackageDir "C:\...\builtin" -QtsToolPath "E:\...\QtsTool.exe"
.EXAMPLE
  .\Analyze-QtsPackage.ps1 -PackageDir "C:\...\builtin" -TargetPackages "300100011500","300100011600" -DetailedAnalysis
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$PackageDir,

    [Parameter(Mandatory=$false)]
    [string]$QtsToolPath = '',

    [string]$OutputDir = '',

    [string[]]$TargetPackages = @(),

    [switch]$DetailedAnalysis,

    [switch]$ForceRebuildConfig,

    [switch]$SkipConfig
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# Default QtsTool path
if ([string]::IsNullOrWhiteSpace($QtsToolPath)) {
    $QtsToolPath = 'E:\wangzhe\Tools\SizeStatistics\bin\QtsTool2022\QtsTool.exe'
}

# ─────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────
function Log-Step { param($m); Write-Host "`n[STEP] $m" -ForegroundColor Cyan }
function Log-OK   { param($m); Write-Host "  [OK] $m"   -ForegroundColor Green }
function Log-Warn { param($m); Write-Host "  [!!] $m"   -ForegroundColor Yellow }
function Log-Err  { param($m); Write-Host "  [XX] $m"   -ForegroundColor Red }
function Log-Info { param($m); Write-Host "       $m" }

# ─────────────────────────────────────────────────────────────
# Detect file type via magic bytes
# ─────────────────────────────────────────────────────────────
function Get-FileType([byte[]]$b) {
    if ($b.Length -lt 4) { return 'Tiny(<4B)' }
    if ($b[0] -eq 0x41 -and $b[1] -eq 0x4B -and $b[2] -eq 0x50 -and $b[3] -eq 0x4B) { return 'AKPK(Wwise)' }
    if ($b[0] -eq 0x52 -and $b[1] -eq 0x49 -and $b[2] -eq 0x46 -and $b[3] -eq 0x46) { return 'RIFF(WAV/AVI)' }
    if ($b[0] -eq 0x4F -and $b[1] -eq 0x67 -and $b[2] -eq 0x67 -and $b[3] -eq 0x53) { return 'OGG(Audio)' }
    if ($b[0] -eq 0x89 -and $b[1] -eq 0x50 -and $b[2] -eq 0x4E -and $b[3] -eq 0x47) { return 'PNG' }
    if ($b[0] -eq 0xFF -and $b[1] -eq 0xD8)                                          { return 'JPEG' }
    if ($b[0] -eq 0x44 -and $b[1] -eq 0x44 -and $b[2] -eq 0x53 -and $b[3] -eq 0x20) { return 'DDS(Texture)' }
    if ($b[0] -eq 0xAB -and $b[1] -eq 0x4B -and $b[2] -eq 0x54 -and $b[3] -eq 0x58) { return 'KTX(Texture)' }
    if ($b.Length -ge 7) {
        $sig = [System.Text.Encoding]::ASCII.GetString($b[0..6])
        if ($sig -eq 'UnityFS') { return 'UnityFS(AB)' }
    }
    if ($b[0] -eq 0x00 -and $b[1] -eq 0x00) { return 'Unity-Serialized' }
    if ($b[0] -eq 0x6F)                       { return 'Unity-Asset(6F)' }
    if ($b[0] -eq 0xFC -and $b[1] -eq 0xFD)  { return 'Unity-Asset(FC)' }
    if ($b[0] -eq 0x50 -and $b[1] -eq 0x4B)  { return 'ZIP/PK' }
    if ($b[0] -eq 0x04 -and $b[1] -eq 0x22 -and $b[2] -eq 0x4D -and $b[3] -eq 0x18) { return 'LZ4Frame' }
    return 'Unknown'
}

# ─────────────────────────────────────────────────────────────
# Fast scan: parse --debugdump -n output
# ─────────────────────────────────────────────────────────────
function Get-PackageInfoFast([string]$pkgDir, [string]$pkgName, [string]$tool) {
    $dbPath = Join-Path $pkgDir "$pkgName.db"
    $empty  = [PSCustomObject]@{
        PackageName    = $pkgName
        CompatVersion  = 0
        FileCount      = 0
        TotalSizeBytes = 0
        SizeLt1KB      = 0
        Size1to10KB    = 0
        Size10to50KB   = 0
        Size50to200KB  = 0
        SizeGt200KB    = 0
        StorageCount   = 0
        IsPrebuild     = 0
        TypeStats      = @{}
        Error          = ''
    }
    if (-not (Test-Path $dbPath)) {
        $empty.Error = 'db not found'
        return $empty
    }

    $lines        = & $tool '--debugdump' '-n' $dbPath 2>&1
    $compatVer    = 0; $storageCount = 0; $isPrebuild = 0
    $fileCount    = 0; $totalBytes   = 0
    $sizeLt1      = 0; $size1to10    = 0; $size10to50 = 0
    $size50to200  = 0; $sizeGt200    = 0

    foreach ($line in $lines) {
        $l = "$line"
        if ($l -match '\[Header\]') {
            if ($l -match 'compatibilityVersion=(\d+)') { $compatVer    = [int]$matches[1] }
            if ($l -match 'storageCount_=(\d+)')        { $storageCount = [int]$matches[1] }
            if ($l -match 'isPrebuild_=(\d+)')          { $isPrebuild   = [int]$matches[1] }
        }
        if ($l -match '^\[F\]' -and $l -match 'size=(\d+)') {
            $sz = [long]$matches[1]
            $fileCount++
            $totalBytes += $sz
            $kb = $sz / 1024
            if      ($kb -lt 1)   { $sizeLt1++ }
            elseif  ($kb -lt 10)  { $size1to10++ }
            elseif  ($kb -lt 50)  { $size10to50++ }
            elseif  ($kb -lt 200) { $size50to200++ }
            else                  { $sizeGt200++ }
        }
    }

    return [PSCustomObject]@{
        PackageName    = $pkgName
        CompatVersion  = $compatVer
        FileCount      = $fileCount
        TotalSizeBytes = $totalBytes
        SizeLt1KB      = $sizeLt1
        Size1to10KB    = $size1to10
        Size10to50KB   = $size10to50
        Size50to200KB  = $size50to200
        SizeGt200KB    = $sizeGt200
        StorageCount   = $storageCount
        IsPrebuild     = $isPrebuild
        TypeStats      = @{}
        Error          = ''
    }
}

# ─────────────────────────────────────────────────────────────
# Detailed: classify exported files by magic bytes
# ─────────────────────────────────────────────────────────────
function Get-FileTypeStats([string]$exportDir) {
    $stat  = @{}
    $files = Get-ChildItem $exportDir -File -ErrorAction SilentlyContinue
    if (-not $files) { return $stat }
    foreach ($f in $files) {
        try   { $t = Get-FileType ([System.IO.File]::ReadAllBytes($f.FullName)) }
        catch { $t = 'ReadError' }
        if (-not $stat.ContainsKey($t)) { $stat[$t] = 0 }
        $stat[$t]++
    }
    return $stat
}

# ─────────────────────────────────────────────────────────────
# Generate QtsVFSPackage.txt
# ─────────────────────────────────────────────────────────────
function New-QtsPackageConfig([string]$pkgDir, [string]$tool) {
    $cfgPath = Join-Path $pkgDir 'QtsVFSPackage.txt'

    # Detect compatibility version from base package
    $baseDb    = Join-Path $pkgDir '0\0.db'
    $compatVer = 5
    $baseName  = '0'
    if (Test-Path $baseDb) {
        $out = & $tool '--debugdump' '-n' $baseDb 2>&1
        foreach ($l in $out) {
            if ("$l" -match 'compatibilityVersion=(\d+)') { $compatVer = [int]$matches[1] }
            if ("$l" -match '\[Header\] package=([^,]+),') { $baseName = $matches[1].Trim() }
        }
    }
    Log-Info "CompatVersion=$compatVer  BasePkg=$baseName"

    $subPatches = Get-ChildItem $pkgDir -Directory |
                  Where-Object { $_.Name -ne $baseName }  |
                  Sort-Object Name |
                  Select-Object -ExpandProperty Name
    $allPkgs = @($baseName) + $subPatches

    # Build JSON manually to avoid encoding issues
    $subJson = ($subPatches | ForEach-Object { "        `"$_`"" }) -join ",`n"
    $pkgJson = ($allPkgs    | ForEach-Object { "`"$_`"" }) -join ','

    if ($compatVer -ge 6) {
        $json = @"
{
    "compatibility_version": $compatVer,
    "system_name": "$baseName",
    "package_name": "$baseName",
    "internal_package_name": "$baseName",
    "all_in_one": false,
    "packages_count": $($allPkgs.Count),
    "package_names": [$pkgJson],
    "data_version": "0.0.0.0",
    "build_id": 0,
    "compression_type": 1,
    "has_extension_patch": false,
    "sub_patches_count": $($subPatches.Count),
    "sub_patches": [
$subJson
    ]
}
"@
    } else {
        $json = @"
{
    "compatibility_version": $compatVer,
    "package_name": "$baseName",
    "data_version": "0.0.0.0",
    "build_id": 0,
    "compression_type": 1,
    "has_extension_patch": false,
    "sub_patches_count": $($subPatches.Count),
    "sub_patches": [
$subJson
    ]
}
"@
    }

    $utf8nob = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($cfgPath, $json, $utf8nob)
    Log-OK "QtsVFSPackage.txt written -> $cfgPath"
}

# ─────────────────────────────────────────────────────────────
# Write Markdown report
# ─────────────────────────────────────────────────────────────
function Write-Report([string]$mdPath, [string]$csvPath, [array]$data, [bool]$det, [string]$pkgDir) {
    $sb  = [System.Text.StringBuilder]::new()
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $mode = if ($det) { 'Detailed (export + magic bytes)' } else { 'Fast scan (debugdump)' }

    [void]$sb.AppendLine('# QtsVFS Package Analysis Report')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine("- **Generated**: $now")
    [void]$sb.AppendLine("- **PackageDir**: ``$pkgDir``")
    [void]$sb.AppendLine("- **Mode**: $mode")
    [void]$sb.AppendLine()

    # Summary
    $tf  = ($data | Measure-Object FileCount      -Sum).Sum
    $tsb = ($data | Measure-Object TotalSizeBytes -Sum).Sum
    $tmb = [math]::Round($tsb / 1MB, 2)
    [void]$sb.AppendLine('## Summary')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| Item | Value |')
    [void]$sb.AppendLine('|------|-------|')
    [void]$sb.AppendLine("| Total packages | $($data.Count) |")
    [void]$sb.AppendLine("| Total files    | $tf |")
    [void]$sb.AppendLine("| Total size     | $tmb MB |")
    [void]$sb.AppendLine()

    # Top 10 largest
    [void]$sb.AppendLine('## Top 10 Largest Packages')
    [void]$sb.AppendLine()
    [void]$sb.AppendLine('| Package | Files | Size(MB) | <1KB | 1-10K | 10-50K | 50-200K | >200K |')
    [void]$sb.AppendLine('|---------|-------|----------|------|-------|--------|---------|-------|')
    $data | Sort-Object TotalSizeBytes -Descending | Select-Object -First 10 | ForEach-Object {
        $mb = [math]::Round($_.TotalSizeBytes/1MB, 2)
        [void]$sb.AppendLine("| $($_.PackageName) | $($_.FileCount) | $mb | $($_.SizeLt1KB) | $($_.Size1to10KB) | $($_.Size10to50KB) | $($_.Size50to200KB) | $($_.SizeGt200KB) |")
    }
    [void]$sb.AppendLine()

    # All packages
    [void]$sb.AppendLine('## All Packages')
    [void]$sb.AppendLine()
    if ($det) {
        [void]$sb.AppendLine('| Package | Files | Size(MB) | <1KB | 1-10K | 10-50K | 50-200K | >200K | Top File Types |')
        [void]$sb.AppendLine('|---------|-------|----------|------|-------|--------|---------|-------|----------------|')
        $data | Sort-Object PackageName | ForEach-Object {
            $mb  = [math]::Round($_.TotalSizeBytes/1MB, 2)
            $top = if ($_.TypeStats -and $_.TypeStats.Count -gt 0) {
                ($_.TypeStats.GetEnumerator() | Sort-Object Value -Descending |
                 Select-Object -First 3 | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join ', '
            } else { '-' }
            [void]$sb.AppendLine("| $($_.PackageName) | $($_.FileCount) | $mb | $($_.SizeLt1KB) | $($_.Size1to10KB) | $($_.Size10to50KB) | $($_.Size50to200KB) | $($_.SizeGt200KB) | $top |")
        }
    } else {
        [void]$sb.AppendLine('| Package | Files | Size(MB) | <1KB | 1-10K | 10-50K | 50-200K | >200K | CompatVer | Storages |')
        [void]$sb.AppendLine('|---------|-------|----------|------|-------|--------|---------|-------|-----------|---------|')
        $data | Sort-Object PackageName | ForEach-Object {
            $mb = [math]::Round($_.TotalSizeBytes/1MB, 2)
            [void]$sb.AppendLine("| $($_.PackageName) | $($_.FileCount) | $mb | $($_.SizeLt1KB) | $($_.Size1to10KB) | $($_.Size10to50KB) | $($_.Size50to200KB) | $($_.SizeGt200KB) | $($_.CompatVersion) | $($_.StorageCount) |")
        }
    }

    $utf8nob = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($mdPath, $sb.ToString(), $utf8nob)

    # CSV
    $csvRows = $data | Sort-Object PackageName | ForEach-Object {
        $typeStr = if ($det -and $_.TypeStats -and $_.TypeStats.Count -gt 0) {
            ($_.TypeStats.GetEnumerator() | Sort-Object Value -Descending |
             ForEach-Object { "$($_.Key):$($_.Value)" }) -join '; '
        } else { '' }
        [PSCustomObject]@{
            PackageName    = $_.PackageName
            FileCount      = $_.FileCount
            TotalSizeMB    = [math]::Round($_.TotalSizeBytes/1MB, 2)
            Lt1KB          = $_.SizeLt1KB
            S1to10KB       = $_.Size1to10KB
            S10to50KB      = $_.Size10to50KB
            S50to200KB     = $_.Size50to200KB
            Gt200KB        = $_.SizeGt200KB
            CompatVersion  = $_.CompatVersion
            StorageCount   = $_.StorageCount
            FileTypeStats  = $typeStr
        }
    }
    $csvRows | Export-Csv $csvPath -Encoding UTF8 -NoTypeInformation
}

# ─────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────
if (-not (Test-Path $PackageDir))  { Log-Err "PackageDir not found: $PackageDir"; exit 1 }
if (-not (Test-Path $QtsToolPath)) { Log-Err "QtsTool.exe not found: $QtsToolPath"; exit 1 }

$PackageDir = (Resolve-Path $PackageDir).Path

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $ts        = Get-Date -Format 'yyyyMMdd_HHmmss'
    $OutputDir = Join-Path (Split-Path $PackageDir -Parent) "QtsAnalysis_$ts"
}
New-Item -ItemType Directory -Force $OutputDir | Out-Null

$modeStr = if ($DetailedAnalysis) { 'Detailed (export+magic)' } else { 'Fast scan (debugdump)' }
Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  QtsVFS Package Analyzer' -ForegroundColor White
Write-Host "  PackageDir : $PackageDir" -ForegroundColor Gray
Write-Host "  Tool       : $QtsToolPath" -ForegroundColor Gray
Write-Host "  OutputDir  : $OutputDir" -ForegroundColor Gray
Write-Host "  Mode       : $modeStr" -ForegroundColor Yellow
Write-Host '========================================' -ForegroundColor Cyan

# ── Step 1: QtsVFSPackage.txt ────────────────────────────────
# Fast scan doesn't need QtsVFSPackage.txt at all (uses debugdump).
# Detailed mode needs a "builtin-only" config for export to work.
# Strategy: backup original → write builtin-only → export → restore original

$cfgPath     = Join-Path $PackageDir 'QtsVFSPackage.txt'
$cfgBackup   = Join-Path $PackageDir 'QtsVFSPackage_original.bak'
$builtinCfg  = Join-Path $PackageDir 'QtsVFSPackage_builtin.txt'
$originalContent = $null

if ($DetailedAnalysis) {
    # Backup current config (may be the real 1724-packages version)
    if (Test-Path $cfgPath) {
        $originalContent = Get-Content $cfgPath -Raw
        Copy-Item $cfgPath $cfgBackup -Force
        Log-Step "Original QtsVFSPackage.txt backed up -> $cfgBackup"
    }

    # Generate builtin-only config
    Log-Step 'Generating builtin-only QtsVFSPackage.txt for export...'
    New-QtsPackageConfig $PackageDir $QtsToolPath
    Copy-Item $cfgPath $builtinCfg -Force
    Log-Info "Builtin config also saved to: $builtinCfg"
} else {
    Log-Step 'Fast scan mode: skipping QtsVFSPackage.txt generation'
}

# ── Step 2: Determine target packages ────────────────────────
$allDirs = Get-ChildItem $PackageDir -Directory
if ($TargetPackages.Count -gt 0) {
    $targetDirs = @($allDirs | Where-Object { $TargetPackages -contains $_.Name })
    Log-Step "Targeting $($targetDirs.Count) specific packages: $($TargetPackages -join ', ')"
} else {
    $targetDirs = @($allDirs)
    Log-Step "Analyzing all $($targetDirs.Count) packages"
}

# ── Step 3: Analyze ──────────────────────────────────────────
$results = [System.Collections.ArrayList]::new()
$total   = $targetDirs.Count
$i       = 0

foreach ($dir in ($targetDirs | Sort-Object Name)) {
    $i++
    $pkgName = $dir.Name
    $pct     = if ($total -gt 0) { [math]::Round($i * 100 / $total) } else { 100 }
    Write-Progress -Activity 'Analyzing packages' -Status "$i/$total  $pkgName" -PercentComplete $pct

    $info = Get-PackageInfoFast $dir.FullName $pkgName $QtsToolPath

    if ($DetailedAnalysis -and $info.FileCount -gt 0) {
        $exportDir = Join-Path $OutputDir "exports\$pkgName"
        New-Item -ItemType Directory -Force $exportDir | Out-Null

        $exportOut = & $QtsToolPath '--export' $PackageDir $exportDir '-package' $pkgName '-y' 2>&1
        $ok = $exportOut | Where-Object { "$_" -match 'Successfully' }
        if ($ok) {
            $info.TypeStats = Get-FileTypeStats $exportDir
        } else {
            Log-Warn "Export may have failed for $pkgName"
        }
    }

    $mb      = [math]::Round($info.TotalSizeBytes/1MB, 2)
    $topType = if ($info.TypeStats.Count -gt 0) {
        ' [' + (($info.TypeStats.GetEnumerator() | Sort-Object Value -Descending |
                  Select-Object -First 1 | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join '') + ']'
    } else { '' }
    Write-Host ("  [{0,3}%] {1,-25}  {2,5} files  {3,7} MB{4}" -f $pct, $pkgName, $info.FileCount, $mb, $topType)

    [void]$results.Add($info)
}

Write-Progress -Activity 'Analyzing packages' -Completed

# ── Restore original QtsVFSPackage.txt ───────────────────────
if ($DetailedAnalysis -and $null -ne $originalContent) {
    $utf8nob = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($cfgPath, $originalContent, $utf8nob)
    if (Test-Path $cfgBackup) { Remove-Item $cfgBackup -Force }
    Log-OK "Original QtsVFSPackage.txt restored"
}

# ── Step 4: Reports ──────────────────────────────────────────
Log-Step 'Writing reports...'
$mdPath  = Join-Path $OutputDir 'report.md'
$csvPath = Join-Path $OutputDir 'report.csv'
Write-Report $mdPath $csvPath $results $DetailedAnalysis.IsPresent $PackageDir
Log-OK "Markdown : $mdPath"
Log-OK "CSV      : $csvPath"

# Console summary
$tf  = ($results | Measure-Object FileCount      -Sum).Sum
$tmb = [math]::Round(($results | Measure-Object TotalSizeBytes -Sum).Sum / 1MB, 2)

Write-Host ''
Write-Host '===== Analysis Complete =====' -ForegroundColor Green
Write-Host "  Packages : $($results.Count)"
Write-Host "  Files    : $tf"
Write-Host "  Total    : $tmb MB"
Write-Host "  Reports  : $OutputDir"
Write-Host ''
Write-Host 'Top 10 by size:' -ForegroundColor Yellow
$results | Sort-Object TotalSizeBytes -Descending | Select-Object -First 10 | ForEach-Object {
    $mb = [math]::Round($_.TotalSizeBytes/1MB, 2)
    Write-Host ('  {0,-25}  {1,5} files  {2,7} MB' -f $_.PackageName, $_.FileCount, $mb)
}
