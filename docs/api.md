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
    { "id": "…", "name": "走路循环", "created_at": 1785912000000, "frame_count": 8, "first_frame_id": "…" }
  ]
}
```

### POST /api/projects

```json
// 请求
{ "name": "走路循环" }
// 响应
{ "id": "…", "name": "走路循环" }
```

### GET /api/projects/:id

```json
{ "project": { "id": "…", "name": "…", "created_at": 1785912000000, "frame_count": 8 } }
```

### PATCH /api/projects/:id

`{ "name": "新名字" }` → `{ "ok": true }`

### DELETE /api/projects/:id

删除项目及其全部帧、任务与磁盘文件 → `{ "ok": true }`，广播 `project_deleted`。

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
- **API provider（OpenAI 兼容，含 OpenAI 官方 / 火山方舟豆包 Seedream / 各类网关）**：无引用图走 `POST {apiBaseUrl}/images/generations`（JSON `{ model, prompt, size?, n: 1 }`）；有引用图走 `POST {apiBaseUrl}/images/edits`（multipart：image + prompt + model + size?，需模型支持，如 gpt-image 系列；dall-e-3 不支持 edits）。响应取 `data[0].b64_json` 或 `data[0].url` 下载。
- **DashScope provider（百炼原生）**：`POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`（qwen-image 系列官方接口，不在兼容模式内）；无引用图 content 仅 `[{text}]`，有引用图前置 `{image: dataURI}`（base64）；响应取 `output.choices[0].message.content[*].image` URL 下载（24h 有效）。`apiSize` 为星号格式（如 `2048*2048`）原样透传；baseUrl 可填工作区子域（`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`），尾部的 `/api/v1` 会自动归一。
- **Gemini provider（banana / nano-banana）**：`POST {apiBaseUrl}/v1beta/models/{model}:generateContent`（`x-goog-api-key` 头）；parts 为 `[{text}, {inlineData: base64 引用图}?]`；`apiSize` 映射 `imageConfig.aspectRatio`（如 `16:9`）；响应取 `candidates[0].content.parts[*].inlineData.data`（base64）。
- **MiniMax provider**：`POST {apiBaseUrl}/v1/image_generation`（Bearer）；引用图走 `subject_reference`（主体特征保持，限一张，base64 dataURI）；`apiSize` 映射 `aspect_ratio`（如 `16:9`）；`response_format=base64`，响应取 `data.image_base64[0]`，`base_resp.status_code` 非 0 视为失败。

模型取请求的 `model`，缺省 provider 模型列表第一项，都没有则任务 error。provider 不存在/配置不齐时任务置 `error` 并给出说明。`count` 1–16。

**视频模式**：`mediaKind: "video"`（缺省 `image`）+ `fps`（1–60，缺省 8）——生成一段视频后按 fps 逐帧切割入库（`count` 忽略）。仅支持 CLI / 百炼 / MiniMax provider（其余类型前置 400；支持情况见 `GET /api/config` 的 `gen.providers[].video`）：

- **CLI provider**：`{output}` 给 `.mp4` 后缀路径，产出经魔数检测为视频（ftyp/EBML/RIFF-AVI）则走 ffmpeg 抽帧。**图片模式下 CLI 产物若实为视频同样自动转拆帧**（此时 `count` 忽略）。
- **MiniMax provider（v2 协议，MiniMax-H3 等）**：`POST {apiBaseUrl}/v2/video_generation`（`{ model, content:[{type:"text",text}], ratio? }`）→ `task_id`；轮询 `GET {apiBaseUrl}/v2/query/video_generation/{task_id}`（5s 间隔，10 分钟超时；`task.status`：succeeded/failed/cancelled），成功取 `task.content.url` 下载。
- **DashScope provider（万相 wan2.x/wanx2.1 旧版异步协议）**：`POST {apiBaseUrl}/api/v1/services/aigc/video-generation/video-synthesis`（头 `X-DashScope-Async: enable`；`{ model, input:{prompt}, parameters:{size?, watermark:false} }`）→ `output.task_id`；轮询 `GET {apiBaseUrl}/api/v1/tasks/{task_id}`（`output.task_status`：PENDING/RUNNING/SUCCEEDED/FAILED），成功取 `output.video_url` 下载。

视频为异步任务（约 1–5 分钟），进度写 `job.progress` 并经 WS 推送；拆出帧按 target 入库（项目帧 / 素材），`autoMatting` 照常生效。视频模式不支持引用图（前端不展示，服务端忽略）。

引用图（可选，仅图片模式）：`referenceMaterialId` / `referenceFrameId` 二选一，服务端按 id 解析文件路径（优先 processed 否则 raw，防止客户端路径注入）。API / 百炼 provider 原生支持引用图；CLI 前置校验（创建 job 前直接 400）：两个 id 同传 / id 查不到 / 选了引用图但模板缺 `{reference}` / 模板含 `{reference}` 但未选引用图。

## 素材库 /api/materials

素材先在素材库生成/上传、抠图、对比，确认后再导入项目成为帧。素材的 `source` 语义与帧一致（`cli`/`upload`/`gif`/`mp4`/`image`），`status` 为 `raw`（原图）/ `matted`（已抠图）。

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

### GET /api/materials/:id/image?type=raw|processed

图片流（`image/png`，no-store）。`type=processed` 且无 processed 时回退 raw。

### POST /api/materials/upload

multipart/form-data：`file` + 可选 `autoMatting`(`"true"`)、`fps`（视频抽帧，默认 8）。
PNG/JPG 等单图 → 直接生成 1 个素材，响应 `{ "materialId": "…" }；GIF/MP4 → 队列拆帧每帧一个素材，响应 `{ "jobId": "…" }`。

```bash
curl -F "file=@slime.png" http://localhost:3000/api/materials/upload
curl -F "file=@walk.gif" -F "autoMatting=true" http://localhost:3000/api/materials/upload
```

### POST /api/materials/generate

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "referenceMaterialId": "…" }` → `{ "jobId": "…" }`（生成 provider 解析与 `/api/import/generate` 一致，未配置时 job error 给出配置说明）。可选 `name`：素材命名基准（缺省取 prompt 前 24 字符），产出命名为 `name #i`（count>1）——素材详情「多动作生成」按「素材名_动作」传入。引用图规则与 `/api/import/generate` 一致（可选 `referenceMaterialId` / `referenceFrameId`，前置 400 校验）。支持 `mediaKind: "video"` + `fps` 视频逐帧切割（同 `/api/import/generate` 的视频模式，拆出帧逐张成素材）。

### POST /api/materials/:id/matting

入队抠图任务（`matting` job，队列并发 2），响应 `{ "jobId": "…" }`；素材不存在 404，缺 raw 文件 400。引擎解析顺序见 `GET /api/config`——自定义 CLI → 内置 rembg → PATH rembg → passthrough 复制（passthrough 警告写入 `job.progress`）。完成后 `status` 置 `matted` 并广播 `material_updated`；rembg 模型首次使用需下载（可达数百 MB），进度经 WS `job_*` 事件推送。

### POST /api/materials/batch-matting

`{ "ids": ["…", "…"] }` → `{ "ok": true, "count": 2 }`。选中素材的二次加工：逐个校验存在且有 raw 文件后入队抠图任务（`matting` job，队列并发 2），跳过无效 id。

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

`status`：`queued` / `running` / `done` / `error`。任务负载在内存中，服务重启时会把遗留的 `queued` / `running` 任务标记为 `error`（「服务重启，任务中断」）。

## WebSocket /ws

服务端 → 客户端单向广播，JSON：

```json
{ "type": "frame_updated", "payload": { "id": "…", "projectId": "…" } }
```

| type | 时机 |
| --- | --- |
| `job_queued` / `job_running` / `job_progress` / `job_done` / `job_error` | 任务生命周期 |
| `frame_updated` | PATCH / 替换 / 帧抠图完成 |
| `frames_changed` | 导入完成 / 复制 / 删除 / 素材导入项目 |
| `frames_reordered` | 换序 |
| `project_deleted` | 删除项目 |
| `material_updated` | 素材抠图完成 / 还原原图 / 剪裁替换图片 |
| `materials_changed` | 素材上传 / 生成 / 批量删除 |
| `settings_changed` | 设置写入（layout / theme / genProvider / matting） |

前端建议：收到 `frame_updated` / `frames_reordered` / `frames_changed` / `job_done` 后重拉帧列表，收到 `material_updated` / `materials_changed` 后重拉素材列表；断线 3s 重连。

## 界面偏好 /api/settings

布局（编辑器面板尺寸）、主题模式、生成 provider、抠图配置等持久化在服务端 `settings` 表（SQLite），换浏览器/重启不丢；主题前端以 localStorage 为首屏即时缓存，服务端不可达时静默降级。

### GET /api/settings

返回整个 kv 对象（value 已 JSON 解析）：

```json
{
  "layout": { "sidebarW": 260, "timelineH": 160 },
  "theme": "dark",
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
// 请求（key 白名单：layout、theme、genProviders、matting；其他 key 返回 400）
{ "value": { "sidebarW": 260, "timelineH": 160 } }
// 响应
{ "ok": true }
```

`theme` 的合法值：`"system"`（跟随系统）/ `"light"` / `"dark"`。写入后广播 `settings_changed` `{ key }`。

`genProviders`：生成 provider 列表（CLI / OpenAI 兼容 API / 百炼 DashScope 原生 / Gemini（banana）/ MiniMax 可配多个共存，生成时按 id 选择、模型单独指定）。元素字段：`id` / `name` / `type`（`"cli"` | `"api"` | `"dashscope"` | `"gemini"` | `"minimax"`）/ `apiBaseUrl` / `apiKey` / `apiModels`（生成弹窗的模型下拉项）/ `apiSize`（可空；api 为 `1024x1024` 形式，dashscope 为 `2048*2048` 星号形式，gemini/minimax 为宽高比如 `16:9`）。**CLI 为结构化字段**（免手写模板）：`cliBin`（命令，PATH 名或绝对路径）/ `cliPromptArg`（prompt 参数名，留空=位置参数）/ `cliOutputArg`（输出参数名）/ `cliModelArg`（模型参数名，留空不下发）/ `cliReferenceArg`（引用图参数名，留空=不支持引用图）/ `cliExtraArgs`（原样追加的固定参数）。执行 argv = `[cliBin, cliPromptArg?, prompt, cliOutputArg?, output, cliModelArg?+model, cliReferenceArg?+ref, ...extra]`，不经 shell。列表为空时 env `FRAMEBAKER_GEN_CLI` 兜底（走遗留模板占位符路径）。

`promptEnhancers`：提示词加强模型列表，元素 `{ id, name, apiBaseUrl, apiKey, apiModel }`（OpenAI 兼容 chat/completions）；加强用的系统提示词服务端内置固定。

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
