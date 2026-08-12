# FrameBaker Architecture

## Overview

```
                        ┌──────────────────────────────────────────────┐
                        │              Browser (React 19)               │
                        │  TopNav (Projects/Materials/Settings)         │
                        │  ProjectList   Editor ─ FrameEditor(PixiJS)  │
                        │  Timeline(DnD) PlaybackBar    ImportModal     │
                        │  MaterialsPage MaterialModal(comparison/crop) │
                        │  CropModal ─ imageops/ (Web Worker image ops) │
│  JobPanel (right-side persistent job queue, WS-driven)  │
                        │        │ fetch /api        │ WebSocket /ws   │
                        └────────┼───────────────────┼────────────────┘
                                 │                   │
┌────────────────────────────────▼───────────────────▼────────────────┐
│                    Bun.serve (apps/server/src/index.ts)             │
│  routes: "/" "/project/:id" "/materials" "/settings" → HTML import  │
│  fetch:  /ws → server.upgrade ──────► ws.ts (client set broadcast)  │
│          rest → Elysia app (app.ts)                                │
│                                                                     │
│  Elysia /api                                                        │
│   ├─ api/projects.ts   Project CRUD                                 │
│   ├─ api/frames.ts     Frame query/PATCH/replace/delete/dup/reorder │
│   │                    + image stream                               │
│   ├─ api/import.ts     Upload/extract / generate → create job       │
│   │                    (project frames)                             │
│   ├─ api/materials.ts  Material CRUD/matting/batch matting/crop/     │
│   │                    import to project                            │
│   ├─ api/settings.ts   Settings table read/write (layout/theme/     │
│   │                    lang/genProviders/matting allowlist)          │
│   └─ /api/jobs(/:id)   Job list (panel initial load) / single query │
│                                                                     │
│  mcp/ (MCP server: POST /mcp JSON-RPC 2.0 Streamable HTTP)         │
│       34 tools directly operating db/internal modules for AI agents │
│                                                                     │
│  provider.ts (multi-gen provider / matting config: settings > env)  │
│  providerAdapter.ts (generation validation/execution adapter +      │
│                      provider model detection)                      │
│  doctor.ts (health check + API connectivity: /api/doctor            │
│             /api/provider/test)                                     │
│  queue.ts (in-memory queue, concurrency 2; JobTarget = project |   │
│            materials)                                               │
│   ├─ jobs/extract.ts   extract_frames / generate_frames             │
│   │                    ├─ CLI template (jobs/run.ts)                 │
│   │                    ├─ OpenAI-compatible API (jobs/generateApi.ts)│
│   │                    ├─ Video generation (DashScope/MiniMax async  │
│   │                    │   polling → mp4)                           │
│   │                    └─ generatedArtifacts.ts (classify & commit   │
│   │                       frames/materials)                         │
│   └─ jobs/matting.ts   matting (frame | material; engine detection   │
│                        below)                                       │
│                                                                     │
│  db.ts (bun:sqlite, WAL) ── jobs/frames/projects/materials tables   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ read/write (absolute paths via import.meta.dir)
                        ┌───────▼────────┐        ┌────────────┐
                        │ storage/ (root) │        │ ffmpeg/CLI │
                        │ framebaker.db  │        │ external   │
                        │ projects/...   │        │ processes  │
                        │ materials/...  │        └────────────┘
                        └────────────────┘

         packages/shared: front/back shared types & constants (no build, exports point to src/index.ts)
```

## Monorepo Layout (Bun workspaces)

| Package | Path | Description |
| --- | --- | --- |
| `@framebaker/server` | `apps/server` | Elysia API + job queue + SQLite; also serves frontend via Bun fullstack mode |
| `@framebaker/web` | `apps/web` | React 19 + PixiJS v8 frontend, `index.html` as bundle entry, fonts in `public/fonts` |
| `@framebaker/shared` | `packages/shared` | `Frame`/`Project`/`Job`/`Material`/`FramePatch`/enums (FRAME_STATUSES, FRAME_SOURCES, JOB_TYPES, JOB_STATUSES, MATERIAL_STATUSES, GEN_PROVIDER_TYPES, WS_EVENTS) / SOURCE_COLORS / `GenProviderSettings` / `MattingSettings` / API response types |

Root `tsconfig.base.json` provides shared compilerOptions (strict, moduleResolution: bundler, noEmit); each app's `tsconfig.json` extends it and adds its own lib/jsx/types.

Root `scripts/version.ts` implements the `MAJOR.WEEK.BUG` main-release policy and keeps the root/workspace package versions, Bun lockfile workspace versions, MCP-reported version, and bilingual changelog release headings synchronized. The week is a monotonic development-week counter within a major, not an ISO calendar week. Version history lives in `docs/CHANGELOG.md` and `docs/CHANGELOG.zh-CN.md`; policy details live in `docs/VERSIONING.md` and `docs/VERSIONING.zh-CN.md`.

## Key Design

- **HTML import fullstack**: `apps/server/src/index.ts` does `import index from "../../web/index.html"`, `Bun.serve`'s `routes` mounts it at `/` and `/project/:id`; the editor page frontend reads `location.pathname` to restore project context (no router library). In development mode (`NODE_ENV !== "production"`), each request re-bundles with HMR support.
- **storage independent of cwd**: `db.ts` uses `import.meta.dir` to traverse three levels up to find the repo root, `STORAGE_ROOT = <root>/storage`; DB columns `raw_path`/`processed_path` store absolute paths. Running from root `bun dev` or from within `apps/server` both point to the same location.
- **Job queue**: `queue.ts` in-memory FIFO, concurrency limit 2; job status persisted to SQLite (queued/running/done/error/cancelled + progress/error), payloads (staging paths, prompts, etc.) only in memory — unfinished jobs are not recovered after restart; on startup, orphaned queued/running jobs are marked as error ("server restarted, job interrupted"). `POST /api/jobs/:id/cancel` can cancel queued/running jobs (AbortSignal → `runCmd` kills process / API polling interrupted). All state changes broadcast via `ws.ts`; frontend `JobPanel` (right-side persistent panel mounted at App root) shows progress via WS `job_*` events + `GET /api/jobs(/:id)` fallback polling; queued/running can be cancelled. Scheduler dependency is one-way: `queue.ts` calls `jobs/*` workers; matting jobs after extraction/generation are queued via narrow callbacks injected by the scheduler — workers never reverse-depend on queue.
- **WS broadcast**: `ws.ts` maintains a client Set, `broadcast(type, payload)` sends JSON; event names defined centrally in shared `WS_EVENTS`. Frontend on receiving `frame_updated/frames_reordered/frames_changed/job_done` re-fetches frame list; on `material_updated/materials_changed` re-fetches material list.
- **Material source semantics**: image-layer outputs use the shared `layers` source and “Layers” badge rather than the generic `api` source. Startup migration identifies legacy outputs by `metadata.provider=imageLayers` and relabels them.
- **Frame extraction numbering**: ffmpeg extracts to `staging/extract_<uuid>/frame_%04d.png`, then scans the raw directory for the current highest number and renumbers sequentially into `raw/frame_XXXX.png`; multiple imports don't overwrite each other; `duplicate` generates `dup_<uuid>.png` which doesn't match the scan pattern and won't be accidentally collected.
- **Injection safety**: external commands (generation CLI / matting CLI) don't use template strings: settings page configures structured fields (command + parameter name mappings), server assembles argv array (Bun.spawn, no shell); legacy env templates (FRAMEBAKER_GEN_CLI / FRAMEBAKER_MATTING_CLI) are split by whitespace into argv then placeholders are replaced — also no shell, safe even with spaces in prompts.
- **Generation provider resolution** (`provider.ts`, reads settings table in real-time on each call): settings `genProviders` list models — CLI / OpenAI-compatible API / DashScope native / Gemini (banana) / MiniMax can coexist; when list is empty, env `FRAMEBAKER_GEN_CLI` synthesizes an id=`env` CLI provider (legacyTemplate path) as fallback. Generation requests select by `providerId` (default: first fully configured); `type=cli` uses structured argv assembly (`cliBin` + parameter name mappings `cliPromptArg`/`cliOutputArg`/`cliModelArg`/`cliReferenceArg`/`cliExtraArgs`; empty name = positional arg or not sent); `type=api`/`dashscope`/`gemini`/`minimax` uses `jobs/generateApi.ts`:
  - api (OpenAI-compatible): no reference image `POST {base}/images/generations` (JSON); with reference image `POST {base}/images/edits` (multipart image+prompt, needs gpt-image series or similar edits-capable models); `data[0].b64_json` or `data[0].url` fetched, 120/180s timeout.
  - dashscope (DashScope native, wan2.7-image / qwen-image etc. not in compatible mode): `POST {base}/api/v1/services/aigc/multimodal-generation/generation`, messages content as `[{image: dataURI}?, {text}]` (reference image uploaded as base64), synchronous response `output.choices[0].message.content[*].image` URL downloaded; `apiSize` supports `2K`/`1K`/`4K` or `width*height`; `apiBaseUrl` normalized via `normalizeDashscopeBaseUrl` stripping `/compatible-mode/v1` and `/api/v1` (Token Plan default `https://token-plan.cn-beijing.maas.aliyuncs.com`, Key `sk-sp-`).
  - gemini (banana / nano-banana): `POST {base}/v1beta/models/{model}:generateContent` (x-goog-api-key), parts `[{text}, {inlineData}?]`; the dedicated response adapter scans all candidates, classifies prompt/output safety and text-only refusals from Gemini metadata, and retries one transient `NO_IMAGE`/`IMAGE_OTHER` result; `apiSize` maps to `imageConfig.aspectRatio`.
  - minimax: image `POST {base}/v1/image_generation` (Bearer), reference image via `subject_reference` (one image limit, subject feature preservation), `response_format=base64`, response takes `data.image_base64[0]`; `apiSize` maps to `aspect_ratio`.
  Model defaults to request `model`, then first item in provider's model list; neither available = job error. `GET /api/config` delivers `gen.providers` and `promptEnhancers` summary (no apiKey; providers carry `video` flag, mapping from shared constant `PROVIDER_VIDEO_SUPPORT`).
- **Video generation** (`generateFrames` with `mediaKind="video"`, only cli/dashscope/minimax): only generates and saves `materials/{id}/raw.mp4` (no frame extraction); extraction via `POST /api/materials/:id/extract` (`fps` full-range or `timestamps` point-extract, single job) → `extract_frames`. CLI/DashScope/MiniMax video protocols as above; polling 5s interval, 10-minute timeout. **In image mode, CLI output detected as video also stored as video material**.
- **Capability layering**: provider connection (Base URL / Key) is separated from model capabilities; models managed by `imageModels` / `videoModels` / `textModels`, default sizes by `imageSize` / `videoSize`. Adapter only selects model from target media capability and validates. Prompt enhancers reuse api/dashscope connections via `providerId + model`; legacy standalone credentials handled by runtime compat layer.
- **Prompt enhancement** (`enhance.ts`): `POST /api/enhance-prompt` calls OpenAI-compatible `chat/completions` from settings `promptEnhancers` list (enhancement system prompt built-in, pixel-art oriented), returns enhanced text; frontend preserves original and shows both side by side for selection.
- **Health check & connectivity test** (`doctor.ts` + `providerAdapter.ts`): `GET /api/doctor` checks storage writable / ffmpeg / matting engine & model cache / each generation provider (CLI checks command existence; OpenAI-compatible, DashScope-compatible, and Gemini send actual model list requests; MiniMax has no lightweight probe endpoint, field validation only) / each enhancer model (sends `GET /models`); `POST /api/provider/test` tests a specific API provider or enhancer model with unsaved form values (8s timeout, 401/403 = auth failure, standard model list verifies model is present).
- **Matting engine detection** (`jobs/matting.ts`, resolved in real-time on each call, visible via `GET /api/config`): a. custom CLI (settings page `matting.cliBin` structured fields take priority, otherwise env `FRAMEBAKER_MATTING_CLI` legacy template `{input}` `{output}` optional `{model}`) → b. `<repo>/.venv-matting` bundled rembg (POSIX: `bin/rembg`, Windows: `Scripts/rembg.exe`; installed by `scripts/setup_matting.sh` / `setup_matting.ps1`: python3 venv + `pip install "rembg[cli,cpu]"`) → c. `rembg` in PATH → d. passthrough copy with install hint in job.progress / response warning. rembg invocation: `rembg i -m <MODEL> in out`, model name from settings page `matting.model` → `FRAMEBAKER_MATTING_MODEL` → default u2net, model cache in `storage/models` (spawn injects `U2NET_HOME`). Frontend upload/generate form "background removal" toggle defaults on; `GET /api/config` drives engine status display.
- **Image processing worker** (`apps/web/src/imageops/`): crop decode / transparent-edge bounding box scan / PNG encode run in Web Worker (OffscreenCanvas). Bun's HTML bundler doesn't handle `new Worker(new URL(...))` — worker script served via server route `GET /imageops/imageOps.worker.js` which `Bun.build`s on demand same-origin; `client.ts` lazy-loads singleton and auto-degrades to main-thread canvas on worker unavailable/error; pure computation (`ops.ts`) shared by both sides.
- **Frame transform geometry** (`apps/web/src/frameGeometry.ts`): centralizes center-anchor, offset, rotation, scale axis-aligned bounding box, fit-to-view, and rotation normalization; Pixi `FrameEditor` and Canvas `export.ts` are two render adapters sharing the same geometric semantics.
- **Import workflow** (`apps/web/src/hooks/useImportWorkflow.ts`): project import and material import share file state transitions, sequential upload, job polling, partial failure, timer cleanup, and completion summary; the two modals only provide their own FormData/API adapters; crop phase handled by `useCropQueue`.
- **Generation provider adapter & artifact submission**: `providerAdapter.ts` resolves provider in real-time per job, encapsulates config/model/capability validation, CLI argv, API/CLI output dispatch, and doctor's model detection; `jobs/generatedArtifacts.ts` handles artifact allocation, media classification, frame/material/video commit, staging cleanup, broadcast, and auto-matting finalization. `jobs/extract.ts` only coordinates "output → commit"; API vendor protocols remain in `jobs/generateApi.ts`.

## Data Flows

### MCP (AI Agent Calls)

```
AI client → POST /mcp { jsonrpc, method: "initialize" }
  → server returns protocolVersion/capabilities/serverInfo + Mcp-Session-Id
  → client sends notifications/initialized
  → tools/list returns 34 tools
  → tools/call { name, arguments } → direct db ops → returns { content: [{ type:"text", text:JSON }] }
```

`mcp/` tools directly call `db` / `queue.ts` / `providerAdapter.ts` / `enhance.ts` / `doctor.ts`; logic is consistent with corresponding `/api/*` handlers but without HTTP self-calls.

### Import (GIF/MP4/Single Image)

```
Browser FormData → POST /api/import/upload
  → saves to staging/<uuid>/input.<ext>, creates extract_frames job (enqueued)
  → extract.ts: ffmpeg (gif full-frame / mp4 with fps filter / image direct copy)
  → per-frame INSERT frames (status=ready, or matting when autoMatting)
  → autoMatting: each frame re-enqueued as matting job → matting.ts (CLI or passthrough copy as processed)
  → broadcasts frames_changed / job_done → frontend refreshes frame list
```

### Editing

```
Drag Pixi sprite → pointerup → PATCH /api/frames/:id {offset_x, offset_y}
  → SQLite update → broadcasts frame_updated → all clients sync
Toolbar step-adjust scale / rotation / opacity → same PATCH to persist
Replace image → CropModal crops and encodes PNG → POST /api/frames/:id/replace
  → writes to processed slot and cleans up old processed file
Timeline HTML5 DnD → frontend optimistic reorder → POST /api/projects/:id/reorder {frameIds}
  → transaction rewrites idx → broadcasts frames_reordered
```

### Sprite Sheet Export (Pure Frontend, No Server)

```
Fetch all /api/frames/:id/image by idx → createImageBitmap
  → compute global bounding box using same center-origin semantics as Pixi (offset / scale / rotation)
  → per-frame individual canvas (uniform cell size, transform & opacity baked in, imageSmoothing off)
  → download per-frame <name>_0001.png … + <name>.frames.json (with per-frame file/w/h/duration, originX/originY)
```

### Material Library (Material → Matting → Import to Project)

The job queue's extract/generate/matting three job types use `JobTarget` (`{kind:"project"} | {kind:"materials"}`) to differentiate where outputs land; the same ffmpeg/CLI logic serves both targets without code duplication; material-type jobs store empty string in `jobs.project_id`.

```
Upload single image → POST /api/materials/upload → materials/<id>/raw.png direct commit (source=image)
Upload GIF/MP4 → same endpoint → staging temp store → extract_frames(target=materials)
  → ffmpeg frame extraction → one material per frame (name=filename #i, source=extract)
Generate → POST /api/materials/generate → generate_frames(target=materials)
  → providerAdapter per CLI / OpenAI-compatible / DashScope / Gemini / MiniMax output
  → generatedArtifacts classifies and commits image or video material (source=provider type, metadata stores prompt/provider/model/size)
Matting → POST /api/materials/:id/matting → creates matting job, tracked by JobPanel
  → engine detection order see "Key Design"; success produces processed.png, status='matted'
  → no engine: passthrough copy with explanation in job.progress
  → frontend comparison slider views raw vs processed; POST /:id/unmatting deletes processed to restore
  → multi-select materials can POST /api/materials/batch-matting for batch queueing (secondary processing triggered on demand)
Crop → CropModal (frontend worker crops to PNG blob) → POST /api/materials/:id/replace-image
  → overwrites currently displayed image slot (processed ?? raw), broadcasts material_updated
Import → POST /api/materials/:id/import or /batch-import
  → raw / processed slots copied separately as project frames (raw/mat_<frameId>.png, mat_ prefix avoids extraction scan pattern),
    preserving both original and matted result, idx appended to project end, source inherited from material
  → broadcasts frames_changed, open project editor auto-refreshes via WS
```

## Storage Layout

```
storage/
  framebaker.db            # SQLite (WAL): projects / frames / jobs / materials
  projects/<projectId>/
    raw/frame_0000.png ... # extracted/generated originals (dup_<uuid>.png for duplicates, mat_<uuid>.png for material imports)
    processed/<frameId>.png        # matted or replaced image
    processed/<frameId>_replaced.png
  materials/<materialId>/
    raw.png                # material original
    processed.png          # matted output (optional)
  models/u2net.onnx etc.   # rembg model cache (U2NET_HOME, auto-downloaded on first matting)
  staging/<jobId>/         # upload staging (cleaned after job completion)
  staging/extract_<uuid>/  # extraction staging (cleaned after completion)
```

Database tables (`apps/server/src/db.ts`, created on startup with CREATE TABLE IF NOT EXISTS):

- `projects(id, name, folder_id, created_at)`
- `frames(id, project_id, idx, raw_path, processed_path, status, duration, is_keyframe, offset_x, offset_y, scale, rotation, opacity, tags, source, metadata)`
- Canonical animation model: `animation_axes(project_id, idx, fps)` → `animation_tracks(axis_id, idx, visible, locked, is_primary)` plus shared `animation_steps(axis_id, idx, duration)`; `frames.track_id + step_id` is a unique composited cell coordinate. Legacy `frames.idx/duration` remain synchronized mirrors.
- Startup migration is transactional/idempotent: every historical or empty project gets `Default` (8 fps) / `Main`; historical frames become one deterministic step each ordered by `idx,id`, preserving frame IDs, files, transforms, order, and durations. `frames.is_asset` separates reusable left-panel assets from timeline instances. Dragging an asset creates an instance without consuming the source; timeline-to-timeline drag still moves or swaps cells.
- `jobs(id, project_id, type, status, progress, error, created_at)`
- `materials(id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at)`
- `folders(id, kind, parent_id, name, sort, created_at)`: multi-level directories for materials/projects (kind=`material`|`project`)
- `settings(key, value, updated_at)`: UI preferences (layout / theme / lang) and runtime config (genProvider / matting), server-side authoritative persistence; theme and language use frontend localStorage only as first-paint cache, load order: "local renders immediately → server value overwrites"; writes are dual-written (layout PUT debounced ~500ms); silently degrades offline

## Frontend Pages & Components

- `App.tsx`: `/` project list ↔ `/project/:id` editor ↔ `/materials` material library ↔ `/settings` settings page (history.pushState + popstate); globally suppresses browser native context menu (preserves input/textarea for paste; frames use custom ContextMenu)
- `TopNav`: primary nav (Projects / Materials / Settings) + theme toggle (three-state: follow system / light / dark) + language toggle (zh/en, `LangToggle`); editor page has its own top bar and doesn't show this
- `SettingsPage`: generation provider list management (CLI / API multiple coexisting, add/remove/edit + save + API test connection), matting config (CLI template / default model datalist + cache status), doctor (health check result list)
- `ProjectList`: pixel card grid (motion stagger entrance, hover lift), new/delete modals
- `MaterialsPage`: material library page — left directory tree (`FolderTree`) + right card grid (source color badge per provider, bottom-left "matted" badge, checkbox + Cmd/Shift multi-select, drag into folders), batch bar (delete / import to project / batch matting raw-only / cancel)
- `ProjectList`: project list same left-tree-right-grid layout, new projects land in current folder
- `FolderTree`: All / Ungrouped + multi-level folder CRUD / HTML5 DnD
- `MaterialModal`: material detail — raw/matted comparison slider (pointer drag clip ratio), matting/restore, crop (CropModal, operates on currently displayed image slot), grid split (GridSplitModal: multi-cell sprite sheet split by rows × columns into individual materials, grid line preview, reuses imageops cropImage + `/api/materials/upload` single-image commit, original preserved), multi-action generation (ActionGenModal: uses current material as reference image, per shared `ACTION_PRESETS` action presets calls `/api/materials/generate` per action, optional `name` as "material_action" naming, one generation job per action), import to project (select project + copy count), delete (confirmation)
- `MaterialImportModal` / `ProjectPickerModal`: material upload & generation entry / project selection modal; upload tab after file selection asks "crop needed?" (`useCropQueue` per-image queue or single re-crop, static images only); generation tab uses `ProviderModelPicker` to select provider + model, submit closes window (same as ImportModal, progress via JobPanel)
- `ProviderModelPicker`: shared provider + model selection for generation dialogs (`GET /api/config`'s `gen.providers` driven; api=model dropdown/input, cli=`{model}` placeholder value), `resolveProviderSelection` resolves defaults at submission time
- `CropModal` + `imageops/` + `hooks/useCropQueue`: pixel-art crop tool — integer-pixel selection (drag / 8-way resize / numeric input), scroll-wheel zoom, pixel grid (zoom≥8), auto-select non-transparent area; heavy lifting in Web Worker, falls back to main thread; shared by both import modals, material detail, and project frame replace — all output PNG
- `Editor`: state hub (frames/activeId/selectedIds/image version counter v), WS subscription refresh; frame multi-select and batch operations (BatchBar)
- `FrameList`: vertical frame list, left border color = shared `SOURCE_COLORS[source]` (light theme color-mix darkened); frame item right-click triggers context menu (onContextMenu bubbles up to Editor)
- `FrameEditor`: PixiJS `Application` (async init + cancelled race handling); viewport centered zoom; main sprite drag to change offset; onion skin (prev red 0.3 / next blue 0.2); grid Graphics; canvas background and grid color follow theme (CSS variables); toolbar adjusts scale (10% step) / rotation (15° step) / opacity (10% step), plus crop replace / duration ± / keyframe
- `Timeline`: HTML5 DnD reorder, keyframe star, duration corner badge; frame item right-click triggers context menu (same as FrameList)
- `ContextMenu`: generic context menu — fixed positioned at cursor, auto-collapses at viewport right/bottom edges, closes on Esc / outside click / scroll / blur; click item closes menu then executes; in editor right-clicking an unselected frame = sets it as current frame and shows single-frame menu (keyframe / duration ±1 / crop / duplicate / delete); right-clicking within multi-selection = preserves selection and shows batch menu (duplicate / trim transparent edges / delete, reuses BatchBar handlers)
- `PlaybackBar` + `FrameEditor` playback mode: 1–24 fps tick, each frame stays for `duration` ticks; directly reuses Pixi transform rendering
- `ImportModal`: Material Library / Upload Files / CLI Generate three tabs — Material Library tab grid-selects materials then `batch-import` into current project (primary workflow), top search box filters locally by material name/prompt (doesn't affect already selected); Upload tab distributes multiple files one by one, after file selection asks "crop needed?" (shares useCropQueue + CropModal with material import), after submit polls `/api/jobs/:id` in-modal for summary; Generate tab submit closes window (non-blocking wait), progress via JobPanel; Generate tab supports "Image / Video" toggle (video mode: fps extraction slider, `ProviderModelPicker` only lists video-capable providers, hides count/reference/size)
- `JobPanel` (mounted at App root): right-side persistent job queue panel — initial `GET /api/jobs` takes over in-progress jobs, then WS `job_*` events drive + active jobs 3s polling fallback; queued/running can be cancelled; completed/cancelled stay 6s then auto-remove; failed ones persist and can be manually dismissed; renders nothing when no jobs
- `SplitDivider` + `layout.ts`: editor layout split dividers (frame list width 180–480 default 240, timeline height 80–320 default 140), pointer capture drag, double-click to reset, sizes stored in localStorage `framebaker-layout`; canvas area relies on Pixi `resizeTo` (ResizeObserver) to auto-follow and redraw
- `theme.ts`: theme management (localStorage `framebaker-theme`; when no stored preference follows system prefers-color-scheme and responds to system changes in real-time)
- `i18n.ts` + `i18n/zh.ts` / `i18n/en.ts`: interface language (zh default / en); copy uses stable keys (e.g., `common.close`), `t(key)` / `useT()` looks up table; localStorage `framebaker-lang` + settings `lang`
- `notice.ts` + `AppModals` (mounted at App root): global notification bar and confirmation modal, replacing browser default `alert`/`confirm` — any component calls `notify(text)` / `await askConfirm(text)`, browser default dialogs are forbidden
- `api.ts`: fetch wrapper + WS client (3s reconnect on disconnect)
