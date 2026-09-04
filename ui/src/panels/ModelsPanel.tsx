import { useEffect, useRef, useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { cancelInstall, getDisk, getDiskLocal, getDeviceProfile, installModel, getPersistedSettings, uninstallModel, uninstallPreview, isServiceLaunchPending, restartService } from "../api";
import type { DeviceProfile, InstallProgress, ModelInfo } from "../types";
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

// 下载源显示名（与 engines/*.json install.mirrors 同名）
const MIRROR_LABEL: Record<string, string> = {
  huggingface: "huggingface（官方）",
  "hf-mirror": "hf-mirror（镜像）",
  modelscope: "modelscope（官方）",
};

// ---------- 设备画像 ----------
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
// 入门档默认推荐的轻量组合
const STARTER_ENGINES = ["sensevoice", "kokoro", "llm-0.5b"];
// torch 系引擎（Python venv + torch）有独立进程，安装可选 CPU/GPU 版
const TORCH_ENGINES = new Set(["qwen3", "cosyvoice-clone", "sensevoice-original"]);
// 装完自动重启的「真做了事」判据：纯空跑（一切已就绪秒过）不自动重启打扰
const INSTALL_DID_WORK =
  /(缺引擎环境|venv 创建|安装依赖|换装|wheel|下载|拉取|模型缺失|补齐|本地安装|重装|已停止端口|自动停止)/;

// 状态 → 简洁标签（2026-09-05：缺文件/缺环境等直接给标签，不再铺长列表）
const STATE_META: Record<string, { label: string; cls: string; icon: string }> = {
  running: { label: "运行中", cls: "ok", icon: "lucide:circle-check" },
  ready: { label: "就绪 · 未运行", cls: "info", icon: "lucide:circle-dot" },
  "partial-files": { label: "文件缺失", cls: "warn", icon: "lucide:file-warning" },
  "missing-runtime": { label: "环境缺失", cls: "warn", icon: "lucide:package-x" },
  incomplete: { label: "环境 + 文件缺失", cls: "fail", icon: "lucide:triangle-alert" },
  unknown: { label: "服务未启动", cls: "warn", icon: "lucide:circle-dot" },
};

type ViewTab = "model" | "detail";

export default function ModelsPanel(props: PanelProps) {
  // ===== 状态 =====
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress[]>([]);
  const [pct, setPct] = useState<{ received: number; total: number } | null>(null);
  const [bigConfirm, setBigConfirm] = useState<{ engine: string; label: string; gb: string } | null>(null);
  const [uninstallConfirm, setUninstallConfirm] = useState<{
    engine: string;
    label: string;
    estBytes: number | null;
    sizeHint: string;
    stopWarn: boolean;
  } | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallingEngine, setUninstallingEngine] = useState<string | null>(null);
  const [mirrorPick, setMirrorPick] = useState<Record<string, string>>({});
  const [diskAvail, setDiskAvail] = useState<number | null>(null);
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  // 缺失明细展开状态（点状态标签展开/收起具体缺哪些文件/环境）
  const [openMiss, setOpenMiss] = useState<Record<string, boolean>>({});
  const logRef = useRef<HTMLDivElement | null>(null);
  // 2026-09-05：双页签「模型 = 功能性（下载/卸载/进度）/ 详情 = 展示性（资源表/信息）」
  const [view, setView] = useState<ViewTab>("model");

  // ===== 副作用：磁盘剩余 + 设备画像自愈重试 =====
  useEffect(() => {
    getDiskLocal()
      .then((b) => setDiskAvail(b))
      .catch(() => {
        getDisk()
          .then((d) => setDiskAvail(d.availBytes))
          .catch(() => {});
      });
  }, []);
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

  // ===== 安装（含装完自动重启） =====
  const install = async (m: ModelInfo, confirmBigDownload = false, torchOverride?: "cuda" | "cpu") => {
    if (installing) return;
    setInstalling(m.engine);
    setProgress([]);
    setPct(null);
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
      // 进程型引擎（8001/8002/8003）安装/换装（会停掉全部引擎）后必须重启一次服务才会被拉起；
      // 仅当安装器"真做了事"才自动重启（纯空跑不打扰）；节能下未被本类启用的引擎不拉起（start-all 按 eco 跳过）。
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
            message: "已请求重启服务，等待引擎就绪…（该引擎显示「启动中」即真实加载中，约 1 分钟内转「运行中」）",
          },
        ]);
        props.refresh();
        setTimeout(() => props.refresh(), 8000);
        setTimeout(() => props.refresh(), 24000);
      }
    } catch (e) {
      const msg = String(e);
      const mConfirm = /BIG_DOWNLOAD_CONFIRM:([\d.]+GB)/.exec(msg);
      if (mConfirm && !confirmBigDownload) {
        setProgress((prev) => [
          ...prev,
          { type: "log", message: `「${m.label}」需二次确认下载（约 ${mConfirm[1]}）…` },
        ]);
        setBigConfirm({ engine: m.engine, label: m.label, gb: mConfirm[1] });
      } else if (/已有安装任务进行中/.test(msg)) {
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

  // ===== 单引擎卸载 =====
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
    setUninstallingEngine(engine);
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
      setUninstallingEngine(null);
    }
  };

  // ===== 派生/工具 =====
  const stateOf = (m: ModelInfo) => m.state || (m.installed ? "running" : "partial-files");
  const needFix = (m: ModelInfo) => {
    const s = stateOf(m);
    return s === "partial-files" || s === "missing-runtime" || s === "incomplete";
  };
  // 该引擎是否属于"当前应启动"（全能恒真；节能 = 本类启用引擎 或 非 TTS/ASR 类）
  const ecoOnFor = (m: ModelInfo): boolean => {
    const pm = getPersistedSettings();
    if (pm.powerMode !== "eco") return true;
    if (m.category !== "tts" && m.category !== "asr") return true;
    return m.category === "tts" ? pm.ecoTts === m.engine : pm.ecoAsr === m.engine;
  };

  const restartServiceNow = async (m: ModelInfo) => {
    if (installing) return;
    setProgress([]);
    setProgress((prev) => [
      ...prev,
      { type: "log", message: `「${m.label}」请求重启本地服务（重新拉起全部进程型引擎，冷启动需等待）…` },
    ]);
    try {
      await restartService();
      setProgress((prev) => [
        ...prev,
        { type: "log", message: "已请求重启服务，等待引擎就绪…（该引擎「启动中」即真实加载中）" },
      ]);
    } catch (e) {
      setProgress((prev) => [...prev, { type: "error", message: `重启服务失败：${e}（也可点侧边栏「启动」重试）` }]);
    }
    props.refresh();
    setTimeout(() => props.refresh(), 8000);
    setTimeout(() => props.refresh(), 24000);
  };

  // 「下载/模型」页签角标：需要安装/修复的引擎数
  const needFixCount = props.models.filter((m) => needFix(m)).length;
  const starterMissing =
    device?.tier === "entry" ? props.models.filter((m) => STARTER_ENGINES.includes(m.engine) && needFix(m)) : [];
  const installStarter = async () => {
    for (const m of starterMissing) {
      await install(m);
    }
  };

  // ===== 渲染小件 =====
  // torch 引擎：本机有 N 卡（或探测未知）显示 GPU/CPU 双按钮；确知纯 CPU 只给 CPU 版
  const renderTorch = (m: ModelInfo, busy: boolean) => {
    if (!TORCH_ENGINES.has(m.engine) || busy || stateOf(m) === "unknown") return null;
    const cpuDisabled = busyHere(m) || !!installing || m.accelTag?.kind === "cpu";
    const cudaDisabled = busyHere(m) || !!installing || m.accelTag?.kind === "cuda";
    const gpuTitle =
      m.accelTag?.kind === "cuda"
        ? "当前已安装 GPU（CUDA）版"
        : "安装/换装 GPU（CUDA）版：只重建 venv 的 torch，模型不重下；无缓存时约 2.5GB；本机无 N 卡会自动改装 CPU";
    const cpuTitle =
      m.accelTag?.kind === "cpu"
        ? "当前已安装 CPU 版"
        : "安装/换装 CPU 版：只重建 venv 的 torch，模型不重下";
    return (
      <div className="torch-ver-row">
        {!device || device?.gpu?.vramGB ? (
          <>
            <button className={`torch-ver ${m.accelTag?.kind === "cuda" ? "cur" : "alt"}`} disabled={cudaDisabled} title={gpuTitle} onClick={() => install(m, false, "cuda")}>
              <Icon icon="lucide:gpu" width={12} height={12} />
              {m.accelTag?.kind === "cuda" ? "GPU 版 · 已装" : m.installed ? "换 GPU 版" : "装 GPU 版"}
            </button>
            <button className={`torch-ver ${m.accelTag?.kind === "cpu" ? "cur" : "alt"}`} disabled={cpuDisabled} title={cpuTitle} onClick={() => install(m, false, "cpu")}>
              <Icon icon="lucide:cpu" width={12} height={12} />
              {m.accelTag?.kind === "cpu" ? "CPU 版 · 已装" : m.installed ? "换 CPU 版" : "装 CPU 版"}
            </button>
          </>
        ) : (
          <button className="torch-ver cur" disabled title="本机未检测到 NVIDIA 显卡，仅 CPU 版">
            <Icon icon="lucide:cpu" width={12} height={12} /> CPU 版（本机）
          </button>
        )}
      </div>
    );
  };
  const busyHere = (m: ModelInfo) => installing === m.engine;

  const mirrorSel = (m: ModelInfo) =>
    needFix(m) && (m.install?.mirrors?.length || 0) > 1 ? (
      <select
        className="mirror-sel"
        value={mirrorPick[m.engine] || ""}
        onChange={(e) => setMirrorPick((prev) => ({ ...prev, [m.engine]: e.target.value }))}
        title="下载源：默认「自动」（官方优先，失败/无进展 30s/低速 60s 自动切换镜像）；可手动指定某一源"
      >
        <option value="">自动（官方优先 · 自动切换）</option>
        {m.install!.mirrors.map((x) => (
          <option key={x} value={x}>
            {MIRROR_LABEL[x] || x}
          </option>
        ))}
      </select>
    ) : null;

  const hasMissing = (m: ModelInfo) =>
    (m.missingFiles?.length || 0) > 0 || (m.missingRuntime?.length || 0) > 0;

  // 状态标签：有缺失时可点击展开/收起具体明细
  const statePill = (m: ModelInfo) => {
    const s = stateOf(m);
    const meta = STATE_META[s] || STATE_META.ready;
    const miss = hasMissing(m);
    const open = !!openMiss[m.engine];
    const icon = <Icon icon={meta.icon} width={11} height={11} />;
    if (miss) {
      return (
        <button
          type="button"
          className={`badge ${meta.cls} st-pill${open ? " open" : ""}`}
          title={open ? "收起缺失明细" : `展开缺失明细（${meta.label}）`}
          onClick={() => setOpenMiss((prev) => ({ ...prev, [m.engine]: !prev[m.engine] }))}
        >
          {icon} {meta.label}
          <span className="st-caret">
            <Icon icon="lucide:chevron-down" width={12} height={12} />
          </span>
        </button>
      );
    }
    return (
      <span className={`badge ${meta.cls}`}>
        {icon} {meta.label}
      </span>
    );
  };

  // 缺失明细（点击状态标签展开后显示）：文件缺失 + 环境缺失具体条目
  const renderMissingDetail = (m: ModelInfo) => {
    const files = m.missingFiles || [];
    const rt = m.missingRuntime || [];
    if (!files.length && !rt.length) return null;
    return (
      <div className="missing-list">
        {files.map((f) => (
          <div key={f.path} className="missing-item">
            <Icon icon="lucide:x" width={12} height={12} />
            <code>{f.path.replace(/^models\//, "")}</code>
            <em>
              {f.type}
              {f.expectBytes ? ` · ${fmtBytes(f.expectBytes)}` : ""}
              {f.actualBytes != null && f.expectBytes ? `（实际 ${fmtBytes(f.actualBytes)}）` : ""}
            </em>
          </div>
        ))}
        {rt.map((r) => (
          <div key={r.label} className="missing-item">
            <Icon icon="lucide:wrench" width={12} height={12} />
            <span>{r.label}</span>
          </div>
        ))}
        {rt.length > 0 && (
          <div className="missing-item hint">环境项由安装器/引导自动创建或克隆兜底</div>
        )}
      </div>
    );
  };

  const accelBadge = (m: ModelInfo) => {
    if (!m.accelTag) return null;
    return (
      <span className={`badge accel-${m.accelTag.kind}`}>
        <Icon icon={m.accelTag.kind === "cuda" ? "lucide:gpu" : "lucide:cpu"} width={11} height={11} />{" "}
        {m.accelTag.label}
      </span>
    );
  };

  // ================= 渲染 =================
  return (
    <Panel
      title="模型管理"
      subtitle="「模型」页签 = 下载/修复/卸载等操作；「详情」页签 = 资源表与信息"
      actions={
        <Button variant="ghost" onClick={props.refresh}>
          <Icon icon="lucide:refresh-cw" width={16} height={16} /> 刷新
        </Button>
      }
    >
      {/* 双页签：模型（功能）｜详情（展示） */}
      <div className="mp-seg">
        <button className={`mp-seg-btn ${view === "model" ? "on" : ""}`} onClick={() => setView("model")}>
          <Icon icon="lucide:download" width={14} height={14} /> 模型
          {needFixCount > 0 && <span className="mp-seg-count">{needFixCount}</span>}
          <span className="mp-seg-sub">下载 / 修复 / 卸载</span>
        </button>
        <button className={`mp-seg-btn ${view === "detail" ? "on" : ""}`} onClick={() => setView("detail")}>
          <Icon icon="lucide:info" width={14} height={14} /> 详情
          <span className="mp-seg-sub">资源表 / 状态 / 许可</span>
        </button>
      </div>

      {/* ================= 「模型」页签：功能性 ================= */}
      {view === "model" && (
        <>
          {starterMissing.length > 0 && (
            <div className="entry-starter">
              <Icon icon="lucide:sparkles" width={15} height={15} />
              <span>
                检测到<b>入门档</b>设备，推荐先装齐轻量组合（
                {starterMissing.map((m) => m.label.split("（")[0]).join(" + ")}）：
              </span>
              <Button onClick={installStarter} disabled={!!installing}>
                {installing ? <Spinner /> : (
                  <>
                    <Icon icon="lucide:download" width={14} height={14} /> 一键装齐
                  </>
                )}
              </Button>
            </div>
          )}

          <div className="models-list">
            {props.models.map((m) => {
              const busy = installing === m.engine;
              const st = stateOf(m);
              const need = needFix(m);
              const proc = TORCH_ENGINES.has(m.engine);
              const ecoOn = ecoOnFor(m);
              const launchPending = isServiceLaunchPending();
              const launching = ecoOn && st === "ready" && proc && launchPending;
              const needsRestart = ecoOn && st === "ready" && proc && !launchPending;
              return (
                <div key={m.engine} className={`model-row ${busy ? "busy" : ""}`}>
                  <div className="model-info">
                    <div className="model-name">{m.label}</div>
                    <div className="model-meta">
                      <span className="model-cat">{catLabel[m.category] || m.category}</span>
                      <span className="model-engine">{m.engine}</span>
                      <span className="model-size">{m.size}</span>
                      {accelBadge(m)}
                      {launching && (
                        <span className="badge info">
                          <Icon icon="lucide:loader-2" width={11} height={11} /> 启动中…（加载）
                        </span>
                      )}
                    </div>
                    {/* 状态标签放在左侧模型信息下方（有缺失时可点击展开明细） */}
                    <div className="pill-line">{statePill(m)}</div>
                    {openMiss[m.engine] && renderMissingDetail(m)}
                    {busy && pct && pct.total > 0 && (
                      <div className="dl-wrap">
                        <div className="dl-bar">
                          <div className="dl-fill" style={{ width: `${Math.min(100, (pct.received / pct.total) * 100)}%` }} />
                        </div>
                        <span className="dl-txt">
                          {fmtBytes(pct.received)} / {fmtBytes(pct.total)}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="model-action">
                    {needsRestart && (
                      <Button onClick={() => restartServiceNow(m)} disabled={!!installing || uninstalling}>
                        <Icon icon="lucide:power" width={13} height={13} /> 重启服务
                      </Button>
                    )}
                    {renderTorch(m, busy)}
                    <div className="model-action-row">
                      {st === "unknown" ? (
                        <Button disabled title="请先启动本地服务（侧边栏「启动」）">
                          <Icon icon="lucide:power" width={14} height={14} /> 启动服务后安装
                        </Button>
                      ) : need ? (
                        busy ? (
                          <Button variant="ghost" onClick={cancel}>取消</Button>
                        ) : (
                          <Button
                            onClick={() => install(m)}
                            disabled={!!installing || uninstalling}
                            title={installing ? "已有模型正在安装，稍候" : undefined}
                          >
                            <Icon icon="lucide:download" width={14} height={14} />
                            {st === "missing-runtime" || (m.missingRuntime && m.missingRuntime.length > 0)
                              ? "检测/修复"
                              : `补齐${m.totalMissingBytes ? ` · ${fmtBytes(m.totalMissingBytes)}` : ""}`}
                          </Button>
                        )
                      ) : uninstalling && uninstallingEngine === m.engine ? (
                        <Button disabled>
                          <Spinner /> 卸载中…
                        </Button>
                      ) : null}
                      {!installing && !uninstalling && (
                        <Button
                          variant="ghost"
                          className="uninstall-btn"
                          onClick={() => startUninstall(m)}
                          title="卸载：删除该引擎的模型文件与运行环境"
                        >
                          <Icon icon="lucide:trash-2" width={14} height={14} /> 卸载
                        </Button>
                      )}
                    </div>
                    {mirrorSel(m)}
                    {need && !device && (
                      <span className="state-hint">
                        显卡探测暂不可用（服务刚启动？）——GPU 版按有 N 卡显示；无 N 卡时后端自动改装 CPU。
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {props.models.length === 0 && (
              <div className="empty">暂无模型数据（请确认服务已启动）</div>
            )}
          </div>

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
                安装进度{installing ? ` · ${installing}` : uninstalling ? " · 卸载" : ""}
              </div>
              {progress.map((p, i) => (
                <div key={i} className={`install-line ${p.type === "error" ? "err" : p.type === "done" ? "ok" : ""}`}>
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
        </>
      )}

      {/* ================= 「详情」页签：纯展示（资源表为核心，不与「模型」页签重复列引擎） ================= */}
      {view === "detail" && (
        <>
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

          {/* 核心：按类别资源表（含节能每类启用选择；主文件/磁盘/内存/状态一览） */}
          <EcoResourceTables models={props.models} refresh={props.refresh} />
        </>
      )}

      {/* 浮层确认：大流量下载二次确认 */}
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
                  await install(m, true);
                }}
                disabled={!!installing}
              >
                <Icon icon="lucide:download" width={14} height={14} /> 确认下载 {bigConfirm.gb}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 浮层确认：单引擎卸载 */}
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
    </Panel>
  );
}
