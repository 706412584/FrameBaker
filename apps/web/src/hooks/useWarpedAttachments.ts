// 角色预览 warp 贴图缓存：按「URL|grid|points」签名缓存 warp 后的 objectURL，
// 新签名 pending 期间保留该部件上一帧 URL 防闪烁；签名失效即 revoke，卸载时全部 revoke。

import { useCallback, useEffect, useRef, useState } from "react";
import { warpImage } from "../imageops/client";

export interface WarpedAttachmentRequest {
  /** 附件 id，结果按此键返回。 */
  id: string;
  /** 原图 URL（materialImageUrl，已含版本号）。 */
  url: string;
  grid: [number, number];
  points: number[];
}

const signatureOf = (request: WarpedAttachmentRequest) =>
  `${request.url}|${request.grid[0]},${request.grid[1]}|${request.points.join(",")}`;

/**
 * 消费部件有效 warp 并产出贴图 objectURL（按附件 id 索引；无 URL 时调用方回退原图）。
 * 全零 warp 由调用方过滤，不进入 requests。
 */
export function useWarpedAttachments(requests: WarpedAttachmentRequest[]): Record<string, string | undefined> {
  const [urls, setUrls] = useState<Record<string, string | undefined>>({});
  const cacheRef = useRef(new Map<string, string>());
  const displayedRef = useRef(new Map<string, string>());
  const pendingRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const publish = useCallback(() => {
    const next: Record<string, string | undefined> = {};
    for (const [id, signature] of displayedRef.current) {
      const url = cacheRef.current.get(signature);
      if (url) next[id] = url;
    }
    setUrls(next);
  }, []);
  const serialized = requests.map((request) => `${request.id}=${signatureOf(request)}`).join("\n");
  useEffect(() => {
    const cache = cacheRef.current, displayed = displayedRef.current, pending = pendingRef.current;
    const wantedIds = new Set(requests.map((request) => request.id));
    for (const id of [...displayed.keys()]) if (!wantedIds.has(id)) displayed.delete(id);
    for (const request of requests) {
      const signature = signatureOf(request);
      if (cache.has(signature)) {
        displayed.set(request.id, signature);
        continue;
      }
      if (pending.has(signature)) continue; // 同签名请求中，保留旧 URL 防闪烁
      pending.add(signature);
      void (async () => {
        try {
          const response = await fetch(request.url);
          if (!response.ok) throw new Error(`${response.status}`);
          const warped = await warpImage(await response.blob(), request.grid, request.points);
          const objectUrl = URL.createObjectURL(warped);
          if (!mountedRef.current) {
            URL.revokeObjectURL(objectUrl);
            return;
          }
          cache.set(signature, objectUrl);
          // 仅当该部件当前仍需要此签名才切换展示（拖拽期间签名快速过期，等最新一帧即可）
          const current = requestsRef.current.find((item) => item.id === request.id);
          if (current && signatureOf(current) === signature) {
            displayed.set(request.id, signature);
            publish();
          }
        } catch {
          // warp 失败保持原图（调用方回退 materialImageUrl）
        } finally {
          pending.delete(signature);
        }
      })();
    }
    // 回收不再展示且不再需要的缓存
    const keep = new Set([...requests.map(signatureOf), ...displayed.values()]);
    for (const [signature, url] of cache) {
      if (keep.has(signature)) continue;
      URL.revokeObjectURL(url);
      cache.delete(signature);
    }
    publish();
    // serialized 是 requests 内容的稳定签名；requests 本体每次渲染新建，不能作依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, serialized]);
  useEffect(() => () => {
    mountedRef.current = false;
    for (const url of cacheRef.current.values()) URL.revokeObjectURL(url);
    cacheRef.current.clear();
    displayedRef.current.clear();
    pendingRef.current.clear();
  }, []);
  return urls;
}
