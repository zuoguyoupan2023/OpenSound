import { useRef, useState, useEffect } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { chat, transcribe, speakStream, getCloudApiKey, getPersistedSettings, updateSettings, switchEcoBig, type EcoBig } from "../api";
import { createRecorder, type Recorder, createFramePlayer, stopAudio } from "../audio";
import { saveRecording, teeCollect, mergeWavFrames, saveTts } from "../audioStore";
import {
  conversationList,
  conversationGet,
  conversationSave,
  conversationDelete,
  newSessionId,
  type ConversationMetaRec,
} from "../conversationStore";
import { fmtTime, truncate } from "../format";
import { listVoices, type CloneVoice } from "../voiceStore";
import { Panel, Button, Select, Spinner, EngineBadge } from "../components/ui";
import { showToast } from "../toast";

interface Msg {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  engine?: string;
  model?: string;
  /** 关联音频库中该轮朗读的记录 id */
  tts_audio_id?: string;
}

// 云端 LLM 档位（与后端 CLOUD_ENGINES 保持一致）
const CLOUD_LLM_MODELS: Record<string, { value: string; label: string }[]> = {
  deepseek: [
    { value: "deepseek-v4-flash", label: "模型: DeepSeek-V4-Flash（快·便宜）" },
    { value: "deepseek-v4-pro", label: "模型: DeepSeek-V4-Pro（更强）" },
  ],
  zhipu: [
    { value: "glm-4.7", label: "模型: GLM-4.7（最新）" },
    { value: "glm-4.6", label: "模型: GLM-4.6" },
  ],
};
const CLOUD_DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-v4-flash",
  zhipu: "glm-4.7",
};
const CLOUD_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  zhipu: "智谱 GLM",
};

export default function ChatPanel(props: PanelProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [engine, setEngine] = useState<string>("llama-cpp");
  // 000-plan-3：初始档位 = 用户上次选择（config 持久化）；无保存值默认 8B（已装才生效，未装由下方回落 effect 校正）
  const [llmModel, setLlmModel] = useState<string>(
    () => getPersistedSettings().llmModel || "llm-qwen3-8b"
  );

  // 030：节能模式在模型选择处直接切换（未启用 → 关旧启新）
  const ecoSettings = getPersistedSettings();
  const ecoChatQwenOff = ecoSettings.powerMode === "eco" && ecoSettings.ecoBig !== "qwen3";
  const ecoChatCloneOff = ecoSettings.powerMode === "eco" && ecoSettings.ecoBig !== "cosyvoice";
  // 000-plan-3：选档即持久化（节能 = 每类同时仅启用 1 个模型，LLM 类别无"禁用"；8B 可选）
  const adoptLlm = (v: string) => {
    setLlmModel(v);
    updateSettings({ llmModel: v }).catch((e) => console.error("保存 LLM 档位失败:", e));
  };
  const pickChatTts = async (v: "kokoro" | "qwen3" | "clone") => {
    const ecoKey = v === "clone" ? "cosyvoice" : v === "qwen3" ? "qwen3" : null;
    if (ecoKey && ecoSettings.powerMode === "eco" && ecoSettings.ecoBig !== ecoKey) {
      const name = v === "clone" ? "CosyVoice 克隆" : "Qwen3 TTS";
      if (
        !window.confirm(
          `节能模式未启用「${name}」。切换将关闭当前启用的大模型并启动「${name}」（重启服务，冷启动需等待），继续？`
        )
      )
        return;
      try {
        await switchEcoBig(ecoKey as EcoBig);
        showToast(`已切换启用「${name}」，服务重启中…`);
        props.refresh();
        setTimeout(() => props.refresh(), 1500);
      } catch (e) {
        showToast("切换失败: " + e);
        return;
      }
    }
    setTtsEngine(v);
  };
  // 000-plan-3：节能 = 每类同时仅启用 1 个模型（LLM 无"禁用"，8B 可选）——旧"eco 强制 8B→0.5B"逻辑已移除，
  // 默认/回落统一由下方「当前档位未装 → 回落已装最小」effect 处理。
  const [cloudModel, setCloudModel] = useState<string>("deepseek-v4-flash");
  const [ttsEngine, setTtsEngine] = useState<"kokoro" | "qwen3" | "clone">("kokoro");
  const [cloneVoices, setCloneVoices] = useState<CloneVoice[]>([]);
  const [cloneVoiceId, setCloneVoiceId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState("");
  const recRef = useRef<Recorder | null>(null);
  const playerRef = useRef<ReturnType<typeof createFramePlayer> | null>(null);
  // 朗读中断控制：停止时 abort 底层流，避免服务端继续合成、前端继续收流
  const speakAbortRef = useRef<AbortController | null>(null);
  const speakStoppedRef = useRef(false);
  // ===== 对话历史（011 §5.5：每轮自动保存，不设上限，手动删） =====
  const [sessionId, setSessionId] = useState<string>(() => newSessionId());
  const [convList, setConvList] = useState<ConversationMetaRec[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const sessionTitleRef = useRef("");
  // 渲染期同步的引用：供异步回调拿到最新消息序列与引擎组合
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;
  const currentModel = engine === "llama-cpp" ? llmModel : cloudModel;
  const engineModelRef = useRef({ engine: "", model: "" });
  engineModelRef.current = { engine, model: currentModel };

  const llmReady = props.health?.llm?.model !== "missing";
  // 已安装的 LLM 档位（来自 /models）
  const installedLlmModels = (props.models || []).filter(
    (m) => m.category === "llm" && m.installed
  );

  // 000-plan-3（复核更正版）：当前选中档位未安装 → 自动回落到「用户已保存选择（若已装）→ 节能=已装最小 / 全能=8B 已装则 8B、否则已装最小」。
  // 无禁用概念：8B 与任何档位一样，装了就可选。无任何已装则不回落（保留"未下载"引导）。
  // 校正后同步持久化（adoptLlm），避免每次重开都先闪一次旧值。
  useEffect(() => {
    if (engine !== "llama-cpp") return;
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
  }, [props.models, engine, llmModel]);

  // 加载克隆音色（供对话朗读选用）
  useEffect(() => {
    listVoices()
      .then((vs) => {
        setCloneVoices(vs);
        if (vs.length) setCloneVoiceId(vs[0].id);
      })
      .catch(() => {});
  }, []);

  // ===== 会话历史逻辑 =====
  const refreshConvList = () => {
    conversationList()
      .then(setConvList)
      .catch((e) => console.error("载入会话列表失败:", e));
  };

  useEffect(() => {
    refreshConvList();
  }, []);

  // 每轮对话后整体保存当前会话（不阻塞 UI）
  const autoSaveSession = (msgs: Msg[], engineId: string, modelId: string) => {
    if (!msgs.length) return;
    if (!sessionTitleRef.current) {
      const firstUser = msgs.find((m) => m.role === "user");
      sessionTitleRef.current = firstUser ? truncate(firstUser.content, 20) : "";
    }
    conversationSave({
      id: sessionId,
      title: sessionTitleRef.current || "未命名会话",
      engine: engineId,
      model: modelId,
      messages: msgs,
    })
      .then(refreshConvList)
      .catch((e) => console.error("自动保存会话失败:", e));
  };

  const newChat = () => {
    setMessages([]);
    setSessionId(newSessionId());
    sessionTitleRef.current = "";
    setShowHistory(false);
  };

  const openSession = async (meta: ConversationMetaRec) => {
    setError("");
    try {
      const c = await conversationGet(meta.id);
      setMessages(c.messages ?? []);
      setSessionId(c.id);
      sessionTitleRef.current = c.title;
      setShowHistory(false);
    } catch (e) {
      setError("载入会话失败: " + String(e));
    }
  };

  const removeSession = async (id: string) => {
    if (!window.confirm("删除这个会话记录？")) return;
    try {
      await conversationDelete(id);
      refreshConvList();
      if (id === sessionId) newChat();
    } catch (e) {
      setError(String(e));
    }
  };


  const sendText = async (content: string) => {
    if (!content.trim() || busy) return;
    setError("");
    const apiKey = getCloudApiKey(engine);
    if (CLOUD_LLM_MODELS[engine] && !apiKey) {
      setError(`请先在「设置」面板填写 ${CLOUD_LABELS[engine]} 的 API Key`);
      return;
    }
    const base: Msg[] = [...messages, { role: "user", content, ts: Date.now() }];
    setMessages(base);
    setInput("");
    setBusy(true);
    try {
      const history: { role: "system" | "user" | "assistant"; content: string }[] = [
        { role: "system", content: "你是一个本地语音助手，用简洁的中文回答用户。" },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content },
      ];
      const model = engine === "llama-cpp" ? llmModel : cloudModel;
      const r = await chat(history, engine, model, apiKey || undefined);
      // 组装完整消息序列（含本轮引擎信息），一次性更新并自动保存
      const next: Msg[] = [
        ...base,
        { role: "assistant", content: r.text, ts: Date.now(), engine, model },
      ];
      setMessages(next);
      autoSaveSession(next, engine, model);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const startRec = async () => {
    setError("");
    try {
      const rec = await createRecorder();
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setError("无法访问麦克风: " + e);
    }
  };

  const stopRec = async () => {
    const rec = recRef.current!;
    setRecording(false);
    setBusy(true);
    try {
      const wav = await rec.stop();
      recRef.current = null;
      const r = await transcribe(wav, "auto");
      saveRecording(wav, "auto", r.text, { source: "chat" }).catch((e) =>
        console.error("保存录音失败:", e)
      );
      await sendText(r.text);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const speakAnswer = async (text: string) => {
    stopAudio();
    setSpeaking(true);
    speakStoppedRef.current = false;
    const ac = new AbortController();
    speakAbortRef.current = ac;
    const player = createFramePlayer();
    playerRef.current = player;
    try {
      const stream = await speakStream(
        {
          text,
          engine: ttsEngine,
          voice: ttsEngine === "clone" ? cloneVoiceId : undefined,
        },
        ac.signal
      );
      const { playStream, collected } = teeCollect(stream);
      // 落盘与播放解耦：流读完（含被中断）即保存，不等播放完成
      collected
        .then((frames) => {
          if (!frames.length) return;
          return saveTts(mergeWavFrames(frames), ttsEngine, text, {
            source: "chat",
            voice: ttsEngine === "clone" ? cloneVoiceId : undefined,
            interrupted: speakStoppedRef.current || undefined,
          })
            .then((rec) => {
              // 把该轮朗读音频 id 关联回对应的消息（供将来"点击重听"）
              if (!rec) return;
              const next = messagesRef.current.map((x) =>
                x.role === "assistant" && x.content === text && !x.tts_audio_id
                  ? { ...x, tts_audio_id: rec.id }
                  : x
              );
              setMessages(next);
              conversationSave({
                id: sessionId,
                title: sessionTitleRef.current || "未命名会话",
                engine: engineModelRef.current.engine,
                model: engineModelRef.current.model,
                messages: next,
              })
                .then(refreshConvList)
                .catch(() => {});
            })
            .catch((e) => console.error("保存朗读失败:", e));
        })
        .catch((e) => console.error("收集朗读帧失败:", e));
      await player.start(playStream);
      setSpeaking(false);
    } catch (e) {
      // 主动停止不算错误
      if (!speakStoppedRef.current) setError(String(e));
      setSpeaking(false);
    }
  };

  const stopSpeak = () => {
    speakStoppedRef.current = true;
    speakAbortRef.current?.abort();
    speakAbortRef.current = null;
    playerRef.current?.stop();
    playerRef.current = null;
    stopAudio();
    setSpeaking(false);
  };

  return (
    <Panel
      title="对话面板"
      subtitle="文字或语音 → 本地/云端 LLM → 朗读回答"
      actions={
        speaking ? (
          <Button variant="danger" onClick={stopSpeak}>
            停止朗读
          </Button>
        ) : undefined
      }
    >
      <div className="chat-toolbar">
        <Button variant="ghost" onClick={newChat}>
          <Icon icon="lucide:plus" width={16} height={16} /> 新会话
        </Button>
        <div className="chat-history-wrap">
          <Button variant="ghost" onClick={() => setShowHistory((s) => !s)}>
            <Icon icon="lucide:history" width={16} height={16} /> 历史
            {convList.length ? `（${convList.length}）` : ""}
          </Button>
          {showHistory && (
            <div className="chat-history-pop">
              {convList.length === 0 ? (
                <div className="chat-history-empty">暂无历史会话，聊一轮就会自动保存</div>
              ) : (
                convList.map((m) => (
                  <div
                    key={m.id}
                    className={`chat-history-item ${m.id === sessionId ? "current" : ""}`}
                  >
                    <button className="chat-history-open" onClick={() => openSession(m)}>
                      <span className="t">{m.title}</span>
                      <span className="s">
                        {fmtTime(m.updated_at).slice(5, 16)} · {m.message_count} 条 ·{" "}
                        {m.engine}
                      </span>
                    </button>
                    <button
                      className="chat-history-del"
                      title="删除此会话"
                      onClick={() => removeSession(m.id)}
                    >
                      <Icon icon="lucide:trash-2" width={14} height={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <span className="muted chat-session-hint">
          {sessionTitleRef.current || "当前会话每轮自动保存"}
        </span>
      </div>

      <div className="chat-box">
        {messages.length === 0 && (
          <div className="chat-empty">
            输入问题，或点击 <Icon icon="lucide:mic" width={14} height={14} />{" "}
            用语音提问
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-content">{m.content}</div>
            {m.role === "assistant" && (
              <div className="chat-tools">
                <button
                  className="link-btn"
                  onClick={() => speakAnswer(m.content)}
                  disabled={speaking}
                >
                  <Icon icon="lucide:volume-2" width={16} height={16} /> 朗读
                </button>
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <Spinner /> 思考中…
          </div>
        )}
      </div>

      <div className="chat-input-row">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendText(input);
            }
          }}
          placeholder="输入消息，Enter 发送…"
          rows={3}
          disabled={busy}
        />
        <div className="chat-actions">
          <button
            className={`mic-mini ${recording ? "recording" : ""}`}
            onClick={recording ? stopRec : startRec}
            disabled={busy}
            title="语音提问"
          >
            {recording ? (
              <>
                <Icon icon="lucide:square" width={14} height={14} /> 结束
              </>
            ) : (
              <Icon icon="lucide:mic" width={16} height={16} />
            )}
          </button>
          <Button onClick={() => sendText(input)} disabled={busy || !input.trim()}>
            发送
          </Button>
        </div>
      </div>

      <div className="chat-opts">
        <Select
          value={engine}
          onChange={(v) => {
            setEngine(v);
            if (CLOUD_DEFAULT_MODEL[v]) setCloudModel(CLOUD_DEFAULT_MODEL[v]);
          }}
          options={[
            { value: "llama-cpp", label: "LLM: llama-cpp" },
            { value: "ollama", label: "LLM: Ollama" },
            {
              value: "deepseek",
              label: `LLM: DeepSeek（云）${getCloudApiKey("deepseek") ? "" : " · 未填Key"}`,
            },
            {
              value: "zhipu",
              label: `LLM: 智谱 GLM（云）${getCloudApiKey("zhipu") ? "" : " · 未填Key"}`,
            },
          ]}
        />
        {engine === "llama-cpp" && (
          <Select
            value={llmModel}
            onChange={adoptLlm}
            options={
              installedLlmModels.length
                ? installedLlmModels.map((m) => ({
                    value: m.engine,
                    label: `模型: ${m.label}`,
                  }))
                : [
                    {
                      value: "llm-qwen3-8b",
                      label: "模型: Qwen3-8B（未下载 · 请到模型页下载）",
                    },
                  ]
            }
          />
        )}
        {CLOUD_LLM_MODELS[engine] && (
          <Select
            value={cloudModel}
            onChange={setCloudModel}
            options={CLOUD_LLM_MODELS[engine]}
          />
        )}
        <Select
          value={ttsEngine}
          onChange={pickChatTts}
          options={[
            { value: "kokoro", label: "朗读: Kokoro" },
            { value: "qwen3", label: `朗读: Qwen3${ecoChatQwenOff ? "（点击切换并启用）" : ""}` },
            { value: "clone", label: `朗读: 克隆音色${ecoChatCloneOff ? "（点击切换并启用）" : ""}` },
          ]}
        />
        {ttsEngine === "clone" && (
          <Select
            value={cloneVoiceId}
            onChange={setCloneVoiceId}
            options={
              cloneVoices.length
                ? cloneVoices.map((v) => ({ value: v.id, label: v.name }))
                : [{ value: "", label: "（无克隆音色）" }]
            }
          />
        )}
        <EngineBadge label="LLM" ready={llmReady} />
      </div>

      {error && (
        <div className="error-box">
          <Icon icon="lucide:triangle-alert" width={16} height={16} /> {error}
        </div>
      )}
    </Panel>
  );
}
