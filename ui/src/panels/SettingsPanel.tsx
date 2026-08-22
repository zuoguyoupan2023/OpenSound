import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PanelProps } from "../App";
import {
  getPersistedSettings,
  updateSettings,
  getBaseUrl,
} from "../api";
import { showToast } from "../toast";
import { Panel, Button, Spinner } from "../components/ui";

export default function SettingsPanel(props: PanelProps) {
  const [baseUrl, setBaseUrl] = useState(getBaseUrl());
  const [token, setToken] = useState("");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [zhipuKey, setZhipuKey] = useState("");
  const [serverPath, setServerPath] = useState("");
  const [pathLoading, setPathLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [pathMsg, setPathMsg] = useState("");
  // 数据目录（存储规范：音频库/对话历史/config.json 都在这里）
  const [dataDir, setDataDir] = useState("");

  // 自动保存控制：载入完成后才启用；与上次已保存快照相同则跳过
  const loadedRef = useRef(false);
  const savedSnapshotRef = useRef("");

  useEffect(() => {
    const s = getPersistedSettings();
    const initial = [
      s.baseUrl || "http://127.0.0.1:9528",
      s.token || "",
      s.deepseekKey || "",
      s.zhipuKey || "",
    ];
    setBaseUrl(initial[0]);
    setToken(initial[1]);
    setDeepseekKey(initial[2]);
    setZhipuKey(initial[3]);
    savedSnapshotRef.current = JSON.stringify(initial);
    loadedRef.current = true;
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
    invoke<string>("get_data_dir")
      .then(setDataDir)
      .catch((e) => console.error("get_data_dir 失败:", e));
  }, []);

  // 填写后自动保存（600ms 防抖）+ toast「已保存」
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => {
      const next = JSON.stringify([
        baseUrl.trim(),
        token.trim(),
        deepseekKey.trim(),
        zhipuKey.trim(),
      ]);
      if (next === savedSnapshotRef.current) return;
      updateSettings({
        baseUrl: baseUrl.trim(),
        token: token.trim(),
        deepseekKey: deepseekKey.trim(),
        zhipuKey: zhipuKey.trim(),
      })
        .then(() => {
          savedSnapshotRef.current = next;
          showToast("已保存");
          props.refresh();
        })
        .catch((e) => console.error("自动保存设置失败:", e));
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, token, deepseekKey, zhipuKey]);

  const openDataDir = async () => {
    try {
      const p = await invoke<string>("open_data_dir");
      setDataDir(p);
    } catch (e) {
      showToast("打开失败: " + String(e));
    }
  };

  const savePath = async () => {
    setPathMsg("");
    setRestarting(true);
    try {
      await invoke("set_server_path", { path: serverPath });
      // 重启服务使新路径生效
      await invoke("start_service_cmd");
      setPathMsg("已保存并重启服务");
      setTimeout(() => props.refresh(), 500);
    } catch (e) {
      setPathMsg("失败: " + e);
    } finally {
      setRestarting(false);
    }
  };

  return (
    <Panel
      title="设置"
      subtitle="服务连接、鉴权与运行信息（修改后自动保存）"
      actions={
        <Button variant="ghost" onClick={openDataDir}>
          📂 打开数据文件夹
        </Button>
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
            默认 9528（asr-server 主入口）。若开启局域网接入，改为实际地址。修改后自动保存。
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
          <label className="settings-label">DeepSeek API Key（可选）</label>
          <input
            className="input"
            type="password"
            value={deepseekKey}
            onChange={(e) => setDeepseekKey(e.target.value)}
            placeholder="sk-…（platform.deepseek.com 申请）"
          />
          <p className="settings-hint">
            填写后对话面板可选 DeepSeek 云端模型（V4-Flash / V4-Pro），与本地 LLM 并列。仅保存在本机 config.json。
          </p>
        </div>

        <div className="settings-item">
          <label className="settings-label">智谱 GLM API Key（可选）</label>
          <input
            className="input"
            type="password"
            value={zhipuKey}
            onChange={(e) => setZhipuKey(e.target.value)}
            placeholder="…（open.bigmodel.cn 申请）"
          />
          <p className="settings-hint">
            填写后对话面板可选智谱云端模型（GLM-4.7 / GLM-4.6），与本地 LLM 并列。仅保存在本机 config.json。
          </p>
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
          <label className="settings-label">数据存放位置</label>
          <p className="settings-hint">
            音频库、对话历史、config.json 统一存放在应用数据目录：
          </p>
          {dataDir && (
            <p className="settings-msg" style={{ wordBreak: "break-all" }}>
              {dataDir}
            </p>
          )}
          <div style={{ marginTop: 8 }}>
            <Button variant="ghost" onClick={openDataDir}>
              📂 打开数据文件夹
            </Button>
          </div>
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
