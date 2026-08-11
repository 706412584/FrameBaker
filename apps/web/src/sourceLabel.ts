import type { FrameSource } from "@framebaker/shared";

/** 来源短标签的 i18n key */
export const SOURCE_LABEL_KEYS: Record<FrameSource, string> = {
  cli: "CLI",
  api: "API",
  dashscope: "msg.bailian",
  gemini: "banana",
  minimax: "MiniMax",
  layers: "layers.source",
  upload: "common.upload",
  gif: "GIF",
  mp4: "MP4",
  image: "msg.image",
  extract: "msg.extract_tag",
  duplicate: "msg.duplicate",
};
