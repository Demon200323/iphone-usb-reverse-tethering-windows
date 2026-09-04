# Reverts everything Setup.ps1 changed. Run as admin; the iPhone may be plugged in or not.
$ErrorActionPreference = 'Continue'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}
$Tools = Join-Path $PSScriptRoot 'libusb-win32'
$Arch  = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
function Info($m) { Write-Host "   $m" }

Write-Host "`n== Internet Connection Sharing off" -ForegroundColor Cyan
try { $ics = New-Object -ComObject HNetCfg.HNetShare; foreach ($c in @($ics.EnumEveryConnection)) { $s = $ics.INetSharingConfigurationForINetConnection($c); if ($s.SharingEnabled) { $s.DisableSharing(); Info "disabled on $($ics.NetConnectionProps($c).Name)" } } } catch { }

Write-Host "`n== iPhone device keys (all known instances)" -ForegroundColor Cyan
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB' | Where-Object { $_.PSChildName -match '^VID_05AC&PID_12A[0-9A-F]$' } | ForEach-Object {
    Get-ChildItem $_.PSPath | ForEach-Object {
        $k = $_.PSPath; $p = Get-ItemProperty $k
        if ($p.UpperFilters -contains 'libusb0') { $rest = @($p.UpperFilters | Where-Object { $_ -ne 'libusb0' }); if ($rest.Count) { Set-ItemProperty $k UpperFilters ([string[]]$rest) -Type MultiString } else { Remove-ItemProperty $k UpperFilters }; Info "libusb0 upper filter removed: $($_.PSChildName)" }
        if (-not ($p.LowerFilters -contains 'AppleLowerFilter') -and (Get-Service AppleLowerFilter -ErrorAction SilentlyContinue)) { Set-ItemProperty $k LowerFilters ([string[]]@('AppleLowerFilter')) -Type MultiString; Info "AppleLowerFilter restored: $($_.PSChildName)" }
        $dp = Join-Path $k 'Device Parameters'
        if (Test-Path $dp) { Set-ItemProperty $dp OriginalConfigurationValue 0 -Type DWord; Set-ItemProperty $dp AltConfigurationValue 0 -Type DWord }
        if ($p.Driver) { Remove-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Class\$($p.Driver)" EnumeratorClass -ErrorAction SilentlyContinue; Info "EnumeratorClass removed from $($p.Driver)" }
    }
}
# photo-import interface(s) the script disabled
Get-PnpDevice | Where-Object { $_.InstanceId -like 'USB\VID_05AC&PID_12A*MI_00\*' -and $_.Problem -eq 'CM_PROB_DISABLED' } | ForEach-Object { pnputil /enable-device "$($_.InstanceId)" | Out-Null; Info "photo interface re-enabled: $($_.InstanceId.Split('\')[1])" }

Write-Host "`n== libusb-win32 filter driver" -ForegroundColor Cyan
$exe = Join-Path $Tools "bin\$Arch\install-filter.exe"
if (Test-Path $exe) { & $exe uninstall --all-devices | Out-Null; Info 'install-filter uninstall --all-devices' }
Stop-Service libusb0 -Force -ErrorAction SilentlyContinue
sc.exe delete libusb0 | Out-Null; Info 'libusb0 service deleted'
Remove-Item "$env:SystemRoot\System32\drivers\libusb0.sys" -Force -ErrorAction SilentlyContinue; Info 'libusb0.sys removed'

Write-Host "`n== restart iPhone device (if present)" -ForegroundColor Cyan
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\VID_05AC&PID_12A[0-9A-F]\\[^&]+$' } | ForEach-Object { pnputil /restart-device "$($_.InstanceId)" | Out-Null; Info "restarted $($_.InstanceId)" }

Write-Host "`n  Done. Python package pyusb was left installed (pip uninstall pyusb to remove)." -ForegroundColor Green
if (-not [Console]::IsInputRedirected) { Write-Host ''; Write-Host 'Press any key to close...'; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') }
