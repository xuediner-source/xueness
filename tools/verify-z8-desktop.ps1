[CmdletBinding()]
param(
  [string]$ApplicationDirectory = (Join-Path $PSScriptRoot '..\desktop\release\win-unpacked'),
  [ValidateSet('packaged', 'installed')]
  [string]$Label = 'packaged',
  [Parameter(Mandatory = $true)]
  [string]$EvidenceDir,
  [switch]$CaptureLaunchDiagnostics,
  [switch]$ClearCompatibilityDiagnostic
)

$ErrorActionPreference = 'Stop'
$process = $null
$processStartTimeTicks = 0L
$appStillRunning = $false
$failure = $null
$killAttempted = $false
$summary = $null
$resolvedData = $null
$resolvedEvidence = $null
$reportPath = $null
$screenshotsPath = $null
$launchLogPath = $null
$stdoutTask = $null
$stderrTask = $null
$environmentNames = @(
  'XUENESS_ALLOW_REAL',
  'XUENESS_DESKTOP_DATA',
  'XUENESS_DESKTOP_SMOKE_FILE',
  'XUENESS_DESKTOP_SMOKE_SCREENSHOTS',
  'ELECTRON_RUN_AS_NODE'
)
$savedEnvironment = @{}
foreach ($name in $environmentNames) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Stop-LaunchedProcessTree {
  param([int]$ProcessId, [long]$ExpectedStartTimeTicks)

  $live = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $live) { return $false }
  try {
    if ($live.StartTime.ToUniversalTime().Ticks -ne $ExpectedStartTimeTicks) { return $false }
  } catch {
    return $false
  }

  $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  if (-not (Test-Path -LiteralPath $taskkill -PathType Leaf)) { return $false }
  & $taskkill /PID ([string]$ProcessId) /T /F 2>&1 | Out-Null
  return $true
}

try {
  $resolvedApplication = (Resolve-Path -LiteralPath $ApplicationDirectory).Path
  $executable = Join-Path $resolvedApplication 'Xueness.exe'
  if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Xueness.exe was not found in the requested application directory: $resolvedApplication"
  }

  $resolvedEvidence = [IO.Path]::GetFullPath($EvidenceDir)
  [IO.Directory]::CreateDirectory($resolvedEvidence) | Out-Null
  $reportPath = Join-Path $resolvedEvidence "z8-desktop-$Label.json"
  $screenshotsPath = Join-Path $resolvedEvidence "z8-desktop-$Label-appearance"
  if ($CaptureLaunchDiagnostics) { $launchLogPath = Join-Path $resolvedEvidence "z8-desktop-$Label-launch.log" }
  [IO.Directory]::CreateDirectory($screenshotsPath) | Out-Null

  $tempParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedData = Join-Path $tempParent ("xueness-z8-desktop-{0}-{1}" -f $Label, [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($resolvedData) | Out-Null
  $pluginStateDirectory = Join-Path $resolvedData 'state'
  [IO.Directory]::CreateDirectory($pluginStateDirectory) | Out-Null
  $pluginState = Join-Path $pluginStateDirectory 'plugin-state.json'
  [IO.File]::WriteAllText($pluginState, '{"apiVersion":1,"enabled":{"updates":false}}', [Text.UTF8Encoding]::new($false))

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $executable
  $startInfo.WorkingDirectory = $resolvedApplication
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.EnvironmentVariables['TEMP'] = $env:TEMP
  $startInfo.EnvironmentVariables['TMP'] = $env:TMP
  $startInfo.EnvironmentVariables['XUENESS_ALLOW_REAL'] = '0'
  $startInfo.EnvironmentVariables['XUENESS_DESKTOP_DATA'] = $resolvedData
  $startInfo.EnvironmentVariables['XUENESS_DESKTOP_SMOKE_FILE'] = $reportPath
  $startInfo.EnvironmentVariables['XUENESS_DESKTOP_SMOKE_SCREENSHOTS'] = $screenshotsPath
  [void]$startInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')
  if ($ClearCompatibilityDiagnostic) { [void]$startInfo.EnvironmentVariables.Remove('__COMPAT_LAYER') }
  if ($CaptureLaunchDiagnostics) {
    $startInfo.Arguments = '--enable-logging=stderr --v=1'
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
  }
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw 'Windows did not create the packaged desktop process.' }
  $processStartTimeTicks = $process.StartTime.ToUniversalTime().Ticks
  if ($CaptureLaunchDiagnostics) {
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
  }
  $deadline = (Get-Date).AddSeconds(90)
  $exited = $false
  while ((Get-Date) -lt $deadline) {
    try { $process.Refresh() } catch { }
    if ($process.HasExited) { $exited = $true; break }
    $remainingMs = [Math]::Max(1, [Math]::Min(1000, [int]($deadline - (Get-Date)).TotalMilliseconds))
    Start-Sleep -Milliseconds $remainingMs
  }
  if (-not $exited) {
    try { $process.Refresh() } catch { }
    $exited = $process.HasExited
  }
  if (-not $exited) { throw 'Packaged desktop smoke did not exit within 90 seconds.' }
  $process.WaitForExit()
  if ($CaptureLaunchDiagnostics) {
    $stdoutText = $stdoutTask.GetAwaiter().GetResult()
    $stderrText = $stderrTask.GetAwaiter().GetResult()
    $launchText = "=== stdout ===`r`n$stdoutText`r`n=== stderr ===`r`n$stderrText"
    [IO.File]::WriteAllText($launchLogPath, $launchText, [Text.UTF8Encoding]::new($false))
  }
  if ($process.ExitCode -ne 0) { throw "Packaged desktop exited with code $($process.ExitCode)." }
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { throw 'Packaged desktop exited without writing its smoke report.' }

  $smoke = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if ($null -ne $smoke.error) { throw "Desktop smoke reported an error: $($smoke.error) $($smoke.reason)" }
  if ($smoke.workbenchReady -ne $true) { throw 'Smoke report does not confirm workbenchReady.' }
  $catalogCount = @(Get-ChildItem -LiteralPath (Join-Path $resolvedApplication 'resources/backend-ts/catalog') -Filter '*.json' -File).Count
  if ([int]$smoke.plugins -ne $catalogCount) { throw "Smoke report expected $catalogCount plugins but found $($smoke.plugins)." }
  if ($smoke.PSObject.Properties.Name -contains 'modelRequests') {
    if ([int]$smoke.modelRequests -ne 0) { throw "Smoke report observed model requests: $($smoke.modelRequests)." }
  } elseif ($startInfo.EnvironmentVariables['XUENESS_ALLOW_REAL'] -ne '0') {
    throw 'Real model requests were not disabled for the smoke run.'
  }
  if ([int]$smoke.permissionPostRequests -ne 0 -or $smoke.noPermissionRequests -ne $true) {
    throw "Smoke report observed a desktop permission request POST: $($smoke.permissionPostRequests)."
  }

  $appearanceRows = @($smoke.appearanceChecks)
  $expectedAppearances = @('claudex-dark.png', 'claudex-light.png', 'xueness-dark.png', 'xueness-light.png')
  if ($appearanceRows.Count -ne 4) { throw "Smoke report expected four appearance checks but found $($appearanceRows.Count)." }
  $appearanceKeys = @($appearanceRows | ForEach-Object { "$($_.palette)-$($_.theme).png" } | Sort-Object)
  if (($appearanceKeys -join '|') -ne ($expectedAppearances -join '|')) { throw "Unexpected appearance checks: $($appearanceKeys -join ', ')" }
  $missingScreenshots = @($expectedAppearances | Where-Object {
    $path = Join-Path $screenshotsPath $_
    -not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -le 0
  })
  if ($missingScreenshots.Count -gt 0) { throw "Appearance screenshots missing or empty: $($missingScreenshots -join ', ')" }

  $summary = [ordered]@{
    schema = 'xueness.z8.desktop-smoke.v1'
    ok = $true
    label = $Label
    executable = $executable
    isolatedDataDirectory = $resolvedData
    smokeReport = $reportPath
    launchLog = $launchLogPath
    compatibilityDiagnosticClearedForChild = [bool]$ClearCompatibilityDiagnostic
    workbenchReady = $smoke.workbenchReady
    plugins = [int]$smoke.plugins
    modelRequests = @{ observed = 0; realRequestsDisabled = $true; flow = 'startup smoke only; no session run' }
    permissionPostRequests = [int]$smoke.permissionPostRequests
    screenshots = $expectedAppearances
  }
} catch {
  $failure = $_.Exception.Message
  if ($null -ne $process) {
    $stillRunning = $false
    try { $process.Refresh(); $stillRunning = -not $process.HasExited } catch { }
    if ($stillRunning -and $processStartTimeTicks -gt 0) {
      try { $killAttempted = Stop-LaunchedProcessTree -ProcessId $process.Id -ExpectedStartTimeTicks $processStartTimeTicks } catch { }
      for ($attempt = 0; $attempt -lt 5; $attempt++) {
        try { $process.Refresh(); $stillRunning = -not $process.HasExited } catch { $stillRunning = $false }
        if (-not $stillRunning) { break }
        Start-Sleep -Milliseconds 500
      }
      $appStillRunning = $stillRunning
    }
  }
} finally {
  foreach ($name in $environmentNames) {
    $prior = $savedEnvironment[$name]
    if ($null -eq $prior) { Remove-Item -LiteralPath ("Env:" + $name) -ErrorAction SilentlyContinue }
    else { Set-Item -LiteralPath ("Env:" + $name) -Value $prior }
  }
  if ($null -ne $resolvedData -and (Test-Path -LiteralPath $resolvedData) -and -not $appStillRunning) {
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    $dataFullPath = [IO.Path]::GetFullPath($resolvedData)
    $expectedLeaf = '^xueness-z8-desktop-' + [regex]::Escape($Label) + '-[a-f0-9]{32}$'
    if (-not $dataFullPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($dataFullPath) -notmatch $expectedLeaf) {
      throw "Refusing to remove unexpected temporary data path: $dataFullPath"
    }
    Remove-Item -LiteralPath $dataFullPath -Recurse -Force
  }
}

if ($null -ne $failure) {
  $failureSummary = [ordered]@{
    schema = 'xueness.z8.desktop-smoke.v1'
    ok = $false
    label = $Label
    error = $failure
    reportPath = $reportPath
    launchLogPath = $launchLogPath
    compatibilityDiagnosticClearedForChild = [bool]$ClearCompatibilityDiagnostic
    processTreeKillAttempted = $killAttempted
    processStillRunning = $appStillRunning
    retainedIsolatedDataDirectory = if ($appStillRunning) { $resolvedData } else { $null }
  }
  Write-Output ($failureSummary | ConvertTo-Json -Depth 6)
  exit 1
}

Write-Output ($summary | ConvertTo-Json -Depth 6)
