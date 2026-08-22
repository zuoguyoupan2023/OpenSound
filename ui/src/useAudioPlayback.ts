// 单实例音频播放 hook：同一时刻只播一条，再次点击同一条即停止。
// 音频库面板与朗读面板的历史区块共用，避免两处各写一套 <audio> 管理。
import { useCallback, useEffect, useRef, useState } from "react";
import { audioAssetUrl, type AudioRecord } from "./audioStore";

export function useAudioPlayback(onError?: (msg: string) => void) {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const elRef = useRef<HTMLAudioElement | null>(null);
  const playingIdRef = useRef<string | null>(null);
  // 用 ref 持有回调，避免闭包过期
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const stopPlay = useCallback(() => {
    if (elRef.current) {
      elRef.current.pause();
      elRef.current = null;
    }
    playingIdRef.current = null;
    setPlayingId(null);
  }, []);

  useEffect(() => stopPlay, [stopPlay]);

  const togglePlay = useCallback(
    async (rec: AudioRecord): Promise<void> => {
      if (playingIdRef.current === rec.id) {
        stopPlay();
        return;
      }
      stopPlay();
      const src = await audioAssetUrl(rec);
      const el = new Audio(src);
      elRef.current = el;
      playingIdRef.current = rec.id;
      setPlayingId(rec.id);
      el.onended = () => {
        if (elRef.current === el) elRef.current = null;
        playingIdRef.current = null;
        setPlayingId(null);
      };
      el.onerror = () => {
        if (elRef.current === el) elRef.current = null;
        playingIdRef.current = null;
        setPlayingId(null);
        onErrorRef.current?.("播放失败（文件可能已删除）");
      };
      await el.play();
    },
    [stopPlay]
  );

  return { playingId, togglePlay, stopPlay };
}
