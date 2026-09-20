# One-click install for Windows PowerShell.
# Prefers the latest GitHub Release tarball (compiled dist, Node 22 only).
#   irm https://raw.githubusercontent.com/mengzhihua/agent/main/scripts/install.ps1 | iex
# Source from main instead: $env:AGENT_REF = "main"; irm ... | iex
$ErrorActionPreference = "Stop"

$Repo = if ($env:AGENT_REPO) { $env:AGENT_REPO } else { "mengzhihua/agent" }
$Ref = if ($env:AGENT_REF) { $env:AGENT_REF } else { "latest" }
$Prefix = if ($env:AGENT_PREFIX) { $env:AGENT_PREFIX } else { Join-Path $HOME ".agent" }
$Src = Join-Path $Prefix "src"

function Assert-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing $Name. Install it and re-run."
  }
}

Assert-Command node
Assert-Command tar

$major = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($major -lt 22) {
  throw "Node.js 22+ is required (found $(node -v))."
}

if ($args -contains "--uninstall") {
  if (Test-Path (Join-Path $Src "scripts\setup.mjs")) {
    & node (Join-Path $Src "scripts\setup.mjs") --prefix $Prefix --from $Src --uninstall
  } else {
    Remove-Item -Recurse -Force $Src -ErrorAction SilentlyContinue
    Remove-Item -Force (Join-Path $Prefix "bin\agent.cmd") -ErrorAction SilentlyContinue
  }
  return
}

function Save-Url($Url, $Dest) {
  Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
}

New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
$tmp = Join-Path $env:TEMP ("agent-install-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $archive = Join-Path $tmp "src.tgz"
  if ($Ref -eq "main" -or $Ref -eq "master") {
    Write-Host "Downloading $Repo@$Ref source ..."
    Save-Url "https://github.com/$Repo/archive/refs/heads/$Ref.tar.gz" $archive
  } elseif ($Ref -eq "latest") {
    Write-Host "Downloading latest GitHub Release ..."
    try {
      Save-Url "https://github.com/$Repo/releases/latest/download/agent.tgz" $archive
    } catch {
      Write-Host "No release asset yet; installing from main source."
      Save-Url "https://github.com/$Repo/archive/refs/heads/main.tar.gz" $archive
    }
  } else {
    Write-Host "Downloading $Repo@$Ref ..."
    $tag = $Ref
    if (-not $tag.StartsWith("v")) { $tag = "v$Ref" }
    try {
      Save-Url "https://github.com/$Repo/releases/download/$tag/agent.tgz" $archive
    } catch {
      try {
        Save-Url "https://github.com/$Repo/archive/refs/tags/$tag.tar.gz" $archive
      } catch {
        Save-Url "https://github.com/$Repo/archive/refs/heads/$Ref.tar.gz" $archive
      }
    }
  }
  & tar -xzf $archive -C $tmp
  if ($LASTEXITCODE -ne 0) { throw "tar extract failed" }
  $extract = Get-ChildItem -Directory $tmp | Select-Object -First 1
  if (-not $extract) { throw "archive did not contain a directory" }
  if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
  New-Item -ItemType Directory -Force -Path (Split-Path $Src) | Out-Null
  Move-Item $extract.FullName $Src
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$setupArgs = @((Join-Path $Src "scripts\setup.mjs"), "--from", $Src, "--prefix", $Prefix)
if (Test-Path (Join-Path $Src "dist\cli.js")) {
  $setupArgs += "--skip-build"
} else {
  Assert-Command npm
}
& node @setupArgs
Write-Host ""
Write-Host "Windows install complete. Open a new terminal so the user PATH picks up agent."
