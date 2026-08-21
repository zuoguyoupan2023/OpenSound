import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Icon } from "@iconify/react";
import "./icons";
import type { ServiceStatus, PanelId, HealthInfo, ModelInfo } from "./types";
import { getHealth, getModels } from "./api";
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
}

function App() {
  const [status, setStatus] = useState<ServiceStatus>(DEFAULT_STATUS);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [panel, setPanel] = useState<PanelId>("home");

  const refreshHealth = async () => {
    try {
      const [h, m] = await Promise.all([getHealth(), getModels()]);
      setHealth(h);
      setModels(m);
    } catch (e) {
      console.error("refresh health 失败:", e);
      setHealth(null);
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
    })();
    return () => {
      unlisten?.();
    };
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

  const common: PanelProps = { health, models, refresh: refreshHealth, status };

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
          <img src="/icons/icon.png" alt="Tabu-Local" className="logo" />
          <div>
            <div className="brand-name">Tabu-Local</div>
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
      <main className="main">{renderPanel()}</main>
    </div>
  );
}

export default App;
