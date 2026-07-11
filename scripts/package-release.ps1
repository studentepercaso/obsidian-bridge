[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutputDirectory,
    [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $repoRoot 'release'
}
$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)

$packageJson = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'package.json') | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = [string]$packageJson.version
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') {
    throw "Version must use strict x.y.z syntax: $Version"
}

$pluginManifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot '.codex-plugin/plugin.json') | ConvertFrom-Json
$companionManifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'companion/obsidian-bridge-control/manifest.json') | ConvertFrom-Json
$pluginBaseVersion = ([string]$pluginManifest.version -split '\+codex\.', 2)[0]
if ([string]$packageJson.version -ne $Version -or
    $pluginBaseVersion -ne $Version -or
    [string]$companionManifest.version -ne $Version) {
    throw "Version mismatch: package=$($packageJson.version), plugin=$($pluginManifest.version), companion=$($companionManifest.version), requested=$Version"
}

if (-not $SkipChecks) {
    & npm run check:all
    if ($LASTEXITCODE -ne 0) {
        throw "npm run check:all failed with exit code $LASTEXITCODE"
    }
}

$status = & git -C $repoRoot status --porcelain
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect the Git working tree.'
}
if ($status) {
    throw 'Release packaging requires a clean Git working tree. Commit the validated build first.'
}

[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$setupName = "Obsidian-Bridge-Setup-$Version"
$setupRoot = [System.IO.Path]::GetFullPath((Join-Path $outputRoot $setupName))
$companionStage = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".bridge-control-stage-$Version"))
$archiveStage = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".source-stage-$Version.zip"))

foreach ($candidate in @($setupRoot, $companionStage)) {
    if (-not $candidate.StartsWith($outputRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to manage a path outside the output directory: $candidate"
    }
    if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
}
if (Test-Path -LiteralPath $archiveStage) {
    Remove-Item -LiteralPath $archiveStage -Force
}

$pluginRoot = Join-Path $setupRoot 'plugins/obsidian-bridge'
$marketplaceDir = Join-Path $setupRoot '.agents/plugins'
[System.IO.Directory]::CreateDirectory($pluginRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($marketplaceDir) | Out-Null

& git -C $repoRoot archive --format=zip --output=$archiveStage HEAD
if ($LASTEXITCODE -ne 0) {
    throw "git archive failed with exit code $LASTEXITCODE"
}
Expand-Archive -LiteralPath $archiveStage -DestinationPath $pluginRoot -Force
Remove-Item -LiteralPath $archiveStage -Force

foreach ($relative in @('.agents', '.github')) {
    $nested = [System.IO.Path]::GetFullPath((Join-Path $pluginRoot $relative))
    if ($nested.StartsWith($pluginRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $nested)) {
        Remove-Item -LiteralPath $nested -Recurse -Force
    }
}

$marketplace = [ordered]@{
    name = 'obsidian-bridge-preview'
    interface = [ordered]@{
        displayName = 'Obsidian Bridge Preview'
    }
    plugins = @(
        [ordered]@{
            name = 'obsidian-bridge'
            source = [ordered]@{
                source = 'local'
                path = './plugins/obsidian-bridge'
            }
            policy = [ordered]@{
                installation = 'AVAILABLE'
                authentication = 'ON_INSTALL'
            }
            category = 'Productivity'
        }
    )
}
$marketplaceJson = $marketplace | ConvertTo-Json -Depth 8
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    (Join-Path $marketplaceDir 'marketplace.json'),
    $marketplaceJson + [Environment]::NewLine,
    $utf8WithoutBom
)

Copy-Item -LiteralPath (Join-Path $pluginRoot 'INSTALLA-OBSIDIAN-BRIDGE.cmd') -Destination (Join-Path $setupRoot 'INSTALLA-OBSIDIAN-BRIDGE.cmd')
Copy-Item -LiteralPath (Join-Path $pluginRoot 'installer/README-INSTALLER.txt') -Destination (Join-Path $setupRoot 'LEGGIMI-PRIMA.txt')
Copy-Item -LiteralPath (Join-Path $pluginRoot 'installer/README-INSTALLER.en.txt') -Destination (Join-Path $setupRoot 'READ-ME-FIRST.txt')

$setupZip = Join-Path $outputRoot "$setupName.zip"
if (Test-Path -LiteralPath $setupZip) {
    Remove-Item -LiteralPath $setupZip -Force
}

[System.IO.Directory]::CreateDirectory($companionStage) | Out-Null
foreach ($file in @('main.js', 'manifest.json', 'styles.css')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "companion/obsidian-bridge-control/$file") -Destination (Join-Path $companionStage $file)
}
$companionZip = Join-Path $outputRoot "Bridge-Control-$Version-Obsidian.zip"
if (Test-Path -LiteralPath $companionZip) {
    Remove-Item -LiteralPath $companionZip -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($setupRoot, $setupZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
[System.IO.Compression.ZipFile]::CreateFromDirectory($companionStage, $companionZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Remove-Item -LiteralPath $companionStage -Recurse -Force

$hashPath = Join-Path $outputRoot "SHA256-$Version.txt"
$hashLines = foreach ($file in @($setupZip, $companionZip)) {
    $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([System.IO.Path]::GetFileName($file))"
}
$hashLines | Set-Content -LiteralPath $hashPath -Encoding ASCII

Write-Host "Created:"
Write-Host "  $setupZip"
Write-Host "  $companionZip"
Write-Host "  $hashPath"
