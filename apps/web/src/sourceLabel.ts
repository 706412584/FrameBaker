import type { FrameSource } from "@framebaker/shared";

/** 来源短标签的 i18n key（中文即 key） */
export const SOURCE_LABEL_KEYS: Record<FrameSource, string> = {
  cli: "CLI",
  api: "API",
  dashscope: "百炼",
  gemini: "banana",
  minimax: "MiniMax",
  upload: "上传",
  gif: "GIF",
  mp4: "MP4",
  image: "图片",
  duplicate: "复制",
};
