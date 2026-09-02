param(
  [ValidateSet("Install", "Remove")]
  [string]$Action = "Install",
  [Parameter(Mandatory = $true)]
  [string]$DistroName
)

$taskName = "ResourceDeck-$DistroName"
if ($Action -eq "Remove") {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed Windows login task: $taskName"
  exit 0
}

$wsl = Join-Path $env:WINDIR "System32\wsl.exe"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$actionSpec = New-ScheduledTaskAction -Execute $wsl -Argument "-d `"$DistroName`" --exec /bin/true"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $actionSpec -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "Installed Windows login task: $taskName"
