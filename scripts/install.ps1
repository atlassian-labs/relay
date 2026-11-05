param(
  [switch] $Help
)

$ErrorActionPreference = "Stop"

function Show-Usage {
  @"
Install Relay from a GitHub Release artifact.

Required:
  `$env:RELAY_VERSION = "0.1.0"

Optional:
  `$env:RELAY_GITHUB_REPO = "atlassian-labs/relay"
  `$env:RELAY_RELEASE_BASE_URL = "https://github.com/<owner>/<repo>/releases/download/v<version>"
  `$env:RELAY_INSTALL_DIR = "`$HOME\.local\share\relay"
  `$env:RELAY_BIN_DIR = "`$HOME\.local\bin"
"@
}

function Fail([string] $Message) {
  Write-Error $Message
  exit 1
}

function EnvOrDefault([string] $Name, [string] $Default) {
  $Value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Default
  }
  return $Value
}

if ($Help) {
  Show-Usage
  exit 0
}

$Version = [Environment]::GetEnvironmentVariable("RELAY_VERSION")
if ([string]::IsNullOrWhiteSpace($Version)) {
  Fail "RELAY_VERSION is required, for example `$env:RELAY_VERSION = `"0.1.0`""
}
$Version = $Version.Trim().TrimStart("v")
if ($Version -notmatch "^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$") {
  Fail "RELAY_VERSION must be a semantic version"
}

if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "X64")) {
  Fail "unsupported Windows architecture: $env:PROCESSOR_ARCHITECTURE"
}

$Variant = "windows-amd64"
$Archive = "relay-v$Version-$Variant.tar.gz"
$Repo = EnvOrDefault "RELAY_GITHUB_REPO" "atlassian-labs/relay"
$BaseUrl = EnvOrDefault "RELAY_RELEASE_BASE_URL" "https://github.com/$Repo/releases/download/v$Version"
$BaseUrl = $BaseUrl.TrimEnd("/")
$InstallDir = EnvOrDefault "RELAY_INSTALL_DIR" (Join-Path $HOME ".local\share\relay")
$BinDir = EnvOrDefault "RELAY_BIN_DIR" (Join-Path $HOME ".local\bin")
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) "relay-install-$([System.Guid]::NewGuid())"

New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  $ArchivePath = Join-Path $Temp $Archive
  $SumsPath = Join-Path $Temp "SHA256SUMS"
  Invoke-WebRequest -Uri "$BaseUrl/$Archive" -OutFile $ArchivePath
  Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -OutFile $SumsPath

  $Expected = $null
  foreach ($Line in Get-Content $SumsPath) {
    $Parts = $Line.Trim() -split "\s+"
    if ($Parts.Length -ge 2 -and $Parts[1] -eq $Archive) {
      $Expected = $Parts[0]
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($Expected)) {
    Fail "checksum for $Archive was not found in SHA256SUMS"
  }

  $Actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected.ToLowerInvariant()) {
    Fail "checksum mismatch for $Archive"
  }

  $Payload = Join-Path $Temp "payload"
  $ReleaseDir = Join-Path $InstallDir "releases\$Version\$Variant"
  New-Item -ItemType Directory -Force -Path $Payload, $BinDir, (Split-Path $ReleaseDir) | Out-Null
  tar -xzf $ArchivePath -C $Payload
  if (Test-Path $ReleaseDir) {
    Remove-Item -Recurse -Force $ReleaseDir
  }
  Move-Item $Payload $ReleaseDir

  $RelayExe = Join-Path $ReleaseDir "relay.exe"
  $AssetsDir = Join-Path $ReleaseDir "assets"
  $CmdShim = Join-Path $BinDir "relay.cmd"
  $PsShim = Join-Path $BinDir "relay.ps1"
  @"
@echo off
set "ATLAS_PLUGIN_ASSETS=$AssetsDir"
"$RelayExe" %*
exit /b %ERRORLEVEL%
"@ | Set-Content -NoNewline -Encoding ASCII $CmdShim
  @"
`$env:ATLAS_PLUGIN_ASSETS = "$AssetsDir"
& "$RelayExe" @args
exit `$LASTEXITCODE
"@ | Set-Content -NoNewline -Encoding UTF8 $PsShim

  Write-Output "Installed Relay $Version to $CmdShim"
  $PathParts = [Environment]::GetEnvironmentVariable("PATH", "User") -split ";"
  if ($PathParts -notcontains $BinDir) {
    Write-Output "Add this directory to PATH: $BinDir"
  }

  $env:ATLAS_PLUGIN_ASSETS = $AssetsDir
  & $RelayExe --version
} finally {
  Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
