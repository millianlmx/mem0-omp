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
  /** Pause locale de l'observation (popup) ; la pause du serveur est `paused` du statut. */
  observationPaused: boolean;
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
export type OffscreenConfig = { pairing: HarnessTarget | null; stt: SttSettings; version: string };

export type PopupStatus = {
  paired: boolean;
  link: LinkState;
  observationPaused: boolean;
  serverPaused: boolean | null;
  pendingApprovals: number | null;
  meeting: MeetingState | null;
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
  | { to: "background"; type: "settings-changed" };

export type ToOffscreen =
  | { to: "offscreen"; type: "config"; config: OffscreenConfig }
  | { to: "offscreen"; type: "capture-start"; streamId: string; meetingId: string }
  | { to: "offscreen"; type: "capture-stop" };

/** Réponse uniforme d'un message qui peut échouer. */
export type Reply<T = undefined> = { ok: true; value: T } | { ok: false; error: string };
