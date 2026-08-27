import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { cancelInstall, getDisk, getDeviceProfile, installModel, getPersistedSettings } from "../api";
import type { DeviceProfile, EngineFit, InstallProgress, ModelInfo } from "../types";
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

// ---------- 设备画像（000-device-vs-model.md §四 / 4.3 验收） ----------
const TIER_LABEL: Record<string, string> = {
  entry: "入门档",
  standard: "标准档",
  high: "高配档",
  flagship: "旗舰档",
};
const ACCEL_LABEL: Record<string, string> = {
  metal: "Metal",
  cuda: "CUDA",
  cpu: "CPU",
};
// 入门档默认推荐的轻量组合（000-device-vs-model.md 4.3-③：SenseVoice + Kokoro + 轻量 LLM）
const STARTER_ENGINES = ["sensevoice", "kokoro", "llm-0.5b"];

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
  // 设备画像（4.1）：服务启动探测缓存；拉取失败（如服务未升级）→ null，UI 优雅降级不显示徽标
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  // 展开「缺口 / 慢速说明」的引擎 id（🚫/⚙️ 点击切换）
  const [fitOpen, setFitOpen] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    getDisk().then((d) => setDiskAvail(d.availBytes)).catch(() => {});
    getDeviceProfile().then(setDevice).catch(() => setDevice(null));
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [progress.length]);

  const install = async (m: ModelInfo, confirmBigDownload = false) => {
    if (installing) return;
    setInstalling(m.engine);
    setProgress([]);
    setPct(null);
    const onProgress = (p: InstallProgress) => {
      if (p.type === "progress") {
        setPct({ received: p.received || 0, total: p.total || 0 });
      } else if (p.type === "log" && /已存在，跳过/.test(p.message || "")) {
        /* 静默跳过行不进日志 */
      } else {
        setProgress((prev) => [...prev, p]);
      }
    };
    try {
      await installModel(m.engine, onProgress, { mirror: mirrorPick[m.engine], confirmBigDownload });
      await props.refresh();
    } catch (e) {
      const msg = String(e);
      // S5：后端要求大流量下载二次确认（目前仅 cosyvoice-clone 的缺失权重）
      const mConfirm = /BIG_DOWNLOAD_CONFIRM:([\d.]+GB)/.exec(msg);
      if (mConfirm && !confirmBigDownload) {
        const ok = window.confirm(
          `「${m.label}」缺失的模型权重需额外下载约 ${mConfirm[1]}（视网速可能耗时较长），\n确认开始自动下载？\n（取消则可按文档手动放置权重后重试）`
        );
        if (ok) {
          setProgress((prev) => [
            ...prev,
            { type: "log", message: `已确认，开始下载（约 ${mConfirm[1]}）…` },
          ]);
          await install(m, true); // 二次确认后带 confirm=1 重试
          return;
        }
        setProgress((prev) => [
          ...prev,
          { type: "log", message: "已取消大流量下载；可按 005 文档手动下载权重到 models/cosyvoice/ 后重试。" },
        ]);
      } else {
        setProgress((prev) => [...prev, { type: "error", message: msg }]);
      }
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

  // ---------- 设备匹配（4.3 验收①②）：✅ 可安装 / ⚙️ 可装但慢 / 🚫 设备不满足 ----------
  const fitOf = (m: ModelInfo): EngineFit | null => device?.fits[m.engine] ?? null;

  const renderFitBadge = (m: ModelInfo) => {
    const fit = fitOf(m);
    if (!fit) return null;
    if (!fit.can) {
      return (
        <span
          className={`badge fit-no ${fitOpen === m.engine ? "open" : ""}`}
          title="点击查看设备缺口"
          onClick={() => setFitOpen(fitOpen === m.engine ? null : m.engine)}
        >
          <Icon icon="lucide:circle-x" width={11} height={11} /> 设备不满足
        </span>
      );
    }
    if (fit.isSlow) {
      return (
        <span
          className={`badge fit-slow ${fitOpen === m.engine ? "open" : ""}`}
          title={fit.slowNote || "本机可安装，但在当前加速器上速度较慢"}
          onClick={() => setFitOpen(fitOpen === m.engine ? null : m.engine)}
        >
          <Icon icon="lucide:gauge" width={11} height={11} /> 可装 · 慢速
        </span>
      );
    }
    return (
      <span className="badge fit-ok" title="本机满足该模型的磁盘 / 内存 / 加速要求">
        <Icon icon="lucide:circle-check" width={11} height={11} /> 可安装
      </span>
    );
  };

  // 🚫 缺口明细 / ⚙️ 慢速说明（点击徽标展开）
  const renderFitTip = (m: ModelInfo) => {
    if (fitOpen !== m.engine) return null;
    const fit = fitOf(m);
    if (!fit) return null;
    const tips = fit.can
      ? fit.slowNote
        ? [fit.slowNote]
        : []
      : fit.blocks.map((b) => b.message);
    if (tips.length === 0) return null;
    return (
      <div className={`fit-tip ${fit.can ? "slow" : "no"}`}>
        <Icon icon={fit.can ? "lucide:gauge" : "lucide:triangle-alert"} width={13} height={13} />
        <div>
          {tips.map((t, i) => (
            <div key={i}>{t}</div>
          ))}
        </div>
      </div>
    );
  };

  // 入门档默认推荐：未装齐的轻量组合（4.3 验收③）
  const starterMissing =
    device?.tier === "entry"
      ? props.models.filter((m) => STARTER_ENGINES.includes(m.engine) && needFix(m))
      : [];
  const installStarter = async () => {
    for (const m of starterMissing) {
      await install(m); // install 内部串行执行，失败进日志不中断后续
    }
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
      {/* 设备摘要条：打开即知道本机档位与可装数量（LM Studio 式零配置体验） */}
      {device && (
        <div className="device-line">
          <Icon icon="lucide:laptop" width={13} height={13} />
          本机：<b>{TIER_LABEL[device.tier] || device.tier}</b>
          <span>· {ACCEL_LABEL[device.accel] || device.accel} 加速</span>
          <span>· 内存 {device.ramGB}GB</span>
          {device.gpu.vramGB ? <span>· 显存 {device.gpu.vramGB}GB</span> : null}
          <span>· 磁盘可用 {device.diskFreeGB != null ? `${device.diskFreeGB}GB` : "未知"}</span>
          <em>可装 {device.canInstall.length}/{props.models.length}</em>
        </div>
      )}

      {/* 入门档默认推荐轻量组合，一键装齐即用（000-device-vs-model.md 4.3-③） */}
      {starterMissing.length > 0 && (
        <div className="entry-starter">
          <Icon icon="lucide:sparkles" width={15} height={15} />
          <span>
            检测到<b>入门档</b>设备，推荐先装齐轻量组合（
            {starterMissing.map((m) => m.label.split("（")[0]).join(" + ")}）：
          </span>
          <Button onClick={installStarter} disabled={!!installing}>
            {installing ? (
              <Spinner />
            ) : (
              <>
                <Icon icon="lucide:download" width={14} height={14} /> 一键装齐
              </>
            )}
          </Button>
        </div>
      )}

      <div className="models-list">
        {props.models.map((m) => {
          const st = STATE_META[stateOf(m)] || STATE_META.ready;
          const busyHere = installing === m.engine;
          // 030 启动中判定：文件就绪（state=ready）但服务应启动未 running → 冷启动加载中；
          // 节能模式下未选择的大模型 → 「未启用」而非缺文件/启动中
          const BIG_ENGINE_KEY: Record<string, string> = {
            qwen3: "qwen3",
            "cosyvoice-clone": "cosyvoice",
            "sensevoice-original": "sensevoice-original",
          };
          const ecoBigKey = BIG_ENGINE_KEY[m.engine];
          const pm = getPersistedSettings();
          const bigShouldStart = ecoBigKey
            ? pm.powerMode === "eco"
              ? pm.ecoBig === ecoBigKey
              : true
            : true;
          const readyNoRun = stateOf(m) === "ready";
          const launching = readyNoRun && bigShouldStart;
          const ecoDisabled = readyNoRun && !!ecoBigKey && !bigShouldStart;
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
                  {/* 设备匹配徽标（4.3 验收①）：✅ 可安装 / ⚙️ 可装但慢 / 🚫 设备不满足 */}
                  {renderFitBadge(m)}
                </div>
                <div className="model-meta">
                  <span className="model-cat">{catLabel[m.category] || m.category}</span>
                  <span className="model-engine">{m.engine}</span>
                  <span className="model-size">{m.size}</span>
                </div>

                {/* 状态行：启动中 / 未启用（节能） / 常规五态 */}
                <div
                  className={`model-state ${
                    launching ? "st-launch" : ecoDisabled ? "st-eco-off" : `st-${st.cls}`
                  }`}
                >
                  {launching ? (
                    <>
                      <Spinner /> 启动中…
                      <span className="state-hint">模型加载中，冷启动需等待（如克隆约 1–2 分钟）</span>
                    </>
                  ) : ecoDisabled ? (
                    <>
                      <Icon icon="lucide:power" width={13} height={13} /> 未启用（节能模式）
                    </>
                  ) : (
                    <>
                      <Icon icon={st.icon} width={13} height={13} /> {st.label}
                      {!needFix(m) && m.serviceUp && stateOf(m) === "ready" && (
                        <span className="state-hint">服务进程未拉起</span>
                      )}
                    </>
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

                {/* 设备缺口明细 / 慢速说明（4.3 验收②：🚫 点击显示，而不是隐藏） */}
                {renderFitTip(m)}

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
