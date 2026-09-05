@echo off
chcp 65001 >nul
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo ========================================
echo  FrameBaker - Windows 便携版打包
echo ========================================
echo.

:: 检查 bun
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 bun，请先安装：https://bun.sh
    pause
    exit /b 1
)

:: 检查依赖（bun 安装布局缺失会导致前端构建找不到 pixi）
if not exist "apps\web\node_modules\pixi.js" (
    echo [framebaker] 安装依赖...
    bun install --silent
    if errorlevel 1 (
        echo [framebaker] bun install 失败。
        pause
        exit /b 1
    )
)

echo [framebaker] 开始打包...
bun scripts\package-windows.ts
if errorlevel 1 (
    echo [framebaker] 打包失败。
    pause
    exit /b 1
)

echo.
echo [framebaker] 打包流程执行完成。
pause
exit /b 0
