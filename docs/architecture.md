# FrameBaker 架构

## 总览

```
                        ┌──────────────────────────────────────────────┐
                        │                浏览器（React 19）             │
                        │  TopNav(项目/素材库/动作/设置)                  │
                        │  ProjectList   Editor ─ FrameEditor(PixiJS)  │
                        │  Timeline(DnD) PlaybackBar    ImportModal   │
                        │  MaterialsPage MaterialModal(对比滑杆/剪裁)   │
                        │  MotionsPage ─ Quaternius 动作/FK 编辑/姿态表导出 │
                        │  CropModal ─ imageops/（Web Worker 图像处理） │
│  JobPanel（右侧常驻任务队列，WS 驱动）          │
                        │        │ fetch /api        │ WebSocket /ws   │
                        └────────┼───────────────────┼────────────────┘
                                 │                   │
┌────────────────────────────────▼───────────────────▼────────────────┐
│                    Bun.serve（apps/server/src/index.ts）            │
│  routes: "/" "/project/:id" "/materials" "/motions" "/settings" → HTML │
│  fetch:  /ws → server.upgrade ──────► ws.ts（clients 集合广播）      │
│          其余 → Elysia app（app.ts）                                │
│                                                                     │
│  Elysia /api                                                        │
│   ├─ api/projects.ts   项目 CRUD                                    │
│   ├─ api/frames.ts     帧查询/PATCH/替换/删除/复制/换序 + 图片流     │
│   ├─ api/import.ts     上传拆帧 / 生成 → 创建 job（项目帧）          │
│   ├─ api/materials.ts  素材 CRUD/抠图/批量抠图/剪裁替换/导入项目     │
│   ├─ api/settings.ts   settings 表读写（layout/theme/lang/genProviders/  │
│   │                    matting 白名单）                             │
│   └─ /api/jobs(/:id)   任务列表（面板初始加载）/ 单任务查询          │
│                                                                     │
│  provider.ts（多生成 provider / 抠图配置解析：settings 优先 env 兜底）│
│  providerAdapter.ts（生成校验/执行 adapter + provider 模型探测）      │
│  doctor.ts（体检 + API 联通测试：/api/doctor /api/provider/test）    │
│  queue.ts（内存队列，并发 2；JobTarget = project | materials）      │
│   ├─ jobs/extract.ts   extract_frames / generate_frames             │
│   │                    ├─ CLI 模板（jobs/run.ts）                    │
│   │                    ├─ OpenAI 兼容 API（jobs/generateApi.ts）     │
│   │                    ├─ 视频生成（百炼/MiniMax 异步轮询 → mp4）    │
│   │                    └─ generatedArtifacts.ts（分类与帧/素材入库） │
│   └─ jobs/matting.ts   matting（frame | material；引擎探测见下）    │
│                                                                     │
│  db.ts（bun:sqlite，WAL）  ──  jobs/frames/projects/materials 四表  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ 读写（绝对路径，基于 import.meta.dir）
                        ┌───────▼────────┐        ┌────────────┐
                        │ storage/（根级）│        │ ffmpeg/CLI │
                        │ framebaker.db  │        │ 外部进程    │
                        │ projects/...   │        └────────────┘
                        │ materials/...  │
                        └────────────────┘

         packages/shared：前后端共享类型与常量（无构建，exports 直指 src/index.ts）
```

## Monorepo 布局（Bun workspaces）

| 包 | 路径 | 说明 |
| --- | --- | --- |
| `@framebaker/server` | `apps/server` | Elysia API + 任务队列 + SQLite；同时经 Bun 全栈模式托管前端 |
| `@framebaker/web` | `apps/web` | React 19 + PixiJS v8 前端，`index.html` 为打包入口，字体在 `public/fonts` |
| `@framebaker/shared` | `packages/shared` | `Frame`/`Project`/`Job`/`Material` 与 API 类型；通用 `Skeleton`/`MotionClip`/`CharacterBinding`、坐标/四元数、运行时校验和连续时间 FK 采样；共享枚举、provider 与抠图设置 |

根 `tsconfig.base.json` 提供共享 compilerOptions（strict、moduleResolution: bundler、noEmit），各 app 的 `tsconfig.json` extends 后补自己的 lib/jsx/types。

## 关键设计

- **统一入口、双项目类型（Phase C 基线）**：`/project/:id` 保持统一路由，项目以创建后不可修改的 `frame | skeletal` 判别字段分派编辑器。存量项目和旧创建请求均兼容为 `frame`。FrameProject 继续以 `Frame[] + PNG` 为事实源；SkeletalProject 以项目角色、动作引用和命名序列为事实源，主输出是包含绑定与纹理闭包的 `.fbanim` 运行时包。RasterSequence 只作为骨骼项目的可选兼容输出，并通过复制创建/追加 FrameProject，不替代骨骼项目。
- **动作资产与角色项目分工**：`/motions` 只生产可复用 Skeleton/Rig、MotionClip、事件与绑定模板，不选择目标项目或管理最终 Raster 版本。骨骼项目从素材或 CharacterPartSet 组装具体角色，引用共享动作或复制为项目动作，并负责最终编排、预览和导出。
- **双生成线路**：底层 provider adapter、任务队列、matting 与 imageops 保持共享；上层请求按逐帧单图/序列/视频、骨骼部件、参考角色拆分和 MotionClip 等 generation intent 分派。逐帧项目与骨骼项目使用各自上下文内的 Tab，避免把两种产物放进同一组生成按钮。
- **HTML import 全栈**：`apps/server/src/index.ts` 里 `import index from "../../web/index.html"`，`Bun.serve` 的 `routes` 把它挂在 `/`、`/project/:id`、`/materials`、`/motions` 与 `/settings`；前端读 `location.pathname` 恢复页面上下文（无路由库）。`/motions` 默认进入正式 Skeleton / MotionClip 资产工作台，支持动画目录、JSON 导入、连续时间采样、通用 SVG 骨架选择、基础 2D TRS key、step/linear、事件 type/name CRUD、根运动策略和基础循环接缝；全部 clip 修改即时持久化并进入会话 Undo/Redo。“姿态表原型”切换项仍按需挂载固定 `humanoid-v1` Pixi/FK 编辑器，不迁移其浏览器内存数据。development 模式（`NODE_ENV !== "production"`）下每次请求重新打包并支持 HMR。
- **通用动画内核（Phase A）**：`packages/shared/src/animation.ts` 定义 provider/格式无关的 Skeleton、连续时间 MotionClip、右/左手坐标声明、局部 TRS（四元数 `x,y,z,w`）、有界运行时校验、slerp、关键帧与事件不可变编辑、基础循环接缝和 FK 求值；世界变换以列向量 `T * R * S` 的完整 4×4 矩阵为权威结果，正确保留层级非均匀缩放。`packages/shared/schemas/` 发布独立 Draft 2020-12 schema；`animationPackage.ts` 与 `json.ts` 实现 `.fbanim` v1 的逻辑 manifest、RFC 8785 规范字节、SHA-256 内容路径、依赖闭包、路径/大小限制与往返验证。ZIP 暂只视为后续受限传输层。`bun run check:animation` 同时检查矩阵 FK、时间边界、schema 严格编译、包篡改/路径攻击、确定性往返和 FK 等价。当前不含 cubic、事件 payload UI、根运动提取算法/可视化和接触感知接缝；烘焙仍待后续阶段实现。
- **storage 与 cwd 无关**：`db.ts` 用 `import.meta.dir` 上溯三级得到仓库根，`STORAGE_ROOT = <root>/storage`；DB 中 `raw_path`/`processed_path` 存绝对路径。从根 `bun dev` 或从 `apps/server` 内启动都指向同一位置。
- **任务队列**：`queue.ts` 内存 FIFO，并发上限 2；job 状态落 SQLite（queued/running/done/error/cancelled + progress/error），负载（staging 路径、prompt 等）只存内存——重启后未完成任务不恢复，启动时统一把遗留的 queued/running 标记为 error（「服务重启，任务中断」）。`POST /api/jobs/:id/cancel` 可取消排队/运行中任务（AbortSignal → `runCmd` 杀进程 / API 轮询中断）。所有状态变化经 `ws.ts` 广播；前端由 `JobPanel`（右侧常驻面板，挂在 App 根部）经 WS `job_*` 事件 + `GET /api/jobs(/:id)` 兜底轮询展示进度，排队/运行中可点取消。调度依赖保持单向：`queue.ts` 调用 `jobs/*` worker；拆帧/生成后的抠图任务通过调度层注入的窄回调入队，worker 不反向依赖队列。
- **WS 广播**：`ws.ts` 维护客户端 Set，`broadcast(type, payload)` 发 JSON；事件名在 shared 的 `WS_EVENTS` 统一定义。前端收到 `frame_updated/frames_reordered/frames_changed/job_done` 后重拉帧列表，收到 `material_updated/materials_changed` 后重拉素材列表。
- **拆帧编号**：ffmpeg 先拆到 `staging/extract_<uuid>/frame_%04d.png`，再按 raw 目录现存最大编号续编搬入 `raw/frame_XXXX.png`，多次导入互不覆盖；`duplicate` 生成的 `dup_<uuid>.png` 不匹配该扫描规则，不会被误收。
- **注入安全**：外部命令（生成 CLI / 抠图 CLI）不走模板字符串：设置页配的是结构化字段（命令 + 参数名映射），服务端组装 argv 数组（Bun.spawn，不经 shell）；遗留 env 模板（FRAMEBAKER_GEN_CLI / FRAMEBAKER_MATTING_CLI）按空白 split 成 argv 后再替换占位符，同样不经 shell，prompt 含空格也安全。
- **生成 provider 解析**（`provider.ts`，每次调用实时读 settings 表）：settings `genProviders` 列表模型——CLI / OpenAI 兼容 API / 百炼 DashScope 原生 / Gemini（banana）/ MiniMax 可配多个共存，列表为空时 env `FRAMEBAKER_GEN_CLI` 合成 id=`env` 的 CLI provider（legacyTemplate 遗留模板路径）兜底。生成请求按 `providerId` 选择（缺省第一个配置齐备的）；`type=cli` 走结构化 argv 组装（`cliBin` + 参数名映射 `cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`，参数名留空=位置参数或不下发）；`type=api`/`dashscope`/`gemini`/`minimax` 走 `jobs/generateApi.ts`：
  - api（OpenAI 兼容）：无引用图 `POST {base}/images/generations`（JSON），有引用图 `POST {base}/images/edits`（multipart image+prompt，需 gpt-image 系列等支持 edits 的模型）；`data[0].b64_json` 或 `data[0].url` 取图，120/180s 超时。
  - dashscope（百炼原生，wan2.7-image / qwen-image 等不在兼容模式内）：`POST {base}/api/v1/services/aigc/multimodal-generation/generation`，messages content 为 `[{image: dataURI}?, {text}]`（引用图 base64 上送），同步返回 `output.choices[0].message.content[*].image` URL 后下载；`apiSize` 支持 `2K`/`1K`/`4K` 或 `宽*高`；`apiBaseUrl` 经 `normalizeDashscopeBaseUrl` 剥掉 `/compatible-mode/v1` 与 `/api/v1`（Token Plan 默认 `https://token-plan.cn-beijing.maas.aliyuncs.com`，Key `sk-sp-`）。
  - gemini（banana / nano-banana）：`POST {base}/v1beta/models/{model}:generateContent`（x-goog-api-key），parts `[{text}, {inlineData}?]`，响应取首个 `inlineData.data`；`apiSize` 映射 `imageConfig.aspectRatio`。
  - minimax：图片 `POST {base}/v1/image_generation`（Bearer），引用图走 `subject_reference`（限一张，主体特征保持），`response_format=base64` 取 `data.image_base64[0]`；`apiSize` 映射 `aspect_ratio`。
  模型取请求 `model` 缺省列表第一项。`GET /api/config` 下发 `gen.providers` 与 `promptEnhancers` 摘要（不含 apiKey；providers 带 `video` 标记，映射见共享常量 `PROVIDER_VIDEO_SUPPORT`）。
- **视频生成**（`generateFrames` 的 `mediaKind="video"`，仅 cli/dashscope/minimax）：只生成并保存 `materials/{id}/raw.mp4`（不抽帧）；抽帧走 `POST /api/materials/:id/extract`（`fps` 整段或 `timestamps` 定点，单 job）→ `extract_frames`。CLI/百炼/MiniMax 视频协议同前；轮询 5s 间隔、10 分钟超时。**图片模式下 CLI 产物若为视频同样存为视频素材**。
- **能力分层**：provider 连接（Base URL / Key）与模型能力分离，模型按 `imageModels` / `videoModels` / `textModels` 管理，默认尺寸按 `imageSize` / `videoSize` 管理。adapter 只从目标媒体能力中选模并校验。提示词增强器通过 `providerId + model` 复用 api/dashscope 连接；旧独立凭证由运行时兼容层读取。
- **提示词加强**（`enhance.ts`）：`POST /api/enhance-prompt` 调用设置页 `promptEnhancers` 列表里的 OpenAI 兼容 `chat/completions`（加强系统提示词内置固定，像素画方向），返回优化后文本；前端保留原文并并排展示新旧两版供选择。
- **体检与联通测试**（`doctor.ts` + `providerAdapter.ts`）：`GET /api/doctor` 逐项检查存储可写 / ffmpeg / 抠图引擎与模型缓存 / 每个生成 provider（CLI 查命令存在；OpenAI 兼容、百炼兼容模式与 Gemini 实发模型列表请求；MiniMax 无轻量探测端点，仅校验字段）/ 每个加强模型（实发 `GET /models`）；`POST /api/provider/test` 用表单未保存的值单独测某个 API provider 或加强模型（8s 超时，401/403 判认证失败，标准模型列表时核对模型是否在列）。
- **抠图引擎探测**（`jobs/matting.ts`，每次调用实时解析，`GET /api/config` 可查）：a. 自定义 CLI（设置页 `matting.cliBin` 结构化字段优先，否则 env `FRAMEBAKER_MATTING_CLI` 遗留模板 `{input}` `{output}` 可选 `{model}`）→ b. `<repo>/.venv-matting` 内置 rembg（POSIX 为 `bin/rembg`，Windows 为 `Scripts/rembg.exe`；由 `scripts/setup_matting.sh` / `setup_matting.ps1` 安装：python3 venv + `pip install "rembg[cli,cpu]"`）→ c. PATH 里的 `rembg` → d. passthrough 复制并在 job.progress / 响应 warning 里提示安装。rembg 调用为 `rembg i -m <MODEL> in out`，模型名取 设置页 `matting.model` → `FRAMEBAKER_MATTING_MODEL` → 默认 u2net，模型缓存在 `storage/models`（spawn 时注入 `U2NET_HOME`）。前端上传/生成表单的「抠图去背」开关默认勾选，`GET /api/config` 驱动引擎状态显示。
- **图像处理 worker**（`apps/web/src/imageops/`）：剪裁的解码 / 透明边包围盒扫描 / PNG 编码放 Web Worker（OffscreenCanvas）。Bun 的 HTML 打包不处理 `new Worker(new URL(...))`，worker 脚本由服务端路由 `GET /imageops/imageOps.worker.js` 按需 `Bun.build` 同源下发；`client.ts` 懒加载单例并在 worker 不可用/出错时自动降级主线程 canvas，纯计算（`ops.ts`）两侧共用。
- **帧变换几何**（`apps/web/src/frameGeometry.ts`）：集中中心锚点、offset、rotation、scale 的轴对齐包围盒、fit-to-view 与 rotation 归一化；Pixi `FrameEditor` 与 Canvas `export.ts` 是两个渲染 adapter，共用同一几何语义。
- **导入工作流**（`apps/web/src/hooks/useImportWorkflow.ts`）：项目导入与素材导入共用文件状态转换、顺序上传、任务轮询、部分失败、计时器清理与完成汇总；两个 modal 仅提供各自的 FormData/API adapter，剪裁阶段继续由 `useCropQueue` 负责。
- **生成 provider adapter 与产物提交**：`providerAdapter.ts` 每次任务实时解析 provider，封装配置/模型/能力校验、CLI argv、API/CLI 产出分发及 doctor 的模型探测；`jobs/generatedArtifacts.ts` 拥有产物 allocation、媒体分类、帧/素材/视频入库、暂存清理、广播与自动抠图收尾。`jobs/extract.ts` 只协调“产出 → 提交”，API 厂商协议仍位于 `jobs/generateApi.ts`。

## 数据流

### 导入（GIF/MP4/单图）

```
浏览器 FormData → POST /api/import/upload
  → 落盘 staging/<uuid>/input.<ext>，创建 extract_frames job（入队）
  → extract.ts：ffmpeg（gif 全帧 / mp4 加 fps filter / image 直接复制）
  → 逐帧 INSERT frames（status=ready，或 autoMatting 时 matting）
  → autoMatting：每帧再入队 matting job → matting.ts（CLI 或 passthrough 复制为 processed）
  → 广播 frames_changed / job_done → 前端刷新帧列表
```

### 编辑

```
拖拽 Pixi 精灵 → pointerup → PATCH /api/frames/:id {offset_x, offset_y}
  → SQLite 更新 → 广播 frame_updated → 各客户端同步
工具栏步进调整 scale / rotation / opacity → 同一 PATCH 持久化
替换图片 → CropModal 剪裁并编码 PNG → POST /api/frames/:id/replace
  → 写入 processed 槽位并清理旧 processed 文件
时间轴 HTML5 DnD → 前端乐观重排 → POST /api/projects/:id/reorder {frameIds}
  → 事务重写 idx → 广播 frames_reordered
```

### 导出精灵帧（纯前端，无服务端参与）

```
按 idx 拉取全部 /api/frames/:id/image → createImageBitmap
  → 按 Pixi 相同的中心原点语义计算 offset / scale / rotation 后的全局包围盒
  → 每帧单独 canvas（统一单元格尺寸，变换与 opacity 烘焙，imageSmoothing 关闭）
  → 逐帧下载 <name>_0001.png … + <name>.frames.json（含每帧 file/w/h/duration、originX/originY）
```

### 素材库（素材 → 抠图 → 导入项目）

任务队列的 extract/generate/matting 三类 job 用 `JobTarget`（`{kind:"project"} | {kind:"materials"}`）区分落库位置，同一套 ffmpeg/CLI 逻辑服务两个目标，不复制代码；素材类 job 的 `jobs.project_id` 存空串。

```
上传单图 → POST /api/materials/upload → materials/<id>/raw.png 直接入库（source=image）
上传 GIF/MP4 → 同上入口 → staging 暂存 → extract_frames(target=materials)
  → ffmpeg 拆帧 → 每帧一个素材（name=原文件名 #i，source=extract）
生成 → POST /api/materials/generate → generate_frames(target=materials)
  → providerAdapter 按 CLI / OpenAI 兼容 / DashScope / Gemini / MiniMax 产出
  → generatedArtifacts 分类并提交图片或视频素材（source=provider 类型，metadata 存 prompt/provider/model/size）
抠图 → POST /api/materials/:id/matting → 创建 matting job，由 JobPanel 跟踪
  → 引擎解析顺序见「关键设计」；成功产出 processed.png，status='matted'
  → 无引擎时 passthrough 复制并在 job.progress 说明
  → 前端对比滑杆查看 raw vs processed；POST /:id/unmatting 删除 processed 还原
  → 选中多个素材可 POST /api/materials/batch-matting 批量入队（二次加工按需触发）
剪裁 → CropModal（前端 worker 剪裁出 PNG blob）→ POST /api/materials/:id/replace-image
  → 覆盖当前显示图对应槽位（processed ?? raw），广播 material_updated
导入 → POST /api/materials/:id/import 或 /batch-import
  → raw / processed 分槽复制为项目帧（raw/mat_<frameId>.png，mat_ 前缀避开拆帧扫描规则），
    保留原图与抠图结果，idx 追加到项目末尾，source 沿用素材 source
  → 广播 frames_changed，开着的项目编辑器经 WS 自动刷新
```

## 存储布局

```
storage/
  framebaker.db            # SQLite（WAL）：项目、帧、任务、素材、动画资产与设置
  projects/<projectId>/
    raw/frame_0000.png ... # 拆帧/生成的原图（dup_<uuid>.png 复制帧、mat_<uuid>.png 素材导入帧）
    processed/<frameId>.png        # 抠图或替换后的图
    processed/<frameId>_replaced.png
  materials/<materialId>/
    raw.png                # 素材原图
    processed.png          # 抠图后（可选）
  models/u2net.onnx 等     # rembg 模型缓存（U2NET_HOME，首次抠图自动下载）
  staging/<jobId>/         # 上传暂存（job 完成后清理）
  staging/extract_<uuid>/  # 拆帧暂存（完成后清理）
```

数据库表（`apps/server/src/db.ts`，启动时 CREATE TABLE IF NOT EXISTS）：

- `projects(id, name, folder_id, created_at)`
- `frames(id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe, offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)`
- `jobs(id, project_id, type, status, progress, error, created_at)`
- `materials(id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at)`
- `animation_assets(id, kind, name, skeleton_id, folder_id, data, created_at, updated_at)`：正式 Skeleton / MotionClip / CharacterBinding 资产（CHECK 同时预留 render-profile）；正文为通过共享 schema 校验的 JSON，`skeleton_id` 建立动作/绑定到骨架的可查询引用。旧 CHECK 由事务重建迁移并保留旧行。
- `folders(id, kind, parent_id, name, sort, created_at)`：素材/项目/动画多级目录（kind=`material`|`project`|`animation`）
- `settings(key, value, updated_at)`：界面偏好（layout / theme / lang）与运行配置（genProvider / matting），服务端权威持久化；主题与语言前端 localStorage 仅作首屏即时缓存，加载顺序为「本地立即渲染 → 服务端值覆盖」，写入双写（布局 PUT 防抖 ~500ms），离线静默降级

## 前端页面与组件

- `App.tsx`：`/` 项目列表 ↔ `/project/:id` 编辑器 ↔ `/materials` 素材库 ↔ `/settings` 设置页（history.pushState + popstate）；全局屏蔽浏览器原生右键菜单（输入框/文本域保留用于粘贴，帧项走自定义 ContextMenu）
- `TopNav`：一级导航（项目 / 素材库 / 设置）+ 主题切换（三态：跟随系统/浅色/深色）+ 界面语言切换（zh/en，`LangToggle`）；编辑器页有自己的顶栏不显示
- `SettingsPage`：生成 provider 列表管理（CLI / API 多个共存，增删改 + 保存 + API 测试连接）、抠图配置（CLI 模板 / 默认模型 datalist + 缓存状态）、体检（doctor 结果列表）
- `ProjectList`：像素卡片网格（motion stagger 入场、hover 上浮）、新建/删除弹窗
- `MaterialsPage`：素材库页——左目录树（`FolderTree`）+ 右卡片网格（来源彩色徽标按 provider、左下角「已抠图」徽标、复选框 + Cmd/Shift 多选、拖拽入文件夹）、批量条（删除/导入项目/批量抠图仅 raw/取消）
- `ProjectList`：项目列表同左树右网格布局，新建落入当前文件夹
- `FolderTree`：全部 / 未分组 + 多级文件夹 CRUD / HTML5 DnD
- `MaterialModal`：素材详情——原图/抠图对比滑杆（pointer 拖动 clip 比例）、抠图/还原、剪裁（CropModal，作用于当前显示图槽位）、网格切分（GridSplitModal：多宫格精灵图按行×列逐格切成独立素材，网格线预览，复用 imageops cropImage + `/api/materials/upload` 单图入库，原素材保留）、多动作生成（ActionGenModal：以当前素材为引用图，按 shared `ACTION_PRESETS` 动作预设逐动作调 `/api/materials/generate`，可选 `name` 按「素材名_动作」命名，每动作一个生成任务）、导入项目（选项目+复制帧数）、删除（二次确认）
- `MaterialImportModal` / `ProjectPickerModal`：素材上传与生成入口 / 项目选择弹窗；上传 Tab 选文件后询问「是否需要剪裁」（`useCropQueue` 逐张队列或单张重裁，仅静态图）；生成 Tab 用 `ProviderModelPicker` 选 provider + 模型，提交即关窗（同 ImportModal，进度交给 JobPanel）
- `ProviderModelPicker`：生成弹窗共用的 provider + 模型选择（`GET /api/config` 的 `gen.providers` 驱动；api=模型下拉/输入，cli=`{model}` 占位符值），`resolveProviderSelection` 在提交时解析缺省值
- `CropModal` + `imageops/` + `hooks/useCropQueue`：像素图剪裁工具——整数像素框选（拖动/八向缩放/数字输入）、滚轮缩放、像素网格（zoom≥8）、自动框选非透明区域；重活走 Web Worker，失败降级主线程；两个导入弹窗、素材详情与项目帧替换共用，统一产出 PNG
- `Editor`：状态中枢（frames/activeId/selectedIds/图片版本号 v），WS 订阅刷新；帧多选与批量操作（BatchBar）
- `FrameList`：竖排帧列表，左边框色 = shared `SOURCE_COLORS[source]`（浅色主题 color-mix 加深）；帧项右键出菜单（`onContextMenu` 上抛 Editor）
- `FrameEditor`：PixiJS `Application`（async init + cancelled 竞态处理）；viewport 居中缩放；主精灵拖拽改 offset；洋葱皮（prev 红 0.3 / next 蓝 0.2）；网格 Graphics；画布背景与网格色随主题（CSS 变量）；工具栏可调 scale（10% 步进）/rotation（15° 步进）/opacity（10% 步进），并支持剪裁替换/时长±/关键帧
- `Timeline`：HTML5 DnD 换序、关键帧星标、时长角标；帧项右键出菜单（同 FrameList）
- `ContextMenu`：通用右键菜单——fixed 定位光标处、视口右/下边缘自动收拢，Esc / 点外部 / 滚动 / 失焦关闭，点项先关菜单再执行；编辑器里右键未选中帧 = 设为当前帧出单帧菜单（关键帧/时长 ±1/剪裁/复制/删除），右键落在多选内 = 保留选区出批量菜单（复制/裁透明边/删除，复用 BatchBar 的 handler）
- `PlaybackBar` + `FrameEditor` 播放模式：1–24 fps tick，每帧停留 duration 个 tick；直接复用 Pixi 变换渲染
- `ImportModal`：素材库 / 上传文件 / CLI 生成三 Tab——素材库 Tab 网格多选素材后 `batch-import` 进当前项目（主流程），顶部搜索框按素材名/prompt 本地过滤（不影响已选）；上传 Tab 多文件逐个分发，选文件后同样询问「是否需要剪裁」（与素材导入共用 useCropQueue + CropModal），提交后弹窗内轮询 `/api/jobs/:id` 汇总；生成 Tab 提交即关窗（不阻塞等待），进度交给 JobPanel；生成 Tab 支持「图片 / 视频」切换（视频模式：fps 抽帧滑杆、`ProviderModelPicker` 只列支持视频的 provider，隐藏数量/引用图/尺寸）
- `JobPanel`（挂在 App 根部）：右侧常驻任务队列面板——初始 `GET /api/jobs` 接管进行中任务，之后 WS `job_*` 事件驱动 + 活动任务 3s 轮询兜底；排队/运行中可取消；完成/取消停留 6s 自动移除，失败的常驻可手动关闭；无任务时不渲染
- `SplitDivider` + `layout.ts`：编辑器布局分隔条（帧列表宽度 180–480 默认 240、时间轴高度 80–320 默认 140），pointer capture 拖动、双击恢复默认、尺寸存 localStorage `framebaker-layout`；画布区依赖 Pixi `resizeTo`（ResizeObserver）自动跟随重绘
- `theme.ts`：主题管理（localStorage `framebaker-theme`；无记录时跟随系统 prefers-color-scheme 并实时响应系统变化）
- `i18n.ts` + `i18n/zh.ts` / `i18n/en.ts`：界面语言（zh 默认 / en）；文案用稳定 key（如 `common.close`），`t(key)` / `useT()` 查表；localStorage `framebaker-lang` + settings `lang`
- `notice.ts` + `AppModals`（挂在 App 根部）：全局通知条与确认弹窗，替代浏览器默认 `alert`/`confirm`——任何组件调 `notify(text)` / `await askConfirm(text)`，禁止再用浏览器默认弹窗
- `api.ts`：fetch 封装 + WS 客户端（断线 3s 重连）

### 浏览器 PNG 序列烘焙草稿

`apps/web/src/animationBake.ts` 将 Skeleton、MotionClip、CharacterBinding 和 RenderProfile 在 Canvas2D 中组合。采样使用 `[0,duration)` 固定时刻（零时长一帧、最多 10000 帧），按 Slot.drawOrder 绘制并明确完成 Y-up 到 Canvas Y-down 与 Region pivot 映射。RGBA canonical SHA-256 与 PNG bytes SHA-256 分别记录。

提交后服务端在专用 `raster_sequences` 表与 `storage/raster-sequences/<uuid>/frames/` 建立不可变版本；源资产正文使用 canonical JSON 摘要固化。写入先落 `.staging-<uuid>`，SQLite transaction 内插行并 rename，失败清除目录和可见行。导入项目另行复制 PNG、生成新 Frame ID 并事务追加，因此重烘焙、删除序列都不会覆盖或破坏人工修帧。
