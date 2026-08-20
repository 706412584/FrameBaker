# FrameBaker — AGENTS

Pixel-art frame-by-frame animation editor (Bun fullstack). Material import (GIF/MP4 frame extraction, PNG, external CLI generation) → frame editing (PixiJS onion skin) → timeline ordering → playback preview → sprite sheet export.

## Monorepo Structure (Bun workspaces)

```
apps/
  server/        @framebaker/server — Elysia API + job queue + bun:sqlite; Bun.serve hosts frontend
  web/           @framebaker/web   — React 19 + pixi.js v8 + motion + lucide-react; index.html is the bundle entry; HTTP facade in src/api.ts, media URLs in src/api/mediaUrls.ts, WS client in src/api/ws.ts
packages/
  shared/        @framebaker/shared — shared types/constants for front & back (no build, exports point directly to src/index.ts)
docs/            architecture / API / roadmap / changelog documentation
scripts/         environment setup + synchronized SemVer version management
storage/         generated at runtime (gitignored), resolves to repo root regardless of startup cwd
```

## Common Commands

```bash
bun install          # install all workspace dependencies (bun uses isolated layout, each package has its own node_modules)
bun dev              # development (--hot), http://localhost:3000, PORT overridable
bun start            # production
bun run typecheck    # tsc -p apps/server && tsc -p apps/web, must pass after changes
bun run version:check # verify all workspace versions and changelog baseline agree
bun run version:plan -- bug|week|major # preview the next weekly version without writing
bun run version:bump -- bug # release Unreleased notes and bump all workspace versions
```

No test framework; verification = typecheck + curl smoke tests (see examples in docs/api.md).

## Conventions

- **Do not perform any git operations** (no init / commit / push) unless the user explicitly requests it.
- Main releases use `MAJOR.WEEK.BUG`: `major` starts a new major at week 1, `week` advances the sequential development week and resets bug to 0, and `bug` increments fixes within the current week. Add entries under `Unreleased` in both changelogs, then run `bun run version:bump -- bug|week|major`; the script also refreshes the marker-delimited bottom section of both READMEs from the latest two released changelog entries and never performs git operations. Do not hand-edit generated content inside those markers. Full versions remain accepted for controlled corrections.
- Shared types, enums, and WS event names all go in `packages/shared` (FRAME_STATUSES / FRAME_SOURCES / JOB_TYPES / WS_EVENTS / SOURCE_COLORS / Frame / FramePatch etc.); both front and back import from here — do not redefine in web.
- Backend file paths must use `STORAGE_ROOT` exported from `db.ts` (based on import.meta.dir); do not use cwd-relative paths.
- Minimize dependencies: do not introduce new deps unless truly necessary; drag-and-drop uses native HTML5 DnD — no dnd libraries; no Vite / react-router / drizzle.
- Job dependency direction: `queue.ts` → `jobs/*` one-way only; when a worker needs to create follow-up jobs, the scheduler injects a narrow callback — workers must not import `queue.ts` in reverse.
- External commands (ffmpeg / generation CLI / matting CLI) all go through `apps/server/src/jobs/run.ts` runCmd (Bun.spawn + stderr capture); command templates are split by whitespace then placeholders are replaced — no shell string concatenation.
- Generation/matting/prompt enhancement runtime config is parsed by `apps/server/src/provider.ts`: **settings table (settings page) takes priority, env vars are fallback only**; read in real-time on each invocation — do not cache startup values. Generation providers are a list with layered connection credentials and capabilities: `imageModels` / `videoModels` / `textModels`, sizes as `imageSize` / `videoSize` (legacy `apiModels` / `apiSize` for input compat only); prompt enhancers only store `providerId + model` and reuse api/dashscope credentials (legacy standalone credentials are compat-supported). Generation execution adapter in `apps/server/src/providerAdapter.ts`; API-family protocols in `apps/server/src/jobs/generateApi.ts`; artifact submission handled uniformly by `generatedArtifacts.ts`. **CLI always uses structured fields** (`cliBin` + parameter name mappings, server assembles argv) — do not introduce hand-written templates in the settings page. Health checks and connectivity tests in `doctor.ts`.
- Frontend image heavy-lifting (crop decoding / transparent-edge scanning / PNG encoding) goes through `apps/web/src/imageops/` Web Worker (OffscreenCanvas; script served via server route `/imageops/imageOps.worker.js` which Bun.builds on demand — do not use `new Worker(new URL(...))` since Bun HTML bundling doesn't handle it); auto-degrades to main-thread canvas when worker is unavailable; pure computation in `ops.ts` is shared by both sides; crop UI in `components/CropModal.tsx`, per-image crop queue during import in `hooks/useCropQueue.ts`, file state/upload/job finalization in `hooks/useImportWorkflow.ts`.
- Frame transform semantics unified as "image center anchor → offset pixel translation → rotation radian → scale uniform → opacity composite"; the single source of truth for pure geometry is `apps/web/src/frameGeometry.ts` — Pixi edit/preview and `export.ts` must use it for consistency; sprite export bakes transforms into unified cells with a shared origin.
- Motion clips support `att:<attachmentId>` attachment offset tracks (translation/rotation/scale/deform/warp; deform carries the bend delta in value.x, warp carries a self-describing `[cols, rows, dx0, dy0, …]` grid delta, both att:-only): sampled values land in `EvaluatedPose.attachmentOffsets`, and the rendered part matrix is `boneWorld × rest × offsetMatrix(t)`; freeform warp bitmaps are rasterized by the pure `warpImagePixels` in `apps/web/src/imageops/ops.ts` (worker-first, main-thread fallback) — see docs/pose-motion-system.md §15.
- UI copy and code comments in Chinese; user-visible text must go through `apps/web/src/i18n.ts` `t()` / `useT()` (Chinese is the dictionary key: `t("新建项目")`, zh returns key directly, en looks up `apps/web/src/i18n/en.ts`, missing falls back to key; interpolation uses `{name}`). Interface language zh/en persists like theme: localStorage `framebaker-lang` for first-paint flash prevention + settings table `lang` as authority (`LangToggle` on `TopNav`, `index.html` inline script pre-reads). Dates use `getLocale()` (`zh-CN` / `en-US`). Materials/projects support multi-level folders (`folders` table + `folder_id`, UI left tree `FolderTree`); generation source writes provider type into `source` (`cli`/`api`/`dashscope`/`gemini`/`minimax`…); jobs can be cancelled via `POST /api/jobs/:id/cancel`. Pixel-art theme (Fusion Pixel 12 font, box-shadow stepped borders, image-rendering: pixelated), palette is Cassette Futurism dual-theme (dark Magnetic Night default / light Beige Terminal), all via `apps/web/src/styles.css` CSS variables (`[data-theme="dark"|"light"]`) — do not add hardcoded color values; theme management in `apps/web/src/theme.ts`.
- Do not use browser default dialogs (alert/confirm/prompt): errors/notifications go through `apps/web/src/notice.ts` `notify()`, confirmations through `await askConfirm()`, rendered by the App root `AppModals` singleton.
- When modifying APIs, also update `docs/api.md` (EN) and `docs/api.zh-CN.md` (CN); when modifying architecture/directory structure, also update `docs/architecture.md` (EN), `docs/architecture.zh-CN.md` (CN), and this file.
- MCP server is in `apps/server/src/mcp/` (using `@modelcontextprotocol/server` SDK v2, mounted at `/mcp`, Streamable HTTP transport, auto-compatible with 2025-era and 2026-07-28 protocols); tools registered via `McpServer.registerTool()` (Zod v4 inputSchema), directly operating `db` / internal modules (no HTTP self-calls), keeping logic consistent with corresponding `/api/*` handlers; when adding/modifying API features, update MCP tools in sync.
- `storage/` and `node_modules/` are gitignored; clean up storage and /tmp temp files after smoke testing.

## Environment Variables

- `PORT` (default 3000)
- `FRAMEBAKER_GEN_CLI`: CLI generation template with placeholders `{prompt}` `{output}` `{index}` `{reference}` `{model}` (reference image resolved server-side from referenceMaterialId/referenceFrameId; template/reference mismatch returns 400 at job creation). **Fallback only**: the settings page can configure multiple generation providers (CLI template / OpenAI-compatible API, stored in settings table `genProviders`, selected by id at generation time with model specified separately); this env only synthesizes an id=`env` CLI provider when the provider list is empty.
- `FRAMEBAKER_MATTING_CLI`: custom matting template with placeholders `{input}` `{output}` (optional `{model}`); **fallback only** — settings page structured fields (matting.cliBin + parameter names) take priority.
- `FRAMEBAKER_MATTING_MODEL`: rembg model name (default `u2net`); **fallback only** — settings page matting.model takes priority; model cache in `storage/models` (U2NET_HOME).
- `FRAMEBAKER_QUEUE_CONCURRENCY`: job queue parallelism (default `2`, clamped 1–16); **fallback only** — settings page `queueConcurrency` (read in real-time on each `pump()`, so changes take effect immediately for new jobs) takes priority; current value exposed via `GET /api/config`.
- Matting engine: without CLI configured, uses `.venv-matting` bundled rembg installed by `scripts/setup_matting.sh` (Windows: `scripts/setup_matting.ps1`) (POSIX: `bin/rembg`, Windows: `Scripts/rembg.exe`; gitignored), then PATH rembg, then passthrough copy as last resort; detection results visible via `GET /api/config` (resolved in real-time on each request).
