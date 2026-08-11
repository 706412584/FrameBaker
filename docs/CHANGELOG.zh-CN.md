# FrameBaker 变更日志

本文按版本独立记录新增、调整及 Bug 修复。main 发布采用兼容 SemVer 格式的 `MAJOR.WEEK.BUG` 规则，详见 [VERSIONING.zh-CN.md](VERSIONING.zh-CN.md)。

## [Unreleased]

### 新增

- 动作事件支持输入、校验并查看可选 JSON payload，数据随 MotionClip 持久化。
- 新增 MotionClip schema v2：逐片段 cubic-bezier 时间曲线、显式无损 v1 迁移、四元数缓动 slerp、曲线编辑及 `.fbanim`/光栅烘焙兼容。

## [0.2.2] - 2026-08-11

### 新增

- 独立场景分层模型配置与素材库入口；支持 1–4 层及递归分层。
- 未抠图素材可选择在同一任务内严格按“抠图 → 分层”执行。
- 增加统一版本脚本，并在 README 中加入真实生成、实际四层分解的演示素材。

### 修复

- 修复旧配置缺少模型列表时读取 `.length` 导致的运行时崩溃。
- 修复只有原图的素材详情错误显示白色“未抠图”对比图。
- 修复网格拆分素材的原图/抠图图像及元数据丢失问题。
- 修复场景分层产物错误显示为普通“API”来源，统一标记为“分层”并迁移历史数据。

### 调整

- 场景分层从生成 Provider 中拆出为独立配置项。
- 按当前 Gitee 接口实测，将单次分层范围统一为 1–4 层。
- 图片分层 UI 与 MCP 默认推理步数从 20 调整为上游质量配置 50；CFG 保持 4。
- 将「元素分层」重新定义为「场景分层」，明确背景/完整主体/道具/前景边界，并默认关闭前置抠图以保留场景上下文。
- README 增加真实生成并完成四层分解的演示，说明场景图层不能冒充角色骨骼拆件。
- main 发布采用 `MAJOR.WEEK.BUG`，版本脚本增加 `bug`、`week`、`major` 三种发布目标。

## [0.1.0] - 2026-08-11

### 新增

- Bun 全栈逐帧动画编辑器基础版本：项目、素材库、时间轴、PixiJS 编辑、播放预览及精灵帧导出。
- 图片/GIF/视频导入、定点抽帧、多 Provider 图片与视频生成、rembg 抠图及任务队列。
- Cassette Futurism 深浅双主题、可调编辑器布局、帧批量操作及 WebSocket 实时同步。
- 素材剪裁与透明边检测 Web Worker、批量剪裁队列、网格拆分、素材搜索及 ZIP 导出。
- 引用图生成、DashScope/Gemini/MiniMax Provider、提示词增强、结构化 CLI 和模型能力分类。
- 视频素材、自定义播放器、定点/区间抽帧、多动作生成、文件夹、国际化及语言切换。
- Windows/uv 与 CPU/GPU rembg 安装支持、生成体检、变换烘焙和单素材导出。
- MCP Streamable HTTP 服务及中英文界面、API、架构与使用文档。

### 修复

- 修复播放预览越界、Pixi 画布帧显示、任务面板位置及原生选择控件的主题一致性问题。
- 修复提示词增强器的 Gemini/MiniMax 兼容、旧模型关联、Windows 环境及 Provider 配置问题。
- 修复删除/取消、强制素材导入及轮询异常时多文件串行顺序问题。

### 工程与文档

- 增加核心单元测试、覆盖率报告及 GitHub Actions typecheck/test CI。
- 完善中英文 README、用户指南、架构/API/roadmap、演示媒体和 MIT License。
