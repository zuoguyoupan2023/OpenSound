import { useRef, useState, useEffect } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { voiceChat, updateSettings, getPersistedSettings, computeStarting, applyEcoDefaults, switchEcoEngine, engineDisabledInEco, restartService, TTS_PANEL_TO_ID, type EcoTts, type EcoAsr, type PowerMode } from "../api";
import { createRecorder, type Recorder, playWav, stopAudio } from "../audio";
import { saveRecording, saveTts } from "../audioStore";
import { Panel, Button, EngineBadge, Select, Spinner } from "../components/ui";
import { showToast } from "../toast";

type Stage = "idle" | "recording" | "processing" | "speaking" | "done";

export default function HomePanel(props: PanelProps) {
  const [stage, setStage] = useState<Stage>("idle");
  const [asrEngine, setAsrEngine] = useState<string>("auto");
  const [llmEngine, setLlmEngine] = useState<string>("llama-cpp");
  // 000-plan-3：初始档位 = 用户上次选择（config 持久化）；无保存值默认 8B（未装由回落 effect 校正）
  const [llmModel, setLlmModel] = useState<string>(
    () => getPersistedSettings().llmModel || "llm-qwen3-8b"
  );
  const [ttsEngine, setTtsEngine] = useState<"kokoro" | "qwen3">("kokoro");
  const [result, setResult] = useState<{
    recognized: string;
    answer: string;
    audioBase64: string;
  } | null>(null);
  const [error, setError] = useState<string>("");
  const recRef = useRef<Recorder | null>(null);
  // 030：工作台资源模式快捷开关（初始值从持久化设置读取）
  const [powerMode, setPowerMode] = useState<PowerMode>(
    () => getPersistedSettings().powerMode || "full"
  );

  // 030：切换节能/全能 → 持久化 + 重启服务生效
  // 000-plan-3：切到节能时，若某类别尚无启用选择（ecoTts/ecoAsr/llmModel 空）→ 自动补「已装中主文件最小」，
  // 服务重启即按该选择注入（Python 大模型真停/启）；已有用户选择不覆盖。
  const switchPowerMode = async (m: PowerMode) => {
    if (m === powerMode) return;
    const ok = window.confirm(
      m === "eco"
        ? "切换到节能模式：每类同时仅启用 1 个模型——未选过的类别将自动启用「已装最小」档位（如 LLM 0.5B），你随时可在模型页资源表/各面板切换。需要重启本地服务，继续？"
        : "切换到全能模式：重新拉起全部模型（约占 12–16GB 内存）。需要重启本地服务，继续？"
    );
    if (!ok) return;
    setPowerMode(m);
    try {
      const upd: Record<string, string> = { powerMode: m };
      if (m === "eco") {
        const cur = getPersistedSettings();
        const defs = await applyEcoDefaults(props.models || []);
        if (!cur.ecoTts && defs.ecoTts) upd.ecoTts = defs.ecoTts;
        if (!cur.ecoAsr && defs.ecoAsr) upd.ecoAsr = defs.ecoAsr;
        if (!cur.llmModel && defs.llmModel) upd.llmModel = defs.llmModel;
      }
      await updateSettings(upd as never);
      await restartService();
      showToast(`已切换到${m === "eco" ? "节能" : "全能"}模式，服务重启中…`);
      setTimeout(() => props.refresh(), 800);
    } catch (e) {
      showToast("切换失败: " + e);
    }
  };

  // 000-plan-3：节能下 TTS/ASR 引擎下拉联动（非启用项标「点选切换」，点选即类别切换并重启）
  const ecoSettings = getPersistedSettings();
  const ecoActiveTts = ecoSettings.powerMode === "eco" ? (ecoSettings.ecoTts as EcoTts) : null;
  const ecoActiveAsr = ecoSettings.powerMode === "eco" ? (ecoSettings.ecoAsr as EcoAsr) : null;
  const ttsOffLabel = (v: "kokoro" | "qwen3") =>
    ecoActiveTts && engineDisabledInEco("tts", TTS_PANEL_TO_ID[v], ecoSettings)
      ? "（点选切换并启用）"
      : "";
  const asrOffLabel = (v: "sensevoice" | "whisper") =>
    ecoActiveAsr && engineDisabledInEco("asr", v, ecoSettings) ? "（点选切换并启用）" : "";
  const pickTtsHome = async (v: "kokoro" | "qwen3") => {
    const id = TTS_PANEL_TO_ID[v];
    if (ecoSettings.powerMode === "eco" && ecoActiveTts && ecoActiveTts !== id) {
      if (
        !window.confirm(
          `节能模式未启用「${v === "qwen3" ? "Qwen3 TTS" : "Kokoro"}」。切换将把朗读类别改为该引擎并重启服务，继续？`
        )
      )
        return;
      try {
        await switchEcoEngine("tts", id);
        showToast("已切换朗读引擎，服务重启中…");
        props.refresh();
        setTimeout(() => props.refresh(), 1500);
      } catch (e) {
        showToast("切换失败: " + e);
        return;
      }
    }
    setTtsEngine(v);
  };
  const pickAsrHome = async (v: string) => {
    if (ecoSettings.powerMode === "eco" && v !== "auto" && ecoActiveAsr && ecoActiveAsr !== v) {
      if (!window.confirm(`节能模式未启用该识别引擎。切换将把识别类别改为该引擎并重启服务，继续？`)) return;
      try {
        await switchEcoEngine("asr", v);
        showToast("已切换识别引擎，服务重启中…");
        props.refresh();
        setTimeout(() => props.refresh(), 1500);
      } catch (e) {
        showToast("切换失败: " + e);
        return;
      }
    }
    setAsrEngine(v);
  };
  // 000-plan-3：节能下当前引擎不在（面板可表达的）启用集 → 自动回落启用引擎
  useEffect(() => {
    if (!ecoSettings.powerMode || ecoSettings.powerMode !== "eco") return;
    const s = getPersistedSettings();
    const at = s.ecoTts as EcoTts | "";
    const aa = s.ecoAsr as EcoAsr | "";
    if (at === "kokoro" || at === "qwen3") {
      if (ttsEngine !== at) setTtsEngine(at);
    } else if (at === "cosyvoice-clone") {
      setError("节能下朗读类别为克隆音色——请到「朗读/对话」面板使用（本工作台朗读仅 Kokoro/Qwen3）");
    }
    if (aa === "sensevoice" || aa === "whisper") {
      if (asrEngine !== aa) setAsrEngine(aa);
    } else if (aa === "sensevoice-original") {
      setError("节能下识别类别为 SenseVoice 原始版——请到「识别」面板使用（本工作台识别仅量化版/Whisper）");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ecoSettings.powerMode, ecoActiveTts, ecoActiveAsr, props.models]);

  const kokoroReady = props.health?.tts.kokoro === "ready";
  const qwen3Ready = props.health?.tts.qwen3 === "reachable";
  const ttsReady = ttsEngine === "kokoro" ? kokoroReady : qwen3Ready;

  const toggle = async () => {
    setError("");
    if (stage === "recording") {
      // 停止录音并提交全链路
      setStage("processing");
      const rec = recRef.current!;
      const wav = await rec.stop();
      recRef.current = null;
      try {
        const r = await voiceChat(wav, {
          asrEngine,
          llmEngine,
          llmModel,
          ttsEngine,
        });
        // 顺手保存录音 + 朗读结果到音频库（不阻塞）
        saveRecording(wav, asrEngine, r.recognized, { source: "home" }).catch(
          (e) => console.error("保存录音失败:", e)
        );
        saveTts(r.audioBase64, ttsEngine, r.answer, { source: "home" }).catch(
          (e) => console.error("保存朗读失败:", e)
        );
        setResult(r);
        setStage("speaking");
        await playWav(base64ToBlob(r.audioBase64));
        setStage("done");
      } catch (e) {
        setError(String(e));
        setStage("done");
      }
    } else {
      // 开始录音
      try {
        const rec = await createRecorder();
        recRef.current = rec;
        rec.start();
        setStage("recording");
      } catch (e) {
        setError("无法访问麦克风: " + e);
      }
    }
  };

  const cancel = () => {
    recRef.current?.cancel();
    recRef.current = null;
    stopAudio();
    setStage("idle");
  };

  // 000-plan-3：选档即持久化（节能 = 每类同时仅启用 1 个模型，LLM 类别无"禁用"；8B 可选）
  const adoptLlm = (v: string) => {
    setLlmModel(v);
    updateSettings({ llmModel: v }).catch((e) => console.error("保存 LLM 档位失败:", e));
  };

  // 000-plan-3：当前选中档位未安装 → 自动回落到「用户已保存选择（若已装）→ 节能=已装最小 / 全能=8B 已装则 8B、否则已装最小」。
  // 与 ChatPanel 同款：llmModel 初始 8B，全能只装 0.5B 时 voiceChat 仍带 8B → 后端报「LLM 模型缺失」。
  // 无任何已装则不回落（保留"未下载"引导）；校正后同步持久化，避免每次重开闪旧值。
  useEffect(() => {
    if (llmEngine !== "llama-cpp") return;
    const installed = (props.models || []).filter(
      (m) => m.category === "llm" && m.installed
    );
    if (!installed.length) return;
    const installedKeys = installed.map((m) => m.engine);
    if (installedKeys.includes(llmModel)) return; // 当前档位已装：不动（含用户手选）
    const sizeOf = (m: (typeof installed)[number]) => m.profile?.diskGB ?? Number.MAX_SAFE_INTEGER;
    const minInstalled = [...installed].sort((a, b) => sizeOf(a) - sizeOf(b))[0].engine;
    const settings = getPersistedSettings();
    const saved = settings.llmModel;
    let target = "";
    if (saved && installedKeys.includes(saved)) target = saved;
    else if (settings.powerMode === "eco") target = minInstalled;
    else target = installedKeys.includes("llm-qwen3-8b") ? "llm-qwen3-8b" : minInstalled;
    if (target) adoptLlm(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.models, llmEngine, llmModel]);

  return (
    <Panel
      title="语音工作台"
      subtitle="说 → 想 → 读，一键完成本地语音对话闭环"
      actions={
        <>
          <div className="power-switch" title="服务资源模式（030 规划）">
            <button
              className={`cap ${powerMode === "full" ? "on" : ""}`}
              onClick={() => switchPowerMode("full")}
            >
              全能
            </button>
            <button
              className={`cap ${powerMode === "eco" ? "on" : ""}`}
              onClick={() => switchPowerMode("eco")}
            >
              节能
            </button>
            <button
              className="cap-detail"
              title="设置 → 服务资源模式"
              onClick={() => props.goSettings?.("power-mode")}
            >
              <Icon icon="lucide:info" width={14} height={14} /> 详情
            </button>
          </div>
          {stage !== "idle" && (
            <Button variant="danger" onClick={cancel}>
              取消
            </Button>
          )}
        </>
      }
    >
      <div className="home-big">
        <button
          className={`mic-btn ${stage === "recording" ? "recording" : ""}`}
          onClick={toggle}
          disabled={stage === "processing"}
        >
          {stage === "recording" ? (
            <>
              <span className="mic-pulse" /> 点击结束录音
            </>
          ) : stage === "processing" ? (
            <>
              <Spinner /> 识别 + 思考 + 朗读…
            </>
          ) : (
            <>
              <Icon icon="lucide:mic" width={16} height={16} />{" "}
              按住说话（点击开始/结束）
            </>
          )}
        </button>
      </div>

      <div className="field-row">
        <label>
          识别引擎
          <Select
            value={asrEngine}
            onChange={pickAsrHome}
            options={[
              { value: "auto", label: "自动（SenseVoice 优先）" },
              { value: "sensevoice", label: `SenseVoice${asrOffLabel("sensevoice")}` },
              { value: "whisper", label: `Whisper${asrOffLabel("whisper")}` },
            ]}
          />
        </label>
        <label>
          LLM 引擎
          <Select
            value={llmEngine}
            onChange={setLlmEngine}
            options={[
              { value: "llama-cpp", label: "llama-cpp（本地）" },
              { value: "ollama", label: "Ollama（后备）" },
            ]}
          />
        </label>
        {llmEngine === "llama-cpp" && (
          <label>
            LLM 模型
            <Select
              value={llmModel}
              onChange={adoptLlm}
              options={
                (props.models || []).filter(
                  (m) => m.category === "llm" && m.installed
                ).length
                  ? (props.models || [])
                      .filter((m) => m.category === "llm" && m.installed)
                      .map((m) => ({ value: m.engine, label: m.label }))
                  : [{ value: "llm-qwen3-8b", label: "Qwen3-8B（未下载）" }]
              }
            />
          </label>
        )}
        <label>
          朗读引擎
          <Select
            value={ttsEngine}
            onChange={pickTtsHome}
            options={[
              { value: "kokoro", label: `Kokoro（本地）${ttsOffLabel("kokoro")}` },
              { value: "qwen3", label: `Qwen3（低延迟）${ttsOffLabel("qwen3")}` },
            ]}
          />
        </label>
      </div>

      <div className="engine-status">
        <EngineBadge
          label="ASR"
          // 2026-08-31 修复：不能以 health.engines.length>0 判就绪（该数组恒含 'sensevoice(未下载)' 占位，
          // 模型全卸载也恒非空 → 永远绿勾，与识别面板红 x 矛盾）。改与 AsrPanel 同口径：/models 的 state=ready/running。
          ready={props.models?.some(
            (m) =>
              (m.engine === "sensevoice" || m.engine === "whisper") &&
              (m.state === "ready" || m.state === "running")
          )}
          starting={computeStarting(getPersistedSettings(), props.health).asr}
        />
        <EngineBadge
          label="LLM"
          ready={!!props.health && props.health.llm?.model !== "missing"}
        />
        <EngineBadge
          label={`朗读·${ttsEngine}`}
          ready={!!props.health && ttsReady}
          starting={computeStarting(getPersistedSettings(), props.health).kokoro}
        />
      </div>

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}

      {result && (
        <div className="result-box">
          <div className="result-block">
            <div className="result-label">识别到</div>
            <div className="result-text">{result.recognized}</div>
          </div>
          <div className="result-block">
            <div className="result-label">本地回答</div>
            <div className="result-text">{result.answer}</div>
          </div>
          {stage === "done" && (
            <div className="result-replay">
              <Button onClick={() => playWav(base64ToBlob(result.audioBase64))}>
                <Icon icon="lucide:rotate-ccw" width={16} height={16} /> 重新播放
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "audio/wav" });
}
