[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppsRoot = 'E:\models\apps'
$PreservedRoot = 'E:\models\apps\xueness-data\preserved-backups'
$StageRoot = 'E:\models\apps\_stage-z8'
$PlanPath = 'E:\models\apps\_stage-z8\cleanup-plan.json'

$ExpectedDirectoryRelatives = @(
    '_round10', '_round11', '_round13', '_round14', '_round17', '_round18', '_round19',
    '_stage-z2', '_stage-z3', '_stage-z4', '_stage-z5', '_stage-z6', '_stage-z7',
    'xueness-0.1.5-src', 'xueness-build-env', 'xueness-win-20261014',
    'xueness-windows-build-20261007', 'xueness-windows-repair-20261008',
    'downloads\Xueness-windows-preview-20261007',
    'downloads\Xueness-windows-repair-20261008',
    'backups\xueness-before-install-20261016-3a0f6570',
    'backups\xueness-before-install-20261017-aa4be41f',
    'backups\xueness-before-install-20261017-bb0bdcb5',
    'xueness-backup-20261002'
)
$ExpectedFileSizes = @{
    'downloads\xueness-source-b4992aed6e80226b5559727de7de23015d7f329d.zip' = 4828594
    'downloads\Xueness-0.1.1-windows-x64-setup.exe' = 126878840
    'downloads\Xueness-0.1.4-windows-x64-setup.exe' = 127131710
    'downloads\Xueness-0.1.5-windows-x64-setup.exe' = 716800
}
$ExpectedFileRelatives = @($ExpectedFileSizes.Keys)
$MixedBackupNames = @(
    'xueness-before-install-20261016-3a0f6570',
    'xueness-before-install-20261017-aa4be41f',
    'xueness-before-install-20261017-bb0bdcb5'
)
$StateOnlyBackupName = 'xueness-backup-20261002'
$ProtectedPaths = @(
    'E:\models\apps\Xueness',
    'E:\models\apps\xueness-data',
    'E:\models\apps\session-comparison',
    'E:\models\apps\_stage-z8',
    'E:\models\apps\xueness-src',
    'E:\models\apps\re-20261010',
    'E:\models\apps\xueness-audit-20261010',
    'E:\models\apps\xueness-review-20261009',
    'E:\models\apps\xueness-review-20261012',
    'E:\models\apps\xueness-optimization-20261012',
    'E:\models\apps\xueness-frontend-redesign-20261015',
    'E:\models\apps\xueness-review-20261009.bundle'
)
$SkippedDirectoryNames = @(
    '.git', 'node_modules', 'dist', 'build', 'release', 'coverage', 'vendor',
    'target', 'artifacts', 'cache', '__pycache__', '.cache'
)
$ProjectMarkers = @(
    'AGENTS.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
    'composer.json', 'setup.py'
)

function Normalize-FullPath([string] $Path) {
    return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-IsInside([string] $Path, [string] $Root) {
    $fullPath = Normalize-FullPath $Path
    $fullRoot = Normalize-FullPath $Root
    return $fullPath.Equals($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePoint([System.IO.FileSystemInfo] $Item) {
    if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing reparse-point path: $($Item.FullName)"
    }
}

function Assert-SafePath([string] $Path, [string] $Boundary, [switch] $AllowMissingLeaf) {
    $fullPath = Normalize-FullPath $Path
    $fullBoundary = Normalize-FullPath $Boundary
    if (-not (Test-IsInside $fullPath $fullBoundary)) {
        throw "Path escapes its approved boundary: $fullPath"
    }
    $boundaryItem = Get-Item -LiteralPath $fullBoundary -Force -ErrorAction Stop
    Assert-NoReparsePoint $boundaryItem
    if ($fullPath.Equals($fullBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $fullPath
    }
    $relative = $fullPath.Substring($fullBoundary.Length).TrimStart('\')
    $current = $fullBoundary
    foreach ($part in $relative.Split('\')) {
        $current = Join-Path $current $part
        if (-not (Test-Path -LiteralPath $current)) {
            if ($AllowMissingLeaf) { return $fullPath }
            throw "Expected path does not exist: $current"
        }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        Assert-NoReparsePoint $item
    }
    return $fullPath
}

function Ensure-ContainedDirectory([string] $Path, [string] $Boundary) {
    $fullPath = Normalize-FullPath $Path
    $fullBoundary = Normalize-FullPath $Boundary
    if (-not (Test-IsInside $fullPath $fullBoundary)) {
        throw "Destination escapes its approved boundary: $fullPath"
    }
    $null = Assert-SafePath $fullBoundary $fullBoundary
    if ($fullPath.Equals($fullBoundary, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    $relative = $fullPath.Substring($fullBoundary.Length).TrimStart('\')
    $current = $fullBoundary
    foreach ($part in $relative.Split('\')) {
        $current = Join-Path $current $part
        if (-not (Test-Path -LiteralPath $current)) {
            New-Item -ItemType Directory -Path $current -ErrorAction Stop | Out-Null
        }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (-not $item.PSIsContainer) { throw "Destination component is not a directory: $current" }
        Assert-NoReparsePoint $item
    }
}

function Get-TreeSha256([string] $Path) {
    $root = Normalize-FullPath $Path
    $rootItem = Get-Item -LiteralPath $root -Force -ErrorAction Stop
    if (-not $rootItem.PSIsContainer) { throw "Expected data directory: $root" }
    Assert-NoReparsePoint $rootItem
    $entries = New-Object 'System.Collections.Generic.List[string]'
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    $queue.Enqueue($root)
    while ($queue.Count -gt 0) {
        $directory = $queue.Dequeue()
        foreach ($item in (Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            Assert-NoReparsePoint $item
            $relative = $item.FullName.Substring($root.Length).TrimStart('\')
            if ($item.PSIsContainer) {
                $entries.Add('D|' + $relative)
                $queue.Enqueue($item.FullName)
            } else {
                $fileHash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
                $entries.Add('F|' + $relative + '|' + $fileHash)
            }
        }
    }
    $sorted = [string[]] $entries.ToArray()
    [Array]::Sort($sorted, [System.StringComparer]::OrdinalIgnoreCase)
    $canonical = [string]::Join([Environment]::NewLine, $sorted)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($canonical))
        return ([System.BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Assert-ReportOk([string] $Path) {
    $null = Assert-SafePath $Path $StageRoot
    $json = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $okProperty = $json.PSObject.Properties['ok']
    if ($null -eq $okProperty -or $okProperty.Value -isnot [bool] -or $okProperty.Value -ne $true) {
        throw "Required top-level boolean ok=true is missing from verification report: $Path"
    }
}

function Get-DirectRuntimeData([string] $Directory) {
    $result = New-Object 'System.Collections.Generic.List[string]'
    foreach ($name in @('state', '.state')) {
        $candidate = Join-Path $Directory $name
        if (Test-Path -LiteralPath $candidate -PathType Container) {
            $result.Add((Normalize-FullPath $candidate))
        }
    }
    return $result.ToArray()
}

function Find-ProjectRoots([string] $Target) {
    $found = New-Object 'System.Collections.Generic.List[string]'
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue([pscustomobject] @{ Path = (Normalize-FullPath $Target); Depth = 0 })
    while ($queue.Count -gt 0) {
        $node = $queue.Dequeue()
        if ($node.Depth -gt 5) { continue }
        $files = Get-ChildItem -LiteralPath $node.Path -File -Force -ErrorAction SilentlyContinue
        foreach ($marker in $ProjectMarkers) {
            if ($files.Name -contains $marker) {
                $found.Add((Normalize-FullPath $node.Path))
                break
            }
        }
        if ($node.Depth -ge 5) { continue }
        foreach ($directory in (Get-ChildItem -LiteralPath $node.Path -Directory -Force -ErrorAction SilentlyContinue)) {
            if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            if ($directory.Name -in $SkippedDirectoryNames) { continue }
            $queue.Enqueue([pscustomobject] @{ Path = $directory.FullName; Depth = ($node.Depth + 1) })
        }
    }
    return @($found.ToArray() | Sort-Object -Unique)
}

function Get-TargetRuntimeData([string] $Target) {
    $all = New-Object 'System.Collections.Generic.List[string]'
    foreach ($candidate in (Get-DirectRuntimeData $Target)) { $all.Add($candidate) }
    foreach ($projectRoot in (Find-ProjectRoots $Target)) {
        foreach ($candidate in (Get-DirectRuntimeData $projectRoot)) { $all.Add($candidate) }
    }
    return @($all.ToArray() | Sort-Object -Unique)
}

function Preserve-DataTree([string] $Source, [string] $TargetRoot, [string] $Destination) {
    $sourceFull = Normalize-FullPath $Source
    $targetFull = Normalize-FullPath $TargetRoot
    $destinationFull = Normalize-FullPath $Destination
    $null = Assert-SafePath $sourceFull $targetFull
    $null = Assert-SafePath $destinationFull $AppsRoot -AllowMissingLeaf
    if (-not (Test-IsInside $destinationFull $PreservedRoot)) {
        throw "Preserved data destination is outside the approved preservation root: $destinationFull"
    }
    if (Test-Path -LiteralPath $destinationFull) {
        throw "Preservation destination already exists: $destinationFull"
    }
    $before = Get-TreeSha256 $sourceFull
    $destinationParent = Split-Path -Parent $destinationFull
    Ensure-ContainedDirectory $destinationParent $AppsRoot
    $null = Assert-SafePath $destinationFull $AppsRoot -AllowMissingLeaf
    Move-Item -LiteralPath $sourceFull -Destination $destinationFull -ErrorAction Stop
    $after = Get-TreeSha256 $destinationFull
    if ($before -ne $after) {
        throw "Preserved data hash mismatch; original target must not be deleted: $sourceFull"
    }
    return $after
}

$null = Assert-SafePath $AppsRoot $AppsRoot
$null = Assert-SafePath $StageRoot $AppsRoot
$null = Assert-SafePath $PlanPath $StageRoot
$null = Assert-SafePath 'E:\models\apps\xueness-data' $AppsRoot

# Check reports before any planned mutation; reports must contain a top-level boolean ok=true.
Assert-ReportOk (Join-Path $StageRoot 'deployment-verification.json')
Assert-ReportOk (Join-Path $StageRoot 'package-verification-z8.json')

$plan = Get-Content -LiteralPath $PlanPath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
if ($plan.schema -ne 'xueness.cleanup-plan.v1' -or $plan.executionState -ne 'prepared-not-run') {
    throw 'Cleanup plan schema or execution state is not the expected review plan.'
}
if ((Normalize-FullPath $plan.appsRoot) -ne (Normalize-FullPath $AppsRoot)) {
    throw 'Cleanup plan appsRoot does not match the fixed allowlisted root.'
}
$planDirectories = @($plan.directoryTargets | ForEach-Object { (Normalize-FullPath $_.path).Substring((Normalize-FullPath $AppsRoot).Length).TrimStart('\') } | Sort-Object)
$expectedDirectories = @($ExpectedDirectoryRelatives | Sort-Object)
if (($planDirectories -join [Environment]::NewLine) -ne ($expectedDirectories -join [Environment]::NewLine)) {
    throw 'Cleanup plan directory targets differ from the fixed script allowlist.'
}
$planFiles = @($plan.fileTargets | ForEach-Object { (Normalize-FullPath $_.path).Substring((Normalize-FullPath $AppsRoot).Length).TrimStart('\') } | Sort-Object)
$expectedFiles = @($ExpectedFileRelatives | Sort-Object)
if (($planFiles -join [Environment]::NewLine) -ne ($expectedFiles -join [Environment]::NewLine)) {
    throw 'Cleanup plan file targets differ from the fixed script allowlist.'
}
foreach ($fileEntry in $plan.fileTargets) {
    $relative = (Normalize-FullPath $fileEntry.path).Substring((Normalize-FullPath $AppsRoot).Length).TrimStart('\')
    if ([long] $fileEntry.sizeBytes -ne [long] $ExpectedFileSizes[$relative]) {
        throw "Cleanup plan file size differs from the inventory: $relative"
    }
}

$directoryTargets = @()
foreach ($relative in $ExpectedDirectoryRelatives) {
    $target = Normalize-FullPath (Join-Path $AppsRoot $relative)
    $null = Assert-SafePath $target $AppsRoot
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { throw "Planned directory target is not a directory: $target" }
    foreach ($protected in $ProtectedPaths) {
        if ((Normalize-FullPath $target).Equals((Normalize-FullPath $protected), [System.StringComparison]::OrdinalIgnoreCase) -or
            (Test-IsInside $target $protected) -or (Test-IsInside $protected $target)) {
            throw "Planned directory target overlaps a protected path: $target"
        }
    }
    $directoryTargets += $target
}
$fileTargets = @()
foreach ($relative in $ExpectedFileRelatives) {
    $target = Normalize-FullPath (Join-Path $AppsRoot $relative)
    $null = Assert-SafePath $target $AppsRoot
    $item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
    if ($item.PSIsContainer) { throw "Planned file target is a directory: $target" }
    foreach ($protected in $ProtectedPaths) {
        if ((Normalize-FullPath $target).Equals((Normalize-FullPath $protected), [System.StringComparison]::OrdinalIgnoreCase) -or
            (Test-IsInside $target $protected)) {
            throw "Planned file target overlaps a protected path: $target"
        }
    }
    $fileTargets += $target
}

# Build and validate every preservation job before performing any move.
$preserveJobs = New-Object 'System.Collections.Generic.List[object]'
foreach ($name in $MixedBackupNames) {
    $backup = Normalize-FullPath (Join-Path (Join-Path $AppsRoot 'backups') $name)
    $source = Normalize-FullPath (Join-Path $backup 'user-data')
    $destination = Normalize-FullPath (Join-Path (Join-Path $PreservedRoot $name) 'user-data')
    $manifestSource = Normalize-FullPath (Join-Path $backup 'before-manifest.json')
    $manifestDestination = Normalize-FullPath (Join-Path (Join-Path $PreservedRoot $name) 'before-manifest.json')
    $null = Assert-SafePath $source $backup
    $null = Assert-SafePath $manifestSource $backup
    $null = Assert-SafePath $destination $AppsRoot -AllowMissingLeaf
    $null = Assert-SafePath $manifestDestination $AppsRoot -AllowMissingLeaf
    if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $manifestDestination)) {
        throw "Preserved destination already exists for backup: $name"
    }
    $preserveJobs.Add([pscustomobject] @{ Source = $source; TargetRoot = $backup; Destination = $destination; ManifestSource = $manifestSource; ManifestDestination = $manifestDestination; Kind = 'mixed-backup' })
}
$stateBackup = Normalize-FullPath (Join-Path $AppsRoot $StateOnlyBackupName)
$stateSource = Normalize-FullPath (Join-Path $stateBackup 'state')
$stateDestination = Normalize-FullPath (Join-Path (Join-Path $PreservedRoot $StateOnlyBackupName) 'state')
$null = Assert-SafePath $stateSource $stateBackup
$null = Assert-SafePath $stateDestination $AppsRoot -AllowMissingLeaf
if (Test-Path -LiteralPath $stateDestination) { throw 'Preserved state-only backup destination already exists.' }
$preserveJobs.Add([pscustomobject] @{ Source = $stateSource; TargetRoot = $stateBackup; Destination = $stateDestination; Kind = 'state-only-backup' })

$specialBackupPaths = @($MixedBackupNames | ForEach-Object { Normalize-FullPath (Join-Path (Join-Path $AppsRoot 'backups') $_) }) + @($stateBackup)
$genericTargets = @($directoryTargets | Where-Object { $_ -notin $specialBackupPaths })
foreach ($target in $genericTargets) {
    foreach ($source in (Get-TargetRuntimeData $target)) {
        $null = Assert-SafePath $source $target
        $relative = $source.Substring((Normalize-FullPath $target).Length).TrimStart('\')
        if ([string]::IsNullOrWhiteSpace($relative)) { throw "Runtime data path has no target-relative name: $source" }
        $destination = Normalize-FullPath (Join-Path (Join-Path $PreservedRoot (Split-Path -Leaf $target)) $relative)
        $null = Assert-SafePath $destination $AppsRoot -AllowMissingLeaf
        if (Test-Path -LiteralPath $destination) { throw "Preserved runtime data destination already exists: $destination" }
        $preserveJobs.Add([pscustomobject] @{ Source = $source; TargetRoot = $target; Destination = $destination; Kind = 'target-runtime-data' })
    }
}
foreach ($job in $preserveJobs) {
    if ($job.Kind -eq 'mixed-backup') { $null = Assert-SafePath $job.ManifestSource $job.TargetRoot }
    $null = Get-TreeSha256 $job.Source
}

Ensure-ContainedDirectory $PreservedRoot $AppsRoot
$preservedCount = 0
foreach ($job in $preserveJobs) {
    $null = Preserve-DataTree $job.Source $job.TargetRoot $job.Destination
    if ($job.Kind -eq 'mixed-backup') {
        Ensure-ContainedDirectory (Split-Path -Parent $job.ManifestDestination) $AppsRoot
        if (Test-Path -LiteralPath $job.ManifestDestination) {
            throw "Backup manifest destination already exists: $($job.ManifestDestination)"
        }
        $sourceManifestHash = (Get-FileHash -LiteralPath $job.ManifestSource -Algorithm SHA256 -ErrorAction Stop).Hash
        Copy-Item -LiteralPath $job.ManifestSource -Destination $job.ManifestDestination -ErrorAction Stop
        $copiedManifestHash = (Get-FileHash -LiteralPath $job.ManifestDestination -Algorithm SHA256 -ErrorAction Stop).Hash
        if ($sourceManifestHash -ne $copiedManifestHash) {
            throw "Backup manifest copy hash mismatch: $($job.ManifestSource)"
        }
    }
    $preservedCount++
}

# Re-check every exact target immediately before removal.
$deletedDirectories = New-Object 'System.Collections.Generic.List[string]'
foreach ($target in $directoryTargets) {
    $null = Assert-SafePath $target $AppsRoot
    if (-not (Test-IsInside $target $AppsRoot)) { throw "Refusing recursive deletion outside appsRoot: $target" }
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $target) { throw "Directory target remains after removal: $target" }
    $deletedDirectories.Add($target)
}
$deletedFiles = New-Object 'System.Collections.Generic.List[string]'
foreach ($target in $fileTargets) {
    $null = Assert-SafePath $target $AppsRoot
    if (-not (Test-IsInside $target (Join-Path $AppsRoot 'downloads'))) {
        throw "Refusing file deletion outside the exact downloads folder: $target"
    }
    Remove-Item -LiteralPath $target -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $target) { throw "File target remains after removal: $target" }
    $deletedFiles.Add($target)
}

Write-Output 'Cleanup completed.'
Write-Output ('Deleted directories: ' + $deletedDirectories.Count)
foreach ($path in $deletedDirectories) { Write-Output ('  ' + $path) }
Write-Output ('Deleted files: ' + $deletedFiles.Count)
foreach ($path in $deletedFiles) { Write-Output ('  ' + $path) }
Write-Output ('Successfully preserved data trees: ' + $preservedCount)
