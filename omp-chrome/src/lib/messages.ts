// Les réglages persistés et les messages échangés entre les contextes de l'extension
// (service worker, document offscreen, popup, options, script de contenu). Un message
// `chrome.runtime.sendMessage` atteint TOUS les contextes : chacun porte son
// destinataire (`to`) et chaque écouteur ignore ce qui ne lui est pas adressé.

import type { WorkstationAction } from "./actions.ts";
import type { RawInteraction } from "./observation.ts";
import type { HarnessTarget } from "./harness.ts";
import type { SttSettings } from "./stt.ts";

/** `chrome.storage.local` : ce que l'utilisateur règle dans la page d'options et le popup. */
export type Settings = {
  pairing: HarnessTarget | null;
  stt: SttSettings;
  excluded: string[];
  /**
   * Pause locale du poste sur ce navigateur (popup) : ni observation, ni long-poll des
   * actions, ni exécution. La pause du serveur est `paused` du statut.
   */
  observationPaused: boolean;
  /** Le libellé de ce navigateur pour le serveur et les apps (« Perso », « ADEO »…) ; vide : son identifiant. */
  browserLabel: string;
};

export type LinkState = {
  state: "unpaired" | "connecting" | "online" | "offline" | "unauthorized" | "paused";
  detail: string;
  at: number;
};

export type MeetingState = {
  id: string;
  tabId: number;
  title: string;
  startedAt: number;
  micro: "on" | "refused";
  /** Dernière erreur de transcription (oMLX injoignable…), vide sinon. */
  error: string;
};

/** Ce que le document offscreen reçoit pour tenir le long-poll et transcrire. */
export type OffscreenConfig = {
  pairing: HarnessTarget | null;
  stt: SttSettings;
  version: string;
  /** La pause locale : le long-poll des actions est suspendu. */
  paused: boolean;
  /** Les onglets de la fenêtre de l'agent, rapportés au serveur à chaque long-poll (`X-OMP-Agent-Tabs`). */
  agentTabs: number[];
};

/** Une action vue par l'extension, pour le popup : la dernière en cours et le journal des dernières. */
export type ActionLog = {
  seq: number;
  kind: string;
  rationale: string;
  origin: string;
  state: "running" | "done" | "failed" | "needs_approval";
  /** L'erreur, ou ce qui attend l'humain ; vide sinon. */
  detail: string;
  at: number;
};

/** Les actions gardées pour le popup. */
export const ACTION_LOG_KEEP = 10;

export type PopupStatus = {
  paired: boolean;
  link: LinkState;
  observationPaused: boolean;
  serverPaused: boolean | null;
  /** L'arrêt d'urgence en cours côté serveur (qui, quand) ; `null` sinon ou inconnu. */
  stopped: { at: number; by: string } | null;
  pendingApprovals: number | null;
  meeting: MeetingState | null;
  /** L'action que l'extension exécute en ce moment. */
  current: ActionLog | null;
  /** Les dernières actions exécutées (la plus récente d'abord), avec leur raison. */
  recent: ActionLog[];
  version: string;
};

export type ToBackground =
  | { to: "background"; type: "offscreen-ready" }
  | { to: "background"; type: "poll-state"; state: LinkState["state"]; detail: string }
  | { to: "background"; type: "execute"; action: WorkstationAction }
  | { to: "background"; type: "observe"; interaction: RawInteraction }
  | { to: "background"; type: "status" }
  | { to: "background"; type: "set-observation-paused"; paused: boolean }
  | { to: "background"; type: "meeting-start"; tabId: number; title: string; url: string }
  | { to: "background"; type: "meeting-stop" }
  | { to: "background"; type: "meeting-ended"; reason: string }
  | { to: "background"; type: "meeting-error"; error: string }
  | { to: "background"; type: "settings-changed" }
  | { to: "background"; type: "emergency-stop" }
  | { to: "background"; type: "intake-post"; text: string }
  | { to: "background"; type: "intake-get" }
  | { to: "background"; type: "intake-confirm"; id: string }
  | { to: "background"; type: "intake-cancel"; id: string }
  | { to: "background"; type: "intake-answer"; id: string; text: string }
  | { to: "background"; type: "questions-get" }
  | { to: "background"; type: "question-answer"; runId: string; id: number; answer: string };

export type ToOffscreen =
  | { to: "offscreen"; type: "config"; config: OffscreenConfig }
  | { to: "offscreen"; type: "capture-start"; streamId: string; meetingId: string }
  | { to: "offscreen"; type: "capture-stop" };

/** Réponse uniforme d'un message qui peut échouer. */
export type Reply<T = undefined> = { ok: true; value: T } | { ok: false; error: string };
