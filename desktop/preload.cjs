// 最小 preload：当前前后端全走 HTTP/WS，无需暴露任何 Node 能力。
// 预留 contextBridge 以便将来加「打开数据目录」等原生菜单动作。
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("framebakerDesktop", {
  platform: process.platform,
});
