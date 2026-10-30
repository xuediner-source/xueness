# User-scoped, self-contained Windows CLI installation (PowerShell 5.1+).
param(
    [string]$InstallDir = $env:XUENESS_INSTALL_DIR,
    [string]$ManifestUrl = $env:XUENESS_CLI_MANIFEST_URL,
    [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports Windows x64.' }
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw "Windows $architecture is not published yet; use the source CLI." }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\XuenessCLI' }
if (-not $ManifestUrl) { $ManifestUrl = 'https://raw.githubusercontent.com/xuediner-source/xueness/main/cli/latest.json' }
$NoPath = $NoPath -or $env:XUENESS_INSTALL_NO_PATH -eq '1'
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$headers = @{ 'User-Agent' = 'Xueness-CLI-Installer' }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Test-DownloadUri([string]$Value) {
    $uri = [Uri]$Value
    if ($uri.Scheme -ne 'https' -and -not ($uri.Scheme -eq 'http' -and $uri.IsLoopback)) { throw 'Downloads require HTTPS (HTTP is allowed only for loopback verification).' }
}
function Assert-OwnedPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = $InstallDir.TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Installation path escaped its root: $absolute" }
    $parent = $absolute
    while ($parent -and $parent.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $parent) {
            if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Installation path is a link: $parent" }
        }
        if ($parent -eq $InstallDir) { break }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
}
function Write-AtomicUtf8([string]$Path, [string]$Content) {
    $temporary = $Path + '.new-' + [Guid]::NewGuid().ToString('N')
    $backup = $temporary + '.previous'
    [IO.File]::WriteAllText($temporary, $Content, (New-Object Text.UTF8Encoding($false)))
    try {
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $backup) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        foreach ($leftover in @($temporary, $backup)) { if (Test-Path -LiteralPath $leftover) { Remove-Item -LiteralPath $leftover -Force } }
    }
}

Test-DownloadUri $ManifestUrl
Write-Host 'Xueness CLI - Windows x64' -ForegroundColor Cyan
$release = Invoke-RestMethod -Uri $ManifestUrl -Headers $headers -TimeoutSec 60
if ($release.schemaVersion -ne 1 -or $release.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Unsupported CLI release manifest.' }
$asset = $release.platforms.'windows-x64'
if (-not $asset -or $asset.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'This release has no valid Windows x64 archive.' }
Test-DownloadUri $asset.url
$bin = Join-Path $InstallDir 'bin'
$versions = Join-Path $InstallDir 'versions'
$versionDir = Join-Path $versions $release.version
$command = Join-Path $bin 'xueness.cmd'
foreach ($path in @($bin, $versions, $versionDir, $command)) { Assert-OwnedPath $path }
if ((Test-Path -LiteralPath $command) -and -not ([IO.File]::ReadAllText($command).Contains('Xueness CLI launcher'))) { throw "A different launcher already exists at $command" }
New-Item -ItemType Directory -Path $bin, $versions -Force | Out-Null
$receiptPath = Join-Path $versionDir 'install-receipt.json'
$installed = $false
if (Test-Path -LiteralPath $receiptPath) {
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $installed = $receipt.sha256 -eq $asset.sha256 -and (Test-Path -LiteralPath (Join-Path $versionDir 'backend-ts\runtime\node.exe')) -and (Test-Path -LiteralPath (Join-Path $versionDir 'cli-launcher.cjs'))
}
if (-not $installed) {
    if (Test-Path -LiteralPath $versionDir) { throw "An incomplete or different copy exists at $versionDir. The active CLI has not been changed." }
    $staging = Join-Path $InstallDir ('.staging-' + [Guid]::NewGuid().ToString('N'))
    Assert-OwnedPath $staging
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
        $archive = Join-Path $staging 'cli.zip'
        Write-Host "Downloading Xueness CLI $($release.version)..."
        Invoke-WebRequest -Uri $asset.url -OutFile $archive -Headers $headers -UseBasicParsing -TimeoutSec 600
        $hash = [Security.Cryptography.SHA256]::Create()
        $archiveStream = [IO.File]::OpenRead($archive)
        try { $actualHash = [BitConverter]::ToString($hash.ComputeHash($archiveStream)).Replace('-', '') }
        finally { $archiveStream.Dispose(); $hash.Dispose() }
        if ($actualHash -ine $asset.sha256) { throw 'CLI archive SHA256 verification failed. The active CLI has not been changed.' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName -match '(^[\\/]|(^|[\\/])\.\.($|[\\/])|:)' -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'CLI archive contains an unsafe path or link.' }
            }
        } finally { $zip.Dispose() }
        $payload = Join-Path $staging 'payload'
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $payload)
        $node = Join-Path $payload 'backend-ts\runtime\node.exe'
        $launcher = Join-Path $payload 'cli-launcher.cjs'
        foreach ($required in @($node, $launcher, (Join-Path $payload 'backend-ts\apps\server\src\cli\main.js'), (Join-Path $payload 'backend-ts\runtime\LICENSE.node'))) {
            if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "CLI archive is incomplete: $required" }
        }
        $metadata = Get-Content -LiteralPath (Join-Path $payload 'cli-release.json') -Raw | ConvertFrom-Json
        if ($metadata.version -ne $release.version -or $metadata.platform -ne 'windows-x64') { throw 'CLI archive does not match its release manifest.' }
        $probe = & $node $launcher --version
        if ($LASTEXITCODE -ne 0 -or -not "$probe".StartsWith("Xueness CLI $($release.version) ")) { throw 'The downloaded CLI did not start correctly.' }
        [IO.File]::WriteAllText((Join-Path $payload 'install-receipt.json'), (@{ version = $release.version; sha256 = $asset.sha256; installedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $payload -Destination $versionDir
    } finally {
        Assert-OwnedPath $staging
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    }
}
$shim = "@echo off`r`n:: Xueness CLI launcher`r`nsetlocal DisableDelayedExpansion`r`n`"%~dp0..\versions\$($release.version)\backend-ts\runtime\node.exe`" `"%~dp0..\versions\$($release.version)\cli-launcher.cjs`" %*`r`nexit /b %errorlevel%`r`n"
Write-AtomicUtf8 $command $shim
if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (@($userPath -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') })) {
        [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $userPath).TrimEnd(';'), 'User')
    }
    if (-not (@($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') })) { $env:Path = $bin + ';' + $env:Path }
    if (-not ('XuenessInstaller.EnvironmentBroadcast' -as [type])) {
        Add-Type 'using System; using System.Runtime.InteropServices; namespace XuenessInstaller { public class EnvironmentBroadcast { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr param, string value, uint flags, uint timeout, out UIntPtr result); } }'
    }
    $broadcastResult = [UIntPtr]::Zero
    [void][XuenessInstaller.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]65535, 26, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$broadcastResult)
}
Write-Host "Installed Xueness CLI $($release.version)" -ForegroundColor Green
Write-Host "Command: $command"
Write-Host 'Run: xueness onboarding   (configure your model), then xueness'
Write-Host 'Update: run the same installation command again. Your ~/.xueness/state is preserved.'
