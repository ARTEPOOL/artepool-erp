# CI on the Windows runner (M6.2 part F): the server installer from start to finish, as on a
# clean PC. Install silently; check the services, their accounts, /health over TLS 1.3, that the
# database is not reachable on the LAN, the folder rules, the firewall rule, the secrets, a
# "reboot" (services stopped and started); make the shop's encrypted off-site copy; uninstall
# (the data stays); wipe the data as on a new PC; install again; restore the copy as
# administrator through the launcher; check the restored data and the master key; uninstall.
# The emergency tool (decision 0107): its launcher asks for administrator rights, its Start menu
# shortcut, and its program's actions through the launcher (check, password reset, enrollment
# code), recorded in the audit log.
# The desktop app's start at sign-in (a scheduled task for every person, least privilege) and its
# watchdog (it starts the app again only when it stopped while the kiosk lock was on), then the
# desktop app's own uninstaller removes the task.
# Upgrades (decision 0103, M6.2 part G2), with the two test setups `pnpm build:installer
# --test-upgrade` makes: one that works (data kept, its migration applied, a checked pre-upgrade
# copy, the previous programs kept), an older setup refused, and one whose migration fails (the
# database unchanged, the previous version back and answering).
# Reinstall over the kept data (part G3): an older setup refused, the same version's setup uses
# the database and the CA as they were, no wizard. Deleting the data (part G4): refused without
# the owner's password; with it the database, secrets and settings go and the backups stay.
# The install logs are searched for every secret (and the emergency temporary password): none
# may appear.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$data = Join-Path $env:ProgramData 'ARTEPOOL'
$pf = Join-Path $env:ProgramFiles 'ARTEPOOL'
$svc = Join-Path $pf 'artepool-svc.exe'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$work = Join-Path $env:RUNNER_TEMP 'artepool-install-test'
New-Item -ItemType Directory -Force -Path $work | Out-Null
Add-Type -AssemblyName System.Security

function Ok([bool]$condition, [string]$what) {
  if (-not $condition) { throw "FAILED: $what" }
  Write-Host "ok - $what"
}

function Show-Logs {
  if (Test-Path "$data\logs") {
    Get-ChildItem "$data\logs" -Recurse -File | ForEach-Object {
      $file = $_.FullName
      Write-Host "----- $file"
      try { Get-Content $file -Tail 80 -ErrorAction Stop }
      catch { Write-Host "(cannot be read: $($_.Exception.Message))"; & icacls.exe $file 2>&1 | Write-Host }
    }
  }
}

function Install-Server([string]$label) {
  $p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { Show-Logs }
  Ok ($p.ExitCode -eq 0) "$label silent install (exit $($p.ExitCode))"
}

function Uninstall-Server([string]$label, [bool]$dataKept = $true) {
  $p = Start-Process -FilePath "$pf\uninstall.exe" -ArgumentList '/S', "_?=$pf" -Wait -PassThru
  Ok ($p.ExitCode -eq 0) "$label uninstall (exit $($p.ExitCode))"
  Remove-Item -Recurse -Force $pf -ErrorAction SilentlyContinue
  foreach ($name in 'ArtepoolDatabase', 'ArtepoolServer', 'ArtepoolBackup') {
    Ok ($null -eq (Get-Service -Name $name -ErrorAction SilentlyContinue)) "$label service $name removed"
  }
  Ok ($null -eq (Get-NetFirewallRule -DisplayName 'ARTEPOOL Server' -ErrorAction SilentlyContinue)) "$label firewall rule removed"
  Ok ($null -eq (Get-ScheduledTask -TaskName 'ARTEPOOL Updater' -ErrorAction SilentlyContinue)) "$label updater task removed"
  if ($dataKept) { Ok (Test-Path "$data\pgdata\PG_VERSION") "$label the data is kept in ProgramData" }
  Ok (@(Emergency-Shortcuts).Count -eq 0) "$label the emergency tool's shortcut is removed"
  Ok (-not (Test-Path "$pf.previous") -and -not (Test-Path "$pf.failed")) "$label the folders upgrades leave are removed"
}

$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\ARTEPOOL-Server'
function Installed-Version { (Get-ItemProperty $uninstallKey).DisplayVersion }
function Run-Setup([string]$file) { (Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru).ExitCode }
function Version-Of([IO.FileInfo]$setup) { $setup.BaseName -replace '^ARTEPOOL-Server-Setup-', '' }

function Secret([string]$name) {
  $entropy = [Text.Encoding]::UTF8.GetBytes("ARTEPOOL secrets v1/$name")
  $sealed = [IO.File]::ReadAllBytes("$data\secrets\$name.dpapi")
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, 'LocalMachine')
  return [Text.Encoding]::UTF8.GetString($plain)
}

function Psql([string]$sql) {
  $env:PGPASSWORD = Secret 'pg-superuser-password'
  try {
    $port = (Get-Content "$data\config\server.json" -Raw | ConvertFrom-Json).database.port
    $out = & "$pf\pgsql\bin\psql.exe" -h localhost -p $port -U postgres -d artepool -At -v ON_ERROR_STOP=1 -c $sql
    if ($LASTEXITCODE -ne 0) { throw "psql failed: $sql" }
    return $out
  } finally {
    Remove-Item Env:\PGPASSWORD
  }
}

function Check-Health([string]$label) {
  & pnpm exec tsx "$repo\tools\installer\windows\health.ts" "$data\setup\ca.crt" 3100
  Ok ($LASTEXITCODE -eq 0) "$label /health over TLS 1.3"
}

$script:alsoSecret = @()

function Check-Logs-Hold-No-Secret([string]$label) {
  $secrets = @()
  if (Test-Path "$data\secrets") {
    $secrets += @('master-key', 'migrator-password', 'api-password', 'backup-password', 'maint-password', 'pg-superuser-password') |
      ForEach-Object { Secret $_ }
  }
  $secrets += $script:alsoSecret
  if (Test-Path "$data\setup\token") { $secrets += (Get-Content "$data\setup\token" -Raw).Trim() }
  $files = Get-ChildItem "$data\logs" -Recurse -File
  Ok ($files.Count -gt 0) "$label there are logs to check"
  foreach ($file in $files) {
    $text = Get-Content $file.FullName -Raw
    if ($null -eq $text) { continue }
    foreach ($value in $secrets) {
      if ($value.Length -ge 8 -and $text.Contains($value)) { throw "FAILED: a secret is in $($file.FullName)" }
    }
  }
  Ok $true "$label no secret in the $($files.Count) log files"
}

# The Start menu shortcuts that open the emergency tool's launcher.
function Emergency-Shortcuts {
  $shell = New-Object -ComObject WScript.Shell
  Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs" -Filter '*.lnk' |
    Where-Object { $shell.CreateShortcut($_.FullName).TargetPath -like '*\artepool-emergency.exe' }
}

# One emergency action through the launcher, as the emergency window runs it: JSON in, JSON out.
function Emergency([string]$action, [string]$json) {
  $lines = $json | & $svc run emergency $action
  return ($lines | Where-Object { $_ -like '{*' } | Select-Object -Last 1 | ConvertFrom-Json)
}

# ---- 1. A PC where another program already uses PostgreSQL's port 5432 ----
# A first attempt with every database port taken stops (and leaves its secrets); with only 5432
# taken, the setup runs again over what it left and gives the database the next free port.
$listeners = @(5432..5442 | ForEach-Object {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $_)
  $listener.Start()
  $listener
})
$exit = Run-Setup $Installer
Ok ($exit -ne 0) "the setup stops when every database port is taken (exit $exit)"
Ok (Test-Path "$data\secrets\master-key.dpapi") 'the stopped attempt left its secrets'
$listeners | Select-Object -Skip 1 | ForEach-Object { $_.Stop() }
Install-Server 'first'
$listeners[0].Stop()
Ok ((Get-Content "$data\config\server.json" -Raw | ConvertFrom-Json).database.port -eq 5433) 'another program on 5432: the database takes 5433'
foreach ($name in 'ArtepoolDatabase', 'ArtepoolServer', 'ArtepoolBackup') {
  $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
  Ok ($service.State -eq 'Running') "$name is running"
  Ok ($service.StartMode -eq 'Auto') "$name starts with Windows"
  Ok ($service.StartName -eq "NT SERVICE\$name") "$name runs under its own account ($($service.StartName))"
}
Check-Health 'first'
& $svc secrets check
Ok ($LASTEXITCODE -eq 0) 'the six secrets are present, open and well protected'

$lan = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress
$probe = New-Object Net.Sockets.TcpClient
$reached = $false
$databasePort = (Get-Content "$data\config\server.json" -Raw | ConvertFrom-Json).database.port
try { $probe.Connect($lan, $databasePort); $reached = $true } catch { } finally { $probe.Close() }
Ok (-not $reached) "the database is not reachable on the LAN address $lan"

$allowed = @('S-1-5-18', 'S-1-5-32-544')
foreach ($folder in 'pgdata', 'secrets', 'backups', 'logs', 'setup', 'config', 'wal') {
  $acl = Get-Acl "$data\$folder"
  Ok $acl.AreAccessRulesProtected "$folder does not inherit open rules"
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    Ok (($allowed -contains $sid) -or $sid.StartsWith('S-1-5-80-')) "$folder opens only to SYSTEM, Administrators or a service ($($rule.IdentityReference))"
  }
}

$rule = Get-NetFirewallRule -DisplayName 'ARTEPOOL Server'
Ok ($rule.Direction -eq 'Inbound' -and $rule.Action -eq 'Allow') 'one inbound firewall rule'
Ok ([string]$rule.Profile -eq 'Private') "the firewall rule is for private networks ($($rule.Profile))"
Ok ((($rule | Get-NetFirewallAddressFilter).RemoteAddress) -contains 'LocalSubnet') 'the firewall rule is for the local subnet only'
Ok ((($rule | Get-NetFirewallPortFilter).LocalPort) -eq '3100') 'the firewall rule opens the API port only'

# ---- The server PC's updater (decision 0108) ----
$updater = Get-ScheduledTask -TaskName 'ARTEPOOL Updater'
Ok ($updater.Principal.UserId -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')) "the updater runs as SYSTEM ($($updater.Principal.UserId))"
# Task Scheduler keeps the quotes schtasks needs around a path with spaces (and may keep the
# arguments with the program): compare the whole command line without them.
$updaterCommand = "$($updater.Actions[0].Execute) $($updater.Actions[0].Arguments)".Replace('"', '').Trim()
Ok ($updaterCommand -eq "$svc run updater") "the updater runs the launcher ($updaterCommand)"
& $svc run updater
Ok ($LASTEXITCODE -eq 0) 'the updater runs'
Ok ((Psql 'SELECT current_version IS NOT NULL FROM ops.update_state') -eq 't') 'the updater records the version running'
Ok ((Psql 'SELECT check_error FROM ops.update_state') -like '*update key is not set*') 'without the update key no update is accepted'

# ---- The desktop app: start at sign-in and the watchdog (decisions 0082, 0083) ----
$appDir = Join-Path $env:ProgramFiles 'ARTEPOOL ERP'
$appExe = Join-Path $appDir 'artepool-erp.exe'
$task = Get-ScheduledTask -TaskName 'ARTEPOOL ERP'
Ok ($task.Triggers[0].CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') 'the app starts at sign-in'
Ok (@('S-1-5-32-545', 'Users', 'BUILTIN\Users') -contains $task.Principal.GroupId) "for every person ($($task.Principal.GroupId))"
Ok ($task.Principal.RunLevel -eq 'Limited') 'without administrator rights'
Ok ($task.Actions[0].Execute -eq $appExe -and $task.Actions[0].Arguments -eq '--autostart') 'it runs the app with --autostart'
$desktopLog = "$data\logs\install\desktop-app.log"
Ok ((Get-Content $desktopLog -Raw) -match 'start at sign-in \(scheduled task "ARTEPOOL ERP"\): exit code 0') "the desktop app's installer wrote its log"

$stateFile = Join-Path $env:LOCALAPPDATA 'ARTEPOOL\kiosk-state.json'
New-Item -ItemType Directory -Force -Path (Split-Path $stateFile) | Out-Null
function Watchdog-Restarts([bool]$locked, [bool]$running) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Set-Content -Path $stateFile -Value (@{ locked = $locked; running = $running; seenAt = $now; pending = $null } | ConvertTo-Json) -Encoding utf8NoBOM
  $gone = Start-Process -FilePath cmd.exe -ArgumentList '/c', 'exit' -PassThru -WindowStyle Hidden
  $gone.WaitForExit()
  $watchdog = Start-Process -FilePath $appExe -ArgumentList '--watchdog', $gone.Id -PassThru
  $watchdog.WaitForExit(20000) | Out-Null
  $seen = $false
  for ($i = 0; $i -lt 40 -and -not $seen; $i++) {
    $restarted = Get-CimInstance Win32_Process -Filter "Name='artepool-erp.exe'" | Where-Object { $_.CommandLine -like '*--restarted*' }
    $state = Get-Content $stateFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -ErrorAction SilentlyContinue
    $seen = ($null -ne $restarted) -or ($null -ne $state -and $state.pending -eq 'restarted')
    if (-not $seen) { Start-Sleep -Milliseconds 250 }
  }
  & "$env:SystemRoot\System32\taskkill.exe" /F /T /IM artepool-erp.exe 2>$null | Out-Null
  return $seen
}
Ok (-not (Watchdog-Restarts $false $true)) 'the watchdog leaves the app closed when the kiosk lock was off'
Ok (-not (Watchdog-Restarts $true $false)) 'the watchdog leaves the app closed after a normal exit'
Ok (Watchdog-Restarts $true $true) 'the watchdog starts the app again when it stopped while locked'
Remove-Item $stateFile -Force -ErrorAction SilentlyContinue

# ---- 2. A "reboot": the services stopped and started ----
Stop-Service ArtepoolBackup, ArtepoolServer
Stop-Service ArtepoolDatabase
Start-Service ArtepoolDatabase
Start-Service ArtepoolServer, ArtepoolBackup
Check-Health 'after the restart'
Check-Logs-Hold-No-Secret 'first install:'

# ---- 3. The shop's data and its off-site copy ----
"ciowner`nCI Owner`nCI Owner`nblue-pool-water-71`nblue-pool-water-71`n" | & $svc run owner-create
Ok ($LASTEXITCODE -eq 0) 'the owner is created with the console tool'
Psql "BEGIN; SELECT sys.set_context(1, NULL, NULL, gen_random_uuid(), NULL, NULL, 'CI: setup done', NULL); UPDATE sys.setup_state SET state = 'in_progress', path = 'new'; UPDATE sys.setup_state SET state = 'complete'; COMMIT;" | Out-Null
& $svc run backup once
Ok ($LASTEXITCODE -eq 0) 'a local copy is made by the backup program'

# ---- The emergency tool (decision 0107) ----
$emergencyExe = Join-Path $pf 'artepool-emergency.exe'
Ok (Test-Path $emergencyExe) 'the emergency tool is installed beside the launcher'
$manifest = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($emergencyExe))
Ok ($manifest.Contains("requireAdministrator")) "the emergency tool's own manifest asks for administrator rights"
Ok (@(Emergency-Shortcuts).Count -eq 1) 'the emergency tool is in the Start menu'
$status = Emergency 'status' '{}'
Ok ($status.ok -eq $true -and $status.result.setupComplete -eq $true) 'emergency: the database answers and the setup is complete'
Ok ($status.result.owner.username -eq 'ciowner') 'emergency: the owner is shown'
$refused = Emergency 'reset-password' '{"reason":"x","phoneLost":false}'
Ok ($refused.ok -eq $false -and $refused.reason -eq 'reason_required') 'emergency: a reset without a reason is refused'
$reset = Emergency 'reset-password' '{"reason":"CI emergency test","phoneLost":false}'
Ok ($reset.ok -eq $true -and $reset.result.temporaryPassword.Length -ge 10) 'emergency: a temporary password for the owner'
$script:alsoSecret += $reset.result.temporaryPassword
$ownerPassword = $reset.result.temporaryPassword
Ok ((Psql "SELECT count(*) FROM audit.log WHERE action = 'event:auth.owner_password_reset' AND reason LIKE 'emergency tool % CI emergency test'") -eq '1') 'emergency: the reset is in the audit log with its reason'
$code = Emergency 'device-code' '{}'
Ok ($code.ok -eq $true -and $code.result.code.Length -ge 6) 'emergency: an enrollment code'
Check-Logs-Hold-No-Secret 'after the emergency tool:'
$copy = Get-ChildItem "$data\backups" -Recurse -Filter '*.dump' | Sort-Object LastWriteTime | Select-Object -Last 1
Ok ($null -ne $copy) "the copy is $($copy.Name)"
$oldKey = Secret 'master-key'
Copy-Item $copy.FullName "$work\local.dump"
& pnpm exec tsx "$repo\tools\installer\windows\make-bundle.ts" "$work\local.dump" $oldKey $work
Ok ($LASTEXITCODE -eq 0) 'the encrypted off-site copy is made'

# ---- Upgrades (decision 0103): one that works, an older setup, one whose migration fails ----
$tests = @(Get-ChildItem (Join-Path (Split-Path $Installer) 'test') -Filter 'ARTEPOOL-Server-Setup-*.exe' |
  Sort-Object { [version](Version-Of $_) })
Ok ($tests.Count -eq 2) 'the two test upgrades were built'
$firstVersion = Installed-Version
$users = Psql 'SELECT count(*) FROM auth.users'
$exit = Run-Setup $tests[0].FullName
if ($exit -ne 0) { Show-Logs }
Ok ($exit -eq 0) "upgrade $firstVersion -> $(Version-Of $tests[0]) (exit $exit)"
Ok ((Installed-Version) -eq (Version-Of $tests[0])) 'the new version is installed'
Check-Health 'after the upgrade'
Ok ((Psql 'SELECT count(*) FROM auth.users') -eq $users) 'the data is kept'
Ok ((Psql "SELECT to_regclass('sys.ci_upgrade_check') IS NOT NULL") -eq 't') "the new version's migration is applied"
Ok ((Psql "SELECT count(*) FROM audit.log WHERE action = 'event:system.upgraded'") -eq '1') 'the upgrade is in the audit log'
$pre = @(Get-ChildItem "$data\backups\pre-upgrade" -Filter '*.dump')
Ok ($pre.Count -eq 1) "a pre-upgrade copy was made ($($pre[0].Name))"
$sum = (Get-Content "$($pre[0].FullName).sha256" -Raw).Split(' ')[0]
Ok ($sum -eq (Get-FileHash $pre[0].FullName -Algorithm SHA256).Hash.ToLower()) 'its SHA-256 is beside it'
Ok (Test-Path "$pf.previous\artepool-svc.exe") 'the previous programs are kept beside'
foreach ($name in 'ArtepoolDatabase', 'ArtepoolServer', 'ArtepoolBackup') {
  Ok ((Get-Service $name).Status -eq 'Running') "$name runs after the upgrade"
}
$result = Get-Content "$data\updates\last-result.json" -Raw | ConvertFrom-Json
Ok ($result.ok -eq $true) 'the result is saved for System health'

$exit = Run-Setup $Installer
Ok ($exit -eq 4) "an older setup over a newer installation changes nothing (exit $exit)"
Ok ((Installed-Version) -eq (Version-Of $tests[0])) 'the newer version stays'

$migrations = Psql 'SELECT count(*) FROM sys.schema_migrations'
$exit = Run-Setup $tests[1].FullName
Ok ($exit -eq 6) "a failing upgrade puts the previous version back (exit $exit)"
Ok ((Installed-Version) -eq (Version-Of $tests[0])) 'the previous version is installed again'
Check-Health 'after the failed upgrade'
foreach ($name in 'ArtepoolDatabase', 'ArtepoolServer', 'ArtepoolBackup') {
  Ok ((Get-Service $name).Status -eq 'Running') "$name runs again after the failed upgrade"
}
Ok ((Psql 'SELECT count(*) FROM sys.schema_migrations') -eq $migrations) 'the database is unchanged'
Ok ((Psql "SELECT to_regclass('sys.ci_upgrade_broken') IS NULL") -eq 't') 'nothing of the failing migration is left'
$result = Get-Content "$data\updates\last-result.json" -Raw | ConvertFrom-Json
Ok ($result.ok -eq $false -and $result.step -eq 'migrate') "the failure is saved for System health ($($result.step))"
Ok (Test-Path "$pf.failed\artepool-svc.exe") 'the failed programs are kept aside for support'
Check-Logs-Hold-No-Secret 'after the upgrades:'

# ---- 4. Uninstall keeps the data; reinstall uses it; then deleting the data ----
Uninstall-Server 'first'
$caHash = (Get-FileHash "$data\secrets\tls\ca.crt").Hash
$exit = Run-Setup $Installer
Ok ($exit -eq 4) "an older setup does not reinstall over data of a newer version (exit $exit)"
Ok ($null -eq (Get-Service -Name 'ArtepoolDatabase' -ErrorAction SilentlyContinue)) 'and changes nothing'
$exit = Run-Setup $tests[0].FullName
if ($exit -ne 0) { Show-Logs }
Ok ($exit -eq 0) "reinstall over the kept data (exit $exit)"
Check-Health 'after the reinstall'
Ok ((Psql "SELECT count(*) FROM auth.users WHERE username = 'ciowner'") -eq '1') 'the owner is still there'
Ok ((Psql 'SELECT state FROM sys.setup_state') -eq 'complete') 'the first-run setup stays closed'
Ok (-not (Test-Path "$data\setup\token")) 'no setup token'
Ok ((Get-FileHash "$data\secrets\tls\ca.crt").Hash -eq $caHash) 'the PCs keep trusting the same CA'
Ok (@(Get-ChildItem "$data\backups\pre-upgrade" -Filter '*-before-reinstall.dump').Count -eq 1) 'a checked copy was made before the reinstall'
foreach ($name in 'ArtepoolDatabase', 'ArtepoolServer', 'ArtepoolBackup') {
  Ok ((Get-Service $name).Status -eq 'Running') "$name runs after the reinstall"
}
Check-Logs-Hold-No-Secret 'after the reinstall:'

$script:alsoSecret += @('master-key', 'migrator-password', 'api-password', 'backup-password', 'maint-password', 'pg-superuser-password') |
  ForEach-Object { Secret $_ }
"DELETE`nnot-the-owner-password`n" | & $svc run delete-data | Out-Null
Ok ($LASTEXITCODE -eq 1) "delete data with a wrong owner's password is refused (exit $LASTEXITCODE)"
Ok (Test-Path "$data\pgdata\PG_VERSION") 'nothing was deleted'
Ok ((Psql "SELECT count(*) FROM audit.log WHERE action = 'event:system.data_delete_refused'") -eq '1') 'the refusal is in the audit log'
"delete`n$ownerPassword`n" | & $svc run delete-data | Out-Null
Ok ($LASTEXITCODE -eq 1 -and (Test-Path "$data\pgdata\PG_VERSION")) 'without the word DELETE nothing is deleted'
"DELETE`n$ownerPassword`n" | & $svc run delete-data | Out-Null
Ok ($LASTEXITCODE -eq 0) "delete data with DELETE and the owner's password (exit $LASTEXITCODE)"
foreach ($folder in 'pgdata', 'wal', 'secrets', 'config', 'setup') {
  Ok (-not (Test-Path "$data\$folder")) "$folder is deleted"
}
Ok (@(Get-ChildItem "$data\backups" -Recurse -Filter '*.dump').Count -ge 2) 'the backups folder stays'
Ok (Test-Path "$data\logs\install") 'the logs stay'
Check-Logs-Hold-No-Secret 'after deleting the data:'
Uninstall-Server 'after deleting the data:' $false
Remove-Item -Recurse -Force $data
Ok (-not (Test-Path $data)) 'the data is wiped, as on a new PC'

# ---- 5. The new PC: install, then restore the copy as administrator ----
Install-Server 'second'
Check-Health 'second'
$key = Get-Content "$work\key.txt" -Raw
$lines = @($key | & $svc run restore "$work\copy.dump.age" 2>&1 | ForEach-Object { "$_" })
$restoreExit = $LASTEXITCODE
# Its steps and its result (with the reason when it fails); the key went on its input only.
$lines | ForEach-Object { Write-Host "  restore: $_" }
if ($restoreExit -ne 0) { Show-Logs }
Ok ($restoreExit -eq 0) "the restore program finished (exit $restoreExit)"
$result = ($lines | Where-Object { $_ -like '{"result"*' } | Select-Object -Last 1 | ConvertFrom-Json).result
Ok ($result.ok -eq $true) "the restore succeeded ($($lines -join ' | '))"
Ok ($result.masterKeyRestored -eq $true) 'the master key came back with the copy'
Ok ($null -ne $result.enrollment.code) 'this PC got its enrollment code'
Ok ((Secret 'master-key') -eq $oldKey) 'the protected store holds the old master key'
Check-Health 'after the restore'
Ok ((Psql "SELECT count(*) FROM auth.users WHERE username = 'ciowner'") -eq '1') "the old owner is on the new PC"
Ok ((Psql "SELECT state FROM sys.setup_state") -eq 'complete') 'the first-run setup stays locked'
Ok (-not (Test-Path "$data\setup\token")) 'the setup token is gone'
Check-Logs-Hold-No-Secret 'after the restore:'

# ---- 6. Uninstall again: the data stays; then the desktop app's own uninstaller ----
Uninstall-Server 'second'
$p = Start-Process -FilePath "$appDir\uninstall.exe" -ArgumentList '/S', "_?=$appDir" -Wait -PassThru
Ok ($p.ExitCode -eq 0) "the desktop app's uninstaller (exit $($p.ExitCode))"
Ok ($null -eq (Get-ScheduledTask -TaskName 'ARTEPOOL ERP' -ErrorAction SilentlyContinue)) 'the start at sign-in is removed'
Ok ((Get-Content "$data\logs\install\desktop-app.log" -Raw) -match 'uninstalled; start at sign-in removed') "the desktop app's uninstaller wrote its log"
Write-Host 'All installer checks passed.'
