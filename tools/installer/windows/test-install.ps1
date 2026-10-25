# CI on the Windows runner (M6.2 part F): the server installer from start to finish, as on a
# clean PC. Install silently; check the services, their accounts, /health over TLS 1.3, that the
# database is not reachable on the LAN, the folder rules, the firewall rule, the secrets, a
# "reboot" (services stopped and started); make the shop's encrypted off-site copy; uninstall
# (the data stays); wipe the data as on a new PC; install again; restore the copy as
# administrator through the launcher; check the restored data and the master key; uninstall.
# The install logs are searched for every secret: none may appear.
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
      Write-Host "----- $($_.FullName)"
      Get-Content $_.FullName -Tail 80
    }
  }
}

function Install-Server([string]$label) {
  $p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { Show-Logs }
  Ok ($p.ExitCode -eq 0) "$label silent install (exit $($p.ExitCode))"
}

function Uninstall-Server([string]$label) {
  $p = Start-Process -FilePath "$pf\uninstall.exe" -ArgumentList '/S', "_?=$pf" -Wait -PassThru
  Ok ($p.ExitCode -eq 0) "$label uninstall (exit $($p.ExitCode))"
  Remove-Item -Recurse -Force $pf -ErrorAction SilentlyContinue
  foreach ($name in 'ArtepoolDatabase', 'ArtepoolServer', 'ArtepoolBackup') {
    Ok ($null -eq (Get-Service -Name $name -ErrorAction SilentlyContinue)) "$label service $name removed"
  }
  Ok ($null -eq (Get-NetFirewallRule -DisplayName 'ARTEPOOL Server' -ErrorAction SilentlyContinue)) "$label firewall rule removed"
  Ok (Test-Path "$data\pgdata\PG_VERSION") "$label the data is kept in ProgramData"
}

function Secret([string]$name) {
  $entropy = [Text.Encoding]::UTF8.GetBytes("ARTEPOOL secrets v1/$name")
  $sealed = [IO.File]::ReadAllBytes("$data\secrets\$name.dpapi")
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($sealed, $entropy, 'LocalMachine')
  return [Text.Encoding]::UTF8.GetString($plain)
}

function Psql([string]$sql) {
  $env:PGPASSWORD = Secret 'pg-superuser-password'
  try {
    $out = & "$pf\pgsql\bin\psql.exe" -h localhost -U postgres -d artepool -At -v ON_ERROR_STOP=1 -c $sql
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

function Check-Logs-Hold-No-Secret([string]$label) {
  $secrets = @('master-key', 'migrator-password', 'api-password', 'backup-password', 'maint-password', 'pg-superuser-password') |
    ForEach-Object { Secret $_ }
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

# ---- 1. A clean PC: install ----
Install-Server 'first'
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
try { $probe.Connect($lan, 5432); $reached = $true } catch { } finally { $probe.Close() }
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
$copy = Get-ChildItem "$data\backups" -Recurse -Filter '*.dump' | Sort-Object LastWriteTime | Select-Object -Last 1
Ok ($null -ne $copy) "the copy is $($copy.Name)"
$oldKey = Secret 'master-key'
Copy-Item $copy.FullName "$work\local.dump"
& pnpm exec tsx "$repo\tools\installer\windows\make-bundle.ts" "$work\local.dump" $oldKey $work
Ok ($LASTEXITCODE -eq 0) 'the encrypted off-site copy is made'

# ---- 4. Uninstall keeps the data; then a new PC ----
Uninstall-Server 'first'
Remove-Item -Recurse -Force $data
Ok (-not (Test-Path $data)) 'the data is wiped, as on a new PC'

# ---- 5. The new PC: install, then restore the copy as administrator ----
Install-Server 'second'
Check-Health 'second'
$key = Get-Content "$work\key.txt" -Raw
$lines = $key | & $svc run restore "$work\copy.dump.age"
Ok ($LASTEXITCODE -eq 0) 'the restore program finished'
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

# ---- 6. Uninstall again: the data stays ----
Uninstall-Server 'second'
Write-Host 'All installer checks passed.'
