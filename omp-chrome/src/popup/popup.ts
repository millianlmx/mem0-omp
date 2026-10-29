// Le popup : état de la liaison avec le serveur, pause locale de l'observation,
// transcription de l'onglet actif (l'ouverture du popup accorde activeTab ; le service
// worker demande alors le flux par chrome.tabCapture.getMediaStreamId),
// lien vers les réglages.

import { element } from "../dom.ts";
import type { LinkState, MeetingState, PopupStatus } from "../lib/messages.ts";
import { ask } from "../store.ts";

const STATES: Record<LinkState["state"], { title: string; detail: string }> = {
  unpaired: { title: "Non appairée", detail: "Collez le code omp1: du serveur dans les réglages." },
  connecting: { title: "Connexion…", detail: "L'extension joint le serveur." },
  online: { title: "En ligne", detail: "L'extension reçoit les actions du serveur." },
  offline: {
    title: "Hors ligne",
    detail: "Le serveur est injoignable ; l'observation est gardée et envoyée au retour.",
  },
  unauthorized: {
    title: "Jeton refusé",
    detail: "Le serveur refuse le jeton : collez un code d'appairage neuf dans les réglages.",
  },
  paused: {
    title: "En pause",
    detail: "Le poste est en pause depuis OMP Console : aucune action ne part et l'observation est refusée.",
  },
};

const stateEl = element("state", HTMLDivElement);
const stateDetail = element("state-detail", HTMLParagraphElement);
const observe = element("observe", HTMLInputElement);
const observeDetail = element("observe-detail", HTMLParagraphElement);
const meetingButton = element("meeting", HTMLButtonElement);
const meetingMessage = element("meeting-message", HTMLParagraphElement);

function showMessage(text: string, kind: "error" | "success" | "" = ""): void {
  meetingMessage.textContent = text;
  meetingMessage.className = `message ${kind}`;
}

function renderMeeting(meeting: MeetingState | null): void {
  meetingButton.textContent = meeting ? "Arrêter la transcription" : "Transcrire cet onglet";
  if (meeting === null) return;
  const minutes = Math.max(0, Math.round((Date.now() - meeting.startedAt) / 60_000));
  const micro =
    meeting.micro === "on"
      ? "micro compris"
      : "micro refusé : seul l'audio de l'onglet est transcrit (autorisez le micro dans les réglages)";
  showMessage(
    `Transcription en cours depuis ${minutes} min de « ${meeting.title} », ${micro}.${meeting.error ? ` Dernière erreur : ${meeting.error}` : ""}`,
    meeting.error ? "error" : "",
  );
}

function render(status: PopupStatus): void {
  element("version", HTMLSpanElement).textContent = `v${status.version}`;
  const state = status.serverPaused === true ? "paused" : status.link.state;
  stateEl.className = `state ${state}`;
  stateEl.textContent = STATES[state].title;
  const pending =
    status.pendingApprovals !== null && status.pendingApprovals > 0
      ? ` ${status.pendingApprovals} action(s) attendent votre approbation dans OMP Console.`
      : "";
  const detail = state === "offline" || state === "unauthorized" ? status.link.detail : "";
  stateDetail.textContent = `${STATES[state].detail}${detail ? ` (${detail})` : ""}${pending}`;
  observe.checked = !status.observationPaused;
  observe.disabled = !status.paired;
  observeDetail.textContent = status.observationPaused
    ? "Observation en pause sur ce navigateur : rien n'est enregistré."
    : "Sites visités et gestes (jamais ce que vous saisissez, jamais les mots de passe), hors sites exclus.";
  meetingButton.disabled = !status.paired;
  renderMeeting(status.meeting);
}

async function refresh(): Promise<PopupStatus | null> {
  const reply = await ask<PopupStatus>({ to: "background", type: "status" });
  if (!reply.ok) {
    stateEl.className = "state offline";
    stateEl.textContent = "Extension indisponible";
    stateDetail.textContent = reply.error;
    return null;
  }
  render(reply.value);
  return reply.value;
}

observe.addEventListener("change", () => {
  void ask({ to: "background", type: "set-observation-paused", paused: !observe.checked }).then(refresh);
});

meetingButton.addEventListener("click", () => {
  meetingButton.disabled = true;
  void (async () => {
    const status = await refresh();
    if (status?.meeting) {
      showMessage("Arrêt : les derniers segments sont transcrits…");
      const stopped = await ask({ to: "background", type: "meeting-stop" });
      showMessage(
        stopped.ok ? "Transcription terminée : le résumé se prépare sur le serveur." : stopped.error,
        stopped.ok ? "success" : "error",
      );
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) {
        showMessage("Aucun onglet actif à transcrire.", "error");
      } else {
        // Le flux de l'onglet est demandé par le service worker : l'ouverture du popup sur
        // cet onglet (activeTab) l'y autorise.
        const started = await ask<MeetingState>({
          to: "background",
          type: "meeting-start",
          tabId: tab.id,
          title: tab.title ?? "",
          url: tab.url ?? "",
        });
        if (started.ok) renderMeeting(started.value);
        else showMessage(started.error, "error");
      }
    }
    meetingButton.disabled = false;
    await refresh();
  })();
});

element("options", HTMLButtonElement).addEventListener("click", () => void chrome.runtime.openOptionsPage());

void refresh();
