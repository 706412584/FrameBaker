@echo off
chcp 65001 >nul
title FrameBaker
cd /d "%~dp0"

echo ========================================
echo  FrameBaker - 像素风逐帧动画编辑器
echo ========================================
echo.

:: 检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 bun，请先安装：https://bun.sh
    pause
    exit /b 1
)

echo [1/2] 检查依赖...
bun install --silent 2>&1

echo [2/2] 启动服务...
echo.
echo  ^>^> http://localhost:5842
echo.
echo  按 Ctrl+C 停止服务
echo.

bun dev