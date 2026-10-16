import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { P2PFileInfo } from "./protocol";
import { mediaKind } from "./media";
import { openStreamUrl, type StreamHandle, type StreamReader } from "./stream";
import { formatBytes } from "../ux-v3/types";

interface Props {
  reader: StreamReader;
  files: P2PFileInfo[];
  /** Indexes of the files this browser can play. */
  playable: number[];
  receivedBytes: number;
  onUnavailable(): void;
}

/** Plays a P2P file while it downloads (Service Worker + HTTP Range). */
export default function StreamPlayer({ reader, files, playable, receivedBytes, onUnavailable }: Props) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(playable[0]!);
  const [handle, setHandle] = useState<StreamHandle | null>(null);
  const [saving, setSaving] = useState(false);
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const info = files[index]!;
  const kind = mediaKind(info.name, info.mime) ?? "video";

  useEffect(() => {
    let h: StreamHandle | null = null;
    let alive = true;
    void openStreamUrl(reader, index, info).then((res) => {
      if (!alive) return res?.close();
      if (!res) return onUnavailable();
      h = res;
      setHandle(res);
    });
    return () => {
      alive = false;
      h?.close();
      setHandle(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reader, index]);

  useEffect(() => {
    if (handle) void media.current?.play().catch(() => undefined);
  }, [handle]);

  const save = async () => {
    if (!handle) return;
    setSaving(true);
    try {
      const picker = (window as Window & { showSaveFilePicker?: (o: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableStream> }> }).showSaveFilePicker;
      const res = await fetch(handle.url);
      if (picker && res.body) {
        const fh = await picker({ suggestedName: info.name });
        await res.body.pipeTo(await fh.createWritable());
      } else {
        const url = URL.createObjectURL(await res.blob());
        const a = Object.assign(document.createElement("a"), { href: url, download: info.name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      /* cancelled */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pz-stream" data-testid="p2p-stream">
      {playable.length > 1 && (
        <div className="pz-stream-files" role="group" aria-label={t("stream.choose")}>
          {playable.map((i) => (
            <button key={i} type="button" className={i === index ? "on" : ""} aria-pressed={i === index} onClick={() => setIndex(i)}>
              {files[i]!.name}
            </button>
          ))}
        </div>
      )}
      {handle ? (
        kind === "audio" ? (
          <audio ref={media} src={handle.url} controls autoPlay preload="auto" data-testid="p2p-player" aria-label={info.name} />
        ) : (
          <video ref={media} src={handle.url} controls autoPlay playsInline preload="auto" data-testid="p2p-player" aria-label={info.name} />
        )
      ) : (
        <p className="v3-muted">{t("stream.preparing")}</p>
      )}
      <p className="v3-muted pz-stream-meta" data-testid="p2p-stream-bytes" data-bytes={receivedBytes}>
        {t("stream.buffered", { size: formatBytes(receivedBytes), total: formatBytes(info.size) })}
      </p>
      <button type="button" className="v3-btn-ghost" data-testid="p2p-stream-save" disabled={!handle || saving} onClick={save}>
        {saving ? t("stream.saving") : t("stream.save", { size: formatBytes(info.size) })}
      </button>
    </div>
  );
}
