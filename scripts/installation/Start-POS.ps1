param([Parameter(Mandatory=$true)][string]$ConfigFile)
$ErrorActionPreference='Stop'
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$configPath=(Resolve-Path -LiteralPath $ConfigFile).Path
if(-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\@prisma\client\package.json'))){throw 'Install locked dependencies and generate the approved Client first'}
if(-not (Test-Path -LiteralPath (Join-Path $repoRoot 'src\server.js'))){throw 'Application source is missing'}
$env:DOTENV_CONFIG_PATH=$configPath
$env:DOTENV_CONFIG_QUIET='true'
Push-Location -LiteralPath $repoRoot
try { & node.exe -r dotenv/config src/server.js; exit $LASTEXITCODE } finally { Pop-Location }
# This foreground launcher creates no Windows task/service and makes no network/config changes.
