import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, Clock, ListTodo, Square, X, XCircle } from "lucide-react";
import { api, wsClient, type Job } from "../api";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";

const TYPE_LABEL: Record<Job["type"], string> = {
  extract_frames: "job.extract",
  generate_frames: "msg.generate",
  matting: "msg.matting",
};

const DONE_TTL = 6000; // 完成/取消任务停留 6s 后自动移除
const MAX_ITEMS = 20;

const isActive = (j: Job) => j.status === "queued" || j.status === "running";
const isTransient = (j: Job) => j.status === "done" || j.status === "cancelled";

/**
 * 右侧常驻任务队列面板：初始接管进行中的任务，之后靠 WS job_* 事件驱动（3s 轮询兜底断连恢复期）。
 * 完成/取消短暂停留后消失；失败常驻可手动关闭。排队/运行中可取消。
 */
export default function JobPanel() {
  const t = useT();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, number>());

  const dismiss = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
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
    if (isTransient(job) && !timers.current.has(job.id)) {
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
      .catch(() => dismiss(id));

  const cancel = async (id: string) => {
    if (cancelling.has(id)) return;
    if (!(await askConfirm(t("msg.cancel_this_job_running_commands_will_be_aborted")))) return;
    setCancelling((prev) => new Set(prev).add(id));
    try {
      await api.cancelJob(id);
      await fetchOne(id);
    } catch (e) {
      notify(t("msg.cancel_failed_msg", { msg: (e as Error).message }));
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  useEffect(() => {
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
      timerMap.forEach((timer) => clearTimeout(timer));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeKey = jobs
    .filter(isActive)
    .map((j) => j.id)
    .join(",");
  useEffect(() => {
    if (!activeKey) return;
    const timer = window.setInterval(() => {
      activeKey.split(",").forEach((id) => void fetchOne(id));
    }, 3000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  if (jobs.length === 0) return null;
  const activeCount = jobs.filter(isActive).length;

  return (
    <div className="job-panel pixel-panel">
      <div className="job-panel-head">
        <ListTodo size={13} />
        <span>{t("msg.job_queue")}</span>
        <span className="count">
          {activeCount > 0 ? t("msg.n_running", { n: activeCount }) : t("msg.all_done")}
        </span>
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
              ) : j.status === "cancelled" ? (
                <Square size={13} className="wait" />
              ) : (
                <Clock size={13} className="wait" />
              )}
              <span className="kind">{t(TYPE_LABEL[j.type] ?? j.type)}</span>
              <span className="prog" title={j.error ?? j.progress ?? undefined}>
                {j.status === "done"
                  ? t("msg.done")
                  : j.status === "error"
                    ? t("msg.failed")
                    : j.status === "cancelled"
                      ? t("msg.cancelled")
                      : (j.progress ?? (j.status === "queued" ? t("msg.queued") : t("msg.processing")))}
              </span>
              {isActive(j) && (
                <button
                  type="button"
                  className="dismiss"
                  title={t("msg.cancel_job")}
                  disabled={cancelling.has(j.id)}
                  onClick={() => void cancel(j.id)}
                >
                  <Square size={11} />
                </button>
              )}
              {(j.status === "done" || j.status === "error" || j.status === "cancelled") && (
                <button type="button" className="dismiss" title={t("msg.dismiss")} onClick={() => dismiss(j.id)}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div
              className={`px-progress ${j.status === "done" ? "done" : ""} ${j.status === "error" ? "error" : ""} ${j.status === "cancelled" ? "error" : ""}`}
            >
              <div className="bar" />
            </div>
            {j.status === "error" && j.error && <div className="job-error-text">{j.error}</div>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
