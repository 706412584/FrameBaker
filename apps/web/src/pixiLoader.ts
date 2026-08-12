import type * as Pixi from "pixi.js";

type PixiWindow = Window & { PIXI?: typeof Pixi };

let loadPromise: Promise<typeof Pixi> | null = null;

function currentPixi(): typeof Pixi | null {
  return (window as PixiWindow).PIXI ?? null;
}

export function hasPixi(): boolean {
  return currentPixi() !== null;
}

/** 仅在进入编辑器时加载 Pixi，项目列表/素材库/设置页不再下载画布引擎。 */
export function loadPixi(): Promise<typeof Pixi> {
  const loaded = currentPixi();
  if (loaded) return Promise.resolve(loaded);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<typeof Pixi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/pixi.min.js";
    script.async = true;
    script.dataset.framebakerPixi = "true";
    script.onload = () => {
      const pixi = currentPixi();
      if (pixi) resolve(pixi);
      else reject(new Error("PixiJS 加载后未找到全局对象"));
    };
    script.onerror = () => reject(new Error("PixiJS 加载失败"));
    document.head.appendChild(script);
  }).catch((error) => {
    loadPromise = null;
    throw error;
  });
  return loadPromise;
}
