# FrameBaker Roadmap

## M1 — Shipped (Current Version)

- Project management: list / create / delete, first-frame thumbnail cards
- Multi-source import:
  - GIF frame extraction (ffmpeg full-frame extraction)
  - MP4 frame extraction (adjustable fps 1–24)
  - Single image direct import / multi-file multi-select upload (per-file status + summary)
  - External CLI per-frame generation (FRAMEBAKER_GEN_CLI template)
  - Built-in rembg matting engine (scripts/setup_matting.sh, u2net model stored in storage/models; engine detection order: custom CLI → bundled rembg → PATH → passthrough warning; "background removal" toggle defaults on and shows engine status)
- Frame editor (PixiJS v8): drag to change offset, onion skin (prev red / next blue), grid, 25%–400% zoom
- Frame operations: replace image, duration ±, keyframe flag, duplicate, delete
- Timeline: HTML5 drag-and-drop reorder (optimistic update + server-side transaction idx rewrite)
- Playback preview: fps control + per-frame duration
- Sprite sheet export: pure frontend per-frame canvas transform baking, individual PNG per frame + JSON metadata
- Real-time sync: WS broadcast (job/frame/material changes), reconnect on disconnect
- Infrastructure: Bun workspaces monorepo, @framebaker/shared shared types, storage path independent of cwd
- Theme: Cassette Futurism dual theme (dark Magnetic Night / light Beige Terminal), three-state toggle (follow system / light / dark), localStorage persistence, follows system and responds to system changes in real-time when no preference is stored
- Frame batch selection: Cmd/Ctrl+click toggle, Shift+click range select (frame list and timeline linked), batch delete (confirmation) / duplicate / uniform duration
- **Material library (Materials)**: first-class materials module — upload (single image / GIF / MP4 frame extraction) / CLI generation → matting (matting/unmatting) → raw/matted comparison slider → single or batch import to project; material batch selection and batch delete; job queue extract/generate/matting generalized with JobTarget to serve both project frames and materials; project import panel "Material Library" tab multi-select direct import (primary workflow)
- Editor layout: split divider drag to adjust frame list width (180–480) and timeline height (80–320), double-click to reset, localStorage persistence
- Bilingual README (English default + Chinese README.zh-CN.md)
- Job panel (JobPanel): right-side persistent job queue, driven by WS `job_*` events + polling fallback; generation submits and closes window without blocking; material matting unified through job queue (no longer synchronous blocking); orphaned jobs marked as interrupted on server restart
- Sprite sheet grid split: material detail splits by rows × columns (1–8) into individual materials (grid line preview, optional auto-matting), reuses imageops worker, original material preserved
- Multi-action generation: material detail uses current material as reference image, **sequentially appends continuous frames** (can repeat same action, e.g., walk ×4), generates continuous action sheet in one call (`buildActionSheetPrompt` emphasizes inter-frame continuity), then "grid split" to separate
- Material search: project import modal material library tab filters locally by material name / prompt (does not affect already selected)
- AI video generation frame-by-frame extraction: generation modal "image / video" toggle — CLI output auto-detected by magic bytes and split into frames (any mode), DashScope and MiniMax video API async task polling → mp4 → ffmpeg fps extraction into library
- Frame context menu: generic `ContextMenu` component (viewport edge collapse, Esc/outside click/scroll to close); frame list/timeline right-click — single frame menu (keyframe / duration ±1 / crop / duplicate / delete), right-click within multi-selection shows batch menu (reuses BatchBar handlers)
- **MCP server**: built-in Model Context Protocol endpoint (`POST /mcp`, Streamable HTTP + JSON-RPC 2.0, protocol version `2024-11-05`), 48 tools covering projects / frames / materials / generation / matting / folders / jobs / system config; tools directly operate db and internal modules (zero HTTP self-call overhead); compatible with Claude Desktop / Claude Code / Cursor / Windsurf AI clients

## M2 — Candidates (by priority)

| Priority | Item | Notes |
| --- | --- | --- |
| P0 | Job queue persistence | Current: queue and payloads are in-memory, queued/running jobs lost on restart. Plan: scan jobs table on startup to recover, or serialize payloads into jobs table |
| P1 | Non-PNG single image conversion | Current: single image import stores raw bytes as .png filename. Plan: run `ffmpeg -i in out.png` for non-PNG |
| P1 | Sprite sheet export trim | Trim transparent edges, record sourceSize/offset in JSON, reduce file size |
| P1 | Rotation/scale/opacity edit UI | Fields and PATCH already ready, canvas toolbar only exposes offset dragging |
| P2 | GIF frame delay preservation | Current: frame extraction ignores per-frame delays, uniform handling. Plan: use ffprobe/identify to read delays and write to duration |
| P2 | AI interpolation | Generate transition frames between adjacent keyframes (can reuse FRAMEBAKER_GEN_CLI channel or add new interpolation CLI env var) |
| P2 | Delete undo | Batch delete already has confirmation (editor and material library); deletion is still irreversible — could add recycle bin / undo |

## M3 — Candidates (Long-term)

| Priority | Item | Notes |
| --- | --- | --- |
| P2 | WebM/APNG export | Server-side ffmpeg compositing, preview-consistent duration |
| P3 | Aseprite import | Parse .ase/.aseprite files (layers/tags), requires binary parsing |
| P3 | Authentication & multi-user | Currently no auth, local single-user only; required before going to cloud |
| P3 | Frame tag system | tags field already in model and PATCH, missing UI and filtering |
| P3 | Project-level playback params | Loop mode, default fps persisted to project |
| P3 | Material library enhancements | Material rename/tags/search, material directly replaces existing frame in project |

## Explicitly Out of Scope (Current Stage)

- Server-side rendering / SEO (local tool, no such need)
- Bitmap drawing capabilities (brush/eraser) — FrameBaker's positioning is frame management + fine-tuning; drawing is done in external tools then "replace image" to bring back
