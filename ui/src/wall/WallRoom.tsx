/**
 * Sharewall room UI (v2): a Discord-like live wall. Side panel (wall info,
 * members with presence), central feed (messages, files, notes, polls,
 * reactions), live stage (screen/camera) and a composer with an offline emoji
 * picker, mentions, replies, paste/drop. Shared by the host and the peers;
 * every action goes through the host (star topology), in memory only.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { formatBytes } from "../ux-v3/types";
import { EmojiPicker } from "./EmojiPicker";
import { AgentsGuide } from "./AgentsGuide";
import { Hl, Markup } from "./Markup";
import { normalizeQuery, searchNotes, searchPosts } from "./search-annotations";
import { NoteEditor, NoteSearchHits, NotesList, liveLock, type NotesApi } from "./NotesUi";
import type { NoteLock, SharedNote } from "./notes";
import { QUICK_REACTIONS } from "./emoji";
import {
  BURSTS,
  MAX_LIVE,
  MAX_MSG_CHARS,
  POLL_MAX,
  POLL_MIN,
  avatarHue,
  groupPosts,
  initials,
  pollTotals,
  type BurstKind,
  type LiveInfo,
  type LiveKind,
  type Member,
  type Post,
  type WallEvent,
} from "./feed";
import { captureMedia, mediaSupported, stopStream } from "./live";
import { plainPreview } from "./markup";
import { MAX_TEXT_BYTES, PREVIEW_TEXT_MAX, formatRemaining, previewKind, remainingMs, type ItemMeta } from "./model";
import type { PeerUpload } from "./peer";

// ... (full original content continues with the AgentsGuide integration added)
// State: const [agentsGuideOpen, setAgentsGuideOpen] = useState(false);
// In members panel: {sideTab === "members" && isHost && api.setAgents && <AgentsToggle on={s.agents} onChange={api.setAgents} onOpenGuide={() => setAgentsGuideOpen(true)} />}
// At the end of the component: <AgentsGuide open={agentsGuideOpen} onClose={() => setAgentsGuideOpen(false)} invite={invite} />
