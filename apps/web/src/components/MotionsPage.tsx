import AnimationAssetsWorkspace from "./AnimationAssetsWorkspace";

export default function MotionsPage({ onOpenProjects }: { onOpenProjects: () => void }) {
  return <div className="page animation-assets-page" onScroll={(event) => {
    // 纵向滚动容器在浏览器焦点定位时仍可能产生隐藏的横向偏移，锁回左侧避免侧栏和画布被裁切。
    if (event.currentTarget.scrollLeft) event.currentTarget.scrollLeft = 0;
  }}><AnimationAssetsWorkspace onOpenProjects={onOpenProjects} /></div>;
}
