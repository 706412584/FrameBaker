import { useEffect, useState } from "react";

// 全局通知与确认弹窗的统一入口（替代浏览器 alert/confirm）：
// 任意组件调 notify(text) 弹错误/提示条，askConfirm(text) 弹像素风确认框（Promise<boolean>）；
// 渲染由 App 根部的 <AppModals /> 单例完成

export type NoticeKind = "error" | "info";

export interface Notice {
  id: number;
  text: string;
  kind: NoticeKind;
}

interface ConfirmReq {
  id: number;
  text: string;
  resolve: (ok: boolean) => void;
}

let seq = 0;
let notices: Notice[] = [];
let confirmReq: ConfirmReq | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function dismissNotice(id: number) {
  notices = notices.filter((n) => n.id !== id);
  emit();
}

/** 弹一条通知（默认 error 样式），4.2s 自动消失，点击立即关闭 */
export function notify(text: string, kind: NoticeKind = "error") {
  const id = ++seq;
  notices = [...notices.slice(-3), { id, text, kind }]; // 最多同时 4 条，防刷屏
  emit();
  window.setTimeout(() => dismissNotice(id), 4200);
}

/** 像素风确认框；点蒙层/取消 = false，确定 = true（同时只存在一个） */
export function askConfirm(text: string): Promise<boolean> {
  confirmReq?.resolve(false); // 兜底：前一个没有按钮被点就被顶掉时别悬挂
  return new Promise((resolve) => {
    confirmReq = { id: ++seq, text, resolve };
    emit();
  });
}

export function settleConfirm(ok: boolean) {
  confirmReq?.resolve(ok);
  confirmReq = null;
  emit();
}

/** 订阅当前通知列表与待确认请求 */
export function useNoticeState(): { notices: Notice[]; confirm: ConfirmReq | null } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { notices, confirm: confirmReq };
}
