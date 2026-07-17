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

function Remove-VerifiedOutputDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $candidate = [System.IO.Path]::GetFullPath($Path)
    if (-not $candidate.StartsWith($outputRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to manage a path outside the output directory: $candidate"
    }
    if (-not (Test-Path -LiteralPath $candidate)) {
        return
    }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to recursively remove a reparse point: $candidate"
    }
    Remove-Item -LiteralPath $candidate -Recurse -Force
}

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
$runId = [Guid]::NewGuid().ToString('N')
$setupRoot = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".setup-stage-$Version-$runId"))
$companionStage = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".bridge-control-stage-$Version-$runId"))
$archiveStage = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".source-stage-$Version-$runId.zip"))
$verificationRoot = [System.IO.Path]::GetFullPath((Join-Path $outputRoot ".setup-verification-$Version-$runId"))

try {
foreach ($candidate in @($setupRoot, $companionStage, $verificationRoot)) {
    Remove-VerifiedOutputDirectory -Path $candidate
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
    throw "Refusing to overwrite an existing release artifact: $setupZip"
}

$companionFiles = @('main.js', 'manifest.json', 'styles.css')
[System.IO.Directory]::CreateDirectory($companionStage) | Out-Null
foreach ($file in $companionFiles) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "companion/obsidian-bridge-control/$file") -Destination (Join-Path $companionStage $file)
}
$companionZip = Join-Path $outputRoot "Bridge-Control-$Version-Obsidian.zip"
if (Test-Path -LiteralPath $companionZip) {
    throw "Refusing to overwrite an existing release artifact: $companionZip"
}
$rawAssetDirectory = [System.IO.Path]::GetFullPath((Join-Path $outputRoot "Bridge-Control-$Version-assets"))
if (Test-Path -LiteralPath $rawAssetDirectory) {
    throw "Refusing to overwrite an existing release asset directory: $rawAssetDirectory"
}
$rawReleaseAssets = @($companionFiles | ForEach-Object { Join-Path $rawAssetDirectory $_ })
$hashPath = Join-Path $outputRoot "SHA256-$Version.txt"
if (Test-Path -LiteralPath $hashPath) {
    throw "Refusing to overwrite an existing release artifact: $hashPath"
}

$releaseVerified = $false
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($setupRoot, $setupZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    [System.IO.Compression.ZipFile]::CreateFromDirectory($companionStage, $companionZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    Remove-VerifiedOutputDirectory -Path $companionStage

    $requiredSetupEntries = @(
        'INSTALLA-OBSIDIAN-BRIDGE.cmd',
        '.agents/plugins/marketplace.json',
        'plugins/obsidian-bridge/installer/Install-ObsidianBridge.ps1',
        'plugins/obsidian-bridge/.codex-plugin/plugin.json',
        'plugins/obsidian-bridge/.mcp.json',
        'plugins/obsidian-bridge/dist/server.mjs',
        'plugins/obsidian-bridge/skills/use-obsidian-vault/SKILL.md',
        'plugins/obsidian-bridge/companion/obsidian-bridge-control/main.js',
        'plugins/obsidian-bridge/companion/obsidian-bridge-control/manifest.json',
        'plugins/obsidian-bridge/companion/obsidian-bridge-control/styles.css'
    )
    $archive = [System.IO.Compression.ZipFile]::OpenRead($setupZip)
    try {
        $entryNames = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($requiredEntry in $requiredSetupEntries) {
            if ($entryNames -notcontains $requiredEntry) {
                throw "Setup archive verification failed; missing entry: $requiredEntry"
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    Expand-Archive -LiteralPath $setupZip -DestinationPath $verificationRoot -Force
    $verifiedInstaller = Join-Path $verificationRoot 'plugins/obsidian-bridge/installer/Install-ObsidianBridge.ps1'
    $selfTestOutput = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $verifiedInstaller -SelfTest
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged installer self-test failed with exit code $LASTEXITCODE"
    }
    $selfTestReport = ($selfTestOutput -join [Environment]::NewLine) | ConvertFrom-Json
    if (-not [bool]$selfTestReport.selfTest) {
        throw 'Packaged installer self-test did not return the expected report.'
    }

    $previousAppData = $env:APPDATA
    $previousLocalAppData = $env:LOCALAPPDATA
    try {
        $env:APPDATA = Join-Path $verificationRoot 'isolated-app-data'
        $env:LOCALAPPDATA = Join-Path $verificationRoot 'isolated-local-app-data'
        [System.IO.Directory]::CreateDirectory($env:APPDATA) | Out-Null
        [System.IO.Directory]::CreateDirectory($env:LOCALAPPDATA) | Out-Null

        $uiSmokeOutput = & powershell.exe -Sta -NoLogo -NoProfile -ExecutionPolicy Bypass -File $verifiedInstaller -UiSmokeTest
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged WPF UI smoke test failed with exit code $LASTEXITCODE"
        }
        $uiSmokeReport = ($uiSmokeOutput -join [Environment]::NewLine) | ConvertFrom-Json
        if (-not [bool]$uiSmokeReport.uiSmokeTest -or
            [string]$uiSmokeReport.renderEngine -ne 'WPF' -or
            -not [bool]$uiSmokeReport.layout.headerContainsSubtitle -or
            -not [bool]$uiSmokeReport.layout.mainScrollReachable -or
            -not [bool]$uiSmokeReport.layout.completionReachable) {
            throw 'Packaged WPF UI smoke test did not verify the adaptive layout.'
        }

        $marketplaceOutput = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $verifiedInstaller -MarketplaceSelfTest
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged marketplace self-test failed with exit code $LASTEXITCODE"
        }
        $marketplaceReport = ($marketplaceOutput -join [Environment]::NewLine) | ConvertFrom-Json
        if (-not [bool]$marketplaceReport.relationshipVerified -or [string]$marketplaceReport.sourceType -ne 'local') {
            throw 'Packaged marketplace self-test did not verify the generated local relationship.'
        }
    }
    finally {
        $env:APPDATA = $previousAppData
        $env:LOCALAPPDATA = $previousLocalAppData
    }

    [System.IO.Directory]::CreateDirectory($rawAssetDirectory) | Out-Null
    foreach ($file in $companionFiles) {
        Copy-Item -LiteralPath (Join-Path $repoRoot "companion/obsidian-bridge-control/$file") -Destination (Join-Path $rawAssetDirectory $file)
    }
    $hashLines = foreach ($file in @($setupZip, $companionZip) + $rawReleaseAssets) {
        $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $([System.IO.Path]::GetFileName($file))"
    }
    $hashLines | Set-Content -LiteralPath $hashPath -Encoding ASCII
    $releaseVerified = $true
}
finally {
    Remove-VerifiedOutputDirectory -Path $verificationRoot
    Remove-VerifiedOutputDirectory -Path $companionStage
    Remove-VerifiedOutputDirectory -Path $setupRoot
    if (-not $releaseVerified) {
        foreach ($failedArtifact in @($setupZip, $companionZip, $hashPath) + $rawReleaseAssets) {
            if (Test-Path -LiteralPath $failedArtifact -PathType Leaf) {
                Remove-Item -LiteralPath $failedArtifact -Force
            }
        }
        Remove-VerifiedOutputDirectory -Path $rawAssetDirectory
    }
}

Write-Host "Created:"
Write-Host "  $setupZip"
Write-Host "  $companionZip"
foreach ($rawAsset in $rawReleaseAssets) {
    Write-Host "  $rawAsset"
}
Write-Host "  $hashPath"
}
finally {
    foreach ($temporaryDirectory in @($verificationRoot, $companionStage, $setupRoot)) {
        Remove-VerifiedOutputDirectory -Path $temporaryDirectory
    }
    if (Test-Path -LiteralPath $archiveStage -PathType Leaf) {
        Remove-Item -LiteralPath $archiveStage -Force
    }
}
