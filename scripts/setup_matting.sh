#!/usr/bin/env bash
# FrameBaker 内置抠图引擎安装：python3 venv → .venv-matting/ + pip install "rembg[cli]"
# 首次抠图会自动下载模型到 storage/models（U2NET_HOME 由服务端注入）
set -euo pipefail
cd "$(dirname "$0")/.."

VENV=".venv-matting"
PYTHON="${PYTHON:-python3}"

if [ -x "$VENV/bin/rembg" ]; then
  echo "rembg 已安装：$VENV/bin/rembg（如需重装请删除 $VENV 后重跑）"
  exit 0
fi

command -v "$PYTHON" >/dev/null 2>&1 || { echo "错误：找不到 python3，请先安装（brew install python）"; exit 1; }

echo "→ 创建 venv: $VENV ($("$PYTHON" --version 2>&1))"
"$PYTHON" -m venv "$VENV"

echo "→ 升级 pip"
"$VENV/bin/pip" install --upgrade pip

echo "→ 安装 rembg[cli,cpu]（含 onnxruntime CPU 后端，依赖较多，首次较慢）"
"$VENV/bin/pip" install "rembg[cli,cpu]"

echo ""
echo "✓ 安装完成：$VENV/bin/rembg"
echo "  FrameBaker 启动时会自动探测到它（engine=rembg-bundled）"
echo "  默认模型 u2net，可用 FRAMEBAKER_MATTING_MODEL 环境变量切换（如 birefnet-general-lite）"
