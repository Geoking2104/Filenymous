import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EMOJI_GROUPS, searchEmoji } from "./emoji";
import { useModal } from "../home/useModal";

/** Bundled emoji picker (no network). */
export function EmojiPicker({ onPick, onClose, title }: { onPick: (e: string) => void; onClose: () => void; title?: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(EMOJI_GROUPS[0]!.id);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useModal(ref, onClose, { trap: false, initialFocus: input });
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-emoji-trigger]")) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const list = q.trim() ? searchEmoji(q) : (EMOJI_GROUPS.find((g) => g.id === group) ?? EMOJI_GROUPS[0]!).list.map((x) => x.e);
  return (
    <div className="sw2-picker" ref={ref} role="dialog" aria-label={title ?? t("wall.emoji.title")} data-testid="wall-emoji-picker">
      <input
        ref={input}
        className="sw2-picker-search"
        type="search"
        value={q}
        placeholder={t("wall.emoji.search")}
        aria-label={t("wall.emoji.search")}
        data-testid="wall-emoji-search"
        onChange={(e) => setQ(e.target.value)}
      />
      {!q.trim() && (
        <div className="sw2-picker-tabs" role="tablist">
          {EMOJI_GROUPS.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={g.id === group} title={t(`wall.emoji.group.${g.id}`)} onClick={() => setGroup(g.id)}>
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div className="sw2-picker-grid">
        {list.length ? (
          list.map((e) => (
            <button key={e} type="button" className="sw2-emoji" data-testid="wall-emoji" data-emoji={e} onClick={() => onPick(e)}>
              {e}
            </button>
          ))
        ) : (
          <p className="sw-small">{t("wall.emoji.none")}</p>
        )}
      </div>
    </div>
  );
}
