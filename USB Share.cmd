@echo off
rem Double-click: plug-and-go auto mode.  Or:  "USB Share.cmd" menu | on | off | status | watch
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0USB-Share.ps1" %*
