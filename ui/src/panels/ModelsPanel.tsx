import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { cancelInstall, getDisk, installModel } from "../api";
import type { InstallProgress, ModelInfo } from "../types";
import { Panel, Button, Spinner } from "../components/ui";

// ---------- 工具 ----------
function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const catLabel: Record<string, string> = {
  tts: "朗读 TTS",
  asr: "识别 ASR",
  llm: "对话 LLM",
};

// 五态 → 徽标文案与样式类
const STATE_META: Record<string, { label: string; cls: string; icon: string }> = {
  running: { label: "运行中", cls: "ok", icon: "lucide:circle-check" },
  ready: { label: "就绪 · 未运行", cls: "info", icon: "lucide:circle-dot" },
  "partial-files": { label: "缺文件", cls: "warn", icon: "lucide:file-warning" },
  "missing-runtime": { label: "缺环境", cls: "warn", icon: "lucide:package-x" },
  incomplete: { label: "缺文件 + 缺环境", cls: "fail", icon: "lucide:triangle-alert" },
};

export default function ModelsPanel(props: PanelProps) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress[]>([]);
  // 当前下载进度（仅 progress 事件，用于进度条；log/done/error 进日志）
  const [pct, setPct] = useState<{ received: number; total: number } | null>(null);
  // 每引擎选择的镜像（engine → mirror 名）
  const [mirrorPick, setMirrorPick] = useState<Record<string, string>>({});
  const [diskAvail, setDiskAvail] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getDisk().then((d) => setDiskAvail(d.availBytes)).catch(() => {});
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [progress.length]);

  const install = async (m: ModelInfo) => {
    if (installing) return;
    setInstalling(m.engine);
    setProgress([]);
    setPct(null);
    try {
      await installModel(
        m.engine,
        (p) => {
          if (p.type === "progress") {
            setPct({ received: p.received || 0, total: p.total || 0 });
          } else if (p.type === "log" && /已存在，跳过/.test(p.message || "")) {
            /* 静默跳过行不进日志 */
          } else {
            setProgress((prev) => [...prev, p]);
          }
        },
        { mirror: mirrorPick[m.engine] }
      );
      await props.refresh();
    } catch (e) {
      setProgress((prev) => [...prev, { type: "error", message: String(e) }]);
    } finally {
      setInstalling(null);
      setPct(null);
    }
  };

  const cancel = async () => {
    try {
      await cancelInstall();
      setProgress((prev) => [
        ...prev,
        { type: "log", message: "… 已请求取消（保留 .part，可续传）" },
      ]);
    } catch {
      /* ignore */
    }
  };

  const stateOf = (m: ModelInfo) => m.state || (m.installed ? "running" : "partial-files");
  const needFix = (m: ModelInfo) => {
    const s = stateOf(m);
    return s === "partial-files" || s === "missing-runtime" || s === "incomplete";
  };

  return (
    <Panel
      title="模型管理"
      subtitle="查看与下载本地模型（类比 ollama pull）"
      actions={
        <Button variant="ghost" onClick={props.refresh}>
          <Icon icon="lucide:refresh-cw" width={16} height={16} /> 刷新
        </Button>
      }
    >
      <div className="models-list">
        {props.models.map((m) => {
          const st = STATE_META[stateOf(m)] || STATE_META.ready;
          const busyHere = installing === m.engine;
          return (
            <div key={m.engine} className={`model-row ${busyHere ? "busy" : ""}`}>
              <div className="model-info">
                <div className="model-name">
                  {m.label}
                  {m.license && (
                    <span className="badge lic" title={`许可证：${m.license}`}>
                      <Icon icon="lucide:scale" width={11} height={11} />{" "}
                      {m.license.split("/")[0].trim()}
                    </span>
                  )}
                </div>
                <div className="model-meta">
                  <span className="model-cat">{catLabel[m.category] || m.category}</span>
                  <span className="model-engine">{m.engine}</span>
                  <span className="model-size">{m.size}</span>
                </div>

                {/* 状态行 */}
                <div className={`model-state st-${st.cls}`}>
                  <Icon icon={st.icon} width={13} height={13} /> {st.label}
                  {!needFix(m) && m.serviceUp && stateOf(m) === "ready" && (
                    <span className="state-hint">服务进程未拉起</span>
                  )}
                </div>

                {/* 缺失明细 */}
                {(m.missingFiles?.length || 0) > 0 && (
                  <div className="missing-list">
                    {m.missingFiles!.map((f) => (
                      <div key={f.path} className="missing-item">
                        <Icon icon="lucide:x" width={12} height={12} />
                        <code>{f.path.replace(/^models\//, "")}</code>
                        <em>
                          {f.type}
                          {f.expectBytes ? ` · ${fmtBytes(f.expectBytes)}` : ""}
                          {f.actualBytes != null && f.expectBytes
                            ? `（实际 ${fmtBytes(f.actualBytes)}）`
                            : ""}
                        </em>
                      </div>
                    ))}
                  </div>
                )}
                {(m.missingRuntime?.length || 0) > 0 && (
                  <div className="missing-list runtime">
                    {m.missingRuntime!.map((r) => (
                      <div key={r.label} className="missing-item">
                        <Icon icon="lucide:wrench" width={12} height={12} />
                        <span>{r.label}</span>
                      </div>
                    ))}
                    <div className="missing-item hint">环境项由安装器/引导自动创建或克隆兜底</div>
                  </div>
                )}

                {/* 下载进度条 */}
                {busyHere && pct && pct.total > 0 && (
                  <div className="dl-wrap">
                    <div className="dl-bar">
                      <div
                        className="dl-fill"
                        style={{ width: `${Math.min(100, (pct.received / pct.total) * 100)}%` }}
                      />
                    </div>
                    <span className="dl-txt">
                      {fmtBytes(pct.received)} / {fmtBytes(pct.total)}
                    </span>
                  </div>
                )}
              </div>

              <div className="model-action">
                {/* 镜像切换：仅 url-multi 且未装好时显示 */}
                {(m.install?.mirrors?.length || 0) > 1 && needFix(m) && (
                  <select
                    className="mirror-sel"
                    value={mirrorPick[m.engine] || ""}
                    onChange={(e) =>
                      setMirrorPick((prev) => ({ ...prev, [m.engine]: e.target.value }))
                    }
                    title="下载镜像源"
                  >
                    <option value="">镜像：默认顺序</option>
                    {m.install!.mirrors.map((x) => (
                      <option key={x} value={x}>
                        镜像：{x}
                      </option>
                    ))}
                  </select>
                )}

                {!needFix(m) ? (
                  <span className={`badge ${st.cls}`}>
                    <Icon icon={st.icon} width={13} height={13} /> {st.label}
                  </span>
                ) : busyHere ? (
                  <Button variant="ghost" onClick={cancel}>
                    取消
                  </Button>
                ) : (
                  <Button onClick={() => install(m)} disabled={!!installing}>
                    {installing ? (
                      <Spinner />
                    ) : (
                      <>
                        <Icon icon="lucide:download" width={14} height={14} />
                        {stateOf(m) === "missing-runtime"
                          ? "检测/修复"
                          : `补齐${m.totalMissingBytes ? ` · ${fmtBytes(m.totalMissingBytes)}` : ""}`}
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {props.models.length === 0 && (
          <div className="empty">暂无模型数据（请确认服务已启动）</div>
        )}
      </div>

      {/* 磁盘余量 */}
      <div className="disk-line">
        <Icon icon="lucide:hard-drive" width={13} height={13} />
        磁盘剩余空间：
        {diskAvail != null ? fmtBytes(diskAvail) : "未知"}
        {diskAvail != null && diskAvail < 10 * 1024 ** 3 && (
          <em>⚠️ 剩余不足 10GB，大模型下载可能失败</em>
        )}
      </div>

      {progress.length > 0 && (
        <div className="install-log" ref={logRef}>
          <div className="install-head">
            安装进度{installing ? ` · ${installing}` : ""}
          </div>
          {progress.map((p, i) => (
            <div
              key={i}
              className={`install-line ${
                p.type === "error" ? "err" : p.type === "done" ? "ok" : ""
              }`}
            >
              {p.type === "done" ? (
                <Icon icon="lucide:check" width={14} height={14} />
              ) : p.type === "error" ? (
                <Icon icon="lucide:x" width={14} height={14} />
              ) : (
                "·"
              )}{" "}
              {p.message ?? ""}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
