import { useState } from "react";
import type { PanelProps } from "../App";
import { Icon } from "@iconify/react";
import { installModel } from "../api";
import type { InstallProgress } from "../types";
import { Panel, Button, Spinner } from "../components/ui";

export default function ModelsPanel(props: PanelProps) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress[]>([]);

  const install = async (engine: string) => {
    if (installing) return;
    setInstalling(engine);
    setProgress([]);
    try {
      await installModel(engine, (p) =>
        setProgress((prev) => [...prev, p])
      );
      await props.refresh();
    } catch (e) {
      setProgress((prev) => [
        ...prev,
        { type: "error", message: String(e) },
      ]);
    } finally {
      setInstalling(null);
    }
  };

  const catLabel: Record<string, string> = {
    tts: "朗读 TTS",
    asr: "识别 ASR",
    llm: "对话 LLM",
  };

  return (
    <Panel
      title="模型管理"
      subtitle="查看与下载本地模型（类比 ollama pull）"
      actions={
        <Button variant="ghost" onClick={props.refresh}>
          <Icon icon="lucide:refresh-cw" width={16} height={16} /> 刷新
        </Button>
      }
    >
      <div className="models-list">
        {props.models.map((m) => (
          <div key={m.engine} className="model-row">
            <div className="model-info">
              <div className="model-name">{m.label}</div>
              <div className="model-meta">
                <span className="model-cat">{catLabel[m.category] || m.category}</span>
                <span className="model-engine">{m.engine}</span>
                <span className="model-size">{m.size}</span>
              </div>
            </div>
            <div className="model-action">
              {m.installed ? (
                <span className="badge ok">已安装</span>
              ) : (
                <Button
                  onClick={() => install(m.engine)}
                  disabled={!!installing}
                >
                  {installing === m.engine ? (
                    <Spinner />
                  ) : (
                    "安装"
                  )}
                </Button>
              )}
            </div>
          </div>
        ))}
        {props.models.length === 0 && (
          <div className="empty">暂无模型数据（请确认服务已启动）</div>
        )}
      </div>

      {progress.length > 0 && (
        <div className="install-log">
          <div className="install-head">
            安装进度{installing ? ` · ${installing}` : ""}
          </div>
          {progress.map((p, i) => (
            <div
              key={i}
              className={`install-line ${
                p.type === "error" ? "err" : p.type === "done" ? "ok" : ""
              }`}
            >
              {p.type === "done" ? (
                <Icon icon="lucide:check" width={14} height={14} />
              ) : p.type === "error" ? (
                <Icon icon="lucide:x" width={14} height={14} />
              ) : (
                "·"
              )}{" "}
              {p.message}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
