import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Clock, ListTodo, X, XCircle } from "lucide-react";
import { api, wsClient, type Job } from "../api";

const TYPE_LABEL: Record<Job["type"], string> = {
  extract_frames: "拆帧",
  generate_frames: "生成",
  matting: "抠图",
};

const DONE_TTL = 6000; // 完成任务停留 6s 后自动移除
const MAX_ITEMS = 20;

const isActive = (j: Job) => j.status === "queued" || j.status === "running";

/**
 * 右侧常驻任务队列面板：初始接管进行中的任务，之后靠 WS job_* 事件驱动（3s 轮询兜底断连恢复期）。
 * 完成的短暂停留后消失；失败的常驻，可手动关闭。无任务时不渲染。
 */
export default function JobPanel() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = (id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setJobs((prev) => prev.filter((j) => j.id !== id));
  };

  const upsert = (job: Job) => {
    setJobs((prev) => {
      const next = prev.some((j) => j.id === job.id)
        ? prev.map((j) => (j.id === job.id ? job : j))
        : [job, ...prev];
      return next.slice(0, MAX_ITEMS);
    });
    if (job.status === "done" && !timers.current.has(job.id)) {
      timers.current.set(
        job.id,
        window.setTimeout(() => {
          timers.current.delete(job.id);
          setJobs((prev) => prev.filter((j) => j.id !== job.id));
        }, DONE_TTL)
      );
    }
  };

  const fetchOne = (id: string) =>
    api
      .getJob(id)
      .then(upsert)
      .catch(() => dismiss(id)); // 任务查不到（如已清理）直接从面板移除

  useEffect(() => {
    // 初始：只接管正在进行中的任务（历史完成/失败记录不进面板）
    api
      .listJobs()
      .then((list) => setJobs(list.filter(isActive).slice(0, MAX_ITEMS)))
      .catch(() => {});
    const unsub = wsClient.subscribe((msg) => {
      const p = msg.payload as { id?: string } | undefined;
      if (msg.type.startsWith("job_") && p?.id) void fetchOne(p.id);
    });
    const timerMap = timers.current;
    return () => {
      unsub();
      timerMap.forEach((t) => clearTimeout(t));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 活动任务 3s 轮询兜底（WS 事件丢失时收敛状态）
  const activeKey = jobs
    .filter(isActive)
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!activeKey) return;
    const t = window.setInterval(() => {
      activeKey.split(",").forEach((id) => void fetchOne(id));
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  if (jobs.length === 0) return null;
  const activeCount = jobs.filter(isActive).length;

  return (
    <div className="job-panel pixel-panel">
      <div className="job-panel-head">
        <ListTodo size={13} />
        <span>任务队列</span>
        <span className="count">{activeCount > 0 ? `${activeCount} 进行中` : "全部完成"}</span>
      </div>
      <AnimatePresence initial={false}>
        {jobs.map((j) => (
          <motion.div
            key={j.id}
            className={`job-item ${j.status}`}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
          >
            <div className="row">
              {j.status === "done" ? (
                <CheckCircle2 size={13} className="ok" />
              ) : j.status === "error" ? (
                <XCircle size={13} className="err" />
              ) : (
                <Clock size={13} className="wait" />
              )}
              <span className="kind">{TYPE_LABEL[j.type] ?? j.type}</span>
              <span className="prog" title={j.error ?? j.progress ?? undefined}>
                {j.status === "done"
                  ? "完成"
                  : j.status === "error"
                    ? "失败"
                    : (j.progress ?? (j.status === "queued" ? "排队中" : "处理中"))}
              </span>
              {(j.status === "done" || j.status === "error") && (
                <button type="button" className="dismiss" title="移除" onClick={() => dismiss(j.id)}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div className={`px-progress ${j.status === "done" ? "done" : ""} ${j.status === "error" ? "error" : ""}`}>
              <div className="bar" />
            </div>
            {j.status === "error" && j.error && <div className="job-error-text">{j.error}</div>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
