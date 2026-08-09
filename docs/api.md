# FrameBaker API

Base URL：`http://localhost:3000`，除标注外均为 `/api` 前缀。请求/响应类型定义见 `packages/shared/src/types.ts`。

约定：

- 所有 id 为 UUID 字符串
- 帧的 `tags` / `metadata` 在 API 输出中已解析为 JSON（DB 中为字符串）
- 错误响应：非 2xx + 纯文本中文错误信息
- 写操作触发 WS 广播（`/ws`，消息格式 `{ "type": string, "payload": any }`，type 见文末）

## 项目

### GET /api/projects

项目列表，按创建时间倒序。

```json
{
  "projects": [
    { "id": "…", "name": "走路循环", "kind": "frame", "created_at": 1785912000000, "frame_count": 8, "first_frame_id": "…" }
  ]
}
```

`kind` 为创建后不可变的 `frame | skeletal`；存量项目和未指定类型的创建请求均为 `frame`。

### POST /api/projects

```json
// 请求
{ "name": "走路循环", "kind": "frame" }
// 响应
{ "id": "…", "name": "走路循环", "kind": "frame" }
```

### GET /api/projects/:id

```json
{ "project": { "id": "…", "name": "…", "kind": "skeletal", "created_at": 1785912000000, "frame_count": 0 } }
```

### PATCH /api/projects/:id

`{ "name": "新名字" }` → `{ "ok": true }`

### DELETE /api/projects/:id

删除项目及其全部帧、任务、骨骼项目文档与磁盘文件 → `{ "ok": true }`，广播 `project_deleted`。

### GET /api/projects/:id/skeletal-document

仅用于 `kind="skeletal"` 的项目。首次读取会创建并持久化空文档，返回 `{ "document": { "schemaVersion": 1, "projectId": "…", "character": null, "animations": [], "activeAnimationId": null } }`。逐帧项目返回 409。

### PUT /api/projects/:id/skeletal-document

请求体为完整 `SkeletalProjectDocument`，成功返回 `{ "document": {…} }`。`projectId` 必须与 URL 一致；`character` 保存从资产库复制进项目的 `CharacterBinding` 以及可选 `sourceBindingId`，项目内后续修改不会改动原资产；动作项格式为 `{ "id", "name", "motionClipId", "speed", "repeat", "loop" }`，id 和名称非空且各自唯一，`speed` 范围 `(0, 8]`，`repeat` 为 `1..100` 整数，活动动作必须存在。角色骨架、素材与 MotionClip 必须存在，且全部使用同一 Skeleton；没有角色时不得配置动作。逐帧项目返回 409。

## 帧

### GET /api/projects/:id/frames

按 `idx` 升序返回：

```json
{
  "frames": [
    {
      "id": "…", "project_id": "…", "idx": 0,
      "raw_path": "/abs/path/storage/projects/…/raw/frame_0000.png",
      "processed_path": null,
      "status": "ready", "duration": 1, "is_keyframe": 0,
      "offset_x": 0, "offset_y": 0, "scale": 1, "rotation": 0, "opacity": 1,
      "tags": [], "source": "gif", "metadata": {}
    }
  ]
}
```

### GET /api/frames/:id/image?type=raw|processed

图片流（`image/png`，`Cache-Control: no-store`）。`type=processed` 且无 processed 文件时回退 raw。404：帧或文件不存在。

### PATCH /api/frames/:id

可更新字段（至少一个，全部可选）：`offset_x` / `offset_y`（-100000–100000）、`scale`（0.1–8）、`rotation`（弧度，-π–π）、`opacity`（0–1）、`duration`（int 1–600）、`is_keyframe`（0/1）、`tags`（string[]）。

```json
// 请求
{ "offset_x": 12.5, "duration": 3, "is_keyframe": 1 }
// 响应
{ "frame": { /* 更新后的完整帧 */ } }
```

广播 `frame_updated`。

### POST /api/frames/:id/replace

multipart/form-data：`file`（PNG，服务端校验文件签名）。编辑器会先通过 CropModal 剪裁/编码，再写入 `processed/<id>_replaced.png`；旧 processed 文件会被清理，`source` 置为 `upload`，状态置 `ready`。响应 `{ "frame": {…} }`，广播 `frame_updated`。

### POST /api/frames/:id/duplicate?count=N

复制 N 份（1–16，默认 1）插入原帧之后，复制图片文件与全部属性，`source=duplicate`，后续帧 idx 顺延。响应 `{ "ok": true, "count": 2 }`，广播 `frames_changed`。

### DELETE /api/frames/:id

删除帧与图片文件，同项目后续帧 idx 前移。`{ "ok": true }`，广播 `frames_changed`。

### POST /api/projects/:id/reorder

```json
// 请求：必须恰好包含项目全部帧 id
{ "frameIds": ["id3", "id1", "id2"] }
// 响应
{ "ok": true }
```

按数组顺序重写 idx（事务）。400：集合不匹配。广播 `frames_reordered`。

## 导入

### POST /api/import/upload

multipart/form-data：

| 字段 | 说明 |
| --- | --- |
| `file` | 素材文件 |
| `projectId` | 目标项目 |
| `type` | `gif`（全部帧）/ `mp4`（按 fps 抽帧）/ `image`（单图一帧） |
| `fps` | 可选，mp4 抽帧帧率，默认 8（1–60） |
| `autoMatting` | 可选，`"true"` 时每帧再入队抠图任务 |

响应 `{ "jobId": "…" }`，随后轮询 `GET /api/jobs/:id` 或等 WS `job_done`。

```bash
curl -F "file=@test.gif" -F "projectId=$PID" -F "type=gif" http://localhost:3000/api/import/upload
```

### POST /api/import/generate

```json
// 请求
{ "projectId": "…", "prompt": "pixel art knight", "count": 4, "autoMatting": false, "providerId": "…", "model": "wanx2.1-t2i-turbo", "size": "1328*1328", "referenceFrameId": "…", "mediaKind": "image", "fps": 8 }
// 响应
{ "jobId": "…" }
```

provider 解析：传了 `providerId` 按 id 找（找不到 400）；缺省用第一个配置齐备的 provider（设置页可配多个共存，类型：`cli` / `api`（OpenAI 兼容）/ `dashscope`（百炼原生）/ `gemini`（banana）/ `minimax`；列表为空时 env `FRAMEBAKER_GEN_CLI` 合成 id=`env` 的 CLI provider 兜底）。可选 `size` 在生成时覆盖 provider 的 `apiSize`（格式随 provider 类型：api 如 `1024x1024`、dashscope 如 `1328*1328`、gemini/minimax 如 `16:9`；预设档位见共享常量 `GEN_SIZE_PRESETS`；CLI provider 无尺寸概念忽略）。

- **CLI provider**：结构化字段组装 argv（`cliBin` + 参数名映射：`cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`，留空=位置参数或不下发），不经 shell；env `FRAMEBAKER_GEN_CLI` 与旧数据走遗留模板占位符路径（`{prompt}` `{output}` `{index}` `{reference}` `{model}`）。
- **API provider（OpenAI 兼容，含 OpenAI 官方 / 火山方舟豆包 Seedream / 各类网关）**：无引用图走 `POST {apiBaseUrl}/images/generations`（JSON `{ model, prompt, size?, n: 1 }`）；有引用图走 `POST {apiBaseUrl}/images/edits`。单图保持 multipart `image` 字段；双图按官方多图格式重复使用 `image[]`，顺序为外观图、动作图。需端点和模型支持 edits/多图输入（dall-e-3 不支持 edits）。响应取 `data[0].b64_json` 或 `data[0].url` 下载。
- **DashScope provider（百炼原生）**：`POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`（wan2.7-image / qwen-image 等，不在兼容模式内）；content 顺序为外观引用图、动作参考图、文本（未传的图片省略，图片为 base64 dataURI）；响应取 `output.choices[0].message.content[*].image` URL 下载（24h 有效）。`apiSize` 可为 `2K`/`1K`/`4K` 或星号格式（如 `2048*2048`）原样透传。**Base URL 归一**（`normalizeDashscopeBaseUrl`）：可填 Token Plan `https://token-plan.cn-beijing.maas.aliyuncs.com`，或文档兼容地址 `…/compatible-mode/v1` / 尾部 `/api/v1`（服务端剥掉后缀再拼原生路径）；按量付费常用 `https://dashscope.aliyuncs.com`。
- **Gemini provider（banana / nano-banana）**：`POST {apiBaseUrl}/v1beta/models/{model}:generateContent`（`x-goog-api-key` 头）；parts 顺序为外观引用图、动作参考图、文本（未传的图片省略）；`apiSize` 映射 `imageConfig.aspectRatio`（如 `16:9`）；响应取 `candidates[0].content.parts[*].inlineData.data`（base64）。
- **MiniMax provider**：`POST {apiBaseUrl}/v1/image_generation`（Bearer）；引用图走 `subject_reference`（主体特征保持，限一张，base64 dataURI）；`apiSize` 映射 `aspect_ratio`（如 `16:9`）；`response_format=base64`，响应取 `data.image_base64[0]`，`base_resp.status_code` 非 0 视为失败。

模型取请求的 `model`，缺省 provider 模型列表第一项，都没有则任务 error。provider 不存在/配置不齐时任务置 `error` 并给出说明。`count` 1–16。

- **视频模式**：`mediaKind: "video"`——只生成并保存一段视频素材（`raw.mp4`，不抽帧；`count`/`fps` 忽略）。仅支持 CLI / 百炼 / MiniMax。完成后用 `POST /api/materials/:id/extract`（fps 或 timestamps）抽帧成多张图片素材。

- **CLI provider**：`{output}` 给 `.mp4` 后缀路径，产出经魔数检测为视频（ftyp/EBML/RIFF-AVI）则走 ffmpeg 抽帧。**图片模式下 CLI 产物若实为视频同样自动转拆帧**（此时 `count` 忽略）。
- **MiniMax provider**：按模型分协议——`MiniMax-Hailuo-*` / `T2V-*` 走 v1：`POST {apiBaseUrl}/v1/video_generation`（`{ model, prompt, duration? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v1/query/video_generation?task_id=`（`status`：Success/Fail 等）取 `file_id`，再 `GET {apiBaseUrl}/v1/files/retrieve?file_id=` 取 `download_url`。`MiniMax-H3` 等走 v2：`POST {apiBaseUrl}/v2/video_generation`（`{ model, content:[{type:"text",text}], duration, ratio? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v2/query/video_generation/{task_id}`（`task.status`：succeeded/failed/cancelled），成功取 `task.content.url` 下载。默认 `duration=6`；文生视频缺省 `ratio=16:9`。
- **DashScope provider（万相 / HappyHorse）**：`POST {apiBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`（头 `X-DashScope-Async: enable`）。文生视频 `happyhorse-1.1-t2v`：`input:{prompt}` + `parameters:{resolution,ratio,duration,watermark:false}`；图生视频 `*-i2v`：`input.media[{type:first_frame,url}]`（引用图 base64）；参考生视频 `*-r2v`：`media[{type:reference_image}]`。→ `output.task_id`；轮询 `GET {apiBaseUrl}/api/v1/tasks/{task_id}`（`output.task_status`：PENDING/RUNNING/SUCCEEDED/FAILED），成功取 `output.video_url` 下载。旧 wanx 仍可把 `apiSize` 当 `size` 透传。

视频为异步任务（约 1–5 分钟），进度写 `job.progress` 并经 WS 推送；拆出帧按 target 入库（项目帧 / 素材），`autoMatting` 照常生效。视频可按模型使用原有单张 `referenceMaterialId` / `referenceFrameId`；不支持动作参考字段，携带时返回 400。

引用图（可选，仅图片模式）：`referenceMaterialId` / `referenceFrameId` 二选一，服务端按 id 解析文件路径（优先 processed 否则 raw，防止客户端路径注入）。API / 百炼 provider 原生支持引用图；CLI 前置校验（创建 job 前直接 400）：两个 id 同传 / id 查不到 / 选了引用图但模板缺 `{reference}` / 模板含 `{reference}` 但未选引用图。

动作参考图（可选，仅图片模式）：`poseReferenceMaterialId` / `poseReferenceFrameId` 二选一，必须同时提供上述角色/外观引用图。两组图片按“外观图、动作图”顺序传给 OpenAI 兼容 API、DashScope 或 Gemini；两种动作 ID 同传、记录不存在或文件缺失均在创建任务时返回 400。CLI、MiniMax 和所有视频模式暂不支持独立动作参考，携带时明确返回 400，不会静默忽略。

## 素材库 /api/materials

素材先在素材库生成/上传、抠图、对比，确认后再导入项目成为帧。素材的 `source` 语义与帧一致（`cli`/`api`/`dashscope`/`gemini`/`minimax`/`upload`/`gif`/`mp4`/`image`/`duplicate`；AI 生成按实际 provider 类型写入，不再一律 `cli`），`status` 为 `raw`（原图）/ `matted`（已抠图）。素材与项目均可挂 `folder_id`（见 `/api/folders`）。

### GET /api/materials

```json
{
  "materials": [
    {
      "id": "…", "name": "slime #1", "status": "matted", "source": "cli",
      "raw_path": "/abs/storage/materials/…/raw.png",
      "processed_path": "/abs/storage/materials/…/processed.png",
      "metadata": { "prompt": "pixel slime" }, "created_at": 1785912000000
    }
  ]
}
```

### GET /api/materials/:id/image?type=raw|processed&strict=1

图片流（`image/png`，no-store）。`type=processed` 且无 processed 时默认回退 raw；`strict=1` 会在指定槽位缺失时直接返回 404，供运行时包导出避免槽位语义漂移。

### POST /api/materials/upload

multipart/form-data：`file` + 可选 `autoMatting`(`"true"`)、`fps`（视频抽帧，默认 8）。
PNG/JPG 等单图 → 直接生成 1 个素材，响应 `{ "materialId": "…" }；GIF/MP4 → 队列拆帧每帧一个素材，响应 `{ "jobId": "…" }`。

```bash
curl -F "file=@slime.png" http://localhost:3000/api/materials/upload
curl -F "file=@walk.gif" -F "autoMatting=true" http://localhost:3000/api/materials/upload
```

### POST /api/materials/generate

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "referenceMaterialId": "…", "poseReferenceMaterialId": "…" }` → `{ "jobId": "…" }`（生成 provider 解析与 `/api/import/generate` 一致，未配置时 job error 给出配置说明）。可选 `name`：素材命名基准（缺省取 prompt 前 24 字符），产出命名为 `name #i`（count>1）——素材详情「多动作生成」按「素材名_动作」传入。普通引用与动作参考字段、校验和 provider 限制均与 `/api/import/generate` 一致。支持 `mediaKind: "video"`：只生成并保存视频素材（`kind=video`），**不抽帧**；完成后用下方 extract 接口拆帧。可选 `intent`：`frame-image|frame-sheet|frame-video|skeletal-parts|skeletal-decompose|skeletal-repair-part|motion-clip`，以及 `characterPartSetId`。`skeletal-parts` / `skeletal-decompose` 必须指定现有部件集且为图片模式，后者还必须提供引用图片；生成的标准部件表在 metadata 中保留目标集合，打开素材时会默认进入 3×2 骨骼部件切分，但部件表本身不会冒充独立 attachment 成员。缺省 intent 保持旧行为。

## 角色部件集

`CharacterPartSet` 显式组织骨骼角色素材：`{ id, name, source: "manual"|"generated"|"decomposed", referenceMaterialId, members: [{ materialId, role, name }], created_at, updated_at }`。role 为 `head|torso|arm-left|arm-right|leg-left|leg-right|weapon|accessory|custom`。

- `GET /api/character-part-sets` → `{ "characterPartSets": [...] }`
- `GET /api/character-part-sets/:id` → `{ "characterPartSet": {...} }`
- `POST /api/character-part-sets`：提交 `name/source/referenceMaterialId?/members`；校验全部素材存在且素材不重复。
- `PUT /api/character-part-sets/:id`：全量替换 `name/referenceMaterialId?/members`；`source` 不可修改。
- `DELETE /api/character-part-sets/:id`：删除集合及成员关系，不删除素材。

删除素材时会移除成员关系；若素材是集合参考图，则清空引用，保证无悬挂素材引用。

### POST /api/materials/:id/extract

视频/GIF 素材抽帧成多张图片素材 → `{ "jobId": "…" }`。复制源文件到 staging 后入队**一个** `extract_frames` 任务；产出命名为「原名 #i」，默认落在同一文件夹。非视频/GIF 返回 400。

- **整段按 fps**（默认，GIF/视频）：`{ "fps"?: 8, "autoMatting"?: false, "folderId"?: null }`
- **定点抽帧**（仅视频）：`{ "timestamps": [0.12, 0.5, 1.0], "autoMatting"?: false, "folderId"?: null }` —— 秒（浮点），排序去重，最多 64 个；GIF 传 timestamps 返回 400。服务端对每个时间点跑一次 `ffmpeg -ss T -i … -frames:v 1`（可取消）。

### POST /api/materials/:id/matting

入队抠图任务（`matting` job，队列并发 2），响应 `{ "jobId": "…" }`；素材不存在 404，缺 raw 文件 400。**同一素材已有 queued/running 抠图任务时 409**（禁止重复入队）。引擎解析顺序见 `GET /api/config`——自定义 CLI → 内置 rembg → PATH rembg → passthrough 复制（passthrough 警告写入 `job.progress`）。完成后 `status` 置 `matted` 并广播 `material_updated`；rembg 模型首次使用需下载（可达数百 MB），进度经 WS `job_*` 事件推送。

### POST /api/materials/batch-matting

`{ "ids": ["…", "…"] }` → `{ "ok": true, "count": 2, "skipped": 1 }`。仅对 `status=raw` 的素材入队抠图；已抠图或**已有进行中抠图任务**计入 `skipped`（详情页单条仍可重新抠，但进行中会 409）。

### POST /api/materials/:id/replace-image

multipart/form-data：`file`（PNG）+ `slot`（`"raw"` | `"processed"`）。剪裁工具的落盘端点：覆盖对应槽位文件；`slot=processed` 且尚无 processed 时建立之并置 `status=matted`，`slot=raw` 不影响已有 processed。响应 `{ "material": {…} }`，广播 `material_updated`。

### POST /api/materials/:id/unmatting

删除 processed、还原为 `raw` 状态。响应 `{ "material": {…} }`。

### POST /api/materials/:id/import

```json
// 请求
{ "projectId": "…", "count": 2 }
// 响应
{ "ok": true, "count": 2, "frameIds": ["…", "…"] }
```

把素材复制为项目帧追加到末尾：raw 与 processed 槽位分别复制，避免抠图结果覆盖帧原图；若历史素材缺少 raw 才回退 processed。`source` 沿用素材来源，`metadata` 合并 `{fromMaterial: id, ...}`。`count` 1–16，默认 1。广播 `frames_changed`。

### POST /api/materials/batch-delete

`{ "ids": ["…", "…"] }` → `{ "ok": true, "deleted": 2 }`（连同磁盘文件），广播 `materials_changed`。

### POST /api/materials/batch-import

`{ "ids": ["…", "…"], "projectId": "…" }` → `{ "ok": true, "count": 2 }`。按给定顺序各导入 1 帧。

## 任务

### GET /api/jobs

→ `{ "jobs": [ {…}, … ] }`，按创建时间倒序取最近 50 条（前端任务面板初始加载用，之后以 WS 事件为主）。

### GET /api/jobs/:id

```json
{
  "job": {
    "id": "…", "project_id": "…", "type": "extract_frames",
    "status": "done", "progress": "完成", "error": null, "created_at": 1785912000000
  }
}
```

`status`：`queued` / `running` / `done` / `error` / `cancelled`。任务负载在内存中，服务重启时会把遗留的 `queued` / `running` 任务标记为 `error`（「服务重启，任务中断」）。

### POST /api/jobs/:id/cancel

取消排队中或运行中的任务 → `{ "ok": true }`。`queued` 直接出队标 `cancelled`；`running` 触发 AbortSignal（杀掉 `runCmd` 子进程 / 打断 API 轮询）。已结束状态返回 409。广播 `job_cancelled`。

## 通用动画资产 /api/animation-assets

Skeleton、MotionClip 与 CharacterBinding 以正式共享 schema 独立持久化。MotionClip/CharacterBinding 创建或替换时会对其引用的 Skeleton 做完整校验。CharacterBinding v1 仅支持 Region；每个 attachment 的 materialId 与显式 raw/processed 路径必须存在且具有 PNG 签名，不做槽位回退。

### GET /api/animation-assets?kind=skeleton|motion-clip|character-binding

返回轻量索引 `{ "assets": [{ id, kind, name, skeleton_id, folder_id, created_at, updated_at }] }`；省略 `kind` 返回全部资产。

### POST /api/animation-assets

`{ "asset": { /* Skeleton、MotionClip 或 CharacterBinding */ }, "folderId": null }` → `{ "animationAsset": { "asset": {…}, "folder_id": null, "created_at": 0, "updated_at": 0 } }`。

ID 冲突返回 409；schema 非法、动画文件夹错误、关联骨架/骨骼/素材/PNG 槽位不存在返回 400。成功广播 `animation_assets_changed`。

### GET /api/animation-assets/:id

返回完整资产正文与存储元数据；不存在返回 404。

### PUT /api/animation-assets/:id

请求同 POST。资产 ID 与种类不可修改；省略 `folderId` 保持原文件夹，传 `null` 移到未分组。替换骨架前会用新骨架重新校验全部依赖动作和角色绑定，任何骨骼引用失效时返回 409，不会部分写入。

### DELETE /api/animation-assets/:id

删除动作、角色绑定或未被引用的骨架。仍有 MotionClip/CharacterBinding 引用的骨架返回 409；素材批量删除（含单项调用）若被 CharacterBinding Region 引用也返回 409。

## 文件夹 /api/folders

素材库、项目列表与动画资产共用多级文件夹（`kind`: `material` | `project` | `animation`）。资源通过 `folder_id` 归属；删除文件夹时内容上移到父级（不删资源）。

### GET /api/folders?kind=material|project|animation

→ `{ "folders": [ { id, kind, parent_id, name, sort, created_at }, … ] }`（扁平列表，前端组树）。

### POST /api/folders

`{ "kind": "material", "name": "角色", "parentId": null }` → `{ "folder": {…} }`，广播 `folders_changed`。

### PATCH /api/folders/:id

`{ "name"?, "parentId"? }`（禁止移到自身或子孙下）。

### DELETE /api/folders/:id

子树内资源上移到父级后删除整棵文件夹子树。

### POST /api/folders/move-items

`{ "kind": "material", "ids": ["…"], "folderId": null }` → `{ "ok": true, "moved": n }`（`folderId: null` = 未分组）。

## WebSocket /ws

服务端 → 客户端单向广播，JSON：

```json
{ "type": "frame_updated", "payload": { "id": "…", "projectId": "…" } }
```

| type | 时机 |
| --- | --- |
| `job_queued` / `job_running` / `job_progress` / `job_done` / `job_error` / `job_cancelled` | 任务生命周期 |
| `frame_updated` | PATCH / 替换 / 帧抠图完成 |
| `frames_changed` | 导入完成 / 复制 / 删除 / 素材导入项目 |
| `frames_reordered` | 换序 |
| `animation_assets_changed` | 动画资产创建 / 替换 / 删除 / 移动 |
| `project_deleted` | 删除项目 |
| `material_updated` | 素材抠图完成 / 还原原图 / 剪裁替换图片 |
| `materials_changed` | 素材上传 / 生成 / 批量删除 / 移动文件夹 |
| `folders_changed` | 文件夹增删改 / 移动 |
| `settings_changed` | 设置写入（layout / theme / lang / genProvider / matting） |

前端建议：收到 `frame_updated` / `frames_reordered` / `frames_changed` / `job_done` 后重拉帧列表，收到 `material_updated` / `materials_changed` 后重拉素材列表；断线 3s 重连。

## 界面偏好 /api/settings

布局（编辑器面板尺寸）、主题模式、界面语言、生成 provider、抠图配置等持久化在服务端 `settings` 表（SQLite），换浏览器/重启不丢；主题与语言前端以 localStorage 为首屏即时缓存，服务端不可达时静默降级。

### GET /api/settings

返回整个 kv 对象（value 已 JSON 解析）：

```json
{
  "layout": { "sidebarW": 260, "timelineH": 160 },
  "theme": "dark",
  "lang": "zh",
  "genProviders": [
    {
      "id": "…", "name": "OpenAI", "type": "api",
      "cliTemplate": "", "apiBaseUrl": "https://api.openai.com/v1", "apiKey": "sk-…",
      "apiModels": ["gpt-image-1"], "apiSize": "1024x1024"
    },
    { "id": "…", "name": "本地 mygen", "type": "cli", "cliTemplate": "mygen --prompt \"{prompt}\" -o {output}", "apiBaseUrl": "", "apiKey": "", "apiModels": [], "apiSize": "" }
  ],
  "matting": { "cliTemplate": "", "model": "u2net" }
}
```

### PUT /api/settings/:key

```json
// 请求（key 白名单：layout、theme、lang、genProviders、matting、promptEnhancers；其他 key 返回 400）
{ "value": { "sidebarW": 260, "timelineH": 160 } }
// 响应
{ "ok": true }
```

`theme` 的合法值：`"system"`（跟随系统）/ `"light"` / `"dark"`。`lang` 的合法值：`"zh"` / `"en"`。写入后广播 `settings_changed` `{ key }`。

`genProviders`：生成 provider 列表。连接凭证只存一次（`apiBaseUrl` / `apiKey`），能力按 `imageModels` / `videoModels` / `textModels` 分类，图片与视频默认尺寸分别为 `imageSize` / `videoSize`。服务端仍读取旧 `apiModels` / `apiSize`：旧模型按名称迁移到图片或视频能力，旧尺寸同时作为两类尺寸 fallback；设置页只写新字段。CLI 继续使用 `cliBin`、各参数名与 `cliExtraArgs` 的结构化 argv，不经 shell；列表为空时 env `FRAMEBAKER_GEN_CLI` 兜底。

`promptEnhancers` 元素为 `{ id, name, providerId, model }`，复用 `api` 或 `dashscope` provider 的连接凭证；旧 `{ apiBaseUrl, apiKey, apiModel }` 仍可读取运行。`POST /api/enhance-prompt` 可传 `mediaKind: "image" | "video"`，视频模式会使用动作时序、镜头与一致性导向的系统提示词。

`matting`：结构化抠图命令 `cliBin` / `cliInputArg` / `cliOutputArg` / `cliModelArg`（均留空走 env `FRAMEBAKER_MATTING_CLI` 模板 → 自动探测）；`model` 留空回退 `FRAMEBAKER_MATTING_MODEL` / 默认 `u2net`。

## 其他

- `GET /api/health` → `{ "ok": true, "name": "FrameBaker" }`
- `GET /api/config` → 服务端能力探测（每次请求实时解析，设置页改动即时生效）：

```json
{
  "matting": {
    "engine": "rembg-bundled",
    "model": "u2net",
    "hint": null,
    "modelCached": true
  },
  "gen": {
    "providers": [
      { "id": "…", "name": "OpenAI", "type": "api", "models": ["gpt-image-1"], "configured": true }
    ]
  }
}
```

  `engine`：`custom-cli`（设置页 matting.cliTemplate 或 `FRAMEBAKER_MATTING_CLI`）/ `rembg-bundled`（`.venv-matting` 内置）/ `rembg-path`（PATH 中找到）/ `none`（未安装，抠图仅复制原图，`hint` 为安装提示）。`model` 为 rembg 模型名（设置页 matting.model → `FRAMEBAKER_MATTING_MODEL` → 默认 `u2net`），`modelCached` 表示模型文件已在 `storage/models`（未缓存首次抠图自动下载）。`gen.providers` 为全部生成 provider 的摘要（不含 apiKey；`models` 供生成弹窗下拉，`configured` 表示关键字段齐备，`video` 表示支持视频生成——仅 cli/dashscope/minimax，映射见共享常量 `PROVIDER_VIDEO_SUPPORT`）。
- `GET /api/doctor` → 体检：逐项检查存储目录可写 / ffmpeg / 抠图引擎与模型缓存 / 每个生成 provider（CLI 校验命令存在；OpenAI 兼容实发 `GET /models`、Gemini 实发 `GET /v1beta/models`、百炼实发 `GET /compatible-mode/v1/models` 联通测试；MiniMax 无探测端点仅校验字段）→ `{ "checks": [{ "id", "ok", "label", "detail" }] }`。
- `POST /api/provider/test` → API provider 联通测试（用表单当前值，不要求已保存）：`{ "type"?, "apiBaseUrl", "apiKey", "apiModel?" }`；api 实发 `GET {baseUrl}/models` + Bearer、gemini 实发 `GET {baseUrl}/v1beta/models`（x-goog-api-key）、dashscope 实发 `GET {baseUrl}/compatible-mode/v1/models` + Bearer，返回 `{ "ok", "status", "latencyMs", "modelsFound" }`（401/403 判定为认证失败）；minimax 无轻量探测端点，仅校验字段并在 `note` 说明。
- `POST /api/provider/models` → API provider 模型列表（设置页「获取模型」，用表单当前值拉取，不要求已保存）：`{ "type", "apiBaseUrl", "apiKey" }` → `{ "ok", "models": ["…"] }`；端点与联通测试同源（api `/models`、dashscope `/compatible-mode/v1/models`、gemini `/v1beta/models` 去 `models/` 前缀；minimax 为 best-effort 试 `/v1/models`），失败返回 `{ "ok": false, "error" }`，前端保持手填。
- `POST /api/enhance-prompt` → 提示词加强（设置页配置的加强模型，OpenAI 兼容 `chat/completions`，加强系统提示词服务端内置、按 `style` 组装）：`{ "enhancerId"?, "prompt", "style"? }` → `{ "enhanced", "enhancerName" }`；`enhancerId` 缺省用第一个配置齐备的；`style` 取共享常量 `ENHANCE_STYLES` 的 id（pixel/anime/illustration/3d/realistic/general），缺省或未知值按 `pixel` 处理；未配置/调用失败返回 400 文本说明。前端保留原提示词并并排展示两版供选择。
- `GET /fonts/:name` → `apps/web/public/fonts/` 下的字体文件（woff2 / OFL.txt）
- `GET /imageops/imageOps.worker.js` → 前端剪裁 worker 脚本（服务端按需 `Bun.build` 打包 `apps/web/src/imageops/imageOps.worker.ts` 下发；开发模式每次重建，生产缓存）

## RenderProfile 动画资产（Phase B 草稿）

通用 `/api/animation-assets` CRUD 显式接受 `kind: "render-profile"`。v1 正文包含 `width`、`height`（1..4096 整数）、`fps`（1..120）、画布像素 `origin`、正数 `scale` 与固定 `background: "transparent"`；该资产没有 `skeleton_id`。`.fbanim` v1 仍只封装 Skeleton/MotionClip，拒绝 RenderProfile。

## RasterSequence（Phase B）

RasterSequence 是独立、不可变的派生资产，不属于 `animation_assets`，也不进入 `.fbanim` v1。`POST /api/raster-sequences` 接收 multipart：`name`、可选 `parentId`、`manifest`（JSON）及同名 `frames` PNG 文件；服务端验证源资产、规范 JSON 摘要、profile 快照、固定半开采样、PNG IHDR/尺寸与 PNG SHA-256 后创建全新 UUID。另有 `GET /api/raster-sequences`、`GET /api/raster-sequences/:id`、`DELETE /api/raster-sequences/:id`，没有 PUT/PATCH。

`POST /api/raster-sequences/:id/import-project` body `{ "projectId": "…" }` 将 PNG 独立复制为全新项目帧并追加到末尾，`source=raster`，metadata 固化 sequence/frame/digest；重复导入继续追加，不覆盖已有帧、processed 图片或人工变换。目标必须是 `kind=frame` 的逐帧项目；骨骼项目的主输出是 `.fbanim v2`，RasterSequence 仅保留为兼容路径。
