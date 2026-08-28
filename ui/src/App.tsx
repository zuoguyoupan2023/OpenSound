import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import "./icons";
import type { ServiceStatus, PanelId, HealthInfo, ModelInfo } from "./types";
import {
  getHealth,
  getModels,
  getModelsCatalog,
  checkRuntime,
  installRuntime,
  installPythonBase,
  listenRuntimeProgress,
  type RuntimeStatus,
  type RuntimeProgress,
} from "./api";
import HomePanel from "./panels/HomePanel";
import ReadPanel from "./panels/ReadPanel";
import AsrPanel from "./panels/AsrPanel";
import ChatPanel from "./panels/ChatPanel";
import ModelsPanel from "./panels/ModelsPanel";
import AudioLibraryPanel from "./panels/AudioLibraryPanel";
import VoicePanel from "./panels/VoicePanel";
import SettingsPanel from "./panels/SettingsPanel";
import RealtimePanel from "./panels/RealtimePanel";
import "./App.css";

const DEFAULT_STATUS: ServiceStatus = {
  asr_up: false,
  qwen3_up: false,
  asr_url: "http://127.0.0.1:9528",
  qwen3_url: "http://127.0.0.1:8001",
  child_alive: false,
  node_path: "",
};

interface NavItem {
  id: PanelId;
  label: string;
  icon: string;
}

const NAV: NavItem[] = [
  { id: "home", label: "语音工作台", icon: "lucide:mic" },
  { id: "read", label: "朗读", icon: "lucide:volume-2" },
  { id: "asr", label: "识别", icon: "lucide:headphones" },
  { id: "realtime", label: "实时语音", icon: "lucide:zap" },
  { id: "chat", label: "对话", icon: "lucide:message-circle" },
  { id: "models", label: "模型管理", icon: "lucide:brain" },
  { id: "audio", label: "音频库", icon: "lucide:music" },
  { id: "voices", label: "音色管理", icon: "lucide:palette" },
  { id: "settings", label: "设置", icon: "lucide:settings" },
];

export interface PanelProps {
  health: HealthInfo | null;
  models: ModelInfo[];
  refresh: () => Promise<void>;
  status: ServiceStatus;
  /** 032：运行时自检状态（node/依赖），设置页「环境与运行时」区块使用 */
  runtime: RuntimeStatus | null;
  runtimeInstalling: boolean;
  runtimeLogs: RuntimeProgress[];
  onInstallRuntime: () => void;
  /** 034 阶段3：受管 Python 基础（uv + CPython）独立按钮——py 一个按键，与 node 分开 */
  pyInstalling: boolean;
  onInstallPythonBase: () => void;
  /** 面板间跳转（如朗读面板「在音频库中查看」） */
  goPanel?: (id: PanelId) => void;
  /** 跳到设置页并滚动定位到指定区块（030：资源模式区 "power-mode"） */
  goSettings?: (anchor?: string) => void;
  settingsAnchor?: string | null;
  clearSettingsAnchor?: () => void;
}

function App() {
  const [status, setStatus] = useState<ServiceStatus>(DEFAULT_STATUS);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [panel, setPanel] = useState<PanelId>("home");
  // 030：跳到设置页时携带的定位锚点（如 "power-mode" 资源模式区）
  const [settingsAnchor, setSettingsAnchor] = useState<string | null>(null);
  // 032：运行时自检（node / 服务依赖）+ 一键自举进度
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeProgress[]>([]);
  const [runtimeInstalling, setRuntimeInstalling] = useState(false);
  // 034 阶段3：受管 Python 基础（uv + CPython）独立安装状态——与 node 各自一个按钮、互不干扰
  const [pyInstalling, setPyInstalling] = useState(false);

  const refreshHealth = async () => {
    let dyn: ModelInfo[] = [];
    try {
      const [h, m] = await Promise.all([getHealth(), getModels()]);
      setHealth(h);
      dyn = m;
    } catch (e) {
      // P1：服务离线不阻塞模型清单——模型列表改用本地静态目录（engines/*.json）
      console.error("refresh health 失败（服务离线，使用本地清单）:", e);
      setHealth(null);
    }
    // P1：本地清单打底 + 服务在线时的动态状态合并；离线时模型仍完整显示，状态标"服务未启动"
    try {
      const cat = await getModelsCatalog();
      const merged: ModelInfo[] = cat.map((c) => {
        const d = dyn.find((x) => x.engine === c.engine);
        if (d) {
          return {
            ...d,
            category: c.category,
            label: c.label,
            size: c.size,
            license: c.license,
            install: d.install ?? c.install,
          };
        }
        return {
          category: c.category,
          engine: c.engine,
          label: c.label,
          size: c.size,
          license: c.license,
          install: c.install,
          installed: false,
          state: "unknown",
        };
      });
      setModels(merged);
    } catch (e) {
      console.error("get_models_catalog 失败（降级为服务数据）:", e);
      setModels(dyn);
    }
  };

  const refreshRuntime = async () => {
    try {
      setRuntime(await checkRuntime());
    } catch (e) {
      console.error("check_runtime 失败:", e);
    }
  };

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    (async () => {
      unlisten = await listen<ServiceStatus>("service-status", (e) => {
        setStatus(e.payload);
        refreshHealth();
      });
      try {
        const s = await invoke<ServiceStatus>("get_service_status");
        setStatus(s);
      } catch (err) {
        console.error("get_service_status 失败:", err);
      }
      refreshHealth();
      refreshRuntime();
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // 032：运行时自举进度事件（node 下载 → npm ci → 服务拉起）；034：py 安装走同一事件流（step=py,deps）
  useEffect(() => {
    let un: UnlistenFn | undefined;
    (async () => {
      un = await listenRuntimeProgress((p) => {
        setRuntimeLogs((prev) => [...prev.slice(-50), p]);
        if (p.step === "done") {
          if (p.message === "完成") {
            setRuntimeInstalling(false);
            setPyInstalling(false);
            refreshHealth();
            refreshRuntime();
          }
        } else if (p.step === "error") {
          setRuntimeInstalling(false);
          setPyInstalling(false);
          refreshRuntime();
        }
      });
    })();
    return () => {
      un?.();
    };
  }, []);

  const doInstallRuntime = async () => {
    // 033/034：node 按钮——只管「node + 服务端依赖」；python 是另一个按钮（doInstallPythonBase）
    setRuntimeInstalling(true);
    setRuntimeLogs([]);
    try {
      await installRuntime();
    } catch (e) {
      setRuntimeLogs((prev) => [...prev, { step: "error", message: String(e) }]);
    } finally {
      setRuntimeInstalling(false);
      refreshRuntime();
    }
  };

  // 034 阶段3：py 按钮——只装受管 Python 基础（uv + CPython 3.11，~100MB 小流量）；
  // 用户不想装 py 就不装（非强制），引擎 venv 在模型管理页各自安装
  const doInstallPythonBase = async () => {
    if (pyInstalling) return;
    setPyInstalling(true);
    setRuntimeLogs([]);
    try {
      await installPythonBase();
    } catch (e) {
      setRuntimeLogs((prev) => [...prev, { step: "error", message: String(e) }]);
    } finally {
      setPyInstalling(false);
      refreshRuntime();
    }
  };

  const runtimeNeedInstall = runtime && (!runtime.node_ok || !runtime.deps_ready);
  // 034：py 基础（uv + CPython）独立检测——与 node 分开提示、分开按钮
  const pyNeedInstall = runtime && !runtime.python_ready;
  const runtimeBusy = runtimeInstalling || pyInstalling;
  const lastLog = runtimeLogs[runtimeLogs.length - 1];
  const lastPct = lastLog && lastLog.pct != null ? lastLog.pct : null;

  // 兜底轮询（030 规划）：service-status 事件只在 asr/qwen3 变化时触发，
  // funasr(8002)/cosyvoice(8003) 等延迟启动的服务不会通知前端 → UI 停在旧快照（识别面板原始版恒为 x 的根因）。
  // 每 15s 兜底刷新一次，确保任何服务就绪最终反映到 UI。
  useEffect(() => {
    const timer = setInterval(refreshHealth, 15000);
    return () => clearInterval(timer);
  }, []);

  const doStart = async () => {
    try {
      await invoke("start_service_cmd");
    } catch (err) {
      alert("启动失败: " + err);
    }
  };

  const doStop = async () => {
    try {
      await invoke("stop_service_cmd");
      const s = await invoke<ServiceStatus>("get_service_status");
      setStatus(s);
    } catch (err) {
      alert("停止失败: " + err);
    }
  };

  const common: PanelProps = {
    health,
    models,
    refresh: refreshHealth,
    status,
    runtime,
    runtimeInstalling,
    runtimeLogs,
    onInstallRuntime: doInstallRuntime,
    pyInstalling,
    onInstallPythonBase: doInstallPythonBase,
    goPanel: setPanel,
    goSettings: (anchor) => {
      // 时间戳 tick：即使锚点相同，重复点击也强制触发 SettingsPanel 的定位 effect
      setSettingsAnchor(`${Date.now()}:${anchor || ""}`);
      setPanel("settings");
    },
    settingsAnchor,
    clearSettingsAnchor: () => setSettingsAnchor(null),
  };

  const renderPanel = () => {
    switch (panel) {
      case "read":
        return <ReadPanel {...common} />;
      case "asr":
        return <AsrPanel {...common} />;
      case "realtime":
        return <RealtimePanel {...common} />;
      case "chat":
        return <ChatPanel {...common} />;
      case "models":
        return <ModelsPanel {...common} />;
      case "audio":
        return <AudioLibraryPanel {...common} />;
      case "voices":
        return <VoicePanel {...common} />;
      case "settings":
        return <SettingsPanel {...common} />;
      case "home":
      default:
        return <HomePanel {...common} />;
    }
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icons/icon.png" alt="OpenSound" className="logo" />
          <div>
            <div className="brand-name">OpenSound</div>
            <div className="brand-sub">本地语音工作台</div>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${panel === item.id ? "active" : ""}`}
              onClick={() => setPanel(item.id)}
            >
              <span className="nav-icon">
                <Icon icon={item.icon} width={18} height={18} />
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="status-bar">
            <span className={`status-light ${status.asr_up ? "ok" : "fail"}`} />
            <span>{status.asr_up ? "服务运行中" : "服务未就绪"}</span>
          </div>
          <div className="bar-actions">
            {!status.child_alive && (
              <button className="mini-btn" onClick={doStart}>
                启动
              </button>
            )}
            {status.child_alive && (
              <button className="mini-btn" onClick={doStop}>
                停止
              </button>
            )}
          </div>
        </div>
      </aside>
      <main className="main">
        {(runtimeNeedInstall || pyNeedInstall || runtimeBusy) && (
          <div className={`runtime-banner ${runtimeBusy ? "busy" : ""}`}>
            {/* 034 拆分：node/py 各自独立按钮，不再"一个按钮装两个"。
                node 按钮 = node + 服务端依赖；py 按钮 = uv + CPython 基础（可选装，引擎 venv 在模型页）。 */}
            {!runtimeBusy && runtimeNeedInstall && (
              <div className="rb-main">
                <Icon icon="lucide:wrench" width={16} height={16} />
                <div className="rb-text">
                  <div className="rb-title">
                    {!runtime.node_ok ? "缺少 Node.js 运行环境" : "服务端依赖未就绪"}
                  </div>
                  <div className="rb-sub">
                    {!runtime.node_ok
                      ? "由 App 自动下载便携版 Node（免安装、不污染系统），点一下即可。"
                      : "自动安装服务端依赖（npm ci，首次需数分钟，镜像国内可用）。"}
                  </div>
                </div>
                {runtimeInstalling ? (
                  <span className="rb-hint">正在安装 Node…</span>
                ) : (
                  <button className="rb-btn" onClick={doInstallRuntime}>
                    <Icon icon="lucide:download" width={14} height={14} /> 安装 Node
                  </button>
                )}
              </div>
            )}
            {!runtimeBusy && pyNeedInstall && (
              <div className="rb-main">
                <Icon icon="lucide:package" width={16} height={16} />
                <div className="rb-text">
                  <div className="rb-title">缺少受管 Python 基础环境（uv + CPython 3.11）</div>
                  <div className="rb-sub">
                    仅 Qwen3 / SenseVoice 原始版 / CosyVoice 需要（不装 py 则这三个引擎不可用，其余不受影响）。装完各引擎环境在模型管理页安装。
                  </div>
                </div>
                {pyInstalling ? (
                  <span className="rb-hint">正在安装 Python 基础…</span>
                ) : (
                  <button className="rb-btn" onClick={doInstallPythonBase}>
                    <Icon icon="lucide:download" width={14} height={14} /> 安装 Python 基础
                  </button>
                )}
              </div>
            )}
            {runtimeBusy && (
              <div className="rb-main">
                <Icon icon="lucide:loader-2" width={16} height={16} className="rb-busy-icon" />
                <div className="rb-text">
                  <div className="rb-title">{lastLog?.message || "正在准备运行环境…"}</div>
                </div>
                <span className="rb-hint">请勿关闭窗口</span>
              </div>
            )}
            {runtimeBusy && lastPct != null && (
              <div className="rb-bar">
                <div className="rb-fill" style={{ width: `${Math.min(100, lastPct)}%` }} />
              </div>
            )}
          </div>
        )}
        {renderPanel()}
      </main>
    </div>
  );
}

export default App;
