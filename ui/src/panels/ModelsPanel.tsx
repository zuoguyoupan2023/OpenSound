import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { cancelInstall, getDisk, getDiskLocal, getDeviceProfile, installModel, getPersistedSettings, uninstallModel, uninstallPreview, isServiceLaunchPending, restartService } from "../api";
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
// 000-plan：torch 系引擎（Python venv + torch）支持 CPU/GPU 版"安装即选择"
const TORCH_ENGINES = new Set(["qwen3", "cosyvoice-clone", "sensevoice-original"]);
// 2026-09-05：装完自动重启的「真做了事」判据——安装器纯空跑（一切已就绪秒过）不自动重启打扰；
// 出现过真实工作信号（建 venv / 装依赖 / 换 torch / 下载 / 补依赖 / 停引擎）才在成功后自动重启服务启用。
const INSTALL_DID_WORK =
  /(缺引擎环境|venv 创建|安装依赖|换装|wheel|下载|拉取|模型缺失|补齐|本地安装|重装|已停止端口|自动停止)/;

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
  }, []);
  // 2026-09-05 修复（用户实测：4070 Ti 机器上 qwen3 卡片只剩「装 CPU 版」）：
  // 设备画像只在挂载时拉一次、失败即静默置 null 从不重试——安装/重装环境时 9528 正在重启，
  // 撞上窗口期 → device=null → GPU 双按钮/顶部摘要/可安装徽标全部降级成"无显卡"视图，后端其实是 cuda+12GB。
  // 改为：成功一次即停；失败（服务重启中/503）则每 6s 自动重试，面板存活期间不放弃。
  const deviceLoadedRef = useRef(false);
  useEffect(() => {
    if (deviceLoadedRef.current) return;
    let alive = true;
    const tryLoad = () => {
      if (deviceLoadedRef.current) return;
      getDeviceProfile()
        .then((d) => {
          if (!alive) return;
          deviceLoadedRef.current = true;
          setDevice(d);
        })
        .catch(() => {
          if (!alive) return;
          // 服务可能在重启/刚启动探测未完成——保持 device=null（UI 按"未知"处理，不误报无显卡），下轮再试
          setDevice(null);
        });
    };
    tryLoad();
    const iv = setInterval(tryLoad, 6000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [progress.length]);

  const install = async (m: ModelInfo, confirmBigDownload = false, torchOverride?: "cuda" | "cpu") => {
    if (installing) return;
    setInstalling(m.engine);
    setProgress([]);
    setPct(null);
    // 本趟安装产生的 log 行快照（用于判断安装器是否"真做了事"，状态更新是异步的不能读 progress state）
    const lines: InstallProgress[] = [];
    const onProgress = (p: InstallProgress) => {
      if (p.type === "progress") {
        setPct({ received: p.received || 0, total: p.total || 0 });
      } else if (p.type === "log" && /已存在，跳过/.test(p.message || "")) {
        /* 静默跳过行不进日志 */
      } else {
        lines.push(p);
        setProgress((prev) => [...prev, p]);
      }
    };
    try {
      await installModel(m.engine, onProgress, { mirror: mirrorPick[m.engine], confirmBigDownload, torch: torchOverride || "auto" });
      await props.refresh();
      // 2026-09-05 修复（用户实测：装完 sensevoice-原始 卡片无限「启动中」，等 10 分钟不动，
      // 手动全停再开才好）：8001/8002/8003 进程型引擎只有 start-all 冷启动才会被拉起；安装/换装
      //（尤其 torch 换 CUDA 会停掉全部引擎）完成后必须重启一次服务，新引擎才真正启动。
      // 仅当安装器"真做了事"才自动重启（纯空跑不打扰）；节能下未被本类启用的引擎不拉起（start-all 按 eco 选择跳过）。
      const didWork = lines.some((l) => l.type === "log" && INSTALL_DID_WORK.test(l.message || ""));
      if (didWork && TORCH_ENGINES.has(m.engine) && ecoOnFor(m)) {
        setProgress((prev) => [
          ...prev,
          {
            type: "log",
            message: `「${m.label}」已就绪——自动重启服务以启用该引擎（其余进程型引擎一并拉起，冷启动需等待）…`,
          },
        ]);
        await restartService();
        setProgress((prev) => [
          ...prev,
          {
            type: "log",
            message: "已请求重启服务，等待引擎就绪…（本卡片此时显示「启动中」即真实加载中，约 1 分钟内转「运行中」）",
          },
        ]);
        props.refresh();
        setTimeout(() => props.refresh(), 8000);
        setTimeout(() => props.refresh(), 24000);
      }
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

  // 000-plan-3：该引擎是否属于"当前应启动"（全能恒真；节能 = 本类启用引擎 或 非 TTS/ASR 类）
  const ecoOnFor = (m: ModelInfo): boolean => {
    const pm = getPersistedSettings();
    if (pm.powerMode !== "eco") return true;
    if (m.category !== "tts" && m.category !== "asr") return true;
    return m.category === "tts" ? pm.ecoTts === m.engine : pm.ecoAsr === m.engine;
  };

  // 2026-09-05：「重启服务」按钮（安装/换装后或引擎掉线时拉起服务；全局启动，冷启动需等待）
  const restartServiceNow = async (m: ModelInfo) => {
    if (installing) return;
    setProgress([]);
    setProgress((prev) => [
      ...prev,
      {
        type: "log",
        message: `「${m.label}」请求重启本地服务（将重新拉起全部进程型引擎，冷启动需等待）…`,
      },
    ]);
    try {
      await restartService();
      setProgress((prev) => [
        ...prev,
        { type: "log", message: "已请求重启服务，等待引擎就绪…（本卡片「启动中」即真实加载中，约 1 分钟内转「运行中」）" },
      ]);
    } catch (e) {
      setProgress((prev) => [...prev, { type: "error", message: `重启服务失败：${e}（也可点侧边栏「启动」重试）` }]);
    }
    props.refresh();
    setTimeout(() => props.refresh(), 8000);
    setTimeout(() => props.refresh(), 24000);
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
          const ecoOn = ecoOnFor(m);
          const readyNoRun = stateOf(m) === "ready";
          const running = stateOf(m) === "running";
          // 进程型大引擎才有"应启动"的真实状态可标（Python 8001/8002/8003，可被 skip/换装停掉）；
          // 9528 内轻量（kokoro/量化 sensevoice/whisper/LLM）常驻无进程可关 → 卡片显示真实运行状态，
          // 节能停用只在前端（面板下拉 + 顶部资源表）表达。
          const isProcessEngine = TORCH_ENGINES.has(m.engine);
          // 表里如一：显示真实状态；模式期望（节能未选）与真实状态不符时明确提示，不隐瞒
          const ecoNotSelected =
            getPersistedSettings().powerMode === "eco" && isProcessEngine && !ecoOn && (readyNoRun || running); // 节能未启用的大模型
          const ecoMismatch = ecoNotSelected && running; // 期望关闭但实际仍在运行（模式已改未重启）
          const ecoIdle = ecoNotSelected && readyNoRun; // 期望关闭且实际确实没在跑
          // 2026-09-05 修复（装完 sensevoice-原始 卡片无限「启动中」的根因）：
          // 「启动中…」只有在最近确实请求过一次服务启动（启动意图宽限期内）时才是真的——
          // 文件就绪但没人启动（安装/换装后未重启、或上次启动失败）→ 如实显示「就绪 · 未运行」+「重启服务」按钮，
          // 不再拿"就绪但没在听"假装"正在启动"让用户无限等待。
          const launchPending = isServiceLaunchPending();
          const launching = ecoOn && readyNoRun && isProcessEngine && launchPending;
          const needsRestart = ecoOn && readyNoRun && isProcessEngine && !launchPending;
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
                  ) : needsRestart ? (
                    <>
                      <Icon icon={st.icon} width={13} height={13} /> {st.label}
                      <span className="state-hint">
                        进程引擎未在运行（安装/换装后需重启服务，或上次启动失败）——点右侧「重启服务」拉起，冷启动约 1 分钟
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
                {/* 「升级 GPU 加速」按钮：发布策略继续隐藏（2026-09-05 用户拍板）——
                    方向改为「安装时按本机有无 CUDA 二选一（GPU版/CPU版），换卡 = 卸载/重装」，不做"升级"专用链路；
                    后端 gpuUpgrade 标志 / uvVenvInstaller torchCpuHere 分支暂保留未删（后续改造为首次安装直选时接管）。
                */}
                {/* 000-plan：torch 系引擎「安装即选择」——本机有 N 卡时显示「GPU 版 / CPU 版」双按钮：
                    当前已装版本 = 高亮置灰（已是该版，不可再点）；另一版本可点 = 点击即换装
                    （后端只重建 venv 的 torch，模型文件不重下；换装后需重启服务）。
                    未安装时两按钮都可点 = 直接按所选版本安装。无 N 卡 → 只显示 CPU 版（禁用态，走通用按钮）。 */}
                {TORCH_ENGINES.has(m.engine) && !busyHere && (
                  <div className="torch-ver-row">
                    {/* 2026-09-05 修复：探测结果"未知"（device=null，服务刚启动/重启窗口期）时不再假装无显卡——
                        双按钮照常显示（后端 uvVenvInstaller 有守卫：选了 GPU 版但无 N 卡会自动改装 CPU 并提示），
                        并给一行透明说明；已知纯 CPU 机（device 有值且 vram 为空）才只给 CPU 版。 */}
                    {!device || device?.gpu?.vramGB ? (
                      <>
                        <button
                          className={`torch-ver ${m.accelTag?.kind === "cuda" ? "cur" : "alt"}`}
                          disabled={busyHere || !!installing || m.accelTag?.kind === "cuda"}
                          title={
                            m.accelTag?.kind === "cuda"
                              ? "当前已安装 GPU（CUDA）版"
                              : "换装/安装 GPU（CUDA）版：只重建 venv 的 torch，模型不重下；无缓存时约 2.5GB"
                          }
                          onClick={() => install(m, false, "cuda")}
                        >
                          <Icon icon="lucide:gpu" width={13} height={13} />
                          {m.accelTag?.kind === "cuda" ? "GPU 版 · 已装" : m.installed ? "换 GPU 版" : "装 GPU 版"}
                        </button>
                        <button
                          className={`torch-ver ${m.accelTag?.kind === "cpu" ? "cur" : "alt"}`}
                          disabled={busyHere || !!installing || m.accelTag?.kind === "cpu"}
                          title={
                            m.accelTag?.kind === "cpu"
                              ? "当前已安装 CPU 版"
                              : "换装/安装 CPU 版：只重建 venv 的 torch，模型不重下"
                          }
                          onClick={() => install(m, false, "cpu")}
                        >
                          <Icon icon="lucide:cpu" width={13} height={13} />
                          {m.accelTag?.kind === "cpu" ? "CPU 版 · 已装" : m.installed ? "换 CPU 版" : "装 CPU 版"}
                        </button>
                      </>
                    ) : (
                      <button
                        className={`torch-ver ${m.accelTag?.kind === "cpu" ? "cur" : "alt"}`}
                        disabled={busyHere || !!installing || m.accelTag?.kind === "cpu"}
                        title={
                          m.accelTag?.kind === "cpu"
                            ? "当前已安装 CPU 版（本机无 NVIDIA 显卡，只有 CPU 版）"
                            : "安装 CPU 版（本机未检测到 NVIDIA 显卡）"
                        }
                        onClick={() => install(m, false, "cpu")}
                      >
                        <Icon icon="lucide:cpu" width={13} height={13} />
                        {m.accelTag?.kind === "cpu" ? "CPU 版 · 已装" : "装 CPU 版"}
                      </button>
                    )}
                    {!device && (
                      <span className="state-hint">
                        显卡探测暂不可用（服务刚启动/重启？）——按钮先按有 N 卡显示；若本机确实无 NVIDIA 显卡，选 GPU 版会被后端自动改装 CPU 版。
                      </span>
                    )}
                  </div>
                )}

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
                    {needsRestart ? (
                      <Button onClick={() => restartServiceNow(m)} disabled={!!installing || uninstalling}>
                        <Icon icon="lucide:power" width={14} height={14} /> 重启服务
                      </Button>
                    ) : (
                      <span className={`badge ${st.cls}`}>
                        <Icon icon={st.icon} width={13} height={13} /> {st.label}
                      </span>
                    )}
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
                    {/* 2026-09-05 修复：仅"正在装的这张卡"显示转圈/取消；
                        其它卡片在安装期间只置灰（不再每个按钮都转圈，误导成都在下载） */}
                    <Button
                      onClick={() => install(m)}
                      disabled={!!installing}
                      title={installing && !busyHere ? "已有模型正在安装，其它卡片暂时置灰；完成后即可点" : undefined}
                    >
                      {busyHere ? (
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

      {/* 033/2026-09-05：大流量下载二次确认——改为浮层弹窗。
          原实现在面板最底部渲染确认行：下载区在上方时看不到确认按钮、极易漏点/误以为没反应；
          现在固定居中浮层 + 半透明遮罩，任何滚动位置都可见。卸载确认（下方同款）一并浮层化。 */}
      {bigConfirm && (
        <div className="confirm-overlay" onClick={() => {
          setBigConfirm(null);
          setProgress((prev) => [
            ...prev,
            { type: "log", message: "已取消大流量安装；可稍后重试或按模型文档手动处理。" },
          ]);
        }}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">
              <Icon icon="lucide:database-download" width={16} height={16} /> 确认下载模型
            </div>
            <div className="confirm-text">
              「<b>{bigConfirm.label}</b>」需下载约 <b>{bigConfirm.gb}</b>
              （视网速可能耗时较长），确认开始？
            </div>
            <div className="confirm-actions">
              <Button variant="ghost" onClick={() => {
                setBigConfirm(null);
                setProgress((prev) => [
                  ...prev,
                  { type: "log", message: "已取消大流量安装；可稍后重试或按模型文档手动处理。" },
                ]);
              }}>
                取消
              </Button>
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
            </div>
          </div>
        </div>
      )}

      {/* 阶段1：单引擎卸载确认（浮层弹窗，与下载确认同款） */}
      {uninstallConfirm && (
        <div className="confirm-overlay" onClick={() => setUninstallConfirm(null)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">
              <Icon icon="lucide:trash-2" width={16} height={16} /> 确认卸载
            </div>
            <div className="confirm-text">
              卸载「<b>{uninstallConfirm.label}</b>」将删除该引擎的模型文件与运行环境
              {uninstallConfirm.estBytes ? (
                <>
                  ，预计释放约 <b>{fmtBytes(uninstallConfirm.estBytes)}</b>；重新安装需重新下载。
                </>
              ) : (
                <>（约 {uninstallConfirm.sizeHint}）。</>
              )}
              {uninstallConfirm.stopWarn && (
                <div className="confirm-warn">
                  ⚠️ 该引擎服务正在运行，卸载将先停止本地服务、删除完成后自动重启，其它引擎恢复可用（仅该引擎需重新下载）。
                </div>
              )}
              <div className="confirm-hint">仅删除该引擎数据，不影响其它引擎、共享运行环境与音色库。</div>
            </div>
            <div className="confirm-actions">
              <Button variant="ghost" onClick={() => setUninstallConfirm(null)}>
                取消
              </Button>
              <Button variant="danger" onClick={confirmUninstall} disabled={!!installing || uninstalling}>
                <Icon icon="lucide:trash-2" width={14} height={14} /> 确认卸载
              </Button>
            </div>
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
