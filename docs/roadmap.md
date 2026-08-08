# FrameBaker Roadmap

## M1 — 已完成（当前版本）

- 项目管理：列表 / 新建 / 删除，首帧缩略图卡片
- 多来源导入：
  - GIF 拆帧（ffmpeg 全帧提取）
  - MP4 抽帧（fps 可调 1–24）
  - 单图直导入 / 多文件多选上传（逐文件状态 + 汇总）
  - 外部 CLI 逐帧生成（FRAMEBAKER_GEN_CLI 模板）
  - 内置 rembg 抠图引擎（scripts/setup_matting.sh，u2net 模型存 storage/models；引擎探测顺序：自定义 CLI → 内置 rembg → PATH → passthrough 警告；「抠图去背」开关默认勾选并显示引擎状态）
- 帧编辑器（PixiJS v8）：拖拽改 offset、洋葱皮（前红/后蓝）、网格、25%–400% 缩放
- 帧操作：替换图片、时长 ±、关键帧标记、复制、删除
- 时间轴：HTML5 拖拽换序（乐观更新 + 服务端事务重写 idx）
- 播放预览：fps 控件 + 每帧 duration
- 导出精灵帧：纯前端逐帧 canvas 烘焙变换，每帧单独 PNG + JSON 元数据
- 实时同步：WS 广播（任务/帧/素材变更），断线重连
- 基础设施：Bun workspaces monorepo、@framebaker/shared 共享类型、storage 路径与 cwd 无关
- 主题：Cassette Futurism 双主题（深 Magnetic Night / 浅 Beige Terminal），三态切换（跟随系统/浅色/深色），localStorage 持久化，无记录时跟随系统并实时响应系统变化
- 帧批量选择：Cmd/Ctrl+点击切换、Shift+点击范围选（帧列表与时间轴联动），批量删除（二次确认）/复制/统一时长
- **素材库（Materials）**：素材一级模块——上传（单图/GIF/MP4 拆帧）/ CLI 生成 → 抠图（matting/unmatting）→ 原图/抠图对比滑杆 → 单个或批量导入项目；素材批量选择与批量删除；任务队列 extract/generate/matting 以 JobTarget 泛化同时服务项目帧与素材；项目导入面板「素材库」Tab 多选直导（主流程）
- 编辑器布局：分隔条拖拽调整帧列表宽度（180–480）与时间轴高度（80–320），双击恢复默认，localStorage 持久化
- README 双语（英文默认 + 中文 README.zh-CN.md）
- 任务面板（JobPanel）：右侧常驻任务队列，WS `job_*` 事件驱动 + 轮询兜底；生成提交即关窗不阻塞；素材抠图统一走任务队列（不再同步挂起）；服务重启自动标记遗留任务中断
- 多宫格精灵图网格切分：素材详情按行×列（1–8）逐格切成独立素材（网格线预览、可选自动抠图），复用 imageops worker，原素材保留
- 多动作生成：素材详情以当前素材为引用图，**按序追加连续帧**（可重复同一动作，如走路×4），一次生成连续动作拼图表（`buildActionSheetPrompt` 强调帧间连续性），再「网格切分」拆格
- 动作工作台：多动作生成支持独立动作参考图；`/motions` 提供固定人形 FK、CC0 动作预设和姿态表导出。现有功能继续保留但内存数据不做兼容记录，正式资产 UI 完成后直接改用 [`pose-motion-system.md`](./pose-motion-system.md) 的通用动画体系
- 通用动画 Phase A：冻结 provider/外部格式无关的 Skeleton / MotionClip、连续时间与局部 TRS，发布严格 JSON Schema；实现矩阵 FK、RFC 8785 规范 JSON、SHA-256 内容寻址和 `.fbanim` v1 逻辑包的有界验证与确定性往返
- 素材搜索：项目导入弹窗素材库 Tab 按素材名 / prompt 本地过滤
- AI 视频生成逐帧切割：生成弹窗「图片 / 视频」切换——CLI 产物按魔数检测自动拆帧（任何模式）、百炼（万相）与 MiniMax 视频 API 异步任务轮询 → mp4 → ffmpeg 按 fps 抽帧入库
- 帧右键菜单：通用 `ContextMenu` 组件（视口边缘收拢、Esc/外点/滚动关闭）；帧列表/时间轴右键——单帧菜单（关键帧/时长 ±1/剪裁/复制/删除），多选内右键出批量菜单（复用 BatchBar handler）

## M2 — 候选（按优先级排序）

| 优先级 | 事项 | 说明 / 来源 |
| --- | --- | --- |
| P0 | 任务队列持久化 | 现状：队列与负载在内存，重启后 queued/running 任务丢失。方案：启动时扫描 jobs 表恢复，或将负载序列化进 jobs 表 |
| P0 | 通用动画资产 Phase B | 在已完成的通用内核和 `.fbanim` v1 逻辑包上建立独立持久化、引用关系、CRUD API 与正式资产 UI；不保留未持久化原型的兼容层，详见 [`pose-motion-system.md`](./pose-motion-system.md) |
| P1 | 非 PNG 单图转换 | 现状：单图导入按字节直接落盘为 .png 命名。方案：非 PNG 时过一道 `ffmpeg -i in out.png` |
| P1 | 导出精灵帧 trim | 裁掉透明边缘，JSON 记录 sourceSize/offset，减小体积 |
| P1 | 旋转/缩放/透明度编辑 UI | 字段与 PATCH 已就绪，画布工具栏只暴露了 offset 拖拽 |
| P2 | GIF 帧延迟保留 | 现状：拆帧忽略各帧延迟、等长处理。方案：用 ffprobe/identify 读延迟写入 duration |
| P2 | AI 插帧 | 相邻关键帧间生成过渡帧（可复用 FRAMEBAKER_GEN_CLI 通道或新增插帧 CLI 环境变量） |
| P2 | 删除撤销 | 批量删除已有二次确认（编辑器与素材库）；删除后仍不可恢复，可做回收站/undo |

## M3 — 候选（远期）

| 优先级 | 事项 | 说明 |
| --- | --- | --- |
| P2 | WebM/APNG 导出 | 服务端 ffmpeg 合成，预览一致的时长 |
| P3 | Aseprite 导入 | 解析 .ase/.aseprite 文件（图层/标签），需要引入二进制解析 |
| P3 | 鉴权与多用户 | 目前无任何鉴权，仅限本地单用户；上云前必须做 |
| P3 | 帧标签体系 | tags 字段已在模型与 PATCH 中，缺 UI 与筛选 |
| P3 | 项目级播放参数 | 循环方式、默认 fps 持久化到 project |
| P3 | 素材库增强 | 素材重命名/标签/搜索、素材直接替换项目内已有帧 |

## 明确不做（当前阶段）

- 服务端渲染 / SEO（本地工具，无此需求）
- 位图绘制能力（画笔/橡皮擦）——FrameBaker 定位是帧管理 + 微调，绘制交给外部工具后用「替换图片」回流
