param([Parameter(Mandatory=$true)][string]$Database,[Parameter(Mandatory=$true)][int]$ExpectedOid,[Parameter(Mandatory=$true)][string]$ExpectedCluster,[Parameter(Mandatory=$true)][string]$Destination,[string]$PostgresBin='C:\Program Files\PostgreSQL\18\bin')
$ErrorActionPreference='Stop'
# Credentials are supplied privately through PGUSER/PGPASSWORD or pgpass, never arguments.
if($Database -notmatch '^[a-z][a-z0-9_]+$' -or $ExpectedOid -le 0 -or $ExpectedCluster -notmatch '^\d+$'){throw 'Invalid reviewed target'}
if($env:PGHOST -notin @('127.0.0.1','localhost') -or $env:PGDATABASE -cne $Database -or -not $env:PGUSER){throw 'Explicit matching loopback PG configuration required'}
$target=[IO.Path]::GetFullPath($Destination)
if((Test-Path -LiteralPath $target) -or (Test-Path -LiteralPath ($target+'.verification.json'))){throw 'Refusing to overwrite existing backup'}
if(-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($target)))){throw 'Private backup directory must already exist'}
$identity=& (Join-Path $PostgresBin 'psql.exe') -X -A -t -v ON_ERROR_STOP=1 -c "SELECT current_database()||'|'||(SELECT oid FROM pg_database WHERE datname=current_database())||'|'||(SELECT system_identifier FROM pg_control_system())"
if($LASTEXITCODE -ne 0 -or $identity.Trim() -cne "$Database|$ExpectedOid|$ExpectedCluster"){throw 'Backup identity verification failed; no backup started'}
& (Join-Path $PostgresBin 'pg_dump.exe') --format=custom --file=$target
if($LASTEXITCODE -ne 0){throw 'Backup failed; retain diagnostic artifact and do not overwrite it'}
& (Join-Path $PostgresBin 'pg_restore.exe') --list $target | Out-Null
if($LASTEXITCODE -ne 0){throw 'Backup directory verification failed'}
# Decode all contents to the Windows null device, without a database connection or plaintext export.
& (Join-Path $PostgresBin 'pg_restore.exe') --file=NUL $target
if($LASTEXITCODE -ne 0){throw 'Full backup decode verification failed'}
$digest=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
[pscustomobject]@{database=$Database;oid=$ExpectedOid;cluster=$ExpectedCluster;sha256=$digest;fullDecodeVerified=$true} | ConvertTo-Json | Set-Content -LiteralPath ($target+'.verification.json')
Write-Output 'Pinned database backup and full decode verified. Keep the backup and recovery configuration private.'
