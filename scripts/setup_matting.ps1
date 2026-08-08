# FrameBaker bundled matting setup for Windows.
# Keep this file ASCII-compatible so Windows PowerShell 5.1 can parse it without a UTF-8 BOM.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Venv = ".venv-matting"
$Rembg = Join-Path $Venv "Scripts\rembg.exe"

if (Test-Path $Rembg) {
  Write-Host "rembg is already installed: $Rembg"
  exit 0
}

$Uv = Get-Command uv -ErrorAction SilentlyContinue
if ($Uv) {
  Write-Host "Creating venv with uv: $Venv"
  & $Uv.Source venv --python 3.12 $Venv
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $VenvPython = Join-Path $Venv "Scripts\python.exe"
  Write-Host "Installing rembg[cli,cpu] with uv (this can take a while)"
  & $Uv.Source pip install --python $VenvPython --link-mode copy "rembg[cli,cpu]"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  $Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
  $ver = $null
  try { $ver = & $Python --version 2>&1 } catch { }
  if ($LASTEXITCODE -ne 0 -or -not $ver) {
    # Some Windows installations only expose the Python launcher.
    try { $ver = & py --version 2>&1; if ($LASTEXITCODE -eq 0) { $Python = "py" } } catch { }
  }
  if (-not $ver -or $LASTEXITCODE -ne 0) {
    Write-Host "ERROR: uv or Python was not found. Install uv from https://docs.astral.sh/uv/ or Python from https://www.python.org/downloads/."
    exit 1
  }

  Write-Host "Creating venv: $Venv ($ver)"
  & $Python -m venv $Venv
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $Pip = Join-Path $Venv "Scripts\pip.exe"

  Write-Host "Upgrading pip"
  & $Pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "Installing rembg[cli,cpu] (this can take a while)"
  & $Pip install "rembg[cli,cpu]"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "Installation complete: $Rembg"
Write-Host "FrameBaker will detect it as engine=rembg-bundled."
Write-Host "The default model is u2net; FRAMEBAKER_MATTING_MODEL can select another model."
