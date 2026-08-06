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

可更新字段（至少一个，全部可选）：`offset_x` `offset_y` `scale` `rotation` `opacity`（number）、`duration`（int 1–600）、`is_keyframe`（0/1）、`tags`（string[]）。

```json
// 请求
{ "offset_x": 12.5, "duration": 3, "is_keyframe": 1 }
// 响应
{ "frame": { /* 更新后的完整帧 */ } }
```

广播 `frame_updated`。

### POST /api/frames/:id/replace

multipart/form-data：`file`（图片）。写入 `processed/<id>_replaced.png`，`source` 置为 `upload`，状态置 `ready`。响应 `{ "frame": {…} }`，广播 `frame_updated`。

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
{ "projectId": "…", "prompt": "pixel art knight", "count": 4, "autoMatting": false, "providerId": "…", "model": "wanx2.1-t2i-turbo", "referenceFrameId": "…" }
// 响应
{ "jobId": "…" }
```

provider 解析：传了 `providerId` 按 id 找（找不到 400）；缺省用第一个配置齐备的 provider（设置页可配多个 CLI / OpenAI 兼容 API / 百炼 DashScope 原生共存；列表为空时 env `FRAMEBAKER_GEN_CLI` 合成 id=`env` 的 CLI provider 兜底）。

- **CLI provider**：命令模板逐项执行，占位符 `{prompt}` `{output}` `{index}` `{reference}` `{model}`（`{model}` 由请求的 `model` 字段填入）。
- **API provider（OpenAI 兼容）**：无引用图走 `POST {apiBaseUrl}/images/generations`（JSON `{ model, prompt, size?, n: 1 }`）；有引用图走 `POST {apiBaseUrl}/images/edits`（multipart：image + prompt + model + size?，需模型支持，如 gpt-image 系列；dall-e-3 不支持 edits）。响应取 `data[0].b64_json` 或 `data[0].url` 下载。
- **DashScope provider（百炼原生）**：`POST {apiBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`（qwen-image 系列官方接口，不在兼容模式内）；无引用图 content 仅 `[{text}]`，有引用图前置 `{image: dataURI}`（base64）；响应取 `output.choices[0].message.content[*].image` URL 下载（24h 有效）。`apiSize` 为星号格式（如 `2048*2048`）原样透传；baseUrl 可填工作区子域（`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`），尾部的 `/api/v1` 会自动归一。

模型取请求的 `model`，缺省 provider 模型列表第一项，都没有则任务 error。provider 不存在/配置不齐时任务置 `error` 并给出说明。`count` 1–16。

引用图（可选）：`referenceMaterialId` / `referenceFrameId` 二选一，服务端按 id 解析文件路径（优先 processed 否则 raw，防止客户端路径注入）。API / 百炼 provider 原生支持引用图；CLI 前置校验（创建 job 前直接 400）：两个 id 同传 / id 查不到 / 选了引用图但模板缺 `{reference}` / 模板含 `{reference}` 但未选引用图。

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

`{ "prompt": "pixel slime", "count": 4, "autoMatting": false, "referenceMaterialId": "…" }` → `{ "jobId": "…" }`（生成 provider 解析与 `/api/import/generate` 一致，未配置时 job error 给出配置说明）。引用图规则与 `/api/import/generate` 一致（可选 `referenceMaterialId` / `referenceFrameId`，前置 400 校验）。

### POST /api/materials/:id/matting

同步执行抠图（rembg 为秒级耗时）：按 `GET /api/config` 的引擎解析顺序执行——自定义 CLI → 内置 rembg → PATH rembg → passthrough 复制。`status` 置 `matted`，响应 `{ "material": {…}, "warning": null }`（passthrough 时 `warning` 为安装提示文本），广播 `material_updated`。

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

把素材（优先 processed，否则 raw）复制为项目帧追加到末尾，`source` 沿用素材来源，`metadata` 合并 `{fromMaterial: id, ...}`。`count` 1–16，默认 1。广播 `frames_changed`。

### POST /api/materials/batch-delete

`{ "ids": ["…", "…"] }` → `{ "ok": true, "deleted": 2 }`（连同磁盘文件），广播 `materials_changed`。

### POST /api/materials/batch-import

`{ "ids": ["…", "…"], "projectId": "…" }` → `{ "ok": true, "count": 2 }`。按给定顺序各导入 1 帧。

## 任务

### GET /api/jobs/:id

```json
{
  "job": {
    "id": "…", "project_id": "…", "type": "extract_frames",
    "status": "done", "progress": "完成", "error": null, "created_at": 1785912000000
  }
}
```

`status`：`queued` / `running` / `done` / `error`。任务负载在内存中，服务重启后历史任务仅剩 DB 状态。

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

`genProviders`：生成 provider 列表（CLI / OpenAI 兼容 API / 百炼 DashScope 原生可配多个共存，生成时按 id 选择、模型单独指定）。元素字段：`id` / `name` / `type`（`"cli"` | `"api"` | `"dashscope"`）/ `cliTemplate`（占位符 `{prompt}` `{output}` `{index}` `{reference}` `{model}`）/ `apiBaseUrl` / `apiKey` / `apiModels`（生成弹窗的模型下拉项）/ `apiSize`（可空；api 为 `1024x1024` 形式，dashscope 为 `2048*2048` 星号形式）。列表为空时 env `FRAMEBAKER_GEN_CLI` 兜底。

`matting`：`cliTemplate`（占位符 `{input}` `{output}`，可选 `{model}`）留空回退 `FRAMEBAKER_MATTING_CLI` / 自动探测；`model` 留空回退 `FRAMEBAKER_MATTING_MODEL` / 默认 `u2net`。

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

  `engine`：`custom-cli`（设置页 matting.cliTemplate 或 `FRAMEBAKER_MATTING_CLI`）/ `rembg-bundled`（`.venv-matting` 内置）/ `rembg-path`（PATH 中找到）/ `none`（未安装，抠图仅复制原图，`hint` 为安装提示）。`model` 为 rembg 模型名（设置页 matting.model → `FRAMEBAKER_MATTING_MODEL` → 默认 `u2net`），`modelCached` 表示模型文件已在 `storage/models`（未缓存首次抠图自动下载）。`gen.providers` 为全部生成 provider 的摘要（不含 apiKey；`models` 供生成弹窗下拉，`configured` 表示关键字段齐备）。
- `GET /api/doctor` → 体检：逐项检查存储目录可写 / ffmpeg / 抠图引擎与模型缓存 / 每个生成 provider（CLI 校验命令存在，OpenAI 兼容 API 实发 `GET /models` 联通测试，百炼原生仅校验字段）→ `{ "checks": [{ "id", "ok", "label", "detail" }] }`。
- `POST /api/provider/test` → API provider 联通测试（用表单当前值，不要求已保存）：`{ "type"?, "apiBaseUrl", "apiKey", "apiModel?" }` → api 实发 `GET {baseUrl}/models` + Bearer，返回 `{ "ok", "status", "latencyMs", "modelsFound" }`（401/403 判定为认证失败）；dashscope 无轻量探测端点，仅校验字段并在 `note` 说明。
- `GET /fonts/:name` → `apps/web/public/fonts/` 下的字体文件（woff2 / OFL.txt）
- `GET /imageops/imageOps.worker.js` → 前端剪裁 worker 脚本（服务端按需 `Bun.build` 打包 `apps/web/src/imageops/imageOps.worker.ts` 下发；开发模式每次重建，生产缓存）
