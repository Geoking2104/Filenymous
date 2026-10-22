/**
 * Shared whiteboard (Excalidraw, MIT), lazy-loaded so the wall's main bundle
 * stays small. Synced over the wall's sealed DataChannel through the host:
 * only element changes are sent, merged by element version (higher version
 * wins, ties broken by versionNonce, like Excalidraw's own collaboration).
 * No Excalidraw server, no Firebase, no image uploads (image tool disabled);
 * fonts are served from this site (EXCALIDRAW_ASSET_PATH).
 */
import { useEffect, useRef } from "react";
import { CaptureUpdateAction, Excalidraw, MainMenu, restoreElements } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { mergeScene, type BoardElement } from "./collab";

type Api = Parameters<NonNullable<React.ComponentProps<typeof Excalidraw>["excalidrawAPI"]>>[0];

export interface WhiteboardProps {
  initial: BoardElement[];
  /** Remote changes (from the host or other peers). Returns an unsubscribe function. */
  subscribe: (fn: (els: BoardElement[]) => void) => () => void;
  send: (els: unknown[]) => void;
  dark: boolean;
  lang: string;
}

const SEND_EVERY_MS = 90;

export default function Whiteboard({ initial, subscribe, send, dark, lang }: WhiteboardProps) {
  const api = useRef<Api | null>(null);
  /** id → highest version known (sent or received): only newer local versions are sent. */
  const known = useRef(new Map<string, number>(initial.map((e) => [e.id, e.version])));
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<readonly unknown[]>([]);

  useEffect(
    () =>
      subscribe((remote) => {
        const a = api.current;
        for (const r of remote) known.current.set(r.id, Math.max(known.current.get(r.id) ?? 0, r.version));
        if (!a) return;
        const local = a.getSceneElementsIncludingDeleted() as unknown as BoardElement[];
        const merged = mergeScene(local, restoreElements(remote as never, null) as unknown as BoardElement[]);
        if (merged !== local) a.updateScene({ elements: merged as never, captureUpdate: CaptureUpdateAction.NEVER });
      }),
    [subscribe],
  );

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const flush = () => {
    pending.current = null;
    const changed: unknown[] = [];
    for (const raw of latest.current) {
      const e = raw as BoardElement;
      if (e.type === "image") continue;
      if ((known.current.get(e.id) ?? 0) < e.version) {
        known.current.set(e.id, e.version);
        changed.push(e);
      }
    }
    if (changed.length) send(changed);
  };

  return (
    <div className="sw-board-canvas" data-testid="wall-board-canvas">
      <Excalidraw
        excalidrawAPI={(a) => (api.current = a)}
        initialData={{ elements: restoreElements(initial as never, null), appState: { viewBackgroundColor: dark ? "#121212" : "#ffffff" } }}
        theme={dark ? "dark" : "light"}
        langCode={lang.startsWith("fr") ? "fr-FR" : "en"}
        UIOptions={{ tools: { image: false }, canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false } }}
        onChange={(elements) => {
          latest.current = elements;
          if (!pending.current) pending.current = setTimeout(flush, SEND_EVERY_MS);
        }}
      >
        <MainMenu>
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}
