[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SelfTest,
    [string]$VaultPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:BridgePluginId = 'bridge-control'
$script:CodexPluginId = 'obsidian-bridge'
$script:ExpectedCodexPluginVersion = '0.5.5'
$script:BridgePluginRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:PayloadRoot = Join-Path $script:BridgePluginRoot 'companion\obsidian-bridge-control'
$localApplicationData = if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $env:LOCALAPPDATA.Trim()
} else {
    [Environment]::GetFolderPath('LocalApplicationData')
}
$script:BridgeAppDataRoot = Join-Path $localApplicationData 'ObsidianBridge'
$sharedSettingsOverride = [string]$env:OBSIDIAN_BRIDGE_SETTINGS_PATH
if (-not [string]::IsNullOrWhiteSpace($sharedSettingsOverride)) {
    $sharedSettingsOverride = $sharedSettingsOverride.Trim()
    if (-not [System.IO.Path]::IsPathRooted($sharedSettingsOverride) -or $sharedSettingsOverride -match '[\x00-\x1f\x7f]') {
        throw 'OBSIDIAN_BRIDGE_SETTINGS_PATH deve essere un percorso assoluto valido.'
    }
    $script:SharedSettingsPath = [System.IO.Path]::GetFullPath($sharedSettingsOverride)
}
else {
    $script:SharedSettingsPath = Join-Path $script:BridgeAppDataRoot 'settings.json'
}
$script:StableMarketplaceRoot = Join-Path $script:BridgeAppDataRoot 'codex-marketplace'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:SharedSettingsMaxBytes = 64 * 1024
$script:VaultRegistryMaxBytes = 1024 * 1024
$script:SharedLockTimeoutMilliseconds = 5000
$script:VaultIdPattern = '^[0-9a-f]{16}$'
$script:ChangeIdPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

function Get-PropertyValue {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function ConvertTo-ExactValue {
    param($Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $result = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
        foreach ($property in $Value.PSObject.Properties) {
            $result.Add($property.Name, (ConvertTo-ExactValue -Value $property.Value))
        }
        return $result
    }

    if (($Value -is [System.Collections.IEnumerable]) -and -not ($Value -is [string])) {
        $items = New-Object System.Collections.ArrayList
        foreach ($item in $Value) {
            [void]$items.Add((ConvertTo-ExactValue -Value $item))
        }
        return ,([object[]]$items.ToArray())
    }

    return $Value
}

function Read-JsonExact {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description,
        [int64]$MaxBytes = 0
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $file = Get-Item -LiteralPath $Path -Force
    if (Test-PathIsReparsePoint -Path $Path) {
        throw "$Description non puo essere un collegamento, symlink o junction: $Path"
    }
    if ($MaxBytes -gt 0 -and $file.Length -gt $MaxBytes) {
        throw "$Description supera il limite consentito di $MaxBytes byte: $Path"
    }

    $raw = [System.IO.File]::ReadAllText($Path)
    if ($MaxBytes -gt 0 -and $script:Utf8NoBom.GetByteCount($raw) -gt $MaxBytes) {
        throw "$Description supera il limite consentito di $MaxBytes byte: $Path"
    }
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw "$Description e vuoto: $Path"
    }

    try {
        $parsed = $raw | ConvertFrom-Json
    }
    catch {
        throw "$Description contiene JSON non valido. Il file non verra sovrascritto: $Path`n$($_.Exception.Message)"
    }

    return ConvertTo-ExactValue -Value $parsed
}

function Write-TextAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }

    $operationId = [Guid]::NewGuid().ToString('N')
    $temporaryPath = Join-Path $directory ('.bridge-tmp-' + $operationId)
    $replacementBackupPath = Join-Path $directory ('.bridge-replace-backup-' + $operationId)
    try {
        [System.IO.File]::WriteAllText($temporaryPath, $Content, $script:Utf8NoBom)
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $Path, $replacementBackupPath)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $replacementBackupPath -PathType Leaf) {
            Remove-Item -LiteralPath $replacementBackupPath -Force
        }
    }
}

function Write-JsonAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 30
    Write-TextAtomically -Path $Path -Content ($json + [Environment]::NewLine)
}

function Write-SharedSettingsAtomically {
    param([Parameter(Mandatory = $true)]$Value)

    Assert-SharedSettingsSchema -Value $Value -Path $script:SharedSettingsPath
    $json = (ConvertTo-Json -InputObject $Value -Depth 30) + [Environment]::NewLine
    if ($script:Utf8NoBom.GetByteCount($json) -gt $script:SharedSettingsMaxBytes) {
        throw 'La configurazione condivisa risultante supera il limite di 64 KiB.'
    }
    Write-TextAtomically -Path $script:SharedSettingsPath -Content $json
}

function Copy-FileAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $directory = Split-Path -Parent $Destination
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
    }

    $operationId = [Guid]::NewGuid().ToString('N')
    $temporaryPath = Join-Path $directory ('.bridge-tmp-' + $operationId)
    $replacementBackupPath = Join-Path $directory ('.bridge-replace-backup-' + $operationId)
    try {
        [System.IO.File]::Copy($Source, $temporaryPath, $true)
        if (Test-Path -LiteralPath $Destination -PathType Leaf) {
            [System.IO.File]::Replace($temporaryPath, $Destination, $replacementBackupPath)
        }
        else {
            [System.IO.File]::Move($temporaryPath, $Destination)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force
        }
        if (Test-Path -LiteralPath $replacementBackupPath -PathType Leaf) {
            Remove-Item -LiteralPath $replacementBackupPath -Force
        }
    }
}

function Backup-File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Timestamp
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $backupPath = "$Path.backup.$Timestamp"
    if (Test-Path -LiteralPath $backupPath) {
        $backupPath = "$backupPath.$([Guid]::NewGuid().ToString('N'))"
    }
    [System.IO.File]::Copy($Path, $backupPath, $false)
    return $backupPath
}

function Get-OptionalFileHash {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-FileUnchanged {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowNull()][AllowEmptyString()][string]$ExpectedHash,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $currentHash = Get-OptionalFileHash -Path $Path
    if ([string]::IsNullOrEmpty($ExpectedHash)) {
        if ($null -ne $currentHash) {
            throw "$Description e stato creato da un altro processo durante l installazione. Riprova: $Path"
        }
        return
    }
    if ($null -eq $currentHash -or -not [string]::Equals($ExpectedHash, $currentHash, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description e cambiato durante l installazione e non verra sovrascritto. Riprova: $Path"
    }
}

function Test-PathIsReparsePoint {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        return $false
    }

    # OneDrive Files On-Demand usa reparse point cloud che non reindirizzano
    # il percorso e devono restare compatibili con i vault reali. PowerShell
    # espone invece LinkType/Target per symlink e junction che possono uscire
    # dal perimetro: soltanto questi sono considerati collegamenti pericolosi.
    $linkType = Get-PropertyValue -Object $item -Name 'LinkType'
    if (-not [string]::IsNullOrWhiteSpace([string]$linkType)) {
        return $true
    }
    $target = Get-PropertyValue -Object $item -Name 'Target'
    if ($target -is [string]) {
        return -not [string]::IsNullOrWhiteSpace($target)
    }
    if (($target -is [System.Collections.IEnumerable]) -and -not ($target -is [string])) {
        foreach ($entry in $target) {
            if (-not [string]::IsNullOrWhiteSpace([string]$entry)) {
                return $true
            }
        }
    }
    return $false
}

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $root
    }
    return $full.TrimEnd('\', '/')
}

function Assert-NoReparseAncestors {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$StopAt = ''
    )

    $candidate = Get-NormalizedFullPath -Path $Path
    $stop = $null
    if (-not [string]::IsNullOrWhiteSpace($StopAt)) {
        $stop = Get-NormalizedFullPath -Path $StopAt
        $prefix = $stop + [System.IO.Path]::DirectorySeparatorChar
        if (-not [string]::Equals($candidate, $stop, [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Il percorso esce dalla radice consentita: $candidate"
        }
    }

    $current = $candidate
    while (-not [string]::IsNullOrWhiteSpace($current)) {
        if ((Test-Path -LiteralPath $current) -and (Test-PathIsReparsePoint -Path $current)) {
            throw "Collegamento, junction o reparse point non consentito: $current"
        }
        if ($null -ne $stop -and [string]::Equals($current, $stop, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parent = [System.IO.Directory]::GetParent($current)
        if ($null -eq $parent -or [string]::Equals($parent.FullName, $current, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $current = Get-NormalizedFullPath -Path $parent.FullName
    }
}

function Assert-RegularFileOrMissing {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$StopAt = ''
    )

    Assert-NoReparseAncestors -Path $Path -StopAt $StopAt
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.PSIsContainer) {
            throw "Era atteso un file, ma il percorso e una cartella: $Path"
        }
    }
}

function New-SafeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ContainmentRoot,
        [AllowNull()][System.Collections.ArrayList]$OwnedDirectories
    )

    $root = Get-NormalizedFullPath -Path $ContainmentRoot
    $target = Get-NormalizedFullPath -Path $Path
    $prefix = $root + [System.IO.Path]::DirectorySeparatorChar
    if (-not [string]::Equals($target, $root, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "La cartella da creare esce dalla radice consentita: $target"
    }

    Assert-NoReparseAncestors -Path $target -StopAt $root
    if (Test-Path -LiteralPath $target) {
        if (-not (Test-Path -LiteralPath $target -PathType Container)) {
            throw "Il percorso esiste ma non e una cartella: $target"
        }
        return $target
    }

    $missing = New-Object System.Collections.ArrayList
    $cursor = $target
    while (-not (Test-Path -LiteralPath $cursor)) {
        [void]$missing.Add($cursor)
        $parent = [System.IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) {
            throw "Nessun antenato esistente per la cartella: $target"
        }
        $cursor = Get-NormalizedFullPath -Path $parent.FullName
    }
    Assert-NoReparseAncestors -Path $cursor

    for ($index = $missing.Count - 1; $index -ge 0; $index--) {
        $directory = [string]$missing[$index]
        $createdByUs = $false
        try {
            [void](New-Item -ItemType Directory -Path $directory)
            $createdByUs = $true
        }
        catch {
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
                throw
            }
        }
        if (Test-PathIsReparsePoint -Path $directory) {
            throw "La cartella appena creata e diventata un reparse point: $directory"
        }
        if ($createdByUs -and $null -ne $OwnedDirectories) {
            [void]$OwnedDirectories.Add($directory)
        }
    }

    Assert-NoReparseAncestors -Path $target -StopAt $root
    return $target
}

function Remove-OwnedEmptyDirectories {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$OwnedDirectories,
        [Parameter(Mandatory = $true)][string]$ContainmentRoot,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$RollbackProblems
    )

    for ($index = $OwnedDirectories.Count - 1; $index -ge 0; $index--) {
        $directory = [string]$OwnedDirectories[$index]
        try {
            Assert-NoReparseAncestors -Path $directory -StopAt $ContainmentRoot
            if ((Test-Path -LiteralPath $directory -PathType Container) -and
                @(Get-ChildItem -LiteralPath $directory -Force).Count -eq 0) {
                Remove-Item -LiteralPath $directory -Force
            }
        }
        catch {
            [void]$RollbackProblems.Add("cartella ${directory}: $($_.Exception.Message)")
        }
    }
}

function Assert-SafeOwnedDirectoryTree {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "La directory controllata non esiste: $Path"
    }
    if (Test-PathIsReparsePoint -Path $Path) {
        throw "La directory controllata e un reparse point: $Path"
    }
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force -Recurse) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Il contenuto della directory controllata include un reparse point: $($item.FullName)"
        }
    }
}

function Acquire-SharedSettingsLock {
    $settingsDirectory = Split-Path -Parent $script:SharedSettingsPath
    if ([string]::IsNullOrWhiteSpace($settingsDirectory)) {
        throw "Percorso impostazioni condivise non valido: $script:SharedSettingsPath"
    }
    $settingsDirectory = [System.IO.Path]::GetFullPath($settingsDirectory)
    if (-not (Test-Path -LiteralPath $settingsDirectory -PathType Container)) {
        $containmentRoot = [System.IO.Directory]::GetParent($settingsDirectory).FullName
        [void](New-SafeDirectory -Path $settingsDirectory -ContainmentRoot $containmentRoot -OwnedDirectories $null)
    }
    Assert-NoReparseAncestors -Path $settingsDirectory
    Assert-RegularFileOrMissing -Path $script:SharedSettingsPath -StopAt $settingsDirectory

    $lockPath = $script:SharedSettingsPath + '.lock'
    $token = [Guid]::NewGuid().ToString('N')
    $ownerPath = Join-Path $lockPath 'owner.json'
    $started = [Environment]::TickCount
    while (([Environment]::TickCount - $started) -lt $script:SharedLockTimeoutMilliseconds) {
        $owned = $false
        try {
            [void](New-Item -ItemType Directory -Path $lockPath)
            $owned = $true
            if (Test-PathIsReparsePoint -Path $lockPath) {
                throw 'Il lock appena creato e un reparse point.'
            }
            $owner = [ordered]@{
                token = $token
                pid = $PID
                createdAt = [DateTime]::UtcNow.ToString('o')
            }
            $ownerJson = ConvertTo-Json -InputObject $owner -Compress
            $stream = New-Object -TypeName System.IO.FileStream -ArgumentList @(
                $ownerPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            try {
                $bytes = $script:Utf8NoBom.GetBytes($ownerJson)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush($true)
            }
            finally {
                $stream.Dispose()
            }
            return [PSCustomObject]@{
                Path = $lockPath
                OwnerPath = $ownerPath
                Token = $token
            }
        }
        catch {
            if ($owned) {
                try {
                    Assert-SafeOwnedDirectoryTree -Path $lockPath
                    Remove-Item -LiteralPath $lockPath -Recurse -Force
                }
                catch {
                    # Non cancellare mai una directory che non riusciamo piu a riconoscere come nostra.
                }
                throw
            }
            if (Test-Path -LiteralPath $lockPath) {
                if (-not (Test-Path -LiteralPath $lockPath -PathType Container) -or (Test-PathIsReparsePoint -Path $lockPath)) {
                    throw "Il lock delle impostazioni non e una directory sicura: $lockPath"
                }
                Start-Sleep -Milliseconds 50
                continue
            }
            throw
        }
    }
    throw 'La configurazione e occupata da un altro processo. Chiudi il pannello Bridge Control e riprova tra qualche secondo.'
}

function Release-SharedSettingsLock {
    param([Parameter(Mandatory = $true)]$Lock)

    if (-not (Test-Path -LiteralPath $Lock.Path -PathType Container)) {
        return
    }
    Assert-SafeOwnedDirectoryTree -Path $Lock.Path
    $owner = Read-JsonExact -Path $Lock.OwnerPath -Description 'Il proprietario del lock' -MaxBytes 4096
    if (-not ($owner -is [System.Collections.Generic.Dictionary[string, object]]) -or
        -not $owner.ContainsKey('token') -or
        -not [string]::Equals([string]$owner['token'], [string]$Lock.Token, [System.StringComparison]::Ordinal)) {
        throw 'Il lock non appartiene piu a questo installatore e non verra rimosso.'
    }
    $releasePath = $Lock.Path + '.release-' + $Lock.Token
    if (Test-Path -LiteralPath $releasePath) {
        throw "Impossibile rilasciare il lock in sicurezza: esiste gia $releasePath"
    }
    Move-Item -LiteralPath $Lock.Path -Destination $releasePath
    Assert-SafeOwnedDirectoryTree -Path $releasePath
    Remove-Item -LiteralPath $releasePath -Recurse -Force
}

function Get-CanonicalVaultPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim())
    if ([string]::IsNullOrWhiteSpace($expanded)) {
        throw 'Seleziona una cartella vault.'
    }

    $fullPath = [System.IO.Path]::GetFullPath($expanded).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "La cartella vault non esiste: $fullPath"
    }

    Assert-NoReparseAncestors -Path $fullPath
    $fullPath = (Resolve-Path -LiteralPath $fullPath).ProviderPath.TrimEnd('\', '/')
    Assert-NoReparseAncestors -Path $fullPath

    $obsidianDirectory = Join-Path $fullPath '.obsidian'
    if (-not (Test-Path -LiteralPath $obsidianDirectory -PathType Container)) {
        throw "La cartella selezionata non contiene .obsidian e non sembra un vault: $fullPath"
    }
    Assert-NoReparseAncestors -Path $obsidianDirectory -StopAt $fullPath

    return $fullPath
}

function Get-VaultName {
    param([Parameter(Mandatory = $true)][string]$Path)

    $name = [System.IO.Path]::GetFileName($Path.TrimEnd('\', '/')).Trim().Normalize([Text.NormalizationForm]::FormC)
    if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -gt 256 -or $name -match '[\x00-\x1f\x7f]') {
        throw 'Il nome del vault non e valido.'
    }
    return $name
}

function Normalize-RelativeFolder {
    param(
        [AllowEmptyString()][string]$Folder,
        [switch]$AllowEmpty
    )

    $value = $Folder.Trim().Normalize([Text.NormalizationForm]::FormC).Replace('/', '\').Trim('\')
    if ([string]::IsNullOrWhiteSpace($value)) {
        if ($AllowEmpty) {
            return ''
        }
        throw 'La cartella di scrittura non puo essere vuota.'
    }

    if ([System.IO.Path]::IsPathRooted($value)) {
        throw "Usa un percorso relativo al vault, non un percorso assoluto: $value"
    }
    if ($value.Length -gt 1024 -or $value -match '[\x00-\x1f\x7f]') {
        throw 'La cartella supera il limite o contiene caratteri di controllo.'
    }

    $invalidCharacters = [System.IO.Path]::GetInvalidPathChars()
    foreach ($segment in $value.Split('\')) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw "Cartella non valida: $value"
        }
        if ($segment.StartsWith('.')) {
            throw "Le cartelle nascoste non sono consentite: $value"
        }
        if ($segment.IndexOfAny($invalidCharacters) -ge 0 -or $segment.Contains(':')) {
            throw "Cartella non valida: $value"
        }
    }

    return $value.Replace('\', '/')
}

function Get-SafeVaultChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Vault,
        [Parameter(Mandatory = $true)][string]$RelativeFolder
    )

    $candidate = [System.IO.Path]::GetFullPath((Join-Path $Vault $RelativeFolder.Replace('/', '\')))
    $prefix = $Vault.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "La cartella esce dal vault: $RelativeFolder"
    }
    Assert-NoReparseAncestors -Path $candidate -StopAt $Vault
    return $candidate
}

function Get-ObsidianRegistryPath {
    $applicationData = if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        $env:APPDATA.Trim()
    } else {
        [Environment]::GetFolderPath('ApplicationData')
    }
    return Join-Path $applicationData 'obsidian\obsidian.json'
}

function Read-ObsidianVaultRegistry {
    $path = Get-ObsidianRegistryPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Registro dei vault Obsidian non trovato: $path. Apri prima il vault in Obsidian."
    }
    Assert-RegularFileOrMissing -Path $path
    $item = Get-Item -LiteralPath $path -Force
    if ($item.Length -gt $script:VaultRegistryMaxBytes) {
        throw 'Il registro dei vault Obsidian supera il limite di 1 MiB.'
    }
    try {
        $configuration = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
    }
    catch {
        throw "Il registro dei vault Obsidian contiene JSON non valido: $path"
    }
    if ($null -eq $configuration -or $configuration -is [System.Array]) {
        throw "Il registro dei vault Obsidian non e un oggetto JSON: $path"
    }
    $vaults = Get-PropertyValue -Object $configuration -Name 'vaults'
    if ($null -eq $vaults -or $vaults -is [System.Array] -or $vaults -is [string]) {
        throw "Il registro dei vault Obsidian non contiene una sezione vaults valida: $path"
    }
    return $vaults
}

function Get-RegistryPathCandidates {
    param([Parameter(Mandatory = $true)][string]$RawPath)

    $candidates = New-Object System.Collections.ArrayList
    [void]$candidates.Add($RawPath)
    try {
        $decoded = [Uri]::UnescapeDataString($RawPath)
        if (-not [string]::Equals($RawPath, $decoded, [System.StringComparison]::Ordinal)) {
            [void]$candidates.Add($decoded)
        }
    }
    catch {
        # La forma letterale resta comunque disponibile.
    }
    return [string[]]$candidates.ToArray([string])
}

function Resolve-VaultIdentity {
    param([Parameter(Mandatory = $true)][string]$CanonicalVaultPath)

    $wanted = Get-CanonicalVaultPath -Path $CanonicalVaultPath
    $identityMatches = New-Object System.Collections.ArrayList
    $vaults = Read-ObsidianVaultRegistry
    foreach ($vaultProperty in $vaults.PSObject.Properties) {
        if ($vaultProperty.Name -notmatch $script:VaultIdPattern) {
            continue
        }
        $rawPath = Get-PropertyValue -Object $vaultProperty.Value -Name 'path'
        if (-not ($rawPath -is [string]) -or [string]::IsNullOrWhiteSpace($rawPath)) {
            continue
        }
        foreach ($candidate in @(Get-RegistryPathCandidates -RawPath $rawPath)) {
            try {
                $registered = Get-CanonicalVaultPath -Path $candidate
                if ([string]::Equals($registered, $wanted, [System.StringComparison]::OrdinalIgnoreCase)) {
                    [void]$identityMatches.Add($vaultProperty.Name)
                    break
                }
            }
            catch {
                # Ignora record obsoleti o non sicuri.
            }
        }
    }

    $uniqueMatches = @($identityMatches | Select-Object -Unique)
    if ($uniqueMatches.Count -eq 0) {
        throw 'Il vault non risulta registrato in Obsidian. Aprilo una volta nell app desktop, chiudilo e riprova.'
    }
    if ($uniqueMatches.Count -ne 1) {
        throw 'Piu ID Obsidian puntano allo stesso vault. Correggi obsidian.json prima di installare.'
    }
    return [PSCustomObject]@{
        Id = [string]$uniqueMatches[0]
        Name = Get-VaultName -Path $wanted
        Path = $wanted
    }
}

function Get-DiscoveredVaults {
    $results = New-Object System.Collections.ArrayList
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    try {
        $vaults = Read-ObsidianVaultRegistry
        foreach ($vaultProperty in $vaults.PSObject.Properties) {
            if ($vaultProperty.Name -notmatch $script:VaultIdPattern) { continue }
            $rawPath = Get-PropertyValue -Object $vaultProperty.Value -Name 'path'
            if (-not ($rawPath -is [string]) -or [string]::IsNullOrWhiteSpace($rawPath)) { continue }
            foreach ($candidate in @(Get-RegistryPathCandidates -RawPath $rawPath)) {
                try {
                    $fullPath = Get-CanonicalVaultPath -Path $candidate
                    if ($seen.Add($fullPath)) {
                        $name = Get-VaultName -Path $fullPath
                        [void]$results.Add([PSCustomObject]@{
                            Id = $vaultProperty.Name
                            Name = $name
                            Path = $fullPath
                            Label = "$name  -  $fullPath"
                        })
                    }
                    break
                }
                catch {
                    # Prova l eventuale variante URI-decoded o passa al record successivo.
                }
            }
        }
    }
    catch {
        # La selezione manuale resta visibile; l installazione richiedera comunque un ID stabile.
    }
    return [object[]]$results.ToArray()
}

function Find-ObsidianCli {
    $candidates = New-Object System.Collections.ArrayList
    if (-not [string]::IsNullOrWhiteSpace($env:OBSIDIAN_CLI_PATH)) {
        [void]$candidates.Add($env:OBSIDIAN_CLI_PATH)
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        [void]$candidates.Add((Join-Path $env:ProgramFiles 'Obsidian\Obsidian.com'))
    }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Obsidian\Obsidian.com'))
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.com'))
    }

    try {
        $command = Get-Command 'Obsidian.com' -ErrorAction Stop
        [void]$candidates.Add($command.Source)
    }
    catch {
        # Non presente nel PATH.
    }

    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace([string]$candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

function Find-ObsidianApplication {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles 'Obsidian\Obsidian.exe')
    }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Obsidian\Obsidian.exe')
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe')
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [System.IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

function Get-ObsidianStatus {
    $cli = Find-ObsidianCli
    $application = Find-ObsidianApplication
    $running = $null -ne (Get-Process -Name 'Obsidian' -ErrorAction SilentlyContinue | Select-Object -First 1)
    return [PSCustomObject]@{
        CliPath = $cli
        ApplicationPath = $application
        Running = $running
    }
}

function Get-NodeStatus {
    $nodeCommand = $null
    try {
        $nodeCommand = Get-Command 'node.exe' -CommandType Application -ErrorAction Stop | Select-Object -First 1
    }
    catch {
        try {
            $nodeCommand = Get-Command 'node' -CommandType Application -ErrorAction Stop | Select-Object -First 1
        }
        catch {
            return [PSCustomObject]@{
                Ready = $false
                Path = $null
                Version = $null
                Message = 'Node.js 20 o successivo non trovato. E necessario per avviare il plugin Codex.'
            }
        }
    }

    try {
        $versionOutput = (& $nodeCommand.Source --version 2>&1 | Select-Object -First 1).ToString().Trim()
        if ($versionOutput -notmatch '^v(?<major>[0-9]+)\.') {
            throw "Risposta non valida: $versionOutput"
        }
        $major = [int]$Matches['major']
        if ($major -lt 20) {
            return [PSCustomObject]@{
                Ready = $false
                Path = $nodeCommand.Source
                Version = $versionOutput
                Message = "Node.js $versionOutput e troppo vecchio: serve la versione 20 o successiva."
            }
        }
        return [PSCustomObject]@{
            Ready = $true
            Path = $nodeCommand.Source
            Version = $versionOutput
            Message = "Node.js $versionOutput pronto."
        }
    }
    catch {
        return [PSCustomObject]@{
            Ready = $false
            Path = $nodeCommand.Source
            Version = $null
            Message = "Node.js non verificabile: $($_.Exception.Message)"
        }
    }
}

function Assert-CodexPackageRelationship {
    param(
        [Parameter(Mandatory = $true)][string]$MarketplacePath,
        [Parameter(Mandatory = $true)][string]$PluginRoot
    )

    $marketplacePathFull = [System.IO.Path]::GetFullPath($MarketplacePath)
    $pluginRootFull = [System.IO.Path]::GetFullPath($PluginRoot).TrimEnd('\', '/')
    Assert-RegularFileOrMissing -Path $marketplacePathFull
    Assert-NoReparseAncestors -Path $pluginRootFull
    if (-not (Test-Path -LiteralPath $marketplacePathFull -PathType Leaf)) {
        throw "Marketplace Codex non trovato: $marketplacePathFull"
    }
    if (-not (Test-Path -LiteralPath $pluginRootFull -PathType Container)) {
        throw "Root del plugin Codex non trovata: $pluginRootFull"
    }

    $pluginManifestPath = Join-Path $pluginRootFull '.codex-plugin\plugin.json'
    $pluginManifest = Read-JsonExact -Path $pluginManifestPath -Description 'Il manifest del plugin Codex'
    $manifestVersion = if ($null -ne $pluginManifest) { $pluginManifest['version'] } else { $null }
    $versionAccepted = ($manifestVersion -is [string]) -and (
        $manifestVersion -eq $script:ExpectedCodexPluginVersion -or
        $manifestVersion.StartsWith(($script:ExpectedCodexPluginVersion + '+codex.'), [System.StringComparison]::Ordinal)
    )
    if ($null -eq $pluginManifest -or
        $pluginManifest['name'] -ne $script:CodexPluginId -or
        -not $versionAccepted) {
        throw "Il manifest Codex deve identificare $script:CodexPluginId versione ${script:ExpectedCodexPluginVersion}: $pluginManifestPath"
    }

    $marketplace = Read-JsonExact -Path $marketplacePathFull -Description 'Il marketplace Codex'
    if ($null -eq $marketplace -or -not $marketplace.ContainsKey('plugins') -or -not ($marketplace['plugins'] -is [object[]])) {
        throw "Il marketplace Codex non contiene un elenco plugins valido: $marketplacePathFull"
    }
    $matches = New-Object System.Collections.ArrayList
    foreach ($plugin in $marketplace['plugins']) {
        if (-not ($plugin -is [System.Collections.Generic.Dictionary[string, object]]) -or $plugin['name'] -ne $script:CodexPluginId) {
            continue
        }
        $source = $plugin['source']
        if (-not ($source -is [System.Collections.Generic.Dictionary[string, object]]) -or
            $source['source'] -ne 'local' -or -not ($source['path'] -is [string])) {
            throw "La voce $script:CodexPluginId nel marketplace non e una sorgente locale valida."
        }
        [void]$matches.Add($source['path'])
    }
    if ($matches.Count -ne 1) {
        throw "Il marketplace deve contenere esattamente una voce $script:CodexPluginId."
    }

    $marketplaceRoot = [System.IO.Directory]::GetParent(
        [System.IO.Directory]::GetParent(
            [System.IO.Directory]::GetParent($marketplacePathFull).FullName
        ).FullName
    ).FullName
    $declaredRoot = [System.IO.Path]::GetFullPath((Join-Path $marketplaceRoot ([string]$matches[0]))).TrimEnd('\', '/')
    if (-not [string]::Equals($declaredRoot, $pluginRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Il marketplace non punta esattamente al plugin incluso nel pacchetto: $pluginRootFull"
    }
    return $marketplacePathFull
}

function Find-MarketplaceJson {
    $pluginDirectory = [System.IO.DirectoryInfo]$script:BridgePluginRoot
    if ($null -eq $pluginDirectory.Parent -or
        -not [string]::Equals($pluginDirectory.Parent.Name, 'plugins', [System.StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $pluginDirectory.Parent.Parent) {
        return $null
    }
    $candidate = Join-Path $pluginDirectory.Parent.Parent.FullName '.agents\plugins\marketplace.json'
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        return $null
    }
    return Assert-CodexPackageRelationship -MarketplacePath $candidate -PluginRoot $script:BridgePluginRoot
}

function New-CodexPluginDeeplink {
    param([Parameter(Mandatory = $true)][string]$MarketplacePath)

    return 'codex://plugins/obsidian-bridge?marketplacePath=' + [Uri]::EscapeDataString([System.IO.Path]::GetFullPath($MarketplacePath))
}

function Get-CodexPluginDeeplink {
    param([AllowEmptyString()][string]$MarketplacePath = '')

    if ([string]::IsNullOrWhiteSpace($MarketplacePath)) {
        $MarketplacePath = Find-MarketplaceJson
    }
    if ($null -eq $marketplacePath) {
        return $null
    }

    $marketplaceRoot = [System.IO.Directory]::GetParent(
        [System.IO.Directory]::GetParent(
            [System.IO.Directory]::GetParent([System.IO.Path]::GetFullPath($marketplacePath)).FullName
        ).FullName
    ).FullName
    [void](Assert-CodexPackageRelationship -MarketplacePath $marketplacePath -PluginRoot (Join-Path $marketplaceRoot 'plugins\obsidian-bridge'))
    return New-CodexPluginDeeplink -MarketplacePath $marketplacePath
}

function Assert-ManagedAppDataPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $managedRoot = [System.IO.Path]::GetFullPath($script:BridgeAppDataRoot).TrimEnd('\', '/')
    $candidate = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $prefix = $managedRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Percorso non gestito rifiutato: $candidate"
    }
    return $candidate
}

function Copy-DirectoryTreeSafely {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Cartella del marketplace mancante: $Source"
    }
    $sourceDirectory = Get-Item -LiteralPath $Source -Force
    if (($sourceDirectory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Il pacchetto contiene un collegamento non consentito: $Source"
    }
    [void](Assert-ManagedAppDataPath -Path $Destination)
    if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
        Assert-NoReparseAncestors -Path $Destination
        [void](New-Item -ItemType Directory -Path $Destination)
    }
    if (Test-PathIsReparsePoint -Path $Destination) {
        throw "La destinazione del marketplace e un reparse point: $Destination"
    }

    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Il pacchetto contiene un collegamento non consentito: $($item.FullName)"
        }
        $target = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) {
            Copy-DirectoryTreeSafely -Source $item.FullName -Destination $target
        }
        else {
            [System.IO.File]::Copy($item.FullName, $target, $false)
        }
    }
}

function Install-StableMarketplace {
    param(
        [Parameter(Mandatory = $true)][string]$SourceMarketplaceJson,
        [Parameter(Mandatory = $true)][string]$Timestamp
    )

    $sourceJson = [System.IO.Path]::GetFullPath($SourceMarketplaceJson)
    $sourceMarketplaceRoot = [System.IO.Directory]::GetParent(
        [System.IO.Directory]::GetParent(
            [System.IO.Directory]::GetParent($sourceJson).FullName
        ).FullName
    ).FullName
    [void](Assert-CodexPackageRelationship -MarketplacePath $sourceJson -PluginRoot (Join-Path $sourceMarketplaceRoot 'plugins\obsidian-bridge'))

    $stableRoot = [System.IO.Path]::GetFullPath($script:StableMarketplaceRoot)
    [void](Assert-ManagedAppDataPath -Path $stableRoot)
    Assert-NoReparseAncestors -Path $stableRoot
    $stableJson = Join-Path $stableRoot '.agents\plugins\marketplace.json'
    if ([string]::Equals($sourceMarketplaceRoot.TrimEnd('\', '/'), $stableRoot.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
        return [PSCustomObject]@{
            Root = $stableRoot
            MarketplaceJson = $stableJson
            Backup = $null
            Deeplink = Get-CodexPluginDeeplink -MarketplacePath $stableJson
        }
    }

    if (-not (Test-Path -LiteralPath $script:BridgeAppDataRoot -PathType Container)) {
        $parentRoot = [System.IO.Directory]::GetParent($script:BridgeAppDataRoot).FullName
        [void](New-SafeDirectory -Path $script:BridgeAppDataRoot -ContainmentRoot $parentRoot -OwnedDirectories $null)
    }
    $stageRoot = Assert-ManagedAppDataPath -Path (Join-Path $script:BridgeAppDataRoot ('.codex-marketplace-stage-' + [Guid]::NewGuid().ToString('N')))
    $backupRoot = $null
    $stageOwned = $false
    try {
        [void](New-Item -ItemType Directory -Path $stageRoot)
        $stageOwned = $true
        if (Test-PathIsReparsePoint -Path $stageRoot) {
            throw "La cartella di preparazione e un reparse point: $stageRoot"
        }
        Copy-DirectoryTreeSafely -Source (Join-Path $sourceMarketplaceRoot '.agents') -Destination (Join-Path $stageRoot '.agents')
        Copy-DirectoryTreeSafely -Source (Join-Path $sourceMarketplaceRoot 'plugins\obsidian-bridge') -Destination (Join-Path $stageRoot 'plugins\obsidian-bridge')

        $stagedJson = Join-Path $stageRoot '.agents\plugins\marketplace.json'
        [void](Assert-CodexPackageRelationship -MarketplacePath $stagedJson -PluginRoot (Join-Path $stageRoot 'plugins\obsidian-bridge'))

        if (Test-Path -LiteralPath $stableRoot) {
            Assert-NoReparseAncestors -Path $stableRoot
            $backupRoot = Assert-ManagedAppDataPath -Path "$stableRoot.backup.$Timestamp"
            if (Test-Path -LiteralPath $backupRoot) {
                $backupRoot = Assert-ManagedAppDataPath -Path "$backupRoot.$([Guid]::NewGuid().ToString('N'))"
            }
            Move-Item -LiteralPath $stableRoot -Destination $backupRoot
        }

        try {
            Move-Item -LiteralPath $stageRoot -Destination $stableRoot
            $stageOwned = $false
        }
        catch {
            if (($null -ne $backupRoot) -and (Test-Path -LiteralPath $backupRoot -PathType Container) -and -not (Test-Path -LiteralPath $stableRoot)) {
                Move-Item -LiteralPath $backupRoot -Destination $stableRoot
                $backupRoot = $null
            }
            throw
        }

        return [PSCustomObject]@{
            Root = $stableRoot
            MarketplaceJson = $stableJson
            Backup = $backupRoot
            Deeplink = Get-CodexPluginDeeplink -MarketplacePath $stableJson
        }
    }
    finally {
        if ($stageOwned -and (Test-Path -LiteralPath $stageRoot)) {
            $verifiedStage = Assert-ManagedAppDataPath -Path $stageRoot
            if (Test-PathIsReparsePoint -Path $verifiedStage) {
                throw "Pulizia automatica rifiutata: la cartella di preparazione e diventata un reparse point: $verifiedStage"
            }
            Remove-Item -LiteralPath $verifiedStage -Recurse -Force
        }
    }
}

function Assert-ExactDictionaryKeys {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.Dictionary[string, object]]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if ($Value.Count -ne $Expected.Count) {
        throw "$Description contiene campi mancanti o aggiuntivi."
    }
    foreach ($key in $Expected) {
        if (-not $Value.ContainsKey($key)) {
            throw "$Description non contiene il campo obbligatorio $key."
        }
    }
}

function Assert-SharedFolderArray {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not ($Value -is [System.Array]) -or $Value.Count -gt 256) {
        throw "$Description deve essere un elenco di massimo 256 cartelle."
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($folderValue in $Value) {
        if (-not ($folderValue -is [string]) -or $folderValue.Length -gt 1024) {
            throw "$Description contiene una cartella non valida."
        }
        $normalized = Normalize-RelativeFolder -Folder $folderValue
        if (-not [string]::Equals($normalized, $folderValue, [System.StringComparison]::Ordinal) -or -not $seen.Add($normalized)) {
            throw "$Description contiene cartelle duplicate o non normalizzate."
        }
    }
}

function Test-VaultFoldersIntersect {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )

    $leftValue = $Left.Normalize([Text.NormalizationForm]::FormC).Trim('/')
    $rightValue = $Right.Normalize([Text.NormalizationForm]::FormC).Trim('/')
    $leftPrefix = $leftValue + '/'
    $rightPrefix = $rightValue + '/'
    return (
        [string]::Equals($leftValue, $rightValue, [System.StringComparison]::OrdinalIgnoreCase) -or
        $leftValue.StartsWith($rightPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        $rightValue.StartsWith($leftPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    )
}

function New-DisabledManagementPermissions {
    $permissions = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $permissions.Add('edit', $false)
    $permissions.Add('move', $false)
    $permissions.Add('trash', $false)
    return $permissions
}

function Copy-ManagementPermissions {
    param([Parameter(Mandatory = $true)]$Value)

    $permissions = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $permissions.Add('edit', [bool]$Value['edit'])
    $permissions.Add('move', [bool]$Value['move'])
    $permissions.Add('trash', [bool]$Value['trash'])
    return $permissions
}

function Assert-SharedSettingsSchema {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not ($Value -is [System.Collections.Generic.Dictionary[string, object]])) {
        throw "Le impostazioni condivise devono essere un oggetto JSON. Il file non verra sovrascritto: $Path"
    }
    Assert-ExactDictionaryKeys -Value $Value -Expected @('version', 'updatedAt', 'vaults') -Description 'Le impostazioni condivise'
    if (-not ($Value['version'] -is [int]) -or @([int]2, [int]3, [int]4, [int]5) -notcontains $Value['version']) {
        throw "Le impostazioni condivise non usano uno schema supportato (versione 2, 3, 4 o 5): $Path"
    }
    if (-not ($Value['updatedAt'] -is [string]) -or
        [string]::IsNullOrWhiteSpace($Value['updatedAt']) -or
        $Value['updatedAt'].Length -gt 64) {
        throw "Le impostazioni condivise contengono updatedAt non valido: $Path"
    }
    $parsedTimestamp = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse(
        $Value['updatedAt'],
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsedTimestamp
    )) {
        throw "Le impostazioni condivise contengono updatedAt non valido: $Path"
    }
    $vaults = $Value['vaults']
    if (-not ($vaults -is [System.Collections.Generic.Dictionary[string, object]]) -or $vaults.Count -gt 256) {
        throw "La sezione vaults deve essere un oggetto con massimo 256 elementi: $Path"
    }
    foreach ($pair in $vaults.GetEnumerator()) {
        $vaultId = [string]$pair.Key
        if ($vaultId -notmatch $script:VaultIdPattern) {
            throw "ID vault non valido nelle impostazioni condivise: $vaultId"
        }
        $entry = $pair.Value
        if (-not ($entry -is [System.Collections.Generic.Dictionary[string, object]])) {
            throw "Configurazione non valida per il vault $vaultId."
        }
        $expectedEntryKeys = @(
            'vaultName', 'vaultPath', 'enabled', 'readMode', 'readFolders', 'writeEnabled', 'writeFolders'
        )
        if ($Value['version'] -ge 3) {
            $expectedEntryKeys += 'accessMode'
        }
        if ($Value['version'] -ge 4) {
            $expectedEntryKeys += 'managementPermissions'
        }
        if ($Value['version'] -eq 5) {
            $expectedEntryKeys += 'configDir'
        }
        Assert-ExactDictionaryKeys -Value $entry -Expected $expectedEntryKeys -Description "La configurazione del vault $vaultId"
        $vaultName = $entry['vaultName']
        if (-not ($vaultName -is [string]) -or [string]::IsNullOrWhiteSpace($vaultName) -or
            $vaultName.Length -gt 256 -or
            -not [string]::Equals($vaultName, $vaultName.Trim().Normalize([Text.NormalizationForm]::FormC), [System.StringComparison]::Ordinal) -or
            $vaultName -match '[\x00-\x1f\x7f]') {
            throw "Nome non valido per il vault $vaultId."
        }
        $vaultPath = $entry['vaultPath']
        if (-not ($vaultPath -is [string]) -or $vaultPath.Length -gt 4096 -or
            -not [System.IO.Path]::IsPathRooted($vaultPath) -or $vaultPath -match '[\x00-\x1f\x7f]') {
            throw "Percorso non valido per il vault $vaultId."
        }
        if (-not ($entry['enabled'] -is [bool]) -or -not ($entry['writeEnabled'] -is [bool])) {
            throw "Flag booleani non validi per il vault $vaultId."
        }
        if (-not ($entry['readMode'] -is [string]) -or @('off', 'all', 'folders') -notcontains $entry['readMode']) {
            throw "Modalita di lettura non valida per il vault $vaultId."
        }
        if ($Value['version'] -ge 3 -and
            (-not ($entry['accessMode'] -is [string]) -or
             $(if ($Value['version'] -ge 4) { @('protected', 'full', 'management') } else { @('protected', 'full') }) -notcontains $entry['accessMode'])) {
            throw "Modalita di accesso non valida per il vault $vaultId."
        }
        if ($Value['version'] -ge 4) {
            $permissions = $entry['managementPermissions']
            if (-not ($permissions -is [System.Collections.Generic.Dictionary[string, object]])) {
                throw "Permessi di gestione non validi per il vault $vaultId."
            }
            Assert-ExactDictionaryKeys -Value $permissions -Expected @('edit', 'move', 'trash') -Description "I permessi di gestione del vault $vaultId"
            foreach ($permissionName in @('edit', 'move', 'trash')) {
                if (-not ($permissions[$permissionName] -is [bool])) {
                    throw "Il permesso di gestione $permissionName non e valido per il vault $vaultId."
                }
            }
            $anyManagementPermission =
                [bool]$permissions['edit'] -or
                [bool]$permissions['move'] -or
                [bool]$permissions['trash']
            if (($entry['accessMode'] -eq 'management' -and -not $anyManagementPermission) -or
                ($entry['accessMode'] -ne 'management' -and $anyManagementPermission)) {
                throw "Modalita e permessi di gestione non coerenti per il vault $vaultId."
            }
        }
        if ($Value['version'] -eq 5 -and $null -ne $entry['configDir']) {
            $configDir = $entry['configDir']
            $invalidConfigSegment = $false
            $normalizedConfigDir = $null
            if ($configDir -is [string]) {
                $normalizedConfigDir = $configDir.Trim().Normalize([Text.NormalizationForm]::FormC)
                foreach ($segment in $configDir.Split('/')) {
                    if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..') {
                        $invalidConfigSegment = $true
                    }
                }
            }
            if (-not ($configDir -is [string]) -or [string]::IsNullOrWhiteSpace($configDir) -or
                $configDir.Length -gt 1024 -or $configDir -match '[\\\x00-\x1f\x7f]' -or
                [System.IO.Path]::IsPathRooted($configDir) -or
                -not [string]::Equals($normalizedConfigDir, $configDir, [System.StringComparison]::Ordinal) -or
                $invalidConfigSegment) {
                throw "Cartella di configurazione non valida per il vault $vaultId."
            }
        }
        Assert-SharedFolderArray -Value $entry['readFolders'] -Description "Cartelle leggibili del vault $vaultId"
        Assert-SharedFolderArray -Value $entry['writeFolders'] -Description "Cartelle scrivibili del vault $vaultId"
        if ($Value['version'] -eq 5 -and $null -ne $entry['configDir']) {
            foreach ($folderValue in @($entry['readFolders']) + @($entry['writeFolders'])) {
                if (Test-VaultFoldersIntersect -Left ([string]$folderValue) -Right ([string]$entry['configDir'])) {
                    throw "Una cartella autorizzata interseca la cartella di configurazione del vault $vaultId."
                }
            }
        }
    }
}

function Read-SharedSettings {
    if (-not (Test-Path -LiteralPath $script:SharedSettingsPath -PathType Leaf)) {
        if (Test-Path -LiteralPath $script:SharedSettingsPath) {
            throw "Il percorso delle impostazioni condivise non e un file: $script:SharedSettingsPath"
        }
        return $null
    }
    $value = Read-JsonExact -Path $script:SharedSettingsPath -Description 'Le impostazioni condivise' -MaxBytes $script:SharedSettingsMaxBytes
    Assert-SharedSettingsSchema -Value $value -Path $script:SharedSettingsPath
    return $value
}

function Assert-PluginDataObject {
    param(
        $Value,
        [Parameter(Mandatory = $true)][string]$Path
    )
    if ($null -eq $Value) { return }
    if (-not ($Value -is [System.Collections.Generic.Dictionary[string, object]]) -or
        -not $Value.ContainsKey('version') -or
        -not ($Value['version'] -is [int]) -or
        @([int]1, [int]2, [int]3, [int]4) -notcontains $Value['version']) {
        throw "I dati locali del plugin hanno uno schema sconosciuto e non verranno sovrascritti: $Path"
    }
}

function Read-CommunityPlugins {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [string[]]@()
    }

    $raw = [System.IO.File]::ReadAllText($Path)
    if (-not $raw.TrimStart().StartsWith('[')) {
        throw "community-plugins.json ha una struttura sconosciuta e non verra sovrascritto: $Path"
    }
    try {
        $parsed = $raw | ConvertFrom-Json
    }
    catch {
        throw "community-plugins.json contiene JSON non valido e non verra sovrascritto: $Path"
    }

    $plugins = New-Object System.Collections.ArrayList
    foreach ($item in @($parsed)) {
        if (-not ($item -is [string])) {
            throw "community-plugins.json contiene valori sconosciuti e non verra sovrascritto: $Path"
        }
        [void]$plugins.Add([string]$item)
    }
    return [string[]]$plugins.ToArray([string])
}

function New-VaultSettingsEntry {
    param(
        [Parameter(Mandatory = $true)][string]$VaultName,
        [Parameter(Mandatory = $true)][string]$VaultPath,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ReadFolders,
        [Parameter(Mandatory = $true)][bool]$WriteEnabled,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$WriteFolders
    )

    $entry = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $entry.Add('vaultName', $VaultName)
    $entry.Add('vaultPath', $VaultPath)
    # Directory presence does not prove which configuration directory is
    # active. Keep the entry deny-all until the plugin running inside this
    # exact vault records authoritative Vault.configDir.
    $entry.Add('configDir', $null)
    $entry.Add('accessMode', 'protected')
    $entry.Add('managementPermissions', (New-DisabledManagementPermissions))
    $entry.Add('enabled', $true)
    # Nessuna cartella iniziale significa accesso disattivato. La selezione visuale
    # nel companion evita che un campo vuoto conceda accidentalmente l'intero vault.
    $entry.Add('readMode', $(if ($ReadFolders.Count -eq 0) { 'off' } else { 'folders' }))
    $entry.Add('readFolders', [object[]]$ReadFolders)
    $entry.Add('writeEnabled', $WriteEnabled)
    $entry.Add('writeFolders', [object[]]$WriteFolders)
    return $entry
}

function New-InstallerVaultSettingsEntry {
    param(
        $ExistingSharedSettings,
        [Parameter(Mandatory = $true)][string]$VaultId,
        [Parameter(Mandatory = $true)][string]$VaultName,
        [Parameter(Mandatory = $true)][string]$VaultPath
    )

    if ($null -eq $ExistingSharedSettings -or -not $ExistingSharedSettings['vaults'].ContainsKey($VaultId)) {
        return New-VaultSettingsEntry -VaultName $VaultName -VaultPath $VaultPath -ReadFolders @() -WriteEnabled $false -WriteFolders @()
    }

    # Reinstalling updates the bridge files, not the user's permission choices.
    # Copy the existing scope while refreshing only the verified vault identity.
    $existing = $ExistingSharedSettings['vaults'][$VaultId]
    $entry = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $entry.Add('vaultName', $VaultName)
    $entry.Add('vaultPath', $VaultPath)
    # Reinstallation also cannot prove that a previously recorded directory is
    # still active. Preserve the permission choices but require the selected
    # vault to re-attest Vault.configDir when Bridge Control next loads.
    $entry.Add('configDir', $null)
    $entry.Add('accessMode', $(if ($existing.ContainsKey('accessMode')) { [string]$existing['accessMode'] } else { 'protected' }))
    $entry.Add(
        'managementPermissions',
        $(if ($ExistingSharedSettings['version'] -ge 4) {
            Copy-ManagementPermissions -Value $existing['managementPermissions']
        } else {
            New-DisabledManagementPermissions
        })
    )
    $entry.Add('enabled', [bool]$existing['enabled'])
    $entry.Add('readMode', [string]$existing['readMode'])
    $entry.Add('readFolders', [object[]]@($existing['readFolders']))
    $entry.Add('writeEnabled', [bool]$existing['writeEnabled'])
    $entry.Add('writeFolders', [object[]]@($existing['writeFolders']))
    return $entry
}

function Merge-SharedSettings {
    param(
        $Existing,
        [Parameter(Mandatory = $true)][string]$VaultId,
        [Parameter(Mandatory = $true)]$Entry
    )

    if ($null -eq $Existing) {
        $Existing = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
        $Existing.Add('version', 5)
        $Existing.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
        $Existing.Add('vaults', [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal))
    }

    Assert-SharedSettingsSchema -Value $Existing -Path $script:SharedSettingsPath
    if ($Existing['version'] -eq 2) {
        foreach ($legacyEntry in $Existing['vaults'].Values) {
            $legacyEntry.Add('accessMode', 'protected')
        }
        $Existing['version'] = 3
    }
    if ($Existing['version'] -eq 3) {
        foreach ($legacyEntry in $Existing['vaults'].Values) {
            $legacyEntry.Add('managementPermissions', (New-DisabledManagementPermissions))
        }
        $Existing['version'] = 4
    }
    if ($Existing['version'] -eq 4) {
        foreach ($legacyEntry in $Existing['vaults'].Values) {
            $legacyEntry.Add('configDir', $null)
        }
        $Existing['version'] = 5
    }

    $vaults = $Existing['vaults']
    if (-not $vaults.ContainsKey($VaultId) -and $vaults.Count -ge 256) {
        throw 'Non e possibile aggiungere un altro vault: il limite di 256 configurazioni e stato raggiunto.'
    }
    $vaults[$VaultId] = $Entry
    $Existing['updatedAt'] = [DateTime]::UtcNow.ToString('o')
    Assert-SharedSettingsSchema -Value $Existing -Path $script:SharedSettingsPath
    return $Existing
}

function Merge-PluginData {
    param(
        $Existing,
        [Parameter(Mandatory = $true)][string]$VaultId,
        [Parameter(Mandatory = $true)][string]$VaultName,
        [Parameter(Mandatory = $true)][string]$VaultPath,
        [Parameter(Mandatory = $true)]$Entry
    )

    Assert-PluginDataObject -Value $Existing -Path '(data.json)'
    $result = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $result.Add('version', 4)
    $result.Add('vaultId', $VaultId)
    $result.Add('vaultName', $VaultName)
    $result.Add('vaultPath', $VaultPath)
    $result.Add('accessMode', $Entry['accessMode'])
    $result.Add('managementPermissions', (Copy-ManagementPermissions -Value $Entry['managementPermissions']))
    $result.Add('enabled', $Entry['enabled'])
    $result.Add('readMode', $Entry['readMode'])
    $result.Add('readFolders', $Entry['readFolders'])
    $result.Add('writeEnabled', $Entry['writeEnabled'])
    $result.Add('writeFolders', $Entry['writeFolders'])
    $reviewedAuditChangeIds = New-Object System.Collections.ArrayList
    $seenReviewedAuditChangeIds = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if ($null -ne $Existing -and
        $Existing.ContainsKey('reviewedAuditChangeIds') -and
        $Existing['reviewedAuditChangeIds'] -is [System.Array]) {
        foreach ($changeIdValue in $Existing['reviewedAuditChangeIds']) {
            if ($changeIdValue -is [string] -and
                $changeIdValue -match $script:ChangeIdPattern -and
                $seenReviewedAuditChangeIds.Add($changeIdValue)) {
                [void]$reviewedAuditChangeIds.Add([string]$changeIdValue)
            }
        }
    }
    $reviewedValues = [object[]]$reviewedAuditChangeIds.ToArray()
    if ($reviewedValues.Count -gt 100) {
        $reviewedValues = [object[]]$reviewedValues[($reviewedValues.Count - 100)..($reviewedValues.Count - 1)]
    }
    $result.Add('reviewedAuditChangeIds', $reviewedValues)
    $result.Add('openPanelOnNextLoad', $true)
    return $result
}

function Get-InstallContext {
    param(
        [Parameter(Mandatory = $true)][string]$SelectedVaultPath
    )

    $vault = Get-CanonicalVaultPath -Path $SelectedVaultPath
    $identity = Resolve-VaultIdentity -CanonicalVaultPath $vault
    $vault = $identity.Path
    $vaultName = $identity.Name
    $vaultId = $identity.Id
    $sourceMarketplaceJson = Find-MarketplaceJson
    if ($null -eq $sourceMarketplaceJson) {
        throw 'Marketplace Codex non trovato. Avvia INSTALLA-OBSIDIAN-BRIDGE.cmd dalla cartella completa estratta dallo ZIP.'
    }
    [void](Assert-CodexPackageRelationship -MarketplacePath $sourceMarketplaceJson -PluginRoot $script:BridgePluginRoot)

    $payloadFiles = @('manifest.json', 'main.js', 'styles.css')
    foreach ($file in $payloadFiles) {
        $source = Join-Path $script:PayloadRoot $file
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "File del plugin mancante: $source"
        }
        Assert-RegularFileOrMissing -Path $source -StopAt $script:PayloadRoot
    }
    $manifestPath = Join-Path $script:PayloadRoot 'manifest.json'
    $manifest = Read-JsonExact -Path $manifestPath -Description 'Il manifest del companion Obsidian'
    if ($null -eq $manifest -or $manifest['id'] -ne $script:BridgePluginId) {
        throw "Il payload non e il plugin atteso ($script:BridgePluginId): $manifestPath"
    }

    $obsidianDirectory = Join-Path $vault '.obsidian'
    $destinationPluginDirectory = Join-Path $obsidianDirectory "plugins\$script:BridgePluginId"
    $pluginDataPath = Join-Path $destinationPluginDirectory 'data.json'
    $communityPluginsPath = Join-Path $obsidianDirectory 'community-plugins.json'

    Assert-NoReparseAncestors -Path $destinationPluginDirectory -StopAt $vault
    Assert-RegularFileOrMissing -Path $pluginDataPath -StopAt $vault
    Assert-RegularFileOrMissing -Path $communityPluginsPath -StopAt $vault

    $existingPluginData = Read-JsonExact -Path $pluginDataPath -Description 'I dati locali del plugin Obsidian'
    Assert-PluginDataObject -Value $existingPluginData -Path $pluginDataPath
    $existingSharedSettings = Read-SharedSettings
    $communityPlugins = Read-CommunityPlugins -Path $communityPluginsPath

    $entry = New-InstallerVaultSettingsEntry -ExistingSharedSettings $existingSharedSettings -VaultId $vaultId -VaultName $vaultName -VaultPath $vault
    $payloadDestinationHashes = [ordered]@{}
    foreach ($file in $payloadFiles) {
        $destination = Join-Path $destinationPluginDirectory $file
        Assert-RegularFileOrMissing -Path $destination -StopAt $vault
        $payloadDestinationHashes[$file] = Get-OptionalFileHash -Path $destination
    }

    return [PSCustomObject]@{
        VaultId = $vaultId
        VaultPath = $vault
        VaultName = $vaultName
        ObsidianDirectory = $obsidianDirectory
        DestinationPluginDirectory = $destinationPluginDirectory
        PluginDataPath = $pluginDataPath
        CommunityPluginsPath = $communityPluginsPath
        CommunityPlugins = [string[]]$communityPlugins
        PluginDataHash = Get-OptionalFileHash -Path $pluginDataPath
        CommunityPluginsHash = Get-OptionalFileHash -Path $communityPluginsPath
        ExistingPluginData = $existingPluginData
        VaultSettingsEntry = $entry
        PayloadFiles = [string[]]$payloadFiles
        PayloadDestinationHashes = $payloadDestinationHashes
        SourceMarketplaceJson = $sourceMarketplaceJson
    }
}

function New-FileRollbackRecord {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ContainmentRoot,
        [Parameter(Mandatory = $true)][string]$Timestamp
    )

    Assert-RegularFileOrMissing -Path $Path -StopAt $ContainmentRoot
    $existed = Test-Path -LiteralPath $Path -PathType Leaf
    $backup = Backup-File -Path $Path -Timestamp $Timestamp
    return [PSCustomObject]@{
        Path = $Path
        ContainmentRoot = $ContainmentRoot
        Existed = $existed
        Backup = $backup
    }
}

function Restore-FileRollbackRecords {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$Records,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.ArrayList]$Problems
    )

    for ($index = $Records.Count - 1; $index -ge 0; $index--) {
        $record = $Records[$index]
        try {
            Assert-RegularFileOrMissing -Path $record.Path -StopAt $record.ContainmentRoot
            if ($record.Existed) {
                if ([string]::IsNullOrWhiteSpace([string]$record.Backup) -or -not (Test-Path -LiteralPath $record.Backup -PathType Leaf)) {
                    throw 'backup originale non disponibile'
                }
                Assert-RegularFileOrMissing -Path $record.Backup -StopAt $record.ContainmentRoot
                Copy-FileAtomically -Source $record.Backup -Destination $record.Path
            }
            elseif (Test-Path -LiteralPath $record.Path -PathType Leaf) {
                Remove-Item -LiteralPath $record.Path -Force
            }
        }
        catch {
            [void]$Problems.Add("file $($record.Path): $($_.Exception.Message)")
        }
    }
}

function Invoke-BridgeInstallation {
    param(
        [Parameter(Mandatory = $true)]$Context,
        [Parameter(Mandatory = $true)][bool]$Consent
    )

    if (-not $Consent) {
        throw 'Per abilitare il plugin devi selezionare la casella di consenso.'
    }

    $nodeStatus = Get-NodeStatus
    if (-not $nodeStatus.Ready) {
        throw "$($nodeStatus.Message) Usa il pulsante Scarica Node.js 20+; l installatore non installa software in silenzio."
    }

    $verifiedVault = Get-CanonicalVaultPath -Path $Context.VaultPath
    $verifiedIdentity = Resolve-VaultIdentity -CanonicalVaultPath $verifiedVault
    if (-not [string]::Equals($verifiedIdentity.Id, $Context.VaultId, [System.StringComparison]::Ordinal) -or
        -not [string]::Equals($verifiedIdentity.Path, $Context.VaultPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'L identita stabile del vault e cambiata durante la configurazione. Riapri l installatore.'
    }
    Assert-NoReparseAncestors -Path $Context.ObsidianDirectory -StopAt $Context.VaultPath
    Assert-NoReparseAncestors -Path $Context.DestinationPluginDirectory -StopAt $Context.VaultPath

    $lock = Acquire-SharedSettingsLock
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    $backups = New-Object System.Collections.ArrayList
    $rollbackRecords = New-Object System.Collections.ArrayList
    $ownedVaultDirectories = New-Object System.Collections.ArrayList
    $rollbackProblems = New-Object System.Collections.ArrayList
    $result = $null
    $succeeded = $false
    $failureMessage = $null

    try {
        try {
            # Il merge condiviso viene costruito solo dopo avere acquisito il lock.
            $existingSharedSettings = Read-SharedSettings
            $sharedHashUnderLock = Get-OptionalFileHash -Path $script:SharedSettingsPath
            $vaultSettingsEntry = New-InstallerVaultSettingsEntry -ExistingSharedSettings $existingSharedSettings -VaultId $Context.VaultId -VaultName $Context.VaultName -VaultPath $Context.VaultPath
            $pluginData = Merge-PluginData -Existing $Context.ExistingPluginData -VaultId $Context.VaultId -VaultName $Context.VaultName -VaultPath $Context.VaultPath -Entry $vaultSettingsEntry
            $mergedSharedSettings = Merge-SharedSettings -Existing $existingSharedSettings -VaultId $Context.VaultId -Entry $vaultSettingsEntry
            $serializedShared = (ConvertTo-Json -InputObject $mergedSharedSettings -Depth 30) + [Environment]::NewLine
            if ($script:Utf8NoBom.GetByteCount($serializedShared) -gt $script:SharedSettingsMaxBytes) {
                throw 'La configurazione condivisa risultante supera il limite di 64 KiB.'
            }

            Assert-FileUnchanged -Path $Context.PluginDataPath -ExpectedHash $Context.PluginDataHash -Description 'data.json del plugin Obsidian'
            Assert-FileUnchanged -Path $Context.CommunityPluginsPath -ExpectedHash $Context.CommunityPluginsHash -Description 'community-plugins.json'
            foreach ($file in $Context.PayloadFiles) {
                $destination = Join-Path $Context.DestinationPluginDirectory $file
                Assert-FileUnchanged -Path $destination -ExpectedHash $Context.PayloadDestinationHashes[$file] -Description $destination
            }
            Assert-FileUnchanged -Path $script:SharedSettingsPath -ExpectedHash $sharedHashUnderLock -Description 'Il file delle impostazioni condivise'

            $pluginList = New-Object System.Collections.ArrayList
            foreach ($plugin in $Context.CommunityPlugins) {
                if (-not [string]::Equals($plugin, $script:BridgePluginId, [System.StringComparison]::Ordinal)) {
                    [void]$pluginList.Add($plugin)
                }
            }
            [void]$pluginList.Add($script:BridgePluginId)

            [void](New-SafeDirectory -Path $Context.DestinationPluginDirectory -ContainmentRoot $Context.VaultPath -OwnedDirectories $ownedVaultDirectories)

            foreach ($file in $Context.PayloadFiles) {
                $destination = Join-Path $Context.DestinationPluginDirectory $file
                $record = New-FileRollbackRecord -Path $destination -ContainmentRoot $Context.VaultPath -Timestamp $timestamp
                [void]$rollbackRecords.Add($record)
                if ($null -ne $record.Backup) { [void]$backups.Add($record.Backup) }
            }
            foreach ($fileInfo in @(
                [PSCustomObject]@{ Path = $Context.PluginDataPath; Root = $Context.VaultPath },
                [PSCustomObject]@{ Path = $script:SharedSettingsPath; Root = (Split-Path -Parent $script:SharedSettingsPath) },
                [PSCustomObject]@{ Path = $Context.CommunityPluginsPath; Root = $Context.VaultPath }
            )) {
                $record = New-FileRollbackRecord -Path $fileInfo.Path -ContainmentRoot $fileInfo.Root -Timestamp $timestamp
                [void]$rollbackRecords.Add($record)
                if ($null -ne $record.Backup) { [void]$backups.Add($record.Backup) }
            }

            foreach ($file in $Context.PayloadFiles) {
                $destination = Join-Path $Context.DestinationPluginDirectory $file
                Assert-FileUnchanged -Path $destination -ExpectedHash $Context.PayloadDestinationHashes[$file] -Description $destination
                Copy-FileAtomically -Source (Join-Path $script:PayloadRoot $file) -Destination $destination
            }
            Assert-FileUnchanged -Path $Context.PluginDataPath -ExpectedHash $Context.PluginDataHash -Description 'data.json del plugin Obsidian'
            Write-JsonAtomically -Path $Context.PluginDataPath -Value $pluginData
            Assert-FileUnchanged -Path $script:SharedSettingsPath -ExpectedHash $sharedHashUnderLock -Description 'Il file delle impostazioni condivise'
            Write-SharedSettingsAtomically -Value $mergedSharedSettings
            Assert-FileUnchanged -Path $Context.CommunityPluginsPath -ExpectedHash $Context.CommunityPluginsHash -Description 'community-plugins.json'
            Write-JsonAtomically -Path $Context.CommunityPluginsPath -Value ([object[]]$pluginList.ToArray())

            # Il marketplace stabile e l ultimo passo; la funzione ripristina da sola la versione precedente se fallisce.
            $stableMarketplace = Install-StableMarketplace -SourceMarketplaceJson $Context.SourceMarketplaceJson -Timestamp $timestamp
            if ($null -ne $stableMarketplace.Backup) {
                [void]$backups.Add($stableMarketplace.Backup)
            }

            $result = [PSCustomObject]@{
                VaultId = $Context.VaultId
                VaultName = $Context.VaultName
                VaultPath = $Context.VaultPath
                PluginPath = $Context.DestinationPluginDirectory
                SharedSettingsPath = $script:SharedSettingsPath
                MarketplaceRoot = $stableMarketplace.Root
                MarketplaceJson = $stableMarketplace.MarketplaceJson
                CodexDeeplink = $stableMarketplace.Deeplink
                Backups = [string[]]$backups.ToArray([string])
            }
            $succeeded = $true
        }
        catch {
            $originalMessage = $_.Exception.Message
            Restore-FileRollbackRecords -Records $rollbackRecords -Problems $rollbackProblems
            Remove-OwnedEmptyDirectories -OwnedDirectories $ownedVaultDirectories -ContainmentRoot $Context.VaultPath -RollbackProblems $rollbackProblems
            if ($rollbackProblems.Count -gt 0) {
                $failureMessage = "Installazione interrotta: $originalMessage Ripristino incompleto; controlla questi elementi: $([string]::Join(' | ', [string[]]$rollbackProblems.ToArray([string])))"
            }
            else {
                $failureMessage = "Installazione interrotta e modifiche ripristinate: $originalMessage"
            }
        }
    }
    finally {
        try {
            Release-SharedSettingsLock -Lock $lock
        }
        catch {
            if ($succeeded) {
                $succeeded = $false
                $failureMessage = "I file risultano installati, ma il lock non e stato rilasciato: $($_.Exception.Message). Stato parziale: non ripetere l installazione prima di avere controllato $($lock.Path)."
            }
            else {
                $failureMessage = "$failureMessage Inoltre il lock non e stato rilasciato: $($_.Exception.Message)"
            }
        }
    }

    if (-not $succeeded) {
        throw $failureMessage
    }
    return $result
}

function Invoke-InstallerSelfTest {
    $vaultId = '0123456789abcdef'
    $originalReadFolders = [object[]]@('Studio')
    $originalWriteFolders = [object[]]@('Studio/Appunti')

    $existingEntry = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $existingEntry.Add('vaultName', 'Nome precedente')
    $existingEntry.Add('vaultPath', 'C:\Vault precedente')
    $existingEntry.Add('enabled', $true)
    $existingEntry.Add('readMode', 'folders')
    $existingEntry.Add('readFolders', $originalReadFolders)
    $existingEntry.Add('writeEnabled', $true)
    $existingEntry.Add('writeFolders', $originalWriteFolders)

    $vaults = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $vaults.Add($vaultId, $existingEntry)
    $settings = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $settings.Add('version', 2)
    $settings.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
    $settings.Add('vaults', $vaults)

    $fresh = New-InstallerVaultSettingsEntry -ExistingSharedSettings $null -VaultId $vaultId -VaultName 'Nuovo vault' -VaultPath 'C:\Nuovo vault'
    $preserved = New-InstallerVaultSettingsEntry -ExistingSharedSettings $settings -VaultId $vaultId -VaultName 'Vault aggiornato' -VaultPath 'C:\Vault aggiornato'
    $preservedReadFolders = [object[]]@($preserved['readFolders'])
    $preservedWriteFolders = [object[]]@($preserved['writeFolders'])

    # The installer must clone arrays rather than retain mutable aliases to the
    # shared settings object read before the merge.
    $preserved['readFolders'][0] = 'Modificata nel risultato'
    $arraysAreIndependent = [string]$existingEntry['readFolders'][0] -eq 'Studio'
    $migrated = Merge-SharedSettings -Existing $settings -VaultId $vaultId -Entry $preserved

    # A valid v3 full entry must remain full while receiving no management
    # capability during the v4 migration.
    $fullVaultId = 'fedcba9876543210'
    $fullEntry = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $fullEntry.Add('vaultName', 'Vault completo')
    $fullEntry.Add('vaultPath', 'C:\Vault completo')
    $fullEntry.Add('accessMode', 'full')
    $fullEntry.Add('enabled', $true)
    $fullEntry.Add('readMode', 'folders')
    $fullEntry.Add('readFolders', [object[]]@('Studio'))
    $fullEntry.Add('writeEnabled', $true)
    $fullEntry.Add('writeFolders', [object[]]@('Studio'))
    $fullVaults = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $fullVaults.Add($fullVaultId, $fullEntry)
    $fullSettings = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $fullSettings.Add('version', 3)
    $fullSettings.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
    $fullSettings.Add('vaults', $fullVaults)
    $preservedFull = New-InstallerVaultSettingsEntry -ExistingSharedSettings $fullSettings -VaultId $fullVaultId -VaultName 'Vault completo aggiornato' -VaultPath 'C:\Vault completo aggiornato'
    $mergedFull = Merge-SharedSettings -Existing $fullSettings -VaultId $fullVaultId -Entry $preservedFull

    # A valid v4 management entry is already explicitly authorized and must be
    # preserved exactly on reinstall, using a deep copy of its permission map.
    $managementVaultId = '0011223344556677'
    $managementEntry = New-VaultSettingsEntry -VaultName 'Vault gestione' -VaultPath 'C:\Vault gestione' -ReadFolders @('Studio') -WriteEnabled $true -WriteFolders @('Studio')
    [void]$managementEntry.Remove('configDir')
    $managementEntry['accessMode'] = 'management'
    $managementEntry['managementPermissions']['edit'] = $true
    $managementEntry['managementPermissions']['move'] = $true
    $managementVaults = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $managementVaults.Add($managementVaultId, $managementEntry)
    $managementSettings = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $managementSettings.Add('version', 4)
    $managementSettings.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
    $managementSettings.Add('vaults', $managementVaults)
    $preservedManagement = New-InstallerVaultSettingsEntry -ExistingSharedSettings $managementSettings -VaultId $managementVaultId -VaultName 'Vault gestione aggiornato' -VaultPath 'C:\Vault gestione aggiornato'
    $preservedManagementSnapshot = [ordered]@{
        edit = [bool]$preservedManagement['managementPermissions']['edit']
        move = [bool]$preservedManagement['managementPermissions']['move']
        trash = [bool]$preservedManagement['managementPermissions']['trash']
    }
    $preservedManagement['managementPermissions']['edit'] = $false
    $managementObjectsAreIndependent = [bool]$managementEntry['managementPermissions']['edit']
    $preservedManagement['managementPermissions']['edit'] = $true
    $mergedManagement = Merge-SharedSettings -Existing $managementSettings -VaultId $managementVaultId -Entry $preservedManagement

    $invalidDormantEntry = New-VaultSettingsEntry -VaultName 'Vault non valido' -VaultPath 'C:\Vault non valido' -ReadFolders @() -WriteEnabled $false -WriteFolders @()
    [void]$invalidDormantEntry.Remove('configDir')
    $invalidDormantEntry['managementPermissions']['edit'] = $true
    $invalidDormantVaults = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $invalidDormantVaults.Add('8899aabbccddeeff', $invalidDormantEntry)
    $invalidDormantSettings = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $invalidDormantSettings.Add('version', 4)
    $invalidDormantSettings.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
    $invalidDormantSettings.Add('vaults', $invalidDormantVaults)
    $invalidDormantRejected = $false
    try {
        Assert-SharedSettingsSchema -Value $invalidDormantSettings -Path '(self-test dormant permissions)'
    }
    catch {
        $invalidDormantRejected = $true
    }

    $invalidEmptyEntry = New-VaultSettingsEntry -VaultName 'Vault non valido' -VaultPath 'C:\Vault non valido' -ReadFolders @() -WriteEnabled $false -WriteFolders @()
    [void]$invalidEmptyEntry.Remove('configDir')
    $invalidEmptyEntry['accessMode'] = 'management'
    $invalidEmptyVaults = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $invalidEmptyVaults.Add('7766554433221100', $invalidEmptyEntry)
    $invalidEmptySettings = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $invalidEmptySettings.Add('version', 4)
    $invalidEmptySettings.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
    $invalidEmptySettings.Add('vaults', $invalidEmptyVaults)
    $invalidEmptyRejected = $false
    try {
        Assert-SharedSettingsSchema -Value $invalidEmptySettings -Path '(self-test empty management)'
    }
    catch {
        $invalidEmptyRejected = $true
    }

    $invalidConfigEntry = New-VaultSettingsEntry -VaultName 'Vault config non valido' -VaultPath 'C:\Vault config non valido' -ReadFolders @() -WriteEnabled $false -WriteFolders @()
    $invalidConfigEntry['configDir'] = ' Config '
    $invalidConfigVaults = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $invalidConfigVaults.Add('66778899aabbccdd', $invalidConfigEntry)
    $invalidConfigSettings = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $invalidConfigSettings.Add('version', 5)
    $invalidConfigSettings.Add('updatedAt', [DateTime]::UtcNow.ToString('o'))
    $invalidConfigSettings.Add('vaults', $invalidConfigVaults)
    $invalidConfigDirRejected = $false
    try {
        Assert-SharedSettingsSchema -Value $invalidConfigSettings -Path '(self-test configDir)'
    }
    catch {
        $invalidConfigDirRejected = $true
    }

    $reviewedInput = New-Object System.Collections.ArrayList
    foreach ($index in 1..102) {
        [void]$reviewedInput.Add(('00000000-0000-4000-8000-{0:000000000000}' -f $index))
    }
    [void]$reviewedInput.Add('non-un-uuid')
    [void]$reviewedInput.Add('00000000-0000-4000-8000-000000000102')
    $existingPluginData = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $existingPluginData.Add('version', 3)
    $existingPluginData.Add('reviewedAuditChangeIds', [object[]]$reviewedInput.ToArray())
    $mergedPluginData = Merge-PluginData -Existing $existingPluginData -VaultId $fullVaultId -VaultName 'Vault completo aggiornato' -VaultPath 'C:\Vault completo aggiornato' -Entry $preservedFull
    $preservedReviewedIds = [object[]]@($mergedPluginData['reviewedAuditChangeIds'])

    $report = [ordered]@{
        selfTest = $true
        fresh = [ordered]@{
            accessMode = [string]$fresh['accessMode']
            managementPermissions = [ordered]@{
                edit = [bool]$fresh['managementPermissions']['edit']
                move = [bool]$fresh['managementPermissions']['move']
                trash = [bool]$fresh['managementPermissions']['trash']
            }
            enabled = [bool]$fresh['enabled']
            readMode = [string]$fresh['readMode']
            readFolders = [object[]]@($fresh['readFolders'])
            writeEnabled = [bool]$fresh['writeEnabled']
            writeFolders = [object[]]@($fresh['writeFolders'])
        }
        preserved = [ordered]@{
            vaultName = [string]$preserved['vaultName']
            vaultPath = [string]$preserved['vaultPath']
            accessMode = [string]$preserved['accessMode']
            managementPermissions = [ordered]@{
                edit = [bool]$preserved['managementPermissions']['edit']
                move = [bool]$preserved['managementPermissions']['move']
                trash = [bool]$preserved['managementPermissions']['trash']
            }
            enabled = [bool]$preserved['enabled']
            readMode = [string]$preserved['readMode']
            readFolders = $preservedReadFolders
            writeEnabled = [bool]$preserved['writeEnabled']
            writeFolders = $preservedWriteFolders
        }
        arraysAreIndependent = $arraysAreIndependent
        migratedVersion = [int]$migrated['version']
        migratedAccessMode = [string]$migrated['vaults'][$vaultId]['accessMode']
        migratedManagementPermissions = [ordered]@{
            edit = [bool]$migrated['vaults'][$vaultId]['managementPermissions']['edit']
            move = [bool]$migrated['vaults'][$vaultId]['managementPermissions']['move']
            trash = [bool]$migrated['vaults'][$vaultId]['managementPermissions']['trash']
        }
        preservedFull = [ordered]@{
            version = [int]$mergedFull['version']
            accessMode = [string]$mergedFull['vaults'][$fullVaultId]['accessMode']
            managementPermissions = [ordered]@{
                edit = [bool]$mergedFull['vaults'][$fullVaultId]['managementPermissions']['edit']
                move = [bool]$mergedFull['vaults'][$fullVaultId]['managementPermissions']['move']
                trash = [bool]$mergedFull['vaults'][$fullVaultId]['managementPermissions']['trash']
            }
            vaultName = [string]$mergedFull['vaults'][$fullVaultId]['vaultName']
            vaultPath = [string]$mergedFull['vaults'][$fullVaultId]['vaultPath']
        }
        preservedManagement = [ordered]@{
            version = [int]$mergedManagement['version']
            accessMode = [string]$mergedManagement['vaults'][$managementVaultId]['accessMode']
            managementPermissions = $preservedManagementSnapshot
            objectsAreIndependent = $managementObjectsAreIndependent
            vaultName = [string]$mergedManagement['vaults'][$managementVaultId]['vaultName']
            vaultPath = [string]$mergedManagement['vaults'][$managementVaultId]['vaultPath']
        }
        pluginData = [ordered]@{
            version = [int]$mergedPluginData['version']
            managementPermissions = [ordered]@{
                edit = [bool]$mergedPluginData['managementPermissions']['edit']
                move = [bool]$mergedPluginData['managementPermissions']['move']
                trash = [bool]$mergedPluginData['managementPermissions']['trash']
            }
        }
        schemaGuardrails = [ordered]@{
            dormantPermissionsRejected = $invalidDormantRejected
            emptyManagementRejected = $invalidEmptyRejected
            invalidConfigDirRejected = $invalidConfigDirRejected
        }
        reviewedAuditChangeIds = [ordered]@{
            count = [int]$preservedReviewedIds.Count
            first = [string]$preservedReviewedIds[0]
            last = [string]$preservedReviewedIds[$preservedReviewedIds.Count - 1]
            invalidRejected = -not ($preservedReviewedIds -contains 'non-un-uuid')
        }
    }
    Write-Output (ConvertTo-Json -InputObject $report -Depth 10)
}

function Invoke-DryRun {
    param([AllowEmptyString()][string]$SelectedVaultPath)

    if ([string]::IsNullOrWhiteSpace($SelectedVaultPath)) {
        $vaults = @(Get-DiscoveredVaults)
        if ($vaults.Count -eq 0) {
            throw 'Nessun vault rilevato. Usa -DryRun -VaultPath "C:\percorso\vault".'
        }
        $SelectedVaultPath = $vaults[0].Path
    }

    $context = Get-InstallContext -SelectedVaultPath $SelectedVaultPath
    $status = Get-ObsidianStatus
    $nodeStatus = Get-NodeStatus
    $report = [ordered]@{
        dryRun = $true
        writesPerformed = $false
        vaultId = $context.VaultId
        vaultName = $context.VaultName
        vaultPath = $context.VaultPath
        pluginDestination = $context.DestinationPluginDirectory
        sharedSettingsPath = $script:SharedSettingsPath
        accessMode = $context.VaultSettingsEntry['accessMode']
        managementPermissions = [ordered]@{
            edit = [bool]$context.VaultSettingsEntry['managementPermissions']['edit']
            move = [bool]$context.VaultSettingsEntry['managementPermissions']['move']
            trash = [bool]$context.VaultSettingsEntry['managementPermissions']['trash']
        }
        readMode = $context.VaultSettingsEntry['readMode']
        readFolders = [object[]]@($context.VaultSettingsEntry['readFolders'])
        writeEnabled = [bool]$context.VaultSettingsEntry['writeEnabled']
        writeFolders = [object[]]@($context.VaultSettingsEntry['writeFolders'])
        payloadFiles = @($context.PayloadFiles)
        obsidianCli = $status.CliPath
        obsidianRunning = $status.Running
        nodeReady = $nodeStatus.Ready
        nodePath = $nodeStatus.Path
        nodeVersion = $nodeStatus.Version
        nodeMessage = $nodeStatus.Message
        codexReady = $nodeStatus.Ready
        marketplaceJson = Find-MarketplaceJson
        stableMarketplaceJson = Join-Path $script:StableMarketplaceRoot '.agents\plugins\marketplace.json'
        codexDeeplinkAfterInstall = New-CodexPluginDeeplink -MarketplacePath (Join-Path $script:StableMarketplaceRoot '.agents\plugins\marketplace.json')
    }
    Write-Output (ConvertTo-Json -InputObject $report -Depth 10)
}

function Open-SelectedVault {
    param([Parameter(Mandatory = $true)][string]$Path)

    $uri = 'obsidian://open?path=' + [Uri]::EscapeDataString($Path)
    Start-Process $uri
}

function Show-Installer {
    param([AllowEmptyString()][string]$InitialVaultPath)

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'Installa Obsidian Bridge 0.5.5'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object System.Drawing.Size(780, 650)
    $form.MinimumSize = New-Object System.Drawing.Size(780, 650)
    $form.MaximizeBox = $false
    $form.BackColor = [System.Drawing.Color]::White
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

    $header = New-Object System.Windows.Forms.Panel
    $header.Dock = 'Top'
    $header.Height = 94
    $header.BackColor = [System.Drawing.Color]::FromArgb(88, 70, 160)
    $form.Controls.Add($header)

    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Collega Obsidian a ChatGPT - Bridge 0.5.5'
    $title.ForeColor = [System.Drawing.Color]::White
    $title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 20)
    $title.AutoSize = $true
    $title.Location = New-Object System.Drawing.Point(24, 14)
    $header.Controls.Add($title)

    $subtitle = New-Object System.Windows.Forms.Label
    $subtitle.Text = 'Nessuna API key richiesta: usa la CLI locale ufficiale di Obsidian.'
    $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(235, 232, 250)
    $subtitle.AutoSize = $true
    $subtitle.Location = New-Object System.Drawing.Point(27, 56)
    $header.Controls.Add($subtitle)

    $content = New-Object System.Windows.Forms.Panel
    $content.Dock = 'Fill'
    $content.Padding = New-Object System.Windows.Forms.Padding(24, 16, 24, 16)
    $form.Controls.Add($content)
    $content.BringToFront()

    $vaultLabel = New-Object System.Windows.Forms.Label
    $vaultLabel.Text = '1. Vault Obsidian'
    $vaultLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
    $vaultLabel.AutoSize = $true
    $vaultLabel.Location = New-Object System.Drawing.Point(24, 18)
    $content.Controls.Add($vaultLabel)

    $vaultCombo = New-Object System.Windows.Forms.ComboBox
    $vaultCombo.DropDownStyle = 'DropDownList'
    $vaultCombo.DisplayMember = 'Label'
    $vaultCombo.Location = New-Object System.Drawing.Point(28, 47)
    $vaultCombo.Size = New-Object System.Drawing.Size(570, 30)
    $content.Controls.Add($vaultCombo)

    $browseButton = New-Object System.Windows.Forms.Button
    $browseButton.Text = 'Sfoglia...'
    $browseButton.Location = New-Object System.Drawing.Point(610, 45)
    $browseButton.Size = New-Object System.Drawing.Size(110, 32)
    $content.Controls.Add($browseButton)

    $vaultPathLabel = New-Object System.Windows.Forms.Label
    $vaultPathLabel.Text = 'Nessun vault selezionato'
    $vaultPathLabel.ForeColor = [System.Drawing.Color]::DimGray
    $vaultPathLabel.AutoEllipsis = $true
    $vaultPathLabel.Location = New-Object System.Drawing.Point(28, 81)
    $vaultPathLabel.Size = New-Object System.Drawing.Size(690, 22)
    $content.Controls.Add($vaultPathLabel)

    $accessLabel = New-Object System.Windows.Forms.Label
    $accessLabel.Text = '2. Scegli i permessi dentro Obsidian'
    $accessLabel.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
    $accessLabel.AutoSize = $true
    $accessLabel.Location = New-Object System.Drawing.Point(24, 118)
    $content.Controls.Add($accessLabel)

    $accessCard = New-Object System.Windows.Forms.Panel
    $accessCard.BackColor = [System.Drawing.Color]::FromArgb(244, 242, 252)
    $accessCard.BorderStyle = 'FixedSingle'
    $accessCard.Location = New-Object System.Drawing.Point(28, 148)
    $accessCard.Size = New-Object System.Drawing.Size(690, 78)
    $content.Controls.Add($accessCard)

    $accessText = New-Object System.Windows.Forms.Label
    $accessText.Text = "Un nuovo vault parte in Accesso protetto senza cartelle. In Bridge Control scegli le cartelle, Accesso autonomo o i permessi di Gestione completa. L'installer non attiva mai modalita elevate."
    $accessText.ForeColor = [System.Drawing.Color]::FromArgb(55, 48, 90)
    $accessText.Location = New-Object System.Drawing.Point(12, 11)
    $accessText.Size = New-Object System.Drawing.Size(662, 52)
    $accessCard.Controls.Add($accessText)

    $status = Get-ObsidianStatus
    $nodeStatus = Get-NodeStatus
    $statusBox = New-Object System.Windows.Forms.Label
    $cliText = if ($null -ne $status.CliPath) { "CLI rilevata: $($status.CliPath)" } else { 'CLI Obsidian non rilevata: abilitala nelle impostazioni di Obsidian.' }
    $runningText = if ($status.Running) { 'Obsidian e aperto.' } else { 'Obsidian non e aperto: potrai avviarlo alla fine.' }
    $statusBox.Text = "$cliText`r`n$runningText`r`n$($nodeStatus.Message)"
    $statusBox.BackColor = [System.Drawing.Color]::FromArgb(244, 242, 252)
    $statusBox.BorderStyle = 'FixedSingle'
    $statusBox.Location = New-Object System.Drawing.Point(28, 243)
    $statusBox.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)
    $statusBox.Size = New-Object System.Drawing.Size(690, 88)
    $content.Controls.Add($statusBox)

    $nodeDownloadButton = New-Object System.Windows.Forms.Button
    $nodeDownloadButton.Text = 'Scarica Node.js 20+ (sito ufficiale)'
    $nodeDownloadButton.Location = New-Object System.Drawing.Point(28, 338)
    $nodeDownloadButton.Size = New-Object System.Drawing.Size(265, 32)
    $nodeDownloadButton.Visible = -not $nodeStatus.Ready
    $content.Controls.Add($nodeDownloadButton)

    $consentCheck = New-Object System.Windows.Forms.CheckBox
    $consentCheck.AutoSize = $false
    $consentCheck.Size = New-Object System.Drawing.Size(690, 74)
    $consentCheck.Location = New-Object System.Drawing.Point(28, 375)
    $consentCheck.Text = "Autorizzo l'installazione del plugin community Bridge Control nel vault selezionato e del connettore locale per Codex. I permessi esistenti non vengono modificati."
    $content.Controls.Add($consentCheck)

    $installButton = New-Object System.Windows.Forms.Button
    $installButton.Text = 'Installa Bridge'
    $installButton.BackColor = [System.Drawing.Color]::FromArgb(88, 70, 160)
    $installButton.ForeColor = [System.Drawing.Color]::White
    $installButton.FlatStyle = 'Flat'
    $installButton.Enabled = $false
    $installButton.Location = New-Object System.Drawing.Point(500, 450)
    $installButton.Size = New-Object System.Drawing.Size(218, 42)
    $content.Controls.Add($installButton)

    $messageLabel = New-Object System.Windows.Forms.Label
    $messageLabel.ForeColor = [System.Drawing.Color]::Firebrick
    $messageLabel.AutoEllipsis = $true
    $messageLabel.Location = New-Object System.Drawing.Point(28, 455)
    $messageLabel.Size = New-Object System.Drawing.Size(450, 52)
    $content.Controls.Add($messageLabel)

    $completion = New-Object System.Windows.Forms.Panel
    $completion.Dock = 'Fill'
    $completion.BackColor = [System.Drawing.Color]::White
    $completion.Visible = $false
    $form.Controls.Add($completion)

    $doneTitle = New-Object System.Windows.Forms.Label
    $doneTitle.Text = 'Configurazione completata'
    $doneTitle.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 21)
    $doneTitle.ForeColor = [System.Drawing.Color]::FromArgb(60, 120, 76)
    $doneTitle.AutoSize = $true
    $doneTitle.Location = New-Object System.Drawing.Point(34, 120)
    $completion.Controls.Add($doneTitle)

    $doneText = New-Object System.Windows.Forms.Label
    $doneText.Text = "Bridge Control e installato nel vault.`r`nApri Obsidian > Impostazioni > Bridge Control: usa Accesso protetto, Accesso autonomo o scegli i permessi di Gestione completa dopo l'avviso esplicito.`r`nL'installer non attiva modalita elevate. In Problemi recenti puoi controllare errori, recupero e note coinvolte.`r`nNessuna API key richiesta: il collegamento usa la CLI locale ufficiale di Obsidian."
    $doneText.Font = New-Object System.Drawing.Font('Segoe UI', 11)
    $doneText.Location = New-Object System.Drawing.Point(38, 174)
    $doneText.Size = New-Object System.Drawing.Size(690, 128)
    $completion.Controls.Add($doneText)

    $openObsidianButton = New-Object System.Windows.Forms.Button
    $openObsidianButton.Text = 'Apri Obsidian'
    $openObsidianButton.Location = New-Object System.Drawing.Point(40, 316)
    $openObsidianButton.Size = New-Object System.Drawing.Size(190, 42)
    $completion.Controls.Add($openObsidianButton)

    $openCodexButton = New-Object System.Windows.Forms.Button
    $openCodexButton.Text = 'Apri plugin in Codex'
    $openCodexButton.Location = New-Object System.Drawing.Point(244, 316)
    $openCodexButton.Size = New-Object System.Drawing.Size(210, 42)
    $completion.Controls.Add($openCodexButton)

    $codexFallbackLabel = New-Object System.Windows.Forms.Label
    $codexFallbackLabel.Text = 'Se il link Codex non si apre, il percorso stabile verra mostrato qui.'
    $codexFallbackLabel.ForeColor = [System.Drawing.Color]::DimGray
    $codexFallbackLabel.Location = New-Object System.Drawing.Point(40, 371)
    $codexFallbackLabel.Size = New-Object System.Drawing.Size(680, 62)
    $completion.Controls.Add($codexFallbackLabel)

    $closeButton = New-Object System.Windows.Forms.Button
    $closeButton.Text = 'Chiudi'
    $closeButton.Location = New-Object System.Drawing.Point(468, 316)
    $closeButton.Size = New-Object System.Drawing.Size(120, 42)
    $completion.Controls.Add($closeButton)

    $uninstallLabel = New-Object System.Windows.Forms.Label
    $uninstallLabel.Text = 'Per rimuoverlo in futuro usa Impostazioni > Plugin della community > Bridge Control > Disinstalla. L installer non elimina automaticamente file o note.'
    $uninstallLabel.ForeColor = [System.Drawing.Color]::DimGray
    $uninstallLabel.Location = New-Object System.Drawing.Point(40, 442)
    $uninstallLabel.Size = New-Object System.Drawing.Size(670, 60)
    $completion.Controls.Add($uninstallLabel)

    $script:selectedVaultPath = ''
    $script:installedVaultPath = ''
    $script:codexDeeplink = $null
    $script:stableMarketplaceJson = $null

    function Update-InstallButtonState {
        $installButton.Enabled = (
            $consentCheck.Checked -and
            $nodeStatus.Ready -and
            -not [string]::IsNullOrWhiteSpace($script:selectedVaultPath)
        )
    }

    function Add-VaultToCombo {
        param([Parameter(Mandatory = $true)][string]$Path)
        $canonical = Get-CanonicalVaultPath -Path $Path
        foreach ($existing in $vaultCombo.Items) {
            if ([string]::Equals($existing.Path, $canonical, [System.StringComparison]::OrdinalIgnoreCase)) {
                $vaultCombo.SelectedItem = $existing
                return
            }
        }
        $item = [PSCustomObject]@{
            Name = Get-VaultName -Path $canonical
            Path = $canonical
            Label = "$(Get-VaultName -Path $canonical)  -  $canonical"
        }
        [void]$vaultCombo.Items.Add($item)
        $vaultCombo.SelectedItem = $item
    }

    foreach ($vault in @(Get-DiscoveredVaults)) {
        [void]$vaultCombo.Items.Add($vault)
    }
    if (-not [string]::IsNullOrWhiteSpace($InitialVaultPath)) {
        try { Add-VaultToCombo -Path $InitialVaultPath } catch { $messageLabel.Text = $_.Exception.Message }
    }
    elseif ($vaultCombo.Items.Count -gt 0) {
        $vaultCombo.SelectedIndex = 0
    }

    $vaultCombo.Add_SelectedIndexChanged({
        if ($null -ne $vaultCombo.SelectedItem) {
            $script:selectedVaultPath = $vaultCombo.SelectedItem.Path
            $vaultPathLabel.Text = $script:selectedVaultPath
            $consentCheck.Checked = $false
            $messageLabel.Text = ''
            Update-InstallButtonState
        }
    })

    # L'elemento iniziale puo essere stato selezionato prima di collegare l'evento.
    if ($null -ne $vaultCombo.SelectedItem) {
        $script:selectedVaultPath = $vaultCombo.SelectedItem.Path
        $vaultPathLabel.Text = $script:selectedVaultPath
    }

    $browseButton.Add_Click({
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Seleziona la cartella principale del vault Obsidian'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            try {
                Add-VaultToCombo -Path $dialog.SelectedPath
                $messageLabel.Text = ''
            }
            catch {
                [void][System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Vault non valido', 'OK', 'Warning')
            }
        }
        $dialog.Dispose()
    })

    $nodeDownloadButton.Add_Click({
        try {
            Start-Process 'https://nodejs.org/en/download'
        }
        catch {
            [void][System.Windows.Forms.MessageBox]::Show($form, 'Apri manualmente https://nodejs.org/en/download', 'Node.js 20+', 'OK', 'Information')
        }
    })

    $consentCheck.Add_CheckedChanged({
        Update-InstallButtonState
    })
    Update-InstallButtonState

    if (-not $nodeStatus.Ready) {
        $messageLabel.Text = 'Dato mancante: installa Node.js 20+ dal sito ufficiale, poi riapri questo installer.'
    }

    $installButton.Add_Click({
        try {
            $installButton.Enabled = $false
            $browseButton.Enabled = $false
            $messageLabel.ForeColor = [System.Drawing.Color]::FromArgb(88, 70, 160)
            $messageLabel.Text = 'Installazione in corso...'
            [System.Windows.Forms.Application]::DoEvents()

            $context = Get-InstallContext -SelectedVaultPath $script:selectedVaultPath
            $installResult = Invoke-BridgeInstallation -Context $context -Consent $consentCheck.Checked
            $script:installedVaultPath = $context.VaultPath
            $script:codexDeeplink = $installResult.CodexDeeplink
            $script:stableMarketplaceJson = $installResult.MarketplaceJson
            $codexFallbackLabel.Text = "Se il link non si apre, usa questo marketplace stabile:`r`n$($installResult.MarketplaceJson)"
            $openCodexButton.Enabled = $true
            $openCodexButton.Text = 'Apri plugin in Codex'

            $content.Visible = $false
            $header.Visible = $false
            $completion.Visible = $true
            $completion.BringToFront()
        }
        catch {
            $messageLabel.ForeColor = [System.Drawing.Color]::Firebrick
            $messageLabel.Text = $_.Exception.Message
            $browseButton.Enabled = $true
            Update-InstallButtonState
            [void][System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Installazione non completata', 'OK', 'Error')
        }
    })

    $openObsidianButton.Add_Click({
        try { Open-SelectedVault -Path $script:installedVaultPath }
        catch { [void][System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Impossibile aprire Obsidian', 'OK', 'Warning') }
    })

    $openCodexButton.Enabled = $false
    $openCodexButton.Text = 'Apri plugin in Codex'
    $openCodexButton.Add_Click({
        try {
            if ($null -ne $script:codexDeeplink) { Start-Process $script:codexDeeplink }
        }
        catch {
            $fallback = if ($null -ne $script:stableMarketplaceJson) { "`r`nMarketplace stabile: $script:stableMarketplaceJson" } else { '' }
            [void][System.Windows.Forms.MessageBox]::Show($form, ($_.Exception.Message + $fallback), 'Impossibile aprire Codex', 'OK', 'Warning')
        }
    })
    $closeButton.Add_Click({ $form.Close() })

    [void]$form.ShowDialog()
    $form.Dispose()
}

try {
    if ($SelfTest) {
        Invoke-InstallerSelfTest
    }
    elseif ($DryRun) {
        Invoke-DryRun -SelectedVaultPath $VaultPath
    }
    else {
        Show-Installer -InitialVaultPath $VaultPath
    }
}
catch {
    if ($DryRun -or $SelfTest) {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
    else {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Obsidian Bridge', 'OK', 'Error')
        }
        catch {
            [Console]::Error.WriteLine($_.Exception.Message)
        }
    }
    exit 1
}
