import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PanelProps } from "../App";
import {
  getPersistedSettings,
  saveSettings,
  getBaseUrl,
} from "../api";
import { Panel, Button, Spinner } from "../components/ui";

export default function SettingsPanel(props: PanelProps) {
  const [baseUrl, setBaseUrl] = useState(getBaseUrl());
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [serverPath, setServerPath] = useState("");
  const [pathLoading, setPathLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [pathMsg, setPathMsg] = useState("");

  useEffect(() => {
    const s = getPersistedSettings();
    setBaseUrl(s.baseUrl || "http://127.0.0.1:9528");
    setToken(s.token || "");
    (async () => {
      try {
        const p = await invoke<string>("get_server_path");
        setServerPath(p);
      } catch (e) {
        console.error("get_server_path 失败:", e);
      } finally {
        setPathLoading(false);
      }
    })();
  }, []);

  const save = () => {
    saveSettings({ baseUrl, token });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    props.refresh();
  };

  const savePath = async () => {
    setPathMsg("");
    setRestarting(true);
    try {
      await invoke("set_server_path", { path: serverPath });
      // 重启服务使新路径生效
      await invoke("start_service_cmd");
      setPathMsg("✅ 已保存并重启服务");
      setTimeout(() => props.refresh(), 500);
    } catch (e) {
      setPathMsg("❌ " + e);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <Panel
      title="设置"
      subtitle="服务连接、鉴权与运行信息"
      actions={
        <Button onClick={save}>{saved ? "已保存 ✓" : "保存"}</Button>
      }
    >
      <div className="settings-block">
        <div className="settings-item">
          <label className="settings-label">服务地址</label>
          <input
            className="input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://127.0.0.1:9528"
          />
          <p className="settings-hint">
            默认 9528（asr-server 主入口）。若开启局域网接入，改为实际地址。
          </p>
        </div>

        <div className="settings-item">
          <label className="settings-label">asr-server 目录</label>
          <div className="path-row">
            <input
              className="input"
              value={serverPath}
              onChange={(e) => setServerPath(e.target.value)}
              placeholder="/路径/到/Tabu-Voice/asr-server"
              disabled={pathLoading}
            />
            <Button onClick={savePath} disabled={restarting || pathLoading}>
              {restarting ? <Spinner /> : "保存并重启服务"}
            </Button>
          </div>
          <p className="settings-hint">
            指向本机 asr-server 目录（含 start-all.js）。模型本地已有则直接复用，缺的首次按需下载。
          </p>
          {pathMsg && <p className="settings-msg">{pathMsg}</p>}
        </div>

        <div className="settings-item">
          <label className="settings-label">鉴权 Token（可选）</label>
          <input
            className="input"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="留空 = 本机免鉴权"
          />
          <p className="settings-hint">
            本机默认无需 Token；开放局域网时才需要，与浏览器插件设置保持一致。
          </p>
        </div>
      </div>

      <div className="settings-block">
        <div className="settings-item">
          <label className="settings-label">端口约定（与 Tabu-AI 兼容）</label>
          <div className="ports-table">
            <div><code>9528</code> asr-server 主入口（识别/朗读/LLM/对话）</div>
            <div><code>8001</code> qwen3-tts（可选低延迟朗读）</div>
            <div><code>9527</code> bridge WS（终端桥接）</div>
          </div>
        </div>
      </div>

      <div className="settings-block">
        <div className="settings-item">
          <label className="settings-label">运行信息</label>
          <div className="kv">
            <span>子进程存活</span>
            <span>{props.status.child_alive ? "是" : "否"}</span>
          </div>
          <div className="kv">
            <span>asr-server</span>
            <span>{props.status.asr_up ? "运行中" : "未就绪"}</span>
          </div>
          <div className="kv">
            <span>qwen3-tts</span>
            <span>{props.status.qwen3_up ? "运行中" : "未就绪"}</span>
          </div>
          <div className="kv">
            <span>Node</span>
            <span className="muted">{props.status.node_path || "未找到"}</span>
          </div>
        </div>
      </div>

      <div className="settings-block">
        <div className="settings-item">
          <label className="settings-label">生命周期</label>
          <p className="settings-hint">
            关闭窗口不会退出服务（托盘常驻）。开机自启与局域网绑定将在后续版本提供。
          </p>
        </div>
      </div>
    </Panel>
  );
}
