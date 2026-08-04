# FrameBaker 架构

## 总览

```
                        ┌──────────────────────────────────────────────┐
                        │                浏览器（React 19）             │
                        │  TopNav(项目/素材库)                          │
                        │  ProjectList   Editor ─ FrameEditor(PixiJS)  │
                        │  Timeline(DnD) PreviewPlayer   ImportModal   │
                        │  MaterialsPage MaterialModal(对比滑杆)        │
                        │        │ fetch /api        │ WebSocket /ws   │
                        └────────┼───────────────────┼────────────────┘
                                 │                   │
┌────────────────────────────────▼───────────────────▼────────────────┐
│                    Bun.serve（apps/server/src/index.ts）            │
│  routes: "/" "/project/:id" "/materials" → HTML import 打包 apps/web│
│  fetch:  /ws → server.upgrade ──────► ws.ts（clients 集合广播）      │
│          其余 → Elysia app（app.ts）                                │
│                                                                     │
│  Elysia /api                                                        │
│   ├─ api/projects.ts   项目 CRUD                                    │
│   ├─ api/frames.ts     帧查询/PATCH/替换/删除/复制/换序 + 图片流     │
│   ├─ api/import.ts     上传拆帧 / CLI 生成 → 创建 job（项目帧）      │
│   ├─ api/materials.ts  素材 CRUD/抠图/还原/导入项目/批量（素材库）   │
│   └─ /api/jobs/:id     任务状态查询（轮询兜底）                      │
│                                                                     │
│  queue.ts（内存队列，并发 2；JobTarget = project | materials）      │
│   ├─ jobs/extract.ts   extract_frames / generate_frames             │
│   │                    └─ ffmpeg / FRAMEBAKER_GEN_CLI（jobs/run.ts）│
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
| `@framebaker/shared` | `packages/shared` | `Frame`/`Project`/`Job`/`Material`/`FramePatch`/枚举（FRAME_STATUSES、FRAME_SOURCES、JOB_TYPES、JOB_STATUSES、MATERIAL_STATUSES、WS_EVENTS）/ SOURCE_COLORS / API 响应类型 |

根 `tsconfig.base.json` 提供共享 compilerOptions（strict、moduleResolution: bundler、noEmit），各 app 的 `tsconfig.json` extends 后补自己的 lib/jsx/types。

## 关键设计

- **HTML import 全栈**：`apps/server/src/index.ts` 里 `import index from "../../web/index.html"`，`Bun.serve` 的 `routes` 把它挂在 `/` 与 `/project/:id`；编辑器页前端读 `location.pathname` 恢复项目上下文（无路由库）。development 模式（`NODE_ENV !== "production"`）下每次请求重新打包并支持 HMR。
- **storage 与 cwd 无关**：`db.ts` 用 `import.meta.dir` 上溯三级得到仓库根，`STORAGE_ROOT = <root>/storage`；DB 中 `raw_path`/`processed_path` 存绝对路径。从根 `bun dev` 或从 `apps/server` 内启动都指向同一位置。
- **任务队列**：`queue.ts` 内存 FIFO，并发上限 2；job 状态落 SQLite（queued/running/done/error + progress/error），负载（staging 路径、prompt 等）只存内存——重启后未完成任务不恢复。所有状态变化经 `ws.ts` 广播。
- **WS 广播**：`ws.ts` 维护客户端 Set，`broadcast(type, payload)` 发 JSON；事件名在 shared 的 `WS_EVENTS` 统一定义。前端收到 `frame_updated/frames_reordered/frames_changed/job_done` 后重拉帧列表，收到 `material_updated/materials_changed` 后重拉素材列表。
- **拆帧编号**：ffmpeg 先拆到 `staging/extract_<uuid>/frame_%04d.png`，再按 raw 目录现存最大编号续编搬入 `raw/frame_XXXX.png`，多次导入互不覆盖；`duplicate` 生成的 `dup_<uuid>.png` 不匹配该扫描规则，不会被误收。
- **注入安全**：外部命令模板（FRAMEBAKER_GEN_CLI / FRAMEBAKER_MATTING_CLI）按空白 split 成 argv 后再替换占位符，不经 shell，prompt 含空格也安全。
- **抠图引擎探测**（`jobs/matting.ts`，启动时一次，`GET /api/config` 可查）：a. `FRAMEBAKER_MATTING_CLI` 模板（占位符 `{input}` `{output}` 可选 `{model}`）→ b. `<repo>/.venv-matting/bin/rembg`（`scripts/setup_matting.sh` 安装：python3 venv + `pip install "rembg[cli,cpu]"`）→ c. PATH 里的 `rembg` → d. passthrough 复制并在 job.progress / 响应 warning 里提示安装。rembg 调用为 `rembg i -m <MODEL> in out`，`FRAMEBAKER_MATTING_MODEL` 换模型（默认 u2net），模型缓存在 `storage/models`（spawn 时注入 `U2NET_HOME`）。前端上传/生成表单的「抠图去背」开关默认勾选，`GET /api/config` 驱动引擎状态显示。

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
时间轴 HTML5 DnD → 前端乐观重排 → POST /api/projects/:id/reorder {frameIds}
  → 事务重写 idx → 广播 frames_reordered
```

### 导出精灵表（纯前端，无服务端参与）

```
按 idx 拉取全部 /api/frames/:id/image → createImageBitmap
  → canvas 网格（列数 ceil(√n)，单元格取最大宽高，imageSmoothing 关闭）
  → 下载 <name>.spritesheet.png + .json（frames: [{x,y,w,h,duration}]）
```

### 素材库（素材 → 抠图 → 导入项目）

任务队列的 extract/generate/matting 三类 job 用 `JobTarget`（`{kind:"project"} | {kind:"materials"}`）区分落库位置，同一套 ffmpeg/CLI 逻辑服务两个目标，不复制代码；素材类 job 的 `jobs.project_id` 存空串。

```
上传单图 → POST /api/materials/upload → materials/<id>/raw.png 直接入库（source=image）
上传 GIF/MP4 → 同上入口 → staging 暂存 → extract_frames(target=materials)
  → ffmpeg 拆帧 → 每帧一个素材（name=原文件名 #i，source=gif/mp4）
CLI 生成 → POST /api/materials/generate → generate_frames(target=materials)
  → FRAMEBAKER_GEN_CLI 逐项产出 materials/<id>/raw.png（source=cli，metadata 存 prompt）
抠图 → POST /api/materials/:id/matting（同步，rembg 秒级耗时，前端按钮显示"抠图中…"）
  → 引擎解析顺序见「关键设计」；成功产出 processed.png，status='matted'
  → 无引擎时 passthrough 复制并在响应 warning 字段说明
  → 前端对比滑杆查看 raw vs processed；POST /:id/unmatting 删除 processed 还原
导入 → POST /api/materials/:id/import 或 /batch-import
  → 优先取 processed（否则 raw）复制为项目帧（raw/mat_<frameId>.png，
    mat_ 前缀避开拆帧扫描规则），idx 追加到项目末尾，source 沿用素材 source
  → 广播 frames_changed，开着的项目编辑器经 WS 自动刷新
```

## 存储布局

```
storage/
  framebaker.db            # SQLite（WAL）：projects / frames / jobs / materials
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

- `projects(id, name, created_at)`
- `frames(id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe, offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)`
- `jobs(id, project_id, type, status, progress, error, created_at)`
- `materials(id, name, raw_path, processed_path, status, source, metadata, created_at)`
- `settings(key, value, updated_at)`：界面偏好（layout / theme），服务端权威持久化；前端 localStorage 仅作首屏即时缓存，加载顺序为「本地立即渲染 → 服务端值覆盖」，写入双写（布局 PUT 防抖 ~500ms），离线静默降级

## 前端页面与组件

- `App.tsx`：`/` 项目列表 ↔ `/project/:id` 编辑器 ↔ `/materials` 素材库（history.pushState + popstate）
- `TopNav`：一级导航（项目 / 素材库）+ 主题切换（三态：跟随系统/浅色/深色）；编辑器页有自己的顶栏不显示
- `ProjectList`：像素卡片网格（motion stagger 入场、hover 上浮）、新建/删除弹窗
- `MaterialsPage`：素材库页——卡片网格（source 彩色徽标、抠图状态点、复选框 + Cmd/Shift 多选）、批量条（删除/导入项目/取消）、toast 提示
- `MaterialModal`：素材详情——原图/抠图对比滑杆（pointer 拖动 clip 比例）、抠图/还原、导入项目（选项目+复制帧数）、删除（二次确认）
- `MaterialImportModal` / `ProjectPickerModal`：素材上传与 CLI 生成入口 / 项目选择弹窗
- `Editor`：状态中枢（frames/activeId/selectedIds/图片版本号 v），WS 订阅刷新；帧多选与批量操作（BatchBar）
- `FrameList`：竖排帧列表，左边框色 = shared `SOURCE_COLORS[source]`（浅色主题 color-mix 加深）
- `FrameEditor`：PixiJS `Application`（async init + cancelled 竞态处理）；viewport 居中缩放；主精灵拖拽改 offset；洋葱皮（prev 红 0.3 / next 蓝 0.2）；网格 Graphics；画布背景与网格色随主题（CSS 变量）；工具栏（替换/时长±/关键帧）
- `Timeline`：HTML5 DnD 换序、关键帧星标、时长角标
- `PreviewPlayer`：1–24 fps tick，每帧停留 duration 个 tick
- `ImportModal`：素材库 / 上传文件 / CLI 生成三 Tab——素材库 Tab 网格多选素材后 `batch-import` 进当前项目（主流程）；上传 Tab 多文件逐个分发；提交后轮询 `/api/jobs/:id`（WS 为主）
- `SplitDivider` + `layout.ts`：编辑器布局分隔条（帧列表宽度 180–480 默认 240、时间轴高度 80–320 默认 140），pointer capture 拖动、双击恢复默认、尺寸存 localStorage `framebaker-layout`；画布区依赖 Pixi `resizeTo`（ResizeObserver）自动跟随重绘
- `theme.ts`：主题管理（localStorage `framebaker-theme`；无记录时跟随系统 prefers-color-scheme 并实时响应系统变化）
- `api.ts`：fetch 封装 + WS 客户端（断线 3s 重连）
