// 最小 preload：前后端主链路全走 HTTP/WS；此处只暴露桌面壳的原生能力桥。
// 自动更新事件与操作（check/download/install）经 ipcMain 中转，版本源头为壳的 app.getVersion()。
const { contextBridge, ipcRenderer } = require("electron");

const appInfo = (() => {
  try {
    return ipcRenderer.sendSync("framebaker:app-info") ?? {};
  } catch {
    return {};
  }
})();

contextBridge.exposeInMainWorld("framebakerDesktop", {
  platform: process.platform,
  version: appInfo.version,
  /** 订阅主进程更新事件：{type: checking|available|latest|downloading|downloaded|error, version?, percent?, error?} */
  onUpdate: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("framebaker:update", listener);
    return () => ipcRenderer.removeListener("framebaker:update", listener);
  },
  checkUpdates: () => ipcRenderer.invoke("framebaker:update-check"),
  downloadUpdate: () => ipcRenderer.invoke("framebaker:update-download"),
  installUpdate: () => ipcRenderer.send("framebaker:update-install"),
});
