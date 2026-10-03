// 桌面壳（desktop/preload.cjs）注入的 window.framebakerDesktop 桥类型。
// 仅 Electron 窗口内存在；浏览器直连（便携版/源码模式）为 undefined。

export interface DesktopUpdateEvent {
  type: "checking" | "available" | "latest" | "downloading" | "downloaded" | "error";
  version?: string;
  percent?: number;
  bytesPerSecond?: number;
  error?: string;
}

export interface FramebakerDesktopApi {
  platform: string;
  version?: string;
  onUpdate: (callback: (event: DesktopUpdateEvent) => void) => () => void;
  checkUpdates: () => Promise<unknown>;
  downloadUpdate: () => Promise<unknown>;
  installUpdate: () => void;
}

declare global {
  interface Window {
    framebakerDesktop?: FramebakerDesktopApi;
  }
}

export {};
