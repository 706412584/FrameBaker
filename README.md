# FrameBaker

**Pixel-art frame-by-frame animation editor — a Bun full-stack app.**

Import sprites from anywhere (GIF/MP4 frame extraction, PNG upload, external CLI generation), cut out backgrounds with the built-in rembg matting engine, review results in the materials library, then edit frames on a PixiJS onion-skin canvas, arrange the timeline, preview playback, and export a spritesheet.

> ✅ **Multi-axis / multi-track MVP:** animation variants, compositing tracks, shared steps, composite preview and export are available — along with skeletal binding, on-character motion editing, and freeform part warping.

![Bun](https://img.shields.io/badge/Bun-1.3-14151A?logo=bun)
![Elysia](https://img.shields.io/badge/Elysia-1.4-6f61c0)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)
![Core unit coverage](https://img.shields.io/badge/core%20unit%20coverage-100%25-brightgreen)
![License](https://img.shields.io/badge/License-MIT-green)

**English** | [中文](README.zh-CN.md)

![Playback preview demo](docs/media/demo.gif)

### Skeletal Motion Workflow

Assemble a character from parts, then edit motions directly on the bound character: drag bones or part control-point grids on the canvas, keyframe translation/rotation/scale/bend/warp per track, and preview the result live on the project board.

| Motion workspace & live preview | On-character motion editor |
| --- | --- |
| ![Skeletal motion workspace with live preview](docs/media/skeletal-action-workspace.png) | ![Editing a motion on the bound character](docs/media/skeletal-action-editor.png) |

![Per-bone and per-part keyframe tracks on the motion timeline](docs/media/skeletal-action-timeline.png)

### Skeletal Parts Workflow

Generate and matte a reference-locked character parts sheet, then refine its grid with per-cell movement, direct divider resizing, merge/split controls, quality checks, and per-cell erase editing before creating skeletal materials.

| Character parts material | Interactive parts-grid editor |
| --- | --- |
| ![Generated and matted character parts material](docs/media/skeletal-parts-preview.png) | ![Interactive skeletal parts-grid editor](docs/media/skeletal-grid-editor.png) |

| Frame editor | Materials library |
| --- | --- |
| ![Frame editor](docs/media/editor.png) | ![Materials library](docs/media/library.png) |

| Playback preview | Dark theme (Magnetic Night) |
| --- | --- |
| ![Playback preview](docs/media/preview.png) | ![Dark theme](docs/media/library-dark.png) |

| Video material (custom pixel-style player) | Frame extract editor (VIDEO CUT LAB) |
| --- | --- |
| ![Video material detail](docs/media/video-material.png) | ![Frame extract editor](docs/media/video-cut-lab.png) |

## Scene Layering Demo

Scene layering reconstructs a flat image as independently editable, hideable, and movable RGBA layers. The demo material below was generated inside FrameBaker with `wan2.7-image`, then actually decomposed by the standalone `Qwen-Image-Layered` configuration using **4 layers / 50 steps / CFG 4**.

| Generated flat scene | Scene-layer result |
| --- | --- |
| ![Generated moonlit alchemist scene](docs/media/scene-layering-source.png) | ![Background, props, ground, and whole-character layers](docs/media/scene-layering-layers.png) |

- **L1 background:** sky and castle; **L2 props:** crystals, potion, and chest; **L3 ground:** grass platform; **L4 subject:** the complete alchemist character and moon.
- This is semantic layer reconstruction, not strict pixel-label segmentation: the model may group the moon with the character or spread similar objects across layers, but every output remains independently compositable and editable.
- **Scene layering does not promise head, torso, arm, or leg parts.** Character rig decomposition requires a separate mask/segmentation workflow and must not be represented by these outputs.
- Full scenes skip pre-matting by default to preserve background and depth context. Enable background removal only when recursively refining an already isolated foreground.

**The original scene and all four layer outputs as they appear in the materials library:**

![Scene-layer outputs in the FrameBaker materials library](docs/media/scene-layering-library.png)

## Features

- **Multi-source import** — GIF / MP4 frame extraction via ffmpeg (adjustable fps), multi-select PNG upload, external generator CLI (`FRAMEBAKER_GEN_CLI`)
- **Video materials & frame extract editor** — generated/uploaded videos get a custom pixel-style player (checkerboard backdrop, click-to-play, themed scrubber); the "VIDEO CUT LAB" editor scrubs to an exact frame and marks it, or fills a time range at a target fps, then extracts up to 64 frames as image materials in one batch (optionally matted on the way out)
- **Built-in matting** — rembg works out of the box (u2net by default, custom models supported); custom CLI template optional; before/after compare slider to review cutouts
- **Scene layering** — standalone Qwen-Image-Layered configuration decomposes flat art into RGBA background, whole-subject, prop, and foreground layers; recursive refinement is supported without pretending to produce character body parts
- **Materials library** — a first-class staging area: generate or upload, matte, compare, then import into any project — single or batch
- **Frame editor** — PixiJS v8 canvas with onion skin, grid, viewport zoom, draggable offsets, scale / rotation / opacity controls, crop-and-replace, per-frame duration, and keyframes
- **Timeline & batch ops** — drag to reorder, Cmd/Ctrl+Click and Shift+Click multi-select, batch delete / duplicate / set duration
- **Humanoid motion rig** — choose a CC0 Quaternius Universal Animation Library action sampled at 8–16 frames and get immediate playback, tune motion range / arm swing / leg stride / body bounce / lean across the entire clip, then optionally fine-tune individual FK joints before pose-sheet export
- **Spritesheet export** — pure client-side canvas packing with frame transforms baked into aligned cells → `*.spritesheet.png` + `*.json`
- **Cassette Futurism themes** — dark "Magnetic Night" / light "Beige Terminal"; follows system preference until you pick one (tri-state toggle)
- **Live sync** — WebSocket broadcasts for job progress and frame/material changes
- **Adjustable layout** — drag the split dividers to resize the frame list and timeline (persisted)
- **MCP server** — built-in [Model Context Protocol](https://modelcontextprotocol.io) endpoint (`POST /mcp`, Streamable HTTP) exposing 69 tools for AI assistants (Claude Desktop, Cursor, Windsurf) to manage projects, frames, materials, generation, matting, jobs, and settings programmatically

## System Requirements

- **Windows 10/11, macOS, or Linux** — Windows has been verified on real hardware for server startup, frontend serving, APIs, SQLite storage, and ffmpeg detection
- **Bun 1.3+** — required; reopen your terminal after installation and verify that `bun --version` works
- **ffmpeg** — only required for GIF/MP4 frame extraction; PNG imports and editing do not need it
- **uv (recommended) or Python 3** — only needed for the bundled matting engine; uv can download an isolated Python without a system Python installation
- A modern browser with WebGL (PixiJS v8 canvas)

### Windows prerequisites (PowerShell)

```powershell
# 1. Install Bun (or see https://bun.sh/docs/installation)
powershell -c "irm bun.sh/install.ps1 | iex"

# 2. Install ffmpeg when GIF/MP4 extraction is needed
winget install ffmpeg

# 3. Install uv when matting is needed (or install Python from python.org and add it to PATH)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Reopen PowerShell after installation, then verify:
bun --version
ffmpeg -version
uv --version
```

> `setup_matting.ps1` prefers uv and creates an isolated Python 3.12 environment; it falls back to Python from `PATH` when uv is unavailable. The Microsoft Store `python.exe` app execution alias is not a Python installation.

## Quick Start

```bash
bun install
bun dev          # dev mode (--hot) → http://localhost:3000
# or
bun start        # production
```

- ffmpeg is required for frame extraction: `brew install ffmpeg` (macOS) / `winget install ffmpeg` (Windows)
- **Matting engine** (optional; install once per new environment):
  ```bash
  ./scripts/setup_matting.sh            # macOS / Linux (CPU, default)
  ./scripts/setup_matting.sh --gpu      # macOS / Linux (NVIDIA GPU via onnxruntime-gpu)
  # Windows (PowerShell):
  powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1           # CPU
  powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1 -Gpu      # GPU
  ```
  Creates `.venv-matting/` and installs `rembg[cli,cpu]` (or `rembg[cli,gpu]`); on Windows it prefers uv-managed Python 3.12. The u2net model downloads automatically to `storage/models` on first use. Skipping this leaves matting in passthrough mode (copies the original image with a warning).

  **GPU mode** requires an NVIDIA GPU and a matching CUDA Toolkit installation. `onnxruntime-gpu` version must align with your CUDA version (e.g. onnxruntime-gpu 1.16 ↔ CUDA 11.8, 1.17+ ↔ CUDA 12.x). If you get DLL load errors, verify CUDA is installed and the version matches. To switch between CPU and GPU, delete `.venv-matting/` and re-run the script with the other flag.
- Type check: `bun run typecheck`
- Unit tests: `bun run test`
- Core unit-test coverage report: `bun run test:coverage` (currently covers shared rules, frame geometry, and ZIP export)

### Windows Notes & Gotchas

The project runs on Windows but there are several platform-specific things to be aware of:

1. **`bun dev` uses `--watch`, not `--hot`** — Bun 1.3 on Windows has a bug where browser HMR reorders PixiJS 8's circular-dependency initialization, causing a blank canvas. The dev script therefore uses `--watch` (server auto-restart on file changes, but no frontend HMR). **You must manually refresh the browser** after editing frontend code. macOS/Linux keep full HMR.

2. **PixiJS is loaded from CDN, not from the npm package** — `apps/web/index.html` includes a `<script>` tag pointing to `cdn.jsdelivr.net/npm/pixi.js@8.19.0/dist/pixi.min.js`. This bypasses Bun's bundler, which mis-handles PixiJS's circular imports on Windows. The browser's first load needs internet access to `cdn.jsdelivr.net`; subsequent loads use the cache. If you need offline use, download `pixi.min.js` to `apps/web/public/` and point the `<script>` there.

3. **Server dev mode is disabled on Windows** — `apps/server/src/index.ts` sets `development: false` on `win32` to prevent Bun's HTML dev server from injecting HMR scripts that trigger the same PixiJS bug. This does not affect production (`bun start`).

4. **Run `bun install` after every fresh checkout or dependency change** — Bun's isolated workspace layout means the local `@framebaker/shared` package is only resolvable after `bun install`. Without it, Bun may load third-party packages from its global cache but fail to resolve the workspace, causing import errors.

5. **PowerShell environment variables** — Use `$env:PORT=8080; bun dev` (semicolon, not `&&`). The `&&` operator is not supported in older PowerShell versions. Bash syntax `PORT=8080 bun dev` works on macOS/Linux.

6. **PowerShell execution policy for setup scripts** — `setup_matting.ps1` requires `-ExecutionPolicy Bypass` (e.g. `powershell -ExecutionPolicy Bypass -File scripts\setup_matting.ps1`). The script is written in ASCII to be parseable by Windows PowerShell 5.1 without a UTF-8 BOM.

7. **Microsoft Store `python.exe` is not a real Python** — Windows ships an "App execution alias" called `python.exe` that opens the Microsoft Store instead of running Python. Install Python from [python.org](https://www.python.org/downloads/) (and check "Add to PATH"), or install [uv](https://docs.astral.sh/uv/) which can download an isolated Python without a system install. `setup_matting.ps1` prefers uv and only falls back to PATH Python when uv is absent.

8. **Backslash paths for Windows scripts** — Use `scripts\setup_matting.ps1`, not `scripts/setup_matting.ps1`, when running from PowerShell or cmd.

## Matting Engine Resolution

Detected on demand (see `GET /api/config`):

1. `FRAMEBAKER_MATTING_CLI` — custom command template (`{input}` `{output}`, optional `{model}`)
2. Bundled rembg in `<repo>/.venv-matting` (`bin/rembg` on POSIX, `Scripts/rembg.exe` on Windows) — installed by `scripts/setup_matting.sh` / `setup_matting.ps1` (engine = `rembg-bundled`)
3. `rembg` found in `PATH` (engine = `rembg-path`)
4. None — passthrough copy with an install hint (engine = `none`)

rembg runs as `rembg i -m <MODEL> input output`; the model defaults to `u2net` and is cached in `storage/models` (`U2NET_HOME` is injected).

## Environment Variables

| Variable | Description |
| --- | --- |
| `PORT` | Server port, default `3000` |
| `FRAMEBAKER_GEN_CLI` | Generator CLI template; placeholders `{prompt}` `{output}` `{index}` `{reference}`. Example: `FRAMEBAKER_GEN_CLI='mygen --prompt "{prompt}" --ref {reference} -o {output}' bun dev`. `{reference}` resolves to the reference image picked in the UI (a material or project frame, resolved server-side by id — picking one while the template lacks `{reference}`, or vice versa, fails fast with HTTP 400) |
| `FRAMEBAKER_MATTING_CLI` | Custom matting CLI template; placeholders `{input}` `{output}` (optional `{model}`). Takes precedence over the bundled rembg |
| `FRAMEBAKER_MATTING_MODEL` | rembg model name, default `u2net` (e.g. `birefnet-general-lite`, `isnet-general-use`) |

## Project Structure

Bun workspaces monorepo:

- `apps/server` (`@framebaker/server`) — Elysia API + in-memory job queue + bun:sqlite; also serves the frontend via Bun's HTML import
- `apps/web` (`@framebaker/web`) — React 19 + pixi.js v8 + motion + lucide-react
- `packages/shared` (`@framebaker/shared`) — types & constants shared by both ends
- `scripts/` — setup scripts plus synchronized SemVer release management
- `docs/` — documentation, including the dedicated [changelog](docs/CHANGELOG.md)
- `storage/` — runtime data (SQLite, frames, materials, rembg models; gitignored)

## Docs

- [docs/guide.md](docs/guide.md) — user guide (settings page, provider setup, crop tool, material processing, editor)
- [docs/architecture.md](docs/architecture.md) — architecture diagram, modules, data flows, storage layout
- [docs/api.md](docs/api.md) — API reference with request/response examples, WebSocket events, MCP endpoint
- [docs/roadmap.md](docs/roadmap.md) — shipped features and planned work
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — versioned feature and bug-fix history
- [docs/VERSIONING.md](docs/VERSIONING.md) — `MAJOR.WEEK.BUG` policy used by main releases

## MCP (AI Assistant Integration)

FrameBaker includes a built-in MCP server that lets AI assistants control the full application via the [Model Context Protocol](https://modelcontextprotocol.io).

**Endpoint:** `POST /mcp` (Streamable HTTP, JSON-RPC 2.0, protocol version `2024-11-05`)

Start the server (`bun dev` or `bun start`), then configure your AI client:

**Claude Desktop** (macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "framebaker": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Code** (CLI): `claude mcp add framebaker --transport http http://localhost:3000/mcp`

**Cursor** (`.cursor/mcp.json`): `{ "mcpServers": { "framebaker": { "url": "http://localhost:3000/mcp" } } }`

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`): `{ "mcpServers": { "framebaker": { "serverUrl": "http://localhost:3000/mcp" } } }`

The server exposes **69 tools** covering projects, frames, materials, generation, matting, folders, jobs, and system config. See [docs/api.md](docs/api.md) for the full tool list and examples.

## License

[MIT](LICENSE) © 2026 taotao7

The UI font is **Fusion Pixel 12px** (`apps/web/public/fonts/`), licensed under the SIL Open Font License 1.1 — see `apps/web/public/fonts/OFL.txt`.

### Acknowledgements and third-party projects

- [Universal Animation Library](https://quaternius.com/packs/universalanimationlibrary.html) by Quaternius — CC0 1.0 Universal. FrameBaker samples, orthographically projects and retargets the Standard GLB clips `Idle_Loop`, `Walk_Loop`, `Sprint_Loop`, `Sword_Attack`, `Hit_Chest`, `Death01`, `Jump_Start`, and `Jump_Land` into its bundled 2D local-rotation presets. The jump preset combines the launch and landing clips with a compact game-style root arc. The original GLB is not bundled.
- [huchenlei/sd-webui-openpose-editor](https://github.com/huchenlei/sd-webui-openpose-editor) by Chenlei Hu — MIT License. Its pose manipulation workflow and COCO-18 conventions were evaluated during motion-workspace design. The professional editor was intentionally not embedded in the final simple workflow, and no upstream source is bundled.
- [ZhUyU1997/open-pose-editor](https://github.com/ZhUyU1997/open-pose-editor) by Yu Zhu — MIT License. Its transform-gizmo and pose-preview workflow was studied while designing the optional per-joint fine-tuning interaction; its source code is not bundled.

## Known Limitations

Job queue is in-memory (unfinished jobs are lost on restart); GIF frame delays are ignored; single-image imports are stored byte-for-byte (PNG recommended); spritesheet export does no trimming; no authentication — local use only. See the [roadmap](docs/roadmap.md) for planned improvements.

<!-- latest-changelog:start -->
## Latest Changes

### [0.5.0](docs/CHANGELOG.md#050---2026-10-03) · 2026-10-03

#### Added

- Infinite-canvas node workflow (`/graphs` page): React Flow canvas + node connections to build asset pipelines (video material → frame extraction → batch matting → sprite sheet export); node drag positions persist, execution state backfills nodes in real time via WS (running/done/cache-hit/error outlines).
- Workflow execution engine: topological sort + content-addressed caching (`content_hash` = node type + canonical params + upstream port hashes); re-running with a changed end-node parameter cache-hits all upstream nodes; artifacts and payloads fully persisted so completed nodes hit cache after restart; mid-run cancel supported (AbortSignal kills ffmpeg subprocesses).
- Four tables (graphs / graph_nodes / graph_edges / graph_outputs) plus graph CRUD API (port type validation, single-input-port uniqueness, cascade delete) and 7 MCP workflow tools.
- Migrated sprite-video-lab matting pipeline: `matte_cli.py` CLI shim + `matte.pipeline` composite node (pixel-identical to sprite `apply_matte_pipeline`) + 6 single-step atomic matting nodes + `image.decontaminate`; configured via the `spriteMatting` settings key, coexisting with the global rembg matting.
- Migrated sprite-video-lab pixel quantization: `quantize.pixel` node (imageops worker with main-thread fallback), byte-identical to the original.
- Migrated sprite-video-lab UI smart slicing: `slice.ui.analyze` detection + `slice.ui.crop` cropping (connected-component detection reuses the single imageops implementation); detected candidates match the original exactly.
- Client-node execution channel: the executor dispatches tasks over WS to the browser with the canvas open; workers return artifacts or analysis results. `slice.ui.analyze` supports an `interactive` human-in-the-loop mode — it pauses after analysis, shows a candidate-rect adjustment panel on the canvas, then continues downstream on confirm; manual adjustments persist with the cache (survive restarts).
- Canvas interaction polish: double-click / right-click a node to edit params (paramsSchema-driven form + material dropdown); edges colored by port type (hover thickens, click deletes, dashed drag preview); node context menu. Also fixed a latent bug since canvas launch — nodes lacked React Flow Handles, which silently prevented edges from rendering.
- Full sprite video-extraction pipeline parity: added output.nodes (export.frames image frames; export.video alpha .mov via qtrle/argb matching sprite save_alpha_mov; export.package complete bundle with png/webp sheet + frames.zip + export.json + six engine manifests — Phaser/Starling/Cocos/Godot/Urho3D, generators ported verbatim); frame-processing nodes (frame.crop, frame.canvas with bottom/center square modes, frame.alpha green-to-black / semitransparent-to-black / to-opaque reusing sprite's own functions, frames.smart-select with difference signatures + bucketed dedup matching suggest_job_frames); all node artifacts show inline thumbnails on their cards (image/video) with click-to-zoom lightbox.
- UI slice workflow (full sprite ui-layer-lab capability): new node UI Layer Split (ui.layer.analyze via matte_cli.py --op ui-analyze) — OpenCV Canny candidate detection (pure-color background separation when alpha coverage <98%) plus per-candidate GrabCut foreground masking into transparent layers, targeting solid-background UI screenshots (complements slice.ui.analyze's pure-alpha connected components for already-keyed images); params: max layers / min size / layer mode (cutout/raw/both). New UI Slice workflow template (image material → UI layer split → to material library + frame PNGs). Verified: synthesized UI sheet (two buttons/circle/rect/text) — all 5 candidates hit with precise bboxes, 5 layers into the material library.
- Nine interaction fixes: 1) toolbar reorganization — Import/New/Export/Tasks side by side on the right; the task panel moves from a floating FAB to a toolbar entry (ListTodo icon, red dot while running); 2) canvas zoom controls fixed — the built-in Controls plus useReactFlow and instance store channels all fail under this page's controlled re-renders (d3 transform never moves, verified), so custom buttons drive the d3-native wheel/dblclick channel (zoom-in 1→1.18, zoom-out, fit 0.5 all verified); 3) open-folder targeting fixed — explorer needs backslash-native paths (forward slashes fall back to Documents), matching sprite's os.startfile semantics; the artifacts panel gains Save-to… (POST /api/graph/save-artifacts copies the artifacts dir to a custom location; showDirectoryPicker first, path input fallback); 4) the lightbox close button lifts to z-62 with a red hover; 5) matte.pipeline params hide per unselected mode (chroma/spriteflow/birefnet/corridorkey/luma+additive mappings; decontaminate/effect-protection are common; legacy all-on fallback shows everything); 6) sidebar collapsible (Ctrl+B or corner icon, localStorage-persisted) and drag-resizable (160-420px; fixed a stale-closure bug that failed to persist width); 7) new nodes: To Material Library (frames.to-material — graph artifacts become materials, bridging graph→editor; 2 frames → 2 materials verified) and AI Generate Image (generate.image, reusing FrameBaker's generation providers).
- Workflow import/export: a toolbar Export button saves the current graph as JSON (name + node type/params/position + index-based edges); an Import button on the graph list restores JSON as a new graph (unknown node types rejected wholesale, incompatible edges dropped tolerantly, material ids need re-selection). Round-trip verified: 8 nodes and 7 edges identical. The video-extraction pipeline template now defaults to SpriteFlow keying (tolerance 15, useSpriteflow on).
- Export artifact file operations: export.* nodes gain an Artifacts panel on their cards — expand to list the output directory (file names + sizes + frames/ subdirs), each file downloadable (media route takes a download param returning Content-Disposition attachment); an Open-folder button hits POST /api/graph/open-folder to reveal the artifacts dir in File Explorer (restricted to storage/graph/outputs). outputDir flows through the executor done broadcast and the graph document (late-opened canvases get the panel too).
- Canvas-normalize inter-frame jitter fixed: frame.canvas now makes ONE batch CLI call (new matte_cli.py --op resize-batch) — stable_box is the union of all frames' alpha bboxes, so every frame shares the same crop region, canvas width, and paste anchor. Previously each frame computed its own bbox, making auto-mode canvas width wobble and square-center content jump left/right (sprite's stable_resize_frames was always batch-semantics). Pixel-identical to a direct sprite batch call (3 frames with different sizes/positions → uniform canvas, IDENTICAL).
- Preview background switcher (sprite PreviewPanel parity): node thumbnails default to a dark checkerboard — white semi-transparent textures (hair strands / ice veins) explode into a "cobweb" look on the light canvas; the lightbox gains a top background bar (checker/dark/light/custom + color picker), switches sync live to every thumbnail on the canvas, and the choice persists in localStorage.
- Fixed keying dark-rim / inky edges (root cause: non-premultiplied alpha scaling): frame.canvas used ffmpeg scale, whose linear interpolation bleeds transparent pixels' black RGB into semi-transparent edges. It now calls matte_cli.py's new --op resize (reusing sprite's stable_resize_frames: alpha-bbox trim → RGB×alpha premultiply → LANCZOS → un-premultiply → canvas placement), pixel-identical to sprite's preview (same-source frame maxdiff=0; end-to-end visual diff dropped from 55.6% to 0.1%). Added a Trim-transparent-edges param (on by default, matching sprite); canvas mode defaults to auto; template keying/canvas params now match sprite defaults (80/32/0.85/1, 512/20/auto).
- Chain instant preview: Preview-now no longer shows just the raw frame — it grabs the second's frame and runs it through the downstream server-node chain (keying included, with the graph's real params), so the preview IS the processed result; when preview.frame has no downstream it borrows the source material's main chain (extract→matte→canvas…); skips export/client/smart-select nodes (meaningless for one frame) and multi-input nodes it can't feed from a single frame; the node card shows an N-steps badge (hover for the chain); on step failure the preview stays at the last good step. Keying param changes reflect immediately (threshold 80/200 preview diff: 4076 pixels verified).
- Four feedback fixes: 1) context-menu misfire — menu opens only on real right-clicks (button===2); clicking node controls or non-right-button contextmenu no longer pops it, and clicking anywhere on a node closes a lingering menu; 2) task FAB was hidden under the top nav (top 14px→70px under the 60px nav); 3) keying glow black-edge / inky look — root cause was unaligned defaults vs the sprite frontend (threshold 42→80, softness 12→32, despill 0.5→0.85, halo 0→1); visual comparison confirms smooth dark-edge-free results; both registry and matte_cli argparse defaults updated; 4) instant single-frame preview — preview.frame shows its timeline even before any run (duration backfilled after probe) plus a Preview-now button hitting a lightweight API (POST /api/graphs/:id/preview-frame — no full run, no cache writes; staging/preview_frame added to the restricted media allowlist).
- Task floating panel (ComfyUI style): a fixed Tasks button top-right with a running-count badge; the panel live-scrolls the running graph name and per-node progress (WS), plus an execution history (graph_runs persisted server-side, survives restarts) showing per-run graph/time/node stats (done+cached/total, errors in red, running pulse); clicking a history entry opens that graph.- Param-change invalidation & run reset: editing a node param immediately marks it and all downstream nodes with a yellow outline (re-compute preview); hitting Run first clears every node's previous status/preview (cache-hit nodes re-attach thumbnails instantly); verified targetCount 12→15 re-computes smart-select to 15 frames while upstream cache-hits.
- Keying multi-select (pipeline semantics): matte.pipeline's single dropdown becomes six mode switches (chroma/SpriteFlow/BiRefNet/CorridorKey/Luma/additive glow), freely combinable (e.g. key + glow) — fixed-order execution with alpha union (ImageChops.lighter); additive's global behavior (skip despill & decontaminate) is preserved inside combinations; pixel-equivalent to sprite apply_matte_pipeline's multi-mode path (dual-switch output vs direct CLI chroma,additive maxdiff=0); legacy graphs fall back to the pipeline string param.
- Single-frame preview workflow (sprite preview_frame parity): new preview.frame node — grab one frame at a given second; an inline timeline scrubber (0.1s steps, duration readout) plus a Grab-frame button on the node card; wire a keying node downstream to see that frame keyed. Content-addressed cache makes grabbing re-run only that node and downstream. extract.frames gains startTime/endTime/keepEvery; matte.pipeline gains the full sprite parameter set (key mode/manual key/AI device/corridor screen/SF series/decontaminate radius+strength/effect protection); enum dropdowns everywhere (keying modes incl. additive glow, canvas mode, sheet format, quantize method/dithering, device); engine manifests become six independent switches.
- Inline node params (ComfyUI style): all params render as label+control rows directly on the node card (number/text/boolean/dropdown, 400ms debounced PATCH, nodrag so canvas panning isn't disturbed); the params summary and double-click modal become fallbacks. Material fields get an "Upload material…" dropdown entry — videos/GIFs/PSDs upload in graphRaw mode (raw file stored as a single material, no frame-split), auto-selected on upload.
- Workflow templates: a "From template…" dropdown one-click creates the default sprite video-extraction pipeline (video material → extract 8fps → pipeline keying → canvas normalize → smart select → full package/alpha video/frame PNGs, 8 nodes 7 edges with presets); GET /api/graph/templates lists, POST /api/graph/templates/:id/graphs creates.
- Parity completion: export.package gains rectpack tight packing (self-implemented MaxRectsBssf; mixed-size frames auto-pack, layout/frame_positions record true coordinates); sheet compositing switched to PIL paste (ffmpeg overlay has chroma jitter, PIL is pixel-lossless — matching sprite); lightbox plays multi-frame sequences (play/pause, 1-30 fps slider, thumbnail strip); artifact previews persist in the graph document (late-opened canvases and restarts show them); five more nodes — PSD splitting (material.psd), background inpainting (image.bg-inpaint, LaMa→OpenCV fallback), pose detection (pose.detect), human parsing (human.parse), scene layering (image.layers, reusing FrameBaker's image_layers) — with clear install guidance when AI deps are missing.
- Job queue persistence: payloads now persist to the jobs table (payload column). After a restart, queued jobs re-enter the queue and run to completion (never started, so side-effect free); running jobs are marked interrupted with a clear re-submit hint (no resumable checkpoints); restored extract jobs whose source file vanished get an explicit re-import message; jobs left by pre-upgrade versions are marked as missing payload. A job whose in-memory payload record is lost mid-run can also be rebuilt from the database.
- Frame animation export gains two game-engine formats: a TexturePacker JSON Hash atlas (loads directly in Phaser 3 / PixiJS / Cocos — per-frame opaque rect with spriteSourceSize/sourceSize so engines restore alignment and frame origins stay stable) and a Godot 4 SpriteFrames resource (PNG sequence + .tres, pick directly on AnimatedSprite2D; speed/duration converted losslessly per the official formula, import guide included). Existing PNG sequence, single-sheet, and frames.json outputs are unchanged.
- Desktop auto-update: electron-updater integrated (update source: GitHub Releases). The shell silently checks in the background on launch; a new "Software update" section in Settings (Electron shell only) shows the current version with manual check, download (live progress), and install-and-restart (backend process tree is cleaned up before the installer runs). Installer artifacts are now named `FrameBaker-Setup-x.y.z.exe`, fixing the mismatch between the latest.yml URL and the actual artifact name that would 404 downloads; the packaging script publishes to GitHub Releases when GH_TOKEN is set, local packaging behavior unchanged.
- New MCP tool `import_local_material`: registers an absolute local path (a single file or a directory) into the material library — the MCP equivalent of the UI import button. One file = one material, no frame extraction (call `extract_material_frames` afterwards to split a video/GIF); a directory imports every supported file in natural filename order. Supports png/jpg/jpeg/webp/bmp/tga/gif/psd and mp4/mov/webm/avi; kind is inferred from the extension. Materials gain a dedicated `file` source (badge "Local file"), distinguishable from UI uploads and AI generation. Use it to feed externally produced assets (ffmpeg-extracted frames, output from another tool) straight into the library for `material.video` / `material.image` graph nodes and the editor. Copy and DB insert are treated as one unit (a failed insert cleans up the material directory — no orphans); symlinks are rejected (they would bypass the extension allowlist); directory import is per-file fault-tolerant, failures returned via `failed[]`; subdirectories and unsupported files are both reported in `skipped` (never silently dropped).
- MCP workflow tools expanded to 17 (full graph REST parity): new `update_graph_node` (edit a node's params/position — previously `add_graph_node` was the only way to set params, so a node was uneditable after creation, which blocked programmatic graph building), `delete_graph_node` (cascading edge removal), `delete_graph_edge`, `update_graph` (rename), `import_graph` (JSON import), `list_graph_templates`, and `create_graph_from_template`; `create_graph` / `add_graph_node` / `connect_graph_nodes` / `delete_graph` now broadcast `graphs_changed` and refresh `updated_at`, matching the REST handlers.

#### Removed

- Removed the target-skeleton selector from reference decomposition: it only influenced the generation prompt and grid rows/columns, downstream split, naming, and binding never consumed it, and `targetSkeletonId` was never accepted by the server; the split grid is back to manual rows/columns plus the humanoid default.

### [0.4.0](docs/CHANGELOG.md#040---2026-08-20) · 2026-08-20

#### Added

- Added project-level character joint angle adjustments in the binding editor; per-bone base rotations persist with the character and apply consistently to the rest pose, every motion, and `.fbanim` exports without modifying shared skeleton assets.
- Added deterministic flexible attachment deformation with canvas Warp dragging, rest bend, playback sway, axis, frequency, and phase controls for capes and other soft parts.
- Added a full skeletal-parts sheet workflow with flexible per-cell crops, direct divider resizing, rectangular merges, right-click horizontal/vertical subdivision, quality-gated previews, and per-part erase editing before registration.
- Added connected-component auto-detection to the skeletal split modal: opaque parts are detected as individual cells (in reading order) so a uniform grid no longer cuts through a part, and each detected cell stays editable, splittable, mergeable, and renamable.
- Added shared-layer capabilities and tests for humanoid skeleton semantics diagnosis and auto-assembly (not yet wired into the UI).
- Added material-folder filtering to the skeletal binding image picker, including hierarchical folder paths plus All and Ungrouped views.
- Added material renaming from the library context menu, REST API, and MCP tool, with immediate open-view synchronization.
- Completed image-material context menus with direct crop, frame/skeletal split, character decomposition, multi-action/eight-direction generation, matting restore, import, layering, trim, export, and delete actions.
- Motion events can now accept, validate, display, and persist an optional JSON payload.
- Added MotionClip schema v2 with per-segment cubic-bezier timing, explicit lossless v1 migration, eased quaternion slerp, curve editing, and `.fbanim`/raster compatibility.
- Added freeform attachment warping: parts can enable a draggable control-point grid (2×2/3×3/4×4) for static deformation in the binding editor, and `att:` warp tracks animate the same grid deltas on the motion timeline; warped bitmaps are rasterized deterministically (nearest-neighbor) and compose ahead of the bend filter, with full `.fbanim` round-trip support.

#### Changed

- Localized the built-in humanoid skeleton and its joint labels throughout skeleton selection, motion editing, canvas hints, timelines, and character binding while preserving custom names verbatim.
- Refined skeletal-parts prompts to treat the requested grid as capacity, allow transparent surplus cells and rectangular multi-cell blocks for oversized parts, and forbid invented filler parts or weapons.
- Limited divider dragging to the active cell and only the cells directly facing that edge, leaving lateral cells unchanged.
- Unified skeletal project output on the `.fbanim` runtime package and removed the frame-project compatibility bake path, RenderProfile, and RasterSequence APIs.

#### Fixed

- Made the selected attachment's transform outline capture canvas drags, so overlapping parts cannot redirect a Warp or transform edit to another layer.
- Made erase strokes reach the exact image boundary when dragged outside the editor, and stopped near-transparent antialias residue from falsely triggering skeletal-part edge warnings.
- Fixed the skeletal project editor not reflecting animation-asset saves: the live preview canvas and the skeleton/binding views now subscribe to `animation_assets_changed` and refetch the current clip, skeleton, and asset list as soon as the motion editor (or any other page) persists changes.

[View the complete changelog →](docs/CHANGELOG.md)
<!-- latest-changelog:end -->
