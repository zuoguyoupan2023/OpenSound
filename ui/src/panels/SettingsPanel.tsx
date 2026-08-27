import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PanelProps } from "../App";
import {
  getPersistedSettings,
  updateSettings,
  getBaseUrl,
  getDataRoot,
  setDataRoot,
  migrateModelsToData,
  type PowerMode,
  type EcoBig,
} from "../api";
import { showToast } from "../toast";
import { Panel, Button, Spinner } from "../components/ui";

// 030 阶段一：节能模式下可启用的大模型（单开；none=最小集）
const ECO_BIG_OPTS: { value: EcoBig; label: string; mem: string; wait: string }[] = [
  { value: "none", label: "都不启用（仅最小集：SenseVoice 量化 + Kokoro + 0.5B 对话）", mem: "0", wait: "—" },
  { value: "qwen3", label: "Qwen3 TTS（高音质朗读）", mem: "2–4GB", wait: "数十秒" },
  { value: "cosyvoice", label: "CosyVoice 克隆（克隆音色朗读）", mem: "4–6GB", wait: "1–2 分钟" },
  { value: "sensevoice-original", label: "SenseVoice 原始版（高精度识别）", mem: "1.5–2.5GB", wait: "20–60s" },
  { value: "llm-qwen3-8b", label: "Qwen3-8B 对话（更强对话能力）", mem: "6–8GB", wait: "5–10s" },
];

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
  // 032 P3：模型存放目录（数据根目录，独立于服务代码目录）
  const [modelDataRoot, setModelDataRoot] = useState("");
  const [dataRootLoading, setDataRootLoading] = useState(true);
  const [dataRootBusy, setDataRootBusy] = useState(false);
  const [dataRootMsg, setDataRootMsg] = useState("");
  // 030 阶段一：资源模式（节能/全能 + 节能下启用的大模型）
  const [powerMode, setPowerMode] = useState<PowerMode>("full");
  const [ecoBig, setEcoBig] = useState<EcoBig>("none");
  const [applyingMode, setApplyingMode] = useState(false);
  const [modeMsg, setModeMsg] = useState("");

  // 030：从工作台「详情」跳入时，滚动定位到资源模式区并短暂高亮
  useEffect(() => {
    const anchor = props.settingsAnchor?.split(":")[1];
    if (anchor !== "power-mode") return;
    const el = document.getElementById("power-mode-section");
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.classList.add("anchor-flash");
    const t = setTimeout(() => el?.classList.remove("anchor-flash"), 1800);
    props.clearSettingsAnchor?.();
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.settingsAnchor]);

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
    setPowerMode(s.powerMode || "full");
    setEcoBig(s.ecoBig || "none");
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
    getDataRoot()
      .then((p) => {
        setModelDataRoot(p);
        setDataRootLoading(false);
      })
      .catch((e) => {
        console.error("get_data_root 失败:", e);
        setDataRootLoading(false);
      });
  }, []);

  // 032 P3：保存模型存放目录 → 重启服务生效
  const saveDataRoot = async () => {
    setDataRootBusy(true);
    setDataRootMsg("");
    try {
      await setDataRoot(modelDataRoot.trim());
      await invoke("start_service_cmd");
      setDataRootMsg(`已保存并重启服务。模型/缓存/音色将落盘于：${modelDataRoot.trim() || "默认数据目录"}`);
      setTimeout(() => props.refresh(), 800);
    } catch (e) {
      setDataRootMsg("失败: " + e);
    } finally {
      setDataRootBusy(false);
    }
  };

  // 032 P3：把历史落在服务代码目录的 models 迁到模型存放目录
  const doMigrateModels = async () => {
    setDataRootBusy(true);
    setDataRootMsg("");
    try {
      const msg = await migrateModelsToData();
      setDataRootMsg(msg);
      setTimeout(() => props.refresh(), 800);
    } catch (e) {
      setDataRootMsg("迁移失败: " + e);
    } finally {
      setDataRootBusy(false);
    }
  };

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

  // 030 阶段一：应用资源模式并重启服务（关闭/启用的模型下次启动生效）
  const applyPowerMode = async () => {
    setApplyingMode(true);
    setModeMsg("");
    try {
      await updateSettings({ powerMode, ecoBig });
      await invoke("start_service_cmd");
      setModeMsg(
        powerMode === "eco"
          ? `已保存并重启服务（节能模式：${
              ecoBig === "none" ? "仅最小集" : "额外启用 " + (ECO_BIG_OPTS.find((o) => o.value === ecoBig)?.label || ecoBig)
            }）`
          : "已保存并重启服务（全能模式：全部模型拉起）"
      );
      setTimeout(() => props.refresh(), 800);
    } catch (e) {
      setModeMsg("失败: " + e);
    } finally {
      setApplyingMode(false);
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
      <div className="settings-block" id="power-mode-section">
        <div className="settings-item">
          <label className="settings-label">服务资源模式（030 规划）</label>
          <div className="mode-radio-row">
            <label className="mode-radio">
              <input
                type="radio"
                name="powerMode"
                checked={powerMode === "full"}
                onChange={() => setPowerMode("full")}
              />
              <span>
                <b>全能模式</b>
                <em>全部模型常驻，随时可用；约占 12–16GB 内存</em>
              </span>
            </label>
            <label className="mode-radio">
              <input
                type="radio"
                name="powerMode"
                checked={powerMode === "eco"}
                onChange={() => setPowerMode("eco")}
              />
              <span>
                <b>节能模式</b>
                <em>只保留最小集（SenseVoice 量化 + Kokoro 朗读 + 0.5B 对话），大模型按需单开；省 10GB+，切换需等待冷启动</em>
              </span>
            </label>
          </div>

          {powerMode === "eco" && (
            <>
              <p className="settings-hint">
                节能模式下额外启用一个大模型（其余保持关闭，避免多模型同时常驻）：
              </p>
              <div className="mode-radio-row">
                {ECO_BIG_OPTS.map((o) => (
                  <label key={o.value} className="mode-radio">
                    <input
                      type="radio"
                      name="ecoBig"
                      checked={ecoBig === o.value}
                      onChange={() => setEcoBig(o.value)}
                    />
                    <span>
                      <b>{o.label}</b>
                      <em>常驻 {o.mem} · 冷启动 {o.wait}</em>
                    </span>
                  </label>
                ))}
              </div>
              {ecoBig !== "cosyvoice" && (
                <p className="settings-hint warn">
                  ⚠️ 节能模式下未启用克隆服务：使用<b>克隆音色朗读必须运行 CosyVoice</b>，请在上方选择「CosyVoice 克隆」并应用。
                </p>
              )}
            </>
          )}

          <div style={{ marginTop: 10 }}>
            <Button onClick={applyPowerMode} disabled={applyingMode}>
              {applyingMode ? <Spinner /> : "应用并重启服务"}
            </Button>
            {modeMsg && <span className="settings-msg" style={{ marginLeft: 10 }}>{modeMsg}</span>}
          </div>
          <p className="settings-hint">
            选择会在下次服务启动时生效（记录并持久化，重启 app 后沿用）。切换大模型需等待冷启动（见各选项标注）。
          </p>
        </div>
      </div>

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
          <label className="settings-label">模型存放目录（032 P3 · 数据目录）</label>
          <div className="path-row">
            <input
              className="input"
              value={modelDataRoot}
              onChange={(e) => setModelDataRoot(e.target.value)}
              placeholder="留空 = 默认（下载目录/opensound-download）"
              disabled={dataRootLoading}
            />
            <Button onClick={saveDataRoot} disabled={dataRootBusy || dataRootLoading}>
              {dataRootBusy ? <Spinner /> : "保存并重启服务"}
            </Button>
          </div>
          <p className="settings-hint">
            所有模型权重/缓存/克隆音色都存放在这里（<b>不再写进源码文件夹</b>）；换盘/迁移时修改此路径即可，旧模型可用下方按钮一键迁移。
          </p>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10 }}>
            <Button variant="ghost" onClick={doMigrateModels} disabled={dataRootBusy || dataRootLoading}>
              迁移旧模型（从服务代码目录）
            </Button>
          </div>
          {dataRootMsg && <p className="settings-msg">{dataRootMsg}</p>}
        </div>

        <div className="settings-item">
          <label className="settings-label">服务代码目录（高级）</label>
          <div className="path-row">
            <input
              className="input"
              value={serverPath}
              onChange={(e) => setServerPath(e.target.value)}
              placeholder="/路径/到/OpenSound/asr-server"
              disabled={pathLoading}
            />
            <Button onClick={savePath} disabled={restarting || pathLoading}>
              {restarting ? <Spinner /> : "保存并重启服务"}
            </Button>
          </div>
          <p className="settings-hint">
            ⚠️ 这是<b>后端程序所在目录</b>（含 start-all.js），与模型存储无关；模型存放在上方「模型存放目录」。普通用户无需修改。
          </p>
          {pathMsg && <p className="settings-msg">{pathMsg}</p>}
        </div>

        <div className="settings-block">
          <div className="settings-item">
            <label className="settings-label">环境与运行时（032 · App 内一键自举）</label>
            {props.runtime ? (
              <ul className="runtime-list">
                <li className={props.runtime.node_ok ? "ok" : "bad"}>
                  {props.runtime.node_ok ? "✅ Node.js 就绪" : "❌ 缺少 Node.js"}
                  {props.runtime.node_version && <em>（{props.runtime.node_version}）</em>}
                  {props.runtime.node_path && <code>{props.runtime.node_path}</code>}
                </li>
                <li className={props.runtime.deps_ready ? "ok" : "bad"}>
                  {props.runtime.deps_ready
                    ? "✅ 服务端依赖已就绪"
                    : "❌ 服务端依赖缺失（node_modules 未安装）"}
                </li>
                <li className={props.runtime.python_found ? "ok" : "muted"}>
                  {props.runtime.python_found
                    ? `✅ Python ${props.runtime.python_version}`
                    : "ℹ️ 未检测到 Python（仅 python 系引擎需要，后续由 App 内自动安装）"}
                </li>
                <li>数据目录：<code>{props.runtime.data_dir || "未定位"}</code></li>
                <li>服务目录：<code>{props.runtime.server_dir || "未定位"}</code></li>
              </ul>
            ) : (
              <p className="settings-hint">运行环境检测中…</p>
            )}

            {props.runtimeLogs.length > 0 && (
              <div className="runtime-log">
                {props.runtimeLogs.slice(-3).map((l, i) => (
                  <div key={i} className={`runtime-log-line ${l.step === "error" ? "err" : ""}`}>
                    {l.message}
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <Button
                onClick={props.onInstallRuntime}
                disabled={props.runtimeInstalling || !!(props.runtime?.node_ok && props.runtime?.deps_ready)}
              >
                {props.runtimeInstalling ? <Spinner /> : "一键安装 / 修复运行环境"}
              </Button>
            </div>
            <p className="settings-hint">
              缺少 Node.js 或服务依赖时，点按钮即可由 App 自动下载便携版 Node 并安装依赖（无需手动装环境）；安装进度见主界面顶部引导条。
            </p>
          </div>
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
