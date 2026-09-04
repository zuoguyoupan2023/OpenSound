import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "@iconify/react";
import type { PanelProps } from "../App";
import {
  getPersistedSettings,
  updateSettings,
  getBaseUrl,
  getDataRoot,
  setDataRoot,
  migrateModelsToData,
  clearData,
  clearDataPreview,
  type ClearScope,
  type PowerMode,
  type EcoBig,
} from "../api";
import { showToast } from "../toast";
import { Panel, Button, Spinner } from "../components/ui";

// 字节格式化（与模型页同口径）
function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// 030 阶段一：节能模式下可启用的大 Python 模型（单开其一；none=都不开）。
// 000-plan-3：节能 = 每类同时仅启用 1 个模型（无"禁用"）。Python 大模型（TTS/ASR 类）由 eco_big 单开其一；
// LLM 档位（0.5B/8B）不在此列——在对话面板/工作台选择，默认已装最小（0.5B），用户可自选并持久化。
const ECO_BIG_OPTS: { value: EcoBig; label: string; mem: string; wait: string }[] = [
  { value: "none", label: "都不启用（仅最小集：SenseVoice 量化 + Kokoro + LLM 默认 0.5B，可自行切换）", mem: "0", wait: "—" },
  { value: "qwen3", label: "Qwen3 TTS（高音质朗读）", mem: "2–4GB", wait: "数十秒" },
  { value: "cosyvoice", label: "CosyVoice 克隆（克隆音色朗读）", mem: "4–6GB", wait: "1–2 分钟" },
  { value: "sensevoice-original", label: "SenseVoice 原始版（高精度识别）", mem: "1.5–2.5GB", wait: "20–60s" },
];

export default function SettingsPanel(props: PanelProps) {
  // ---------- 阶段2：全局清理四档（cache/models/envs/all） ----------
  const [clearing, setClearing] = useState<ClearScope | null>(null);
  const [clearConfirm, setClearConfirm] = useState<{ scope: ClearScope; est: number } | null>(null);
  const [clearMsg, setClearMsg] = useState("");
  const CLEAR_OPTS: { scope: ClearScope; label: string; desc: string }[] = [
    { scope: "cache", label: "清理缓存", desc: "cache/：uv pip / torch-wheels / numba（可重下）" },
    { scope: "models", label: "卸载全部模型", desc: "models/：全部模型文件" },
    { scope: "envs", label: "卸载全部环境", desc: "venvs/ + runtime/（uv + CPython）" },
    { scope: "all", label: "恢复出厂", desc: "全部 + 音色 + 配置重置（不可撤销）" },
  ];
  const CLEAR_CONFIRM_TEXT: Record<ClearScope, string> = {
    cache: "清理下载缓存（uv pip / torch-wheels / numba）。不影响模型与已装环境，下次下载会重新产生。",
    models: "卸载全部模型文件。服务将停止；之后启动服务时各引擎会按需重新下载（大模型需二次确认）。",
    envs: "卸载全部运行环境（venvs + runtime/uv + runtime/python）。python 系引擎（qwen3/原始版/cosyvoice）需重新安装环境与模型。",
    all: "恢复出厂：清理全部数据（模型/环境/缓存/音色）+ 重置配置（token/API Key/数据目录设置，数据目录回默认路径）。此操作不可撤销！",
  };
  const startClear = async (scope: ClearScope) => {
    try {
      const est = await clearDataPreview(scope);
      setClearConfirm({ scope, est });
    } catch (e) {
      setClearMsg("清理预览失败: " + e);
    }
  };
  const confirmClear = async () => {
    if (!clearConfirm) return;
    const scope = clearConfirm.scope;
    setClearConfirm(null);
    setClearing(scope);
    setClearMsg("");
    try {
      const r = await clearData(scope);
      setClearMsg(`已清理，释放 ${fmtBytes(r.freed_bytes)}。${r.restart_hint}`);
      await props.refresh();
      // 2026-08-31：清理会删环境（uv/python/venvs）——重新检测运行时，避免显示过期的"就绪"
      await props.onRefreshRuntime?.();
    } catch (e) {
      setClearMsg("清理失败: " + e);
    } finally {
      setClearing(null);
    }
  };
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
                    ? `✅ 系统 Python ${props.runtime.python_version}（仅展示；python 系引擎用 App 受管环境）`
                    : "ℹ️ 未检测到系统 Python（python 系引擎用 App 内受管环境，见下）"}
                </li>
                <li className={props.runtime.python_ready ? "ok" : (props.runtime.uv_ready || props.runtime.py311_ready ? "muted" : "bad")}>
                  {props.runtime.python_ready
                    ? "✅ 受管 Python 基础就绪（uv + CPython 3.11）"
                    : "❌ 受管 Python 基础未就绪（uv / CPython 3.11；独立按钮安装，可选装）"}
                </li>
                {!props.runtime.python_ready && (
                  <ul className="runtime-sub-list">
                    <li className={props.runtime.uv_ready ? "ok" : "bad"}>
                      {props.runtime.uv_ready ? "✅" : "❌"} uv（runtime/uv）
                    </li>
                    <li className={props.runtime.py311_ready ? "ok" : "bad"}>
                      {props.runtime.py311_ready ? "✅" : "❌"} CPython 3.11（runtime/python）
                    </li>
                  </ul>
                )}
                <li className={props.runtime.python_ready ? "" : "muted"}>
                  引擎环境（venv，在<b>模型管理页</b>各自安装）：
                </li>
                <ul className="runtime-sub-list">
                  <li className={props.runtime.qwen3_venv ? "ok" : "bad"}>
                    {props.runtime.qwen3_venv ? "✅" : "❌"} Qwen3-TTS venv（.venv-qwen3）
                  </li>
                  <li className={props.runtime.funasr_venv ? "ok" : "bad"}>
                    {props.runtime.funasr_venv ? "✅" : "❌"} SenseVoice 原始版 venv（.venv-funasr）
                  </li>
                  <li className={props.runtime.cosy_venv ? "ok" : "bad"}>
                    {props.runtime.cosy_venv ? "✅" : "❌"} CosyVoice 克隆 venv（.venv-cosyvoice）
                  </li>
                </ul>
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

            {/* 034 拆分：node 与 py 各自独立按钮——不再一个按钮装两个；py 可选装 */}
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Button
                onClick={props.onInstallRuntime}
                disabled={props.runtimeInstalling || !!(props.runtime?.node_ok && props.runtime?.deps_ready)}
              >
                {props.runtimeInstalling ? <Spinner /> : "安装 / 修复 Node 与依赖"}
              </Button>
              <Button
                onClick={props.onInstallPythonBase}
                disabled={props.pyInstalling || !!props.runtime?.python_ready}
              >
                {props.pyInstalling ? <Spinner /> : "安装 / 修复 Python 基础（uv + CPython 3.11）"}
              </Button>
            </div>
            <p className="settings-hint">
              Node 按钮：缺少 Node.js 或服务依赖时，由 App 自动下载便携版 Node 并安装依赖（无需手动装环境）。
              Python 基础按钮：可选装（仅 qwen3 / SenseVoice 原始版 / CosyVoice 需要）；不装则这三个引擎不可用，其余不受影响。
              各引擎的 venv 环境在<b>模型管理页</b>对应卡片点按钮安装。进度见主界面顶部引导条。
            </p>

            {/* 阶段2（2026-08-31）：全局清理四档——由轻到重；每档先停服务、完成后不自动重启 */}
            <div className="settings-item" style={{ marginTop: 12 }}>
              <label className="settings-label">清理与卸载（全局）</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {CLEAR_OPTS.map((o) => (
                  <Button
                    key={o.scope}
                    variant="ghost"
                    onClick={() => startClear(o.scope)}
                    disabled={!!clearing || !!clearConfirm}
                    title={o.desc}
                  >
                    {clearing === o.scope ? (
                      <Spinner />
                    ) : (
                      <>
                        <Icon icon="lucide:trash-2" width={13} height={13} /> {o.label}
                      </>
                    )}
                  </Button>
                ))}
              </div>
              <p className="settings-hint">
                四档由轻到重：清理缓存 → 卸载全部模型 → 卸载全部环境 → 恢复出厂。每档执行前会停止服务，完成后不自动重启（启动时按需重新下载/重建）。单引擎卸载在<b>模型管理页</b>卡片上。
              </p>
              {clearConfirm && (
                <div className="install-confirm">
                  <div className="install-confirm-text">
                    <div>
                      「{CLEAR_OPTS.find((o) => o.scope === clearConfirm.scope)?.label}」将释放约{" "}
                      <b>{fmtBytes(clearConfirm.est)}</b>。
                    </div>
                    <div>{CLEAR_CONFIRM_TEXT[clearConfirm.scope]}</div>
                  </div>
                  <div className="install-confirm-actions">
                    <Button onClick={confirmClear} disabled={!!clearing}>
                      <Icon icon="lucide:trash-2" width={13} height={13} /> 确认清理
                    </Button>
                    <Button variant="ghost" onClick={() => setClearConfirm(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              )}
              {clearMsg && <p className="settings-msg">{clearMsg}</p>}
            </div>
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
            <span>asr-server（9528 · 基础进程，显示模型情况）</span>
            <span>{props.status.asr_up ? "运行中" : "未就绪"}</span>
          </div>
          <div className="kv">
            <span>qwen3-tts（8001）</span>
            <span>{props.status.qwen3_up ? "运行中" : "未就绪"}</span>
          </div>
          <div className="kv">
            <span>sensevoice-原始（8002 · funasr）</span>
            <span>{props.status.funasr_up ? "运行中" : "未就绪"}</span>
          </div>
          <div className="kv">
            <span>cosyvoice（8003 · 克隆）</span>
            <span>{props.status.cosyvoice_up ? "运行中" : "未就绪"}</span>
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
