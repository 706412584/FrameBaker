# FrameBaker Domain Vocabulary

- **Project**: A set of frames sorted by `idx` that can be edited frame-by-frame, played back, and exported as a sprite sheet.
- **Frame**: A single image in the project timeline along with its duration, keyframe flag, and transform properties.
- **Frame Transform**: Anchored at the image center, interpreted in order: offset, rotation, scale, with opacity applied at render time; edit preview and export share the same geometric semantics.
- **Material**: An image or video asset that can be organized, matted, cropped, and imported into projects independently, retaining raw/processed slots.
- **Import Workflow**: The state transitions a file goes through from selection, optional cropping, upload, queuing, to completion summary; project import and material import use different target adapters.
- **Generation Provider**: A CLI or external image/video generation protocol's configuration and execution source; configuration is read in real-time from settings on each invocation, with environment variables as fallback only.
- **Generated Artifact**: An image or video file produced by a provider; upon submission it becomes a project frame or material, with source and generation metadata recorded.
- **Job**: A queued unit of work for frame extraction, generation, or matting, with a queued/running/done/error/cancelled lifecycle.
- **Matting**: An async task that generates a transparent-background processed image from a raw image.
