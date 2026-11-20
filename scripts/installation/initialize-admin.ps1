param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference='Stop'
if(-not $env:DATABASE_URL -or -not $env:PIN_PEPPER){throw 'Externally configured migration connection and new deployment pepper are required'}
$review=Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$adminName=Read-Host 'First administrator display name'
$privatePin=Read-Host 'New six-digit PIN (not displayed)' -AsSecureString
$confirmation=Read-Host 'Confirm PIN (not displayed)' -AsSecureString
$pointer=[IntPtr]::Zero;$confirmPointer=[IntPtr]::Zero
try {
 $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($privatePin)
 $confirmPointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirmation)
 $value=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 if($value -cne [Runtime.InteropServices.Marshal]::PtrToStringBSTR($confirmPointer)){throw 'PIN confirmation differs'}
 $payload=@{database=$review.target.database;oid=$review.target.oid;cluster=$review.target.cluster;role=$review.target.role;port=$review.target.port;name=$adminName;pin=$value;pepper=$env:PIN_PEPPER;expectedMigrations=$review.migrations}|ConvertTo-Json -Depth 8 -Compress
 $processInfo=[Diagnostics.ProcessStartInfo]::new()
 $processInfo.FileName='node.exe';$processInfo.Arguments='"'+(Join-Path $PSScriptRoot 'bootstrap-admin.cjs')+'"'
 $processInfo.UseShellExecute=$false;$processInfo.CreateNoWindow=$true;$processInfo.RedirectStandardInput=$true
 $child=[Diagnostics.Process]::Start($processInfo)
 $child.StandardInput.Write($payload);$child.StandardInput.Close();$child.WaitForExit()
 if($child.ExitCode -ne 0){throw 'First administrator initialization refused'}
} finally {
 if($pointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)}
 if($confirmPointer -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($confirmPointer)}
 $value=$null;$payload=$null;$privatePin.Dispose();$confirmation.Dispose()
}
