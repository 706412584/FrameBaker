# FrameBaker Changelog

This document records features, changes, and bug fixes by release. Main releases use the SemVer-compatible `MAJOR.WEEK.BUG` policy documented in [VERSIONING.md](VERSIONING.md).

## [Unreleased]

### Added

- Motion events can now accept, validate, display, and persist an optional JSON payload.
- Added MotionClip schema v2 with per-segment cubic-bezier timing, explicit lossless v1 migration, eased quaternion slerp, curve editing, and `.fbanim`/raster compatibility.

## [0.2.2] - 2026-08-11

### Added

- Added standalone scene-layer model configuration and material-library actions with 1–4 layers and recursive decomposition.
- Added optional pre-matting that executes strictly as matting then scene decomposition within one job.
- Added synchronized version tooling and a README demonstration generated and decomposed through the real application.

### Fixed

- Prevented runtime `.length` crashes when legacy provider configuration omits model arrays.
- Removed the fake white “unmatted” comparison pane when a material only has a raw image.
- Preserved raw/matted images and metadata in grid-split material outputs.
- Relabeled scene-layer outputs from generic “API” to “Layers”, including migration of existing outputs.

### Changed

- Moved scene-layer configuration out of generation providers into a standalone setting.
- Unified the per-request layer range to 1–4 after testing the current Gitee endpoint.
- Changed the image-layer UI and MCP inference-step default from 20 to the upstream quality setting of 50; CFG remains 4.
- Reframed “Element layers” as “Scene layers”, added an explicit whole-subject/props/background scope, and disabled pre-matting by default to preserve scene context.
- Added a generated, real four-layer scene-decomposition demonstration to the README and documented why scene layers are not character rig parts.
- Adopted the `MAJOR.WEEK.BUG` main-release policy and added `bug`, `week`, and `major` version-script targets.

## [0.1.0] - 2026-08-11

### Added

- Initial Bun full-stack frame-animation editor with projects, material library, timeline, PixiJS editing, playback preview, and sprite-sheet export.
- Image/GIF/video import, timestamp extraction, multi-provider image and video generation, rembg matting, and background jobs.
- Cassette Futurism light/dark themes, resizable editor layout, frame batch operations, and WebSocket live synchronization.
- Worker-backed material cropping and transparent-edge detection, batch crop queues, grid splitting, material search, and ZIP export.
- Reference-image generation, DashScope/Gemini/MiniMax providers, prompt enhancement, structured CLI configuration, and model capability grouping.
- Video materials, custom playback, point/range extraction, multi-action generation, folders, internationalization, and language switching.
- Windows/uv and CPU/GPU rembg setup, provider diagnostics, transform baking, and individual-material exports.
- MCP Streamable HTTP server plus bilingual UI, API, architecture, and user documentation.

### Fixed

- Fixed preview overflow, Pixi canvas frame playback, job-panel positioning, and themed replacements for native selectors.
- Fixed Gemini/MiniMax prompt-enhancer compatibility, legacy model linking, Windows environment behavior, and provider configuration issues.
- Fixed deletion/cancellation, forced material import, and serial multi-file ordering when polling fails.

### Engineering and Documentation

- Added core unit tests, coverage reporting, and GitHub Actions typecheck/test CI.
- Expanded bilingual READMEs, user guide, architecture/API/roadmap docs, demo media, and MIT licensing.
