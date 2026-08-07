import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

export type FileState = "pending" | "uploading" | "queued" | "done" | "error";

export interface UploadItem {
  file: File;
  state: FileState;
  cropped?: boolean;
  error?: string | null;
}

export type UploadResult = { kind: "done" } | { kind: "queued"; jobId: string };
export type UploadAdapter = (file: File) => Promise<UploadResult>;

/** 导入弹窗共用的文件上传、任务收尾与汇总状态。 */
export function useImportWorkflow(onDone: () => void) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [finished, setFinished] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const timerRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const mountedRef = useRef(true);
  const uploadActiveRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadActiveRef.current = false;
      runRef.current++;
      clearTimer();
    };
  }, [clearTimer]);

  const updateItem = useCallback((index: number, patch: Partial<UploadItem>) => {
    if (!mountedRef.current) return;
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }, []);

  const reset = useCallback(() => {
    const hadActiveUpload = uploadActiveRef.current;
    uploadActiveRef.current = false;
    runRef.current++;
    clearTimer();
    setFinished(false);
    if (hadActiveUpload) setSubmitting(false);
    // 已开始的批次被切换 tab 中止跟踪后不再保留，避免返回时重复上传。
    setItems((prev) => (hadActiveUpload || prev.some((item) => item.state !== "pending") ? [] : prev));
  }, [clearTimer]);

  const selectFiles = useCallback(
    (files: File[]) => {
      reset();
      setItems(files.map((file) => ({ file, state: "pending" })));
    },
    [reset]
  );

  const complete = useCallback((run: number) => {
    if (!mountedRef.current || run !== runRef.current) return;
    uploadActiveRef.current = false;
    setSubmitting(false);
    setFinished(true);
    onDoneRef.current();
  }, []);

  const pollJobs = useCallback(
    (entries: { jobId: string; index: number }[], run: number) => {
      const pending = new Map(entries.map((entry) => [entry.jobId, entry.index]));
      const tick = async () => {
        if (!mountedRef.current || run !== runRef.current) return;
        for (const [jobId, index] of [...pending]) {
          try {
            const job = await api.getJob(jobId);
            if (!mountedRef.current || run !== runRef.current) return;
            if (job.status === "done") {
              updateItem(index, { state: "done" });
              pending.delete(jobId);
            } else if (job.status === "error") {
              updateItem(index, { state: "error", error: job.error });
              pending.delete(jobId);
            }
          } catch {
            // 短暂请求失败不改变任务状态，下一轮继续查询。
          }
        }
        if (pending.size === 0) complete(run);
        else timerRef.current = window.setTimeout(tick, 1000);
      };
      void tick();
    },
    [complete, updateItem]
  );

  const submit = useCallback(
    async (upload: UploadAdapter) => {
      if (items.length === 0 || submitting) return;
      clearTimer();
      const run = ++runRef.current;
      const snapshot = items.map((item) => item.file);
      uploadActiveRef.current = true;
      setSubmitting(true);
      setFinished(false);
      const jobs: { jobId: string; index: number }[] = [];
      for (let index = 0; index < snapshot.length; index++) {
        if (!mountedRef.current || run !== runRef.current) return;
        updateItem(index, { state: "uploading", error: null });
        try {
          const result = await upload(snapshot[index]);
          if (!mountedRef.current || run !== runRef.current) return;
          if (result.kind === "queued") {
            jobs.push({ jobId: result.jobId, index });
            updateItem(index, { state: "queued" });
          } else {
            updateItem(index, { state: "done" });
          }
        } catch (error) {
          if (!mountedRef.current || run !== runRef.current) return;
          updateItem(index, { state: "error", error: (error as Error).message });
        }
      }
      if (jobs.length === 0) complete(run);
      else pollJobs(jobs, run);
    },
    [clearTimer, complete, items, pollJobs, submitting, updateItem]
  );

  const okCount = items.filter((item) => item.state === "done").length;
  const errCount = items.filter((item) => item.state === "error").length;

  return {
    items,
    selectFiles,
    updateItem,
    submit,
    reset,
    finished,
    submitting,
    setSubmitting,
    okCount,
    errCount,
  };
}
