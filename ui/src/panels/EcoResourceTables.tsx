import { useState, type ReactNode } from "react";
import type { ModelInfo } from "../types";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import {
  ecoActiveEngine,
  ecoCategoryKey,
  getPersistedSettings,
  switchEcoEngine,
  updateSettings,
} from "../api";

// ---------- 000-plan-3：模型页顶部「每类资源表」（LLM / ASR / TTS） ----------
// 每大类一张动态表：模型 | 主文件 | 磁盘大小 | 内存需求 | 已安装 | 当前启用。
// 节能模式（每类同时仅启用 1 个模型）：当前启用行高亮，其余已装行可「点选启用」（LLM 即时换载；
// TTS/ASR 走 switchEcoEngine 重启服务，Python 大模型真停进程、轻量引擎前端停用）。
// 未选择时给出「默认建议 = 已装中主文件最小」，并有「应用默认」一键落库。

const CATS: { cat: "tts" | "asr" | "llm"; title: string; sub: string }[] = [
  { cat: "tts", title: "朗读 TTS", sub: "Kokoro / Qwen3-TTS / CosyVoice 克隆" },
  { cat: "asr", title: "识别 ASR", sub: "SenseVoice / Whisper / SenseVoice 原始版" },
  { cat: "llm", title: "对话 LLM", sub: "GGUF 档位（同刻仅加载一个）" },
];

const MAX = Number.MAX_SAFE_INTEGER;
const diskOf = (m: ModelInfo): number => m.profile?.diskGB ?? MAX;
const gb = (v?: number): string => (v != null ? `${v}GB` : "—");
const fmtMainFile = (m: ModelInfo): string => {
  const files = m.mainFiles || [];
  if (!files.length) return "目录型模型";
  const head = files[0].replace(/^models[\\/]/, "");
  return files.length > 1 ? `${head} (+${files.length - 1})` : head;
};

export default function EcoResourceTables(props: {
  models: ModelInfo[];
  refresh: () => void;
}) {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const bump = () => setTick((t) => t + 1);
  const s = getPersistedSettings();
  const eco = s.powerMode === "eco";

  const currentOf = (cat: "tts" | "asr" | "llm"): string | null =>
    cat === "llm" ? s.llmModel || null : ecoActiveEngine(cat, s);

  const suggestMin = (list: ModelInfo[]): ModelInfo | null =>
    list.length ? [...list].sort((a, b) => diskOf(a) - diskOf(b))[0] : null;

  const pick = async (cat: "tts" | "asr" | "llm", m: ModelInfo) => {
    setMsg("");
    if (!eco) return;
    if (!m.installed) {
      setMsg(`「${m.label}」未安装——先在下方卡片列表下载，装好后回到本表点选启用`);
      return;
    }
    if (currentOf(cat) === m.engine) return;
    if (cat === "llm") {
      try {
        await updateSettings({ llmModel: m.engine });
        bump();
        setMsg("LLM 档位已切换并保存——下句对话即用新档位（同刻只加载一个 GGUF，无需重启）");
      } catch (e) {
        setMsg("保存失败: " + e);
      }
      return;
    }
    if (
      !window.confirm(
        `节能模式将「${cat === "tts" ? "朗读 TTS" : "识别 ASR"}」类别切换到「${m.label}」：` +
          `关闭同类别当前引擎并重启服务（冷启动需等待），继续？`
      )
    )
      return;
    setBusy(m.engine);
    try {
      await switchEcoEngine(cat, m.engine);
      setMsg("已切换并保存，服务重启中…");
      bump();
      props.refresh();
      setTimeout(() => props.refresh(), 1500);
    } catch (e) {
      setMsg("切换失败: " + e);
    } finally {
      setBusy(null);
    }
  };

  const applyDefaultMin = async () => {
    if (!eco) return;
    setMsg("");
    if (
      !window.confirm(
        "把每类默认设为「当前已安装中主文件最小」的档位并重启服务？（这会覆盖你之前的选择，仅用于想回到系统默认时）"
      )
    )
      return;
    const upd: Record<string, string> = {};
    for (const cat of ["tts", "asr"] as const) {
      const min = suggestMin(props.models.filter((m) => m.category === cat && m.installed));
      if (min) upd[ecoCategoryKey(cat)] = min.engine;
    }
    const llm = suggestMin(props.models.filter((m) => m.category === "llm" && m.installed));
    if (llm) upd.llmModel = llm.engine;
    if (!Object.keys(upd).length) {
      setMsg("当前没有任何已安装模型，先下载再应用默认");
      return;
    }
    setBusy("*apply*");
    try {
      await updateSettings(upd as never);
      await invoke("start_service_cmd");
      setMsg("已应用默认（每类主文件最小已装），服务重启中…");
      bump();
      props.refresh();
      setTimeout(() => props.refresh(), 1500);
    } catch (e) {
      setMsg("应用失败: " + e);
    } finally {
      setBusy(null);
    }
  };

  const renderTable = (cat: "tts" | "asr" | "llm", title: string, sub: string) => {
    const list = props.models.filter((m) => m.category === cat);
    const active = currentOf(cat);
    const suggest = eco ? suggestMin(list.filter((m) => m.installed)) : null;
    const suggestKey = suggest?.engine;
    const activeLabel =
      active && cat === "llm"
        ? "当前档位：见对话面板/工作台（config llm_model）"
        : active
          ? "当前启用（节能每类仅一个）"
          : suggest
            ? "未选择 → 默认将启用「主文件最小」已装档位"
            : "未选择（该类别当前无已装模型可启用）";
    return (
      <div key={cat} className="eco-cat">
        <div className="eco-cat-head">
          <div>
            <b>{title}</b>
            <span className="muted">{sub}</span>
          </div>
          <span className={`eco-active-note ${active ? "on" : ""}`}>
            {eco ? activeLabel : "全能模式：全部引擎可用（表内仅供查阅）"}
          </span>
        </div>
        <table className="eco-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>主文件</th>
              <th>磁盘</th>
              <th>内存</th>
              <th>{eco ? "当前启用" : "状态"}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((m) => {
              const isActive = active === m.engine;
              const isSuggest = eco && !active && suggestKey === m.engine;
              let cell: ReactNode;
              if (!eco) {
                cell = m.installed ? (
                  <span className="badge eco-on">已装</span>
                ) : (
                  <span className="badge eco-off">未下载</span>
                );
              } else if (!m.installed) {
                cell = <span className="badge eco-off">未下载</span>;
              } else if (isActive) {
                cell = (
                  <span className="badge eco-on">
                    <Icon icon="lucide:check" width={12} height={12} /> 启用中
                  </span>
                );
              } else {
                cell = (
                  <button
                    className="link-btn eco-pick"
                    disabled={!!busy}
                    onClick={() => pick(cat, m)}
                  >
                    {busy === m.engine ? "切换中…" : "点选启用"}
                  </button>
                );
              }
              return (
                <tr key={m.engine} className={isActive ? "active" : ""}>
                  <td>
                    <div className="eco-model-name">
                      {m.label}
                      {isSuggest && <span className="badge eco-suggest">默认最小建议</span>}
                    </div>
                  </td>
                  <td className="eco-file" title={(m.mainFiles || []).join("\n")}>
                    {fmtMainFile(m)}
                  </td>
                  <td>{m.profile?.diskGB != null ? gb(m.profile.diskGB) : m.size || "—"}</td>
                  <td>{gb(m.profile?.memNeedGB)}</td>
                  <td>{cell}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.length === 0 && (
          <div className="muted eco-empty">
            该类别暂无引擎登记（新增引擎请登记 engines/*.json + MODEL_ITEMS，表自动出现）
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="eco-resource">
      <div className="eco-resource-head">
        <div className="eco-resource-title">
          <Icon icon="lucide:database" width={15} height={15} /> 按类别 · 模型资源表（{CATS.length} 类
          · 共 {props.models.length} 模型）
          <span className="muted">
            主文件 / 磁盘 / 内存取自 engines/*.json（profile + checks）；节能模式每类仅启用 1 个
          </span>
        </div>
        {eco && (
          <ButtonSmall
            disabled={!!busy}
            onClick={applyDefaultMin}
            label={busy === "*apply*" ? "应用中…" : "应用默认（每类最小已装）"}
          />
        )}
      </div>
      {msg && <div className="error-box eco-msg">{msg}</div>}
      {CATS.map((c) => renderTable(c.cat, c.title, c.sub))}
      <div className="eco-tip">
        💡 节能模式正确语义：每个类别<b>同时仅启用 1 个模型</b>（不是"禁用"）——表中点选即把该类切换过去
        （LLM 即时换载；TTS/ASR 重启服务生效，被替换的 Python 大模型进程关闭、轻量引擎前端停用）。
        识别/朗读/对话面板的下拉与模型页卡片会随本表选择联动显示。
      </div>
    </div>
  );
}

function ButtonSmall(props: {
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button className="btn eco-apply" disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </button>
  );
}
