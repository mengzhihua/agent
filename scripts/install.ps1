# One-click install for Windows PowerShell.
#   irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = if ($env:AGENT_REPO) { $env:AGENT_REPO } else { "mengzhihua/agent" }
$Ref = if ($env:AGENT_REF) { $env:AGENT_REF } else { "main" }
$Prefix = if ($env:AGENT_PREFIX) { $env:AGENT_PREFIX } else { Join-Path $HOME ".agent" }
$Src = Join-Path $Prefix "src"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing $Name. Install it and re-run."
  }
}

Assert-Command node
Assert-Command npm

$major = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($major -lt 22) {
  throw "Node.js 22+ is required (found $(node -v))."
}

if ($args -contains "--uninstall") {
  if (Test-Path (Join-Path $Src "scripts\setup.mjs")) {
    & node (Join-Path $Src "scripts\setup.mjs") --prefix $Prefix --uninstall
  } else {
    Remove-Item -Recurse -Force $Src -ErrorAction SilentlyContinue
    Remove-Item -Force (Join-Path $Prefix "bin\agent.cmd") -ErrorAction SilentlyContinue
  }
  return
}

New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$tmp = Join-Path $env:TEMP ("agent-install-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp "src.zip"
  $url = "https://github.com/$Repo/archive/refs/heads/$Ref.zip"
  Write-Host "Downloading $Repo@$Ref ..."
  try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  } catch {
    Invoke-WebRequest -Uri "https://github.com/$Repo/archive/refs/tags/$Ref.zip" -OutFile $zip -UseBasicParsing
  }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extract = Get-ChildItem -Directory $tmp | Select-Object -First 1
  if (-not $extract) { throw "archive did not contain a directory" }
  if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
  New-Item -ItemType Directory -Force -Path (Split-Path $Src) | Out-Null
  Move-Item $extract.FullName $Src
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

& node (Join-Path $Src "scripts\setup.mjs") --from $Src --prefix $Prefix
Write-Host ""
Write-Host "Windows install complete. Open a new terminal if PATH was updated."
