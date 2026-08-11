# FrameBaker User Guide

## Multi-axis timeline

The editor timeline is a matrix: shared steps are columns and compositing tracks are rows. Choose or add an animation axis for each direction/action variant. Tracks composite back-to-front by their order and may be hidden or locked. Selecting an empty cell is valid; material-library imports fill consecutive cells from that point, while importing without a selected step appends shared steps. Playback and ZIP export render all visible cells per step; JSON includes axis FPS/name, step durations, and contributing frame IDs.

Pixel-art frame-by-frame animation editor: material import (GIF/MP4 frame extraction, PNG upload, AI generation) → crop/matting processing → frame editing (onion skin) → timeline ordering → playback preview → sprite sheet export.

This guide is for end users, explaining each feature by page. For API details see [api.md](api.md), for internals see [architecture.md](architecture.md).

## Quick Start

```bash
bun install
bun dev          # → http://localhost:3000 (PORT overridable)
./scripts/setup_matting.sh   # matting engine (first time; Windows: scripts\setup_matting.ps1); ffmpeg needed for GIF/MP4 (macOS: brew install ffmpeg / Windows: winget install ffmpeg)
```

## Two Core Concepts

- **Material Library** (staging area): all images land here first for cropping, matting, comparison, and review — once satisfied, "import to project" turns them into frames. Materials and projects are independent; one material can be imported into multiple projects.
- **raw / processed**: every material (and every frame) has an original image (raw) and a processed image (processed — matting/crop output) in two slots. When importing to a project, the processed slot is preferred.

## Settings Page (top bar "Settings")

### Generation Providers

CLI and various vendor APIs **can coexist with multiple configs**; select one from the dropdown when generating. The settings page has a row of **preset buttons** (OpenAI / DashScope / banana / MiniMax / VolcEngine (Doubao) / Custom CLI / Custom API) that auto-fill type, Base URL, model list, and size format — usually just fill in the API Key:

- **CLI provider**: local command, **structured fields — no template needed** — fill in the command (PATH name or absolute path), prompt parameter name (e.g., `--prompt`; leave empty for positional arg), output parameter name (e.g., `-o`); optional model parameter name (only sent when a model is selected in the generation dialog), reference image parameter name (leave empty if the CLI doesn't support reference images), and extra fixed arguments (appended as-is). Server assembles argv and executes directly, no shell.
- **API provider (OpenAI-compatible)**: OpenAI official (gpt-image series), VolcEngine Doubao Seedream (`https://ark.cn-beijing.volces.com/api/v3`), various compatible gateways. Text-to-image uses `images/generations`; **selecting a reference image auto-switches to `images/edits`** (requires model support, e.g., gpt-image series; dall-e-3 doesn't support edits and will error in the job). Connectivity test sends `GET {baseUrl}/models`.
- **DashScope provider (native)**: **Token Plan** Base URL: `https://token-plan.cn-beijing.maas.aliyuncs.com` (or paste the docs URL `…/compatible-mode/v1` — server normalizes to host root); Key uses `sk-sp-` dedicated key. Wanxiang `wan2.7-image` / HappyHorse video uses native `api/v1/services/…` (not in OpenAI-compatible chat channel). Pay-as-you-go uses `https://dashscope.aliyuncs.com` + `sk-` key. Image size can be `2K`/`1K`/`4K` or `width*height`; i2v requires a first-frame reference image.
- **banana provider (Gemini images)**: nano-banana (`gemini-2.5-flash-image`, `gemini-3-pro-image-preview`, etc.). Base URL: `https://generativelanguage.googleapis.com`, size as aspect ratio (e.g., `16:9`). Reference image natively supported (inlineData base64). Connectivity test sends `GET /v1beta/models`.
- **MiniMax / DashScope video**: **generation only produces video materials**; open material detail, select fps, "extract frames", then mat/import.

Connectivity test uses the current form values — no need to save first; DashScope / MiniMax have no lightweight probe endpoints, only field validation (generation failures surface as job errors).

### Prompt Enhancement Model

The model used by the "Enhance Prompt" button is configured here (OpenAI-compatible `chat/completions`: OpenAI / DashScope-compatible qwen / DeepSeek etc., e.g., `gpt-4o-mini`, `qwen-plus`). The enhancement system prompt is built-in and fixed (pixel-art oriented) — no template writing needed.

In the generation dialog, clicking **Enhance Prompt** shows the **original and enhanced prompts side by side**, each with a "Use this" button — the original is never auto-overwritten; you can switch or close the comparison at any time. When multiple enhancer models are configured, a dropdown next to the button lets you choose which one to use.

When the list is empty, the env var `FRAMEBAKER_GEN_CLI` falls back to an "env CLI" provider. **Settings page configuration takes priority over all env vars** — changes take effect immediately (no restart needed).

### Matting

- **Custom CLI template**: placeholders `{input}` `{output}` (optional `{model}`); leave empty for auto-detection (bundled `.venv-matting` → PATH rembg → raw copy fallback).
- **Default model**: input field with common model suggestions (u2net / u2netp / isnet-general-use / isnet-anime / birefnet-general etc., also accepts free-form input). Shows the current active model and **cache status** next to it — uncached models auto-download on first matting (about 100 MB, takes a while — this is normal).

### Doctor (Health Check)

Runs automatically when opening the settings page; can also manually "Re-check". Checks item by item:

- Storage directory writable
- ffmpeg (required for GIF/MP4 frame extraction)
- Matting engine (custom CLI validates command existence; rembg shows source)
- Matting model cache status
- Each generation provider individually (CLI validates command existence; API sends actual connectivity test)

## Material Library Page

### Upload Materials

Supports multi-select mixed upload: PNG/JPG each becomes 1 material; GIF/MP4 extracts frames into multiple materials (fps adjustable).

**Crop confirmation**: after selecting static images, you'll be asked "N images — do you want to crop before importing?" —

- **Crop one by one**: opens the crop tool for each sequentially (can "skip this one" at any time)
- **No, import directly**: uploads all as originals
- Each image in the list also has a ✂ button for (re-)cropping at any time; cropped ones show a "Cropped" badge

Cropping is done in-browser (Web Worker, non-blocking UI); only uploads after confirmation. GIF/MP4 are not cropped.

### Generate Materials

Enter a prompt and count (1–16), optionally select a reference image (using a material or project frame as reference), then choose **Provider / Model**:

- API providers: model selected from their model list dropdown (empty list = manual input)
- CLI providers: model input value sent via the configured "model parameter name" (if not configured, ignored)
- Reference image support: CLI template needs `{reference}`; API uses `images/edits` (requires edits-capable models like gpt-image series); DashScope / banana / MiniMax natively support it (MiniMax uses subject feature preservation)

The "Background Removal" toggle defaults on — matting is auto-queued after generation/upload completion.

### Crop Tool

Designed for pixel art: integer-pixel selection box, drag to move, 8-directional handles to resize, X/Y/W/H numeric fine-tuning, scroll-wheel zoom (anchored to cursor), Alt/middle-button pan, pixel grid displayed above 800% zoom, "Auto Transparent Edge" one-click selects non-transparent area (great for trimming whitespace around sprites), "Full Image" one-click reset. Outputs PNG.

### Secondary Processing (Selected Material)

Not all images need processing, so processing is triggered on demand:

- **Detail modal** (click card): raw/matted **comparison slider** to review results; run matting / restore raw / **crop** (operates on currently displayed image — if matted, crops the matted version) / **grid split** (multi-cell sprite sheet split by rows × columns into individual materials) / **multi-action generation** (image: reference image + ordered continuous frames → sheet then split; video: select action to inject into prompt → text-to-video then extract by fps, no sheet needed) / import to project (optional 1–16 copies) / delete
- **Batch operations** (Cmd/Ctrl+click multi-select, Shift+click range select): batch matting (queued), batch import to project, batch delete

Card bottom-right status dot: green = matted, gray = raw.

## Project Editor

- **Import** (three tabs): Material Library (multi-select, appended to timeline end in selection order) / Upload Files (same crop confirmation) / Generate (same as material generation, directly becomes frames)
- **Frame list + canvas**: PixiJS canvas drag frame to change position (offset); onion skin (prev red / next blue); grid; 25–400% zoom; replace image; frame duration; keyframe star
- **Timeline**: drag-and-drop reorder; Cmd/Ctrl, Shift multi-select then batch delete / duplicate / uniform duration
- **Context menu**: right-click on frames in frame list / timeline — single frame (keyframe, duration ±1, crop, duplicate, delete); right-click within multi-selection shows batch menu (duplicate / trim transparent edges / delete)
- **Playback preview**: 1–24 fps, each frame stays for `duration` ticks
- **Sprite sheet export**: pure frontend per-frame baking, downloads `*_0001.png` … + `*.frames.json` (with per-frame file/w/h/duration)
- Layout: frame list width, timeline height adjustable via split divider drag (double-click to reset, auto-persisted); theme three-state (follow system / light / dark)

## FAQ

- **First matting is very slow?** Normal — rembg is downloading the model (~100 MB) to `storage/models`; subsequent runs are near-instant. Cache status visible in settings page.
- **Matting didn't work?** Check settings page health check: without an engine installed, it degrades to "raw copy" with an install hint (`./scripts/setup_matting.sh`, Windows: `scripts\setup_matting.ps1`).
- **Generation job failed?** The error message on the job card explains directly (provider not configured / no model selected / API returned error etc.); use "Test Connection" in settings to troubleshoot first.
- **GIF frame extraction** ignores frame delays and uses uniform 1 tick; job queue is in-memory — unfinished jobs are lost on restart; the app has no authentication and is for local use only.

## Tips & Conventions

- Global notifications pop up at the bottom center (auto-dismiss after 4s, click to dismiss immediately); dangerous operations like delete all use pixel-art style confirmation dialogs.
- All page changes (job progress, matting completion, other users' actions) are refreshed in real-time via WebSocket — no manual page refresh needed.
# Generation Connectivity & Model Capabilities

Each Provider in the settings page only needs Base URL and API Key filled in once. Maintain image, video, and text models separately: the generation dialog only shows models for the current media type, and text models can be reused by prompt enhancers. Default sizes for image and video are also configured separately. Prompt enhancers only need a provider selection and text model; legacy standalone credential configs still work but should be switched to provider selection before saving again.
