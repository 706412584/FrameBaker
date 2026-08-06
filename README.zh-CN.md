# FrameBaker

**像素风逐帧动画编辑器 —— Bun 全栈应用。**

多来源素材导入（GIF/MP4 拆帧、PNG 上传、外部 CLI 生成），内置 rembg 抠图引擎一键去背，在素材库里对比确认效果，再用 PixiJS 洋葱皮编辑器逐帧调整，时间轴排序，播放预览，最后导出精灵表（spritesheet）。

![Bun](https://img.shields.io/badge/Bun-1.3-14151A?logo=bun)
![Elysia](https://img.shields.io/badge/Elysia-1.4-6f61c0)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)

[English](README.md) | **中文**

<!-- 截图位 -->
<!-- ![screenshot](docs/screenshot.png) -->

## 特性

- **多来源导入** —— ffmpeg 拆 GIF/MP4 帧（fps 可调）、PNG 多选上传、外部生成 CLI（`FRAMEBAKER_GEN_CLI`）
- **内置抠图** —— rembg 开箱即用（默认 u2net，可换模型）；也支持自定义 CLI 模板；前后对比滑杆验收去背效果
- **素材库** —— 一级暂存区：生成/上传 → 抠图 → 对比 → 导入任意项目，支持单个与批量
- **帧编辑器** —— PixiJS v8 画布：洋葱皮（前红/后蓝）、网格、25–400% 缩放、拖拽改 offset、替换图片、帧时长、关键帧
- **时间轴与批量操作** —— 拖拽换序，Cmd/Ctrl+点击与 Shift+点击多选，批量删除/复制/统一时长
- **精灵表导出** —— 纯前端 canvas 拼合 → `*.spritesheet.png` + `*.json`
- **Cassette Futurism 双主题** —— 深色 Magnetic Night / 浅色 Beige Terminal；默认跟随系统，三态切换（跟随系统/浅色/深色）
- **实时同步** —— WebSocket 广播任务进度与帧/素材变更
- **可调布局** —— 拖拽分隔条调整帧列表宽度与时间轴高度（自动持久化）

## 快速开始

```bash
bun install
bun dev          # 开发模式（--hot）→ http://localhost:3000
# 或
bun start        # 生产
```

- 端口覆盖：`PORT=8080 bun dev`
- 拆帧依赖 ffmpeg：`brew install ffmpeg`（macOS）/ `winget install ffmpeg`（Windows）
- **抠图引擎**（本机已装好；新机器需要重新执行一次）：
  ```bash
  ./scripts/setup_matting.sh            # macOS / Linux
  # Windows（PowerShell）：
  powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1
  ```
  创建 `.venv-matting/`（python3 venv）并安装 `rembg[cli,cpu]`。u2net 模型在首次抠图时自动下载到 `storage/models`。不安装则抠图退化为 passthrough（复制原图并给出警告）。
- 类型检查：`bun run typecheck`

## 抠图引擎解析顺序

服务启动时探测一次（可用 `GET /api/config` 查看）：

1. `FRAMEBAKER_MATTING_CLI` —— 自定义命令模板（占位符 `{input}` `{output}`，可选 `{model}`）
2. `<repo>/.venv-matting` 内置 rembg（POSIX 为 `bin/rembg`，Windows 为 `Scripts/rembg.exe`）—— 由 `scripts/setup_matting.sh` / `setup_matting.ps1` 安装（engine = `rembg-bundled`）
3. PATH 中的 `rembg`（engine = `rembg-path`）
4. 都没有 —— passthrough 复制原图并提示安装（engine = `none`）

rembg 调用形式为 `rembg i -m <MODEL> input output`；模型默认 `u2net`，统一缓存在 `storage/models`（自动注入 `U2NET_HOME`）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `3000` |
| `FRAMEBAKER_GEN_CLI` | 生成 CLI 模板，占位符 `{prompt}` `{output}` `{index}` `{reference}`。例：`FRAMEBAKER_GEN_CLI='mygen --prompt "{prompt}" --ref {reference} -o {output}' bun dev`。`{reference}` 为界面里选择的引用图（素材或项目帧，服务端按 id 解析路径防注入）——选了引用图但模板缺 `{reference}`，或模板有 `{reference}` 但没选，创建任务时直接 400 |
| `FRAMEBAKER_MATTING_CLI` | 自定义抠图 CLI 模板，占位符 `{input}` `{output}`（可选 `{model}`），优先于内置 rembg |
| `FRAMEBAKER_MATTING_MODEL` | rembg 模型名，默认 `u2net`（如 `birefnet-general-lite`、`isnet-general-use`） |

## 项目结构

Bun workspaces monorepo：

- `apps/server`（@framebaker/server）—— Elysia API + 内存任务队列 + bun:sqlite；经 Bun HTML import 托管前端
- `apps/web`（@framebaker/web）—— React 19 + pixi.js v8 + motion + lucide-react
- `packages/shared`（@framebaker/shared）—— 前后端共享类型与常量
- `scripts/` —— 安装脚本（抠图引擎）
- `docs/` —— 文档
- `storage/` —— 运行时数据（SQLite、帧、素材、rembg 模型；已 gitignore）

## 文档

- [docs/guide.md](docs/guide.md) —— 使用指南（设置页、provider 配置、剪裁工具、素材加工、编辑器）
- [docs/architecture.md](docs/architecture.md) —— 架构图、模块说明、数据流、存储布局
- [docs/api.md](docs/api.md) —— API 一览（含请求/响应示例）与 WS 事件
- [docs/roadmap.md](docs/roadmap.md) —— 已完成清单与后续规划

## 字体许可

界面字体为 **Fusion Pixel 12px**（`apps/web/public/fonts/`），采用 SIL Open Font License 1.1 —— 详见 `apps/web/public/fonts/OFL.txt`。

## 已知限制

任务队列在内存中（重启丢未完成任务）；GIF 拆帧忽略帧延迟；单图导入按字节落盘（建议 PNG）；精灵表不做 trim；无鉴权仅限本地。改进计划见 [roadmap](docs/roadmap.md)。
