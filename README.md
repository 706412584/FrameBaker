# FrameBaker

**Pixel-art frame-by-frame animation editor — a Bun full-stack app.**

Import sprites from anywhere (GIF/MP4 frame extraction, PNG upload, external CLI generation), cut out backgrounds with the built-in rembg matting engine, review results in the materials library, then edit frames on a PixiJS onion-skin canvas, arrange the timeline, preview playback, and export a spritesheet.

![Bun](https://img.shields.io/badge/Bun-1.3-14151A?logo=bun)
![Elysia](https://img.shields.io/badge/Elysia-1.4-6f61c0)
![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)

**English** | [中文](README.zh-CN.md)

<!-- Screenshot placeholder -->
<!-- ![screenshot](docs/screenshot.png) -->

## Features

- **Multi-source import** — GIF / MP4 frame extraction via ffmpeg (adjustable fps), multi-select PNG upload, external generator CLI (`FRAMEBAKER_GEN_CLI`)
- **Built-in matting** — rembg works out of the box (u2net by default, custom models supported); custom CLI template optional; before/after compare slider to review cutouts
- **Materials library** — a first-class staging area: generate or upload, matte, compare, then import into any project — single or batch
- **Frame editor** — PixiJS v8 canvas with onion skin (prev red / next blue), grid, 25–400% zoom, draggable frame offsets, replace image, per-frame duration, keyframes
- **Timeline & batch ops** — drag to reorder, Cmd/Ctrl+Click and Shift+Click multi-select, batch delete / duplicate / set duration
- **Spritesheet export** — pure client-side canvas packing → `*.spritesheet.png` + `*.json`
- **Cassette Futurism themes** — dark "Magnetic Night" / light "Beige Terminal"; follows system preference until you pick one (tri-state toggle)
- **Live sync** — WebSocket broadcasts for job progress and frame/material changes
- **Adjustable layout** — drag the split dividers to resize the frame list and timeline (persisted)

## Quick Start

```bash
bun install
bun dev          # dev mode (--hot) → http://localhost:3000
# or
bun start        # production
```

- Port: `PORT=8080 bun dev`
- ffmpeg is required for frame extraction: `brew install ffmpeg`
- **Matting engine** (already installed on this machine; required again on a fresh checkout):
  ```bash
  ./scripts/setup_matting.sh
  ```
  Creates `.venv-matting/` (python3 venv) and installs `rembg[cli,cpu]`. The u2net model downloads automatically to `storage/models` on first use. Skipping this leaves matting in passthrough mode (copies the original image with a warning).
- Type check: `bun run typecheck`

## Matting Engine Resolution

Detected once at server start (see `GET /api/config`):

1. `FRAMEBAKER_MATTING_CLI` — custom command template (`{input}` `{output}`, optional `{model}`)
2. `<repo>/.venv-matting/bin/rembg` — installed by `scripts/setup_matting.sh` (engine = `rembg-bundled`)
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
- `scripts/` — setup scripts (matting engine)
- `docs/` — documentation
- `storage/` — runtime data (SQLite, frames, materials, rembg models; gitignored)

## Docs

- [docs/guide.md](docs/guide.md) — user guide (settings page, provider setup, crop tool, material processing, editor)（中文）
- [docs/architecture.md](docs/architecture.md) — architecture diagram, modules, data flows, storage layout
- [docs/api.md](docs/api.md) — API reference with request/response examples, WebSocket events
- [docs/roadmap.md](docs/roadmap.md) — shipped features and planned work

## Font License

The UI font is **Fusion Pixel 12px** (`apps/web/public/fonts/`), licensed under the SIL Open Font License 1.1 — see `apps/web/public/fonts/OFL.txt`.

## Known Limitations

Job queue is in-memory (unfinished jobs are lost on restart); GIF frame delays are ignored; single-image imports are stored byte-for-byte (PNG recommended); spritesheet export does no trimming; no authentication — local use only. See the [roadmap](docs/roadmap.md) for planned improvements.
