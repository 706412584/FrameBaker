# FrameBaker 内置抠图引擎安装（Windows）：python venv → .venv-matting\ + pip install "rembg[cli,cpu]"
# 首次抠图会自动下载模型到 storage/models（U2NET_HOME 由服务端注入）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$Venv = ".venv-matting"
$Rembg = Join-Path $Venv "Scripts\rembg.exe"

if (Test-Path $Rembg) {
  Write-Host "rembg 已安装：$Rembg（如需重装请删除 $Venv 后重跑）"
  exit 0
}

$Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
$ver = $null
try { $ver = & $Python --version 2>&1 } catch { }
if ($LASTEXITCODE -ne 0 -or -not $ver) {
  # 部分机器只有 py launcher
  try { $ver = & py --version 2>&1; if ($LASTEXITCODE -eq 0) { $Python = "py" } } catch { }
}
if (-not $ver -or $LASTEXITCODE -ne 0) {
  Write-Host "错误：找不到 python，请先安装（https://www.python.org/downloads/ 或 winget install Python.Python.3）"
  exit 1
}

Write-Host "→ 创建 venv: $Venv ($ver)"
& $Python -m venv $Venv
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$Pip = Join-Path $Venv "Scripts\pip.exe"

Write-Host "→ 升级 pip"
& $Pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "→ 安装 rembg[cli,cpu]（含 onnxruntime CPU 后端，依赖较多，首次较慢）"
& $Pip install "rembg[cli,cpu]"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "✓ 安装完成：$Rembg"
Write-Host "  FrameBaker 启动时会自动探测到它（engine=rembg-bundled）"
Write-Host "  默认模型 u2net，可用 FRAMEBAKER_MATTING_MODEL 环境变量切换（如 birefnet-general-lite）"
