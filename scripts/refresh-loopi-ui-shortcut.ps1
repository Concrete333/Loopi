param(
  [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'

$resolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$launcherPath = Join-Path $resolvedProjectRoot 'Launch Loopi UI.cmd'
$shortcutPath = Join-Path $resolvedProjectRoot 'Launch Loopi UI.lnk'
$iconPath = Join-Path $resolvedProjectRoot 'apps\ui\public\loopi-launcher.ico'

if (-not (Test-Path -LiteralPath $launcherPath)) {
  throw "Launcher file is missing: $launcherPath"
}

if (-not (Test-Path -LiteralPath $iconPath)) {
  throw "Launcher icon is missing: $iconPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $resolvedProjectRoot
$shortcut.Description = 'Launch the local Loopi UI'
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Save()
