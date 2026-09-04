import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { cancelInstall, getDisk, getDiskLocal, getDeviceProfile, installModel, getPersistedSettings, uninstallModel, uninstallPreview } from "../api";
import type { DeviceProfile, EngineFit, InstallProgress, ModelInfo } from "../types";
import { Panel, Button, Spinner } from "../components/ui";
import EcoResourceTables from "./EcoResourceTables";

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

// 2026-08-31：下载源显示名（官方/镜像区分；与 engines/*.json install.mirrors 同名）
const MIRROR_LABEL: Record<string, string> = {
  huggingface: "huggingface（官方）",
  "hf-mirror": "hf-mirror（镜像）",
  modelscope: "modelscope（官方）",
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

// 五态 → 徽标文案与样式类（P1：unknown = 服务未启动时的本地清单占位）
const STATE_META: Record<string, { label: string; cls: string; icon: string }> = {
  running: { label: "运行中", cls: "ok", icon: "lucide:circle-check" },
  ready: { label: "就绪 · 未运行", cls: "info", icon: "lucide:circle-dot" },
  "partial-files": { label: "缺文件", cls: "warn", icon: "lucide:file-warning" },
  "missing-runtime": { label: "缺环境", cls: "warn", icon: "lucide:package-x" },
  incomplete: { label: "缺文件 + 缺环境", cls: "fail", icon: "lucide:triangle-alert" },
  unknown: { label: "服务未启动", cls: "warn", icon: "lucide:circle-dot" },
};

export default function ModelsPanel(props: PanelProps) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress[]>([]);
  // 当前下载进度（仅 progress 事件，用于进度条；log/done/error 进日志）
  const [pct, setPct] = useState<{ received: number; total: number } | null>(null);
  // 033 修复：大流量二次确认用内嵌确认行代替 window.confirm（WebView2 吞原生 confirm → 点了没反应，已踩坑）
  const [bigConfirm, setBigConfirm] = useState<{ engine: string; label: string; gb: string } | null>(null);
  // 阶段1：单引擎卸载——内嵌确认行（先 uninstall_preview 拿将释放空间，确认后 uninstall_model 停服务+删除）
  const [uninstallConfirm, setUninstallConfirm] = useState<{
    engine: string;
    label: string;
    estBytes: number | null;
    sizeHint: string;
    stopWarn: boolean;
  } | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  // 每引擎选择的镜像（engine → mirror 名）
  const [mirrorPick, setMirrorPick] = useState<Record<string, string>>({});
  const [diskAvail, setDiskAvail] = useState<number | null>(null);
  // 设备画像（4.1）：服务启动探测缓存；拉取失败（如服务未升级）→ null，UI 优雅降级不显示徽标
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  // 展开「缺口 / 慢速说明」的引擎 id（🚫/⚙️ 点击切换）
  const [fitOpen, setFitOpen] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // P1：磁盘剩余走本地探测（不依赖服务）；服务在线则永远有值，离线也能显示
    getDiskLocal()
      .then((b) => setDiskAvail(b))
      .catch(() => {
        getDisk()
          .then((d) => setDiskAvail(d.availBytes))
          .catch(() => {});
      });
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
      // S5/033 修复：后端要求大流量下载二次确认（目前仅 cosyvoice-clone 的缺失权重）——
      // 内嵌确认行代替 window.confirm（WebView2 原生 confirm 会被静默吞掉返回 false）
      const mConfirm = /BIG_DOWNLOAD_CONFIRM:([\d.]+GB)/.exec(msg);
      if (mConfirm && !confirmBigDownload) {
        setProgress((prev) => [
          ...prev,
          { type: "log", message: `「${m.label}」需二次确认下载（约 ${mConfirm[1]}）…` },
        ]);
        setBigConfirm({ engine: m.engine, label: m.label, gb: mConfirm[1] });
      } else if (/已有安装任务进行中/.test(msg)) {
        // 2026-09-05：服务端 installLock 仍被占用（多为上次安装异常断开未释放）——给可操作提示而非裸错误
        setProgress((prev) => [
          ...prev,
          {
            type: "error",
            message:
              "服务端仍有安装任务在跑（可能上次下载未正常结束）——稍等几秒重试；若持续如此，到设置页「应用并重启服务」后再试",
          },
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

  // ---------- 阶段1：单引擎卸载（Rust 侧：先停服务 → 删模型文件 + venv + .part） ----------
  const startUninstall = async (m: ModelInfo) => {
    if (installing || uninstalling) return;
    setProgress([]);
    try {
      const p = await uninstallPreview(m.engine);
      setUninstallConfirm({
        engine: m.engine,
        label: m.label,
        estBytes: p.est_bytes || null,
        sizeHint: m.size,
        stopWarn: stateOf(m) === "running" || !!m.serviceUp,
      });
    } catch (e) {
      setProgress((prev) => [...prev, { type: "error", message: `卸载预览失败：${e}` }]);
    }
  };

  const confirmUninstall = async () => {
    if (!uninstallConfirm || installing || uninstalling) return;
    const { engine, label } = uninstallConfirm;
    setUninstallConfirm(null);
    setUninstalling(true);
    setProgress([]);
    setProgress((prev) => [...prev, { type: "log", message: `开始卸载「${label}」…` }]);
    try {
      const r = await uninstallModel(engine);
      const deleted = r.items.filter((i) => i.deleted);
      const failed = r.items.filter((i) => !i.deleted && i.error);
      const restartNote = r.restarted
        ? "服务已自动重启，其它引擎恢复可用"
        : r.nothing_left
          ? "已无其它引擎文件，服务保持停止（需要时点侧边栏「启动」重新拉起）"
          : r.restart_error
            ? `自动重启失败：${r.restart_error}（请手动点侧边栏「启动」）`
            : "服务未运行，未启动";
      setProgress((prev) => [
        ...prev,
        { type: "log", message: `已删除 ${deleted.length} 项（模型文件 + 运行环境）` },
        ...failed.map((i) => ({
          type: "error" as const,
          message: `删除失败 ${i.path}：${i.error}`,
        })),
        {
          type: "done",
          message: `卸载完成，释放 ${fmtBytes(r.freed_bytes)}；${restartNote}`,
        },
      ]);
      await props.refresh();
    } catch (e) {
      setProgress((prev) => [...prev, { type: "error", message: `卸载失败：${e}` }]);
    } finally {
      setUninstalling(false);
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

      {/* 000-plan-3：按类别资源表（顶部新增区块；节能每类单开的选择入口也在这里） */}
      <EcoResourceTables models={props.models} refresh={props.refresh} />

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
          // 000-plan-3：节能 = 每类同时仅启用 1 个模型（无"禁用"）。TTS/ASR 引擎是否为本类当前启用
          //（LLM 档位在 9528 内按请求换载、无进程层"启用"，不在此列）。ecoTts/ecoAsr 未配置（旧 config）→ 该类全未启用。
          const pm = getPersistedSettings();
          const isEco = pm.powerMode === "eco";
          const ecoOn =
            !isEco ||
            (m.category !== "tts" && m.category !== "asr") ||
            (m.category === "tts" ? pm.ecoTts === m.engine : pm.ecoAsr === m.engine);
          const readyNoRun = stateOf(m) === "ready";
          const running = stateOf(m) === "running";
          // 进程型大引擎才有"节能未启用 → 未跑"的真实状态可标（Python 8001/8002/8003，可被 skip）；
          // 9528 内轻量（kokoro/量化 sensevoice/whisper/LLM）常驻无进程可关 → 卡片显示真实运行状态，
          // 节能停用只在前端（面板下拉 + 顶部资源表）表达。
          const isProcessEngine = m.engine === "qwen3" || m.engine === "cosyvoice-clone" || m.engine === "sensevoice-original";
          // 表里如一：显示真实状态；模式期望（节能未选）与真实状态不符时明确提示，不隐瞒
          const ecoNotSelected = isEco && isProcessEngine && !ecoOn && (readyNoRun || running); // 节能未启用的大模型
          const ecoMismatch = ecoNotSelected && running; // 期望关闭但实际仍在运行（模式已改未重启）
          const ecoIdle = ecoNotSelected && readyNoRun; // 期望关闭且实际确实没在跑
          const launching = ecoOn && readyNoRun && isEco && isProcessEngine; // 节能应启用但进程未起（冷启动）
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
                  {/* 036：GPU/CPU 加速版本标记（torch CUDA 版 / CPU 版） */}
                  {m.accelTag && (
                    <span className={`badge accel-${m.accelTag.kind}`} title={m.accelTag.kind === "cuda" ? "torch 为 CUDA 版，GPU 加速推理" : "torch 为 CPU 版（无 GPU 加速）"}>
                      <Icon icon={m.accelTag.kind === "cuda" ? "lucide:gpu" : "lucide:cpu"} width={11} height={11} />{" "}
                      {m.accelTag.label}
                    </span>
                  )}
                </div>

                {/* 状态行：真实状态优先；启动中 / 可用未启用(黄) / 期望关闭仍运行(黄提示) / 常规 */}
                <div
                  className={`model-state ${
                    launching
                      ? "st-launch"
                      : ecoIdle
                        ? fitOf(m)?.can
                          ? "st-avail-off"
                          : "st-fail"
                        : ecoMismatch
                          ? "st-mismatch"
                          : `st-${st.cls}`
                  }`}
                >
                  {launching ? (
                    <>
                      <Spinner /> 启动中…
                      <span className="state-hint">模型加载中，冷启动需等待（如克隆约 1–2 分钟）</span>
                    </>
                  ) : ecoIdle ? (
                    fitOf(m)?.can ? (
                      <>
                        <Icon icon="lucide:check" width={13} height={13} /> 可用 · 未启用（节能模式）
                        <span className="state-hint">可切换使用 → 模型页顶部「按类别 · 模型资源表」点选启用</span>
                      </>
                    ) : (
                      <>
                        <Icon icon="lucide:x" width={13} height={13} /> 设备不满足
                        <span className="state-hint">节能模式未启用，且本机不满足该模型要求</span>
                      </>
                    )
                  ) : ecoMismatch ? (
                    <>
                      <Icon icon={st.icon} width={13} height={13} /> {st.label}
                      <span className="state-hint mismatch-hint">
                        ⚠️ 节能模式已设置，此服务仍在运行（占用内存）——重启服务后关闭
                      </span>
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
                {/* ── 发布版暂隐藏「升级 GPU 加速」按钮（2026-08-31，055 §五）──
                    原因：CUDA torch 升级属「优化非必需」，发布前降风险；
                    后端 gpuUpgrade 标志与 uvVenvInstaller 的 torchCpuHere 分支均保留未删。
                    恢复方法：取消下方注释块 → 重建 exe（坑 M）→ 模型页按钮回归。
                {m.gpuUpgrade && !busyHere && (
                  <Button
                    className="gpu-upgrade"
                    onClick={() => install(m)}
                    disabled={!!installing}
                    title="当前引擎的 torch 为 CPU 版，无法用显卡加速。升级为 CUDA 版（PyTorch 官方源，约 2.5GB）后推理大幅提速。"
                  >
                    <Icon icon="lucide:zap" width={14} height={14} />
                    升级 GPU 加速
                  </Button>
                )}
                */}

                {/* 下载源选择（2026-08-31：所有引擎生效）：默认自动 = 官方优先 + 失败/无进展/低速自动切换；可指定源 */}
                {(m.install?.mirrors?.length || 0) > 1 && needFix(m) && (
                  <select
                    className="mirror-sel"
                    value={mirrorPick[m.engine] || ""}
                    onChange={(e) =>
                      setMirrorPick((prev) => ({ ...prev, [m.engine]: e.target.value }))
                    }
                    title="下载源：默认「自动」（官方优先，失败/无进展 30s/低速 60s 自动切换镜像）；可手动指定某一源"
                  >
                    <option value="">自动（官方优先 · 自动切换）</option>
                    {m.install!.mirrors.map((x) => (
                      <option key={x} value={x}>
                        {MIRROR_LABEL[x] || x}
                      </option>
                    ))}
                  </select>
                )}

                {stateOf(m) === "unknown" ? (
                  <div className="model-action-row">
                    <Button disabled title="请先启动本地服务（侧边栏「启动」或顶部引导条「一键安装」）">
                      <Icon icon="lucide:power" width={14} height={14} /> 启动服务后安装
                    </Button>
                    <Button
                      variant="ghost"
                      className="uninstall-btn"
                      onClick={() => startUninstall(m)}
                      disabled={!!installing || uninstalling}
                      title="卸载：删除该引擎的模型文件与运行环境（含残留 .part）"
                    >
                      <Icon icon="lucide:trash-2" width={14} height={14} /> 卸载
                    </Button>
                  </div>
                ) : !needFix(m) ? (
                  <div className="model-action-row">
                    <span className={`badge ${st.cls}`}>
                      <Icon icon={st.icon} width={13} height={13} /> {st.label}
                    </span>
                    <Button
                      variant="ghost"
                      className="uninstall-btn"
                      onClick={() => startUninstall(m)}
                      disabled={!!installing || uninstalling}
                      title="卸载：删除该引擎的模型文件与运行环境（需先停止服务）"
                    >
                      <Icon icon="lucide:trash-2" width={14} height={14} /> 卸载
                    </Button>
                  </div>
                ) : uninstalling ? (
                  <Button disabled title="正在卸载…">
                    <Spinner /> 卸载中…
                  </Button>
                ) : busyHere ? (
                  <Button variant="ghost" onClick={cancel}>
                    取消
                  </Button>
                ) : (
                  <div className="model-action-row">
                    <Button onClick={() => install(m)} disabled={!!installing}>
                      {installing ? (
                        <Spinner />
                      ) : (
                        <>
                          <Icon icon="lucide:download" width={14} height={14} />
                          {stateOf(m) === "missing-runtime" || (m.missingRuntime && m.missingRuntime.length > 0)
                            ? "检测/修复"
                            : `补齐${m.totalMissingBytes ? ` · ${fmtBytes(m.totalMissingBytes)}` : ""}`}
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      className="uninstall-btn"
                      onClick={() => startUninstall(m)}
                      disabled={!!installing || uninstalling}
                      title="删除该引擎已下载的文件（含未完成的 .part 残留）"
                    >
                      <Icon icon="lucide:trash-2" width={14} height={14} /> 卸载
                    </Button>
                  </div>
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

      {/* 033 修复：大流量二次确认行独立渲染——之前放在 install-log 内（progress>0 才显示），
          BIG_DOWNLOAD_CONFIRM 分支不推 progress → 整块不渲染 → 用户点「检测/修复」只见按钮晃一下 */}
      {bigConfirm && (
        <div className="install-confirm">
          <div className="install-confirm-text">
            「{bigConfirm.label}」需下载约 <b>{bigConfirm.gb}</b>（视网速可能耗时较长），确认开始？
          </div>
          <div className="install-confirm-actions">
            <Button
              onClick={async () => {
                const m = props.models.find((x) => x.engine === bigConfirm.engine);
                if (!m) {
                  setBigConfirm(null);
                  return;
                }
                setProgress((prev) => [
                  ...prev,
                  { type: "log", message: `已确认，开始下载（约 ${bigConfirm.gb}）…` },
                ]);
                setBigConfirm(null);
                await install(m, true); // 二次确认后带 confirm=1 重试
              }}
              disabled={!!installing}
            >
              <Icon icon="lucide:download" width={14} height={14} /> 确认下载 {bigConfirm.gb}
            </Button>
            <Button variant="ghost" onClick={() => {
              setBigConfirm(null);
              setProgress((prev) => [
                ...prev,
                { type: "log", message: "已取消大流量安装；可稍后重试或按模型文档手动处理。" },
              ]);
            }}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* 阶段1：单引擎卸载确认行（与 bigConfirm 同款内嵌确认，替代 window.confirm） */}
      {uninstallConfirm && (
        <div className="install-confirm">
          <div className="install-confirm-text">
            <div>
              卸载「<b>{uninstallConfirm.label}</b>」将删除该引擎的模型文件与运行环境
              {uninstallConfirm.estBytes ? (
                <>
                  ，预计释放约 <b>{fmtBytes(uninstallConfirm.estBytes)}</b>；重新安装需重新下载。
                </>
              ) : (
                <>（约 {uninstallConfirm.sizeHint}）。</>
              )}
            </div>
            {uninstallConfirm.stopWarn && (
              <div className="uninstall-warn">
                ⚠️ 该引擎服务正在运行，卸载将先停止本地服务、删除完成后自动重启，其它引擎恢复可用（仅该引擎需重新下载）。
              </div>
            )}
            <div className="missing-item hint">仅删除该引擎数据，不影响其它引擎、共享运行环境与音色库。</div>
          </div>
          <div className="install-confirm-actions">
            <Button onClick={confirmUninstall} disabled={!!installing || uninstalling}>
              <Icon icon="lucide:trash-2" width={14} height={14} /> 确认卸载
            </Button>
            <Button variant="ghost" onClick={() => setUninstallConfirm(null)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {progress.length > 0 && (
        <div className="install-log" ref={logRef}>
          <div className="install-head">
            安装进度{installing ? ` · ${installing}` : uninstalling ? " · 卸载" : ""}
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
