import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ServiceStatus } from "./types";
import "./App.css";

const DEFAULT_STATUS: ServiceStatus = {
  asr_up: false,
  qwen3_up: false,
  asr_url: "http://127.0.0.1:9528",
  qwen3_url: "http://127.0.0.1:8001",
  child_alive: false,
  node_path: "",
};

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`dot ${ok ? "ok" : "fail"}`} />;
}

function App() {
  const [status, setStatus] = useState<ServiceStatus>(DEFAULT_STATUS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    (async () => {
      // 订阅 Rust 后台健康轮询推送
      unlisten = await listen<ServiceStatus>("service-status", (e) => {
        setStatus(e.payload);
      });
      // 立即拉取一次
      try {
        const s = await invoke<ServiceStatus>("get_service_status");
        setStatus(s);
      } catch (err) {
        console.error("get_service_status 失败:", err);
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  const doStart = async () => {
    setBusy(true);
    try {
      await invoke("start_service_cmd");
    } catch (err) {
      console.error(err);
      alert("启动失败: " + err);
    } finally {
      setBusy(false);
    }
  };

  const doStop = async () => {
    setBusy(true);
    try {
      await invoke("stop_service_cmd");
      // 手动刷新
      const s = await invoke<ServiceStatus>("get_service_status");
      setStatus(s);
    } catch (err) {
      console.error(err);
      alert("停止失败: " + err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <img src="/icons/icon.png" alt="Tabu-Local" className="logo" />
        <h1>Tabu-Local 语音工作台</h1>
        <span className="version">M1 · Tauri 壳</span>
      </header>

      <section className="card status-card">
        <h2>服务状态</h2>
        <div className="rows">
          <div className="row">
            <StatusDot ok={status.asr_up} />
            <span className="name">asr-server（识别/朗读/LLM/对话）</span>
            <span className="url">{status.asr_url}</span>
            <span className={`badge ${status.asr_up ? "ok" : "fail"}`}>
              {status.asr_up ? "运行中" : "未就绪"}
            </span>
          </div>
          <div className="row">
            <StatusDot ok={status.qwen3_up} />
            <span className="name">qwen3-tts（可选低延迟朗读）</span>
            <span className="url">{status.qwen3_url}</span>
            <span className={`badge ${status.qwen3_up ? "ok" : "fail"}`}>
              {status.qwen3_up ? "运行中" : "未就绪"}
            </span>
          </div>
        </div>
        <div className="meta">
          <span>子进程：{status.child_alive ? "存活" : "已退出"}</span>
          <span className="muted">node：{status.node_path || "未找到"}</span>
        </div>
      </section>

      <section className="card actions-card">
        <h2>操作</h2>
        <div className="actions">
          <button onClick={doStart} disabled={busy || status.child_alive}>
            {busy ? "处理中…" : "启动 / 重启服务"}
          </button>
          <button onClick={doStop} disabled={busy || !status.child_alive}>
            停止服务
          </button>
        </div>
        <p className="hint">
          关闭本窗口不会退出服务（托盘常驻）。请从托盘菜单「退出」彻底停止并退出。
        </p>
      </section>
    </div>
  );
}

export default App;
