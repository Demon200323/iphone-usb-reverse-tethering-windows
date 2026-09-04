# One-time setup for iPhone USB reverse tethering on Windows. Run once, as admin, with the iPhone plugged in.
# Everything it changes is listed in README.md and reverted by Uninstall.ps1.
#
#   1. pyusb for the current Python
#   2. libusb-win32 1.4.0.2 (downloaded from the GitHub release, SHA-256 verified): filter driver on the
#      iPhone composite device only, libusb0.dll next to the scripts, libusb0.sys into System32\drivers
#   3. usbccgp: CDC enumeration on (EnumeratorClass), safe configuration index, Apple's lower filter detached
#   4. verification: GET_MODE through the filter must answer 3:3:3:0

$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$Zip    = 'https://github.com/mcuee/libusb-win32/releases/download/release_1.4.0.2/libusb-win32-bin-1.4.0.2.zip'
$ZipSha = '00004c92cdb99be36e17fb2377165eb97e63b48ba895bfc04a642ea9c3e26d94'
$Tools  = Join-Path $PSScriptRoot 'libusb-win32'
$HwId   = 'USB\VID_05AC&PID_12A8'
$Arch   = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }

function Step($n) { Write-Host "`n== $n" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Info($m) { Write-Host "   $m" }

try {
    Step 'Python + pyusb'
    $py = Get-Command python -ErrorAction SilentlyContinue
    if (-not $py) { throw 'python not found on PATH. Install Python 3 (python.org) and tick "Add to PATH".' }
    Info "python: $($py.Source)"
    $null = & python -c 'import usb.core' 2>&1
    if ($LASTEXITCODE -ne 0) { Info 'installing pyusb...'; & python -m pip install --quiet pyusb; if ($LASTEXITCODE -ne 0) { throw 'pip install pyusb failed' } }
    Ok 'pyusb available'

    Step 'libusb-win32 1.4.0.2'
    $exe = Join-Path $Tools "bin\$Arch\install-filter.exe"
    if (-not (Test-Path $exe)) {
        $tmp = Join-Path $env:TEMP 'libusb-win32-bin-1.4.0.2.zip'
        Info "downloading $Zip"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $Zip -OutFile $tmp -UseBasicParsing
        $h = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
        if ($h -ne $ZipSha) { Remove-Item $tmp -Force; throw "SHA-256 mismatch for libusb-win32 zip: $h" }
        Ok 'SHA-256 verified'
        Expand-Archive -Path $tmp -DestinationPath $env:TEMP -Force
        Move-Item (Join-Path $env:TEMP 'libusb-win32-bin-1.4.0.2') $Tools -Force
        Remove-Item $tmp -Force
    }
    $sig = Get-AuthenticodeSignature (Join-Path $Tools 'bin\libusb0.cat')
    if ($sig.Status -ne 'Valid') { throw "libusb0.cat signature not valid: $($sig.Status)" }
    Info "catalog signer: $($sig.SignerCertificate.Subject.Split(',')[0])"
    Copy-Item (Join-Path $Tools "bin\$Arch\libusb0.dll") (Join-Path $PSScriptRoot 'libusb0.dll') -Force
    Ok 'libusb0.dll placed next to the scripts'

    Step 'iPhone on USB'
    $phone = Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\VID_05AC&PID_12A[0-9A-F]\\[^&]+$' } | Select-Object -First 1
    if (-not $phone) { throw 'No iPhone on USB. Plug it in with a data cable (unlock it once if it has been locked for a while) and run Setup again.' }
    $id = $phone.InstanceId
    Info "$($phone.FriendlyName) [$($phone.Status)] $id"

    Step 'libusb-win32 filter driver on the iPhone composite device'
    if (-not (Get-Service libusb0 -ErrorAction SilentlyContinue) -or -not ((Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Enum\$id").UpperFilters -contains 'libusb0')) {
        & $exe install "--device=$HwId" | Out-Null
    }
    # the installer registers the service but does not copy the driver file (skip if already loaded)
    $sysDst = "$env:SystemRoot\System32\drivers\libusb0.sys"
    if (-not (Test-Path $sysDst) -or (Get-Service libusb0 -ErrorAction SilentlyContinue).Status -ne 'Running') {
        Copy-Item (Join-Path $Tools "bin\$Arch\libusb0.sys") $sysDst -Force
        try { Start-Service libusb0 -ErrorAction Stop } catch { }
    }
    Ok "filter installed, service $((Get-Service libusb0).Status)"

    Step 'usbccgp configuration'
    $enumKey = "HKLM:\SYSTEM\CurrentControlSet\Enum\$id"
    $drv = (Get-ItemProperty $enumKey).Driver
    if (-not $drv) { throw 'device has no driver key (usbccgp not bound?)' }
    $swKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\$drv"
    Set-ItemProperty $swKey EnumeratorClass ([byte[]](0x02, 0x00, 0x00)) -Type Binary
    Info "EnumeratorClass = 02 00 00 on $swKey"
    $lf = (Get-ItemProperty $enumKey).LowerFilters
    if ($lf -contains 'AppleLowerFilter') {
        $rest = @($lf | Where-Object { $_ -ne 'AppleLowerFilter' })
        if ($rest.Count) { Set-ItemProperty $enumKey LowerFilters ([string[]]$rest) -Type MultiString } else { Remove-ItemProperty $enumKey LowerFilters }
        Info 'AppleLowerFilter detached from the iPhone device (it forces USB configuration 1)'
    }
    $hk = "$enumKey\Device Parameters"
    Set-ItemProperty $hk OriginalConfigurationValue 2 -Type DWord
    Set-ItemProperty $hk AltConfigurationValue 0 -Type DWord
    Info 'OriginalConfigurationValue = 2 (safe: PTP + usbmux)'
    pnputil /restart-device "$id" | Out-Null
    $t = 0; while ($t -lt 25 -and (Get-PnpDevice -InstanceId $id).Status -ne 'OK') { Start-Sleep 1; $t++ }
    Ok "device restarted: $((Get-PnpDevice -InstanceId $id).Status)"

    Step 'verification'
    Start-Sleep 3
    $out = & python (Join-Path $PSScriptRoot 'iphone_mode.py') get 2>&1
    Info ($out -join ' | ')
    if ($LASTEXITCODE -ne 0) { throw 'the mode tool cannot reach the phone through the filter yet - unplug/replug and run: USB-Share.ps1 status' }
    Ok 'phone reachable through the filter'
    Write-Host ''
    Write-Host '  Setup complete. Double-click "USB Share.cmd" to start sharing.' -ForegroundColor Green
}
catch {
    Write-Host ''
    Write-Host "  SETUP FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
if (-not [Console]::IsInputRedirected) { Write-Host ''; Write-Host 'Press any key to close...'; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') }
