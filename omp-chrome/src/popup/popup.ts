// Le popup : en tête, deux gestes sur l'onglet actif — « Faire ça sur cette page » (une consigne,
// Entrée) et « En faire un fil » (un bouton) — qui posent une Demande avec la page (adresse,
// titre, sélection : lues par le service worker), et le suivi de cette Demande (relue à chaque
// ouverture, précisée, confirmée ou annulée par le service worker) ; puis les questions en attente
// du harness (leur carte, puis le schéma de bifurcation en SVG construit en code ; un clic sur une
// option y répond). Le reste est replié dessous, sous l'état de la liaison avec le serveur (pause
// et arrêt d'urgence compris) : le lien vers OMP Console quand des actions attendent
// l'approbation, la Demande sans la page, le bouton Stop, l'action en cours et les dernières
// actions avec leur raison, la pause locale du poste, la transcription de l'onglet actif
// (l'ouverture du popup accorde activeTab ; le service worker demande alors le flux par
// chrome.tabCapture.getMediaStreamId) et les réglages.
//
// Il se tient à jour tout seul : chaque écriture du service worker dans `chrome.storage`
// (action en cours, journal, liaison, meeting, réglages) le redessine, et l'état du serveur
// est relu toutes les 5 s tant qu'il est ouvert.

import { element } from "../dom.ts";
import { describeIntake, INTAKE_KEY, type Intake } from "../lib/intake.ts";
import type { ActionLog, LinkState, MeetingState, PopupStatus, Reply } from "../lib/messages.ts";
import {
  layoutSchema,
  optionLine,
  type PendingQuestion,
  SCHEMA_LINE_HEIGHT,
  SCHEMA_PAD,
  type SchemaLayout,
} from "../lib/questions.ts";
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
    detail: "Le poste est en pause : aucune action ne part et l'observation est refusée.",
  },
};

const SERVER_REFRESH_MS = 5_000;

const stateEl = element("state", HTMLSpanElement);
/** Le reste du popup, replié sous les deux gestes. */
const more = element("more", HTMLDetailsElement);
let unfolded = false;
const stateDetail = element("state-detail", HTMLParagraphElement);
const approve = element("approve", HTMLButtonElement);
/** Le lien d'app qui ouvre la section Poste d'OMP Console (`HarnessWidgetLink` côté app). */
const CONSOLE_LINK = "ompconsole://workstation";
const stopButton = element("stop", HTMLButtonElement);
const stopMessage = element("stop-message", HTMLParagraphElement);
const currentEl = element("current", HTMLParagraphElement);
const recentEl = element("recent", HTMLOListElement);
const recentEmpty = element("recent-empty", HTMLParagraphElement);
const observe = element("observe", HTMLInputElement);
const observeDetail = element("observe-detail", HTMLParagraphElement);
const meetingButton = element("meeting", HTMLButtonElement);
const meetingMessage = element("meeting-message", HTMLParagraphElement);

function showMessage(target: HTMLParagraphElement, text: string, kind: "error" | "success" | "" = ""): void {
  target.textContent = text;
  target.className = `message ${kind}`;
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
    meetingMessage,
    `Transcription en cours depuis ${minutes} min de « ${meeting.title} », ${micro}.${meeting.error ? ` Dernière erreur : ${meeting.error}` : ""}`,
    meeting.error ? "error" : "",
  );
}

const OUTCOMES: Record<ActionLog["state"], string> = {
  running: "en cours",
  done: "faite",
  failed: "échouée",
  needs_approval: "attend votre approbation",
};

function time(at: number): string {
  return new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Une action : son geste, son issue, qui l'a voulue et pourquoi (textContent seulement : jamais de HTML). */
function actionItem(log: ActionLog): HTMLLIElement {
  const item = document.createElement("li");
  item.className = log.state;
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = `#${log.seq} ${log.kind}`;
  const origin = log.origin === "agent" ? "agent 24/24" : log.origin === "session" ? "session omp" : log.origin;
  item.append(
    kind,
    ` — ${OUTCOMES[log.state]} à ${time(log.at)}${origin ? ` (${origin})` : ""}`,
    document.createElement("br"),
    `Raison : ${log.rationale || "(aucune)"}`,
  );
  if (log.detail !== "") item.append(document.createElement("br"), log.detail);
  return item;
}

function render(status: PopupStatus): void {
  element("version", HTMLSpanElement).textContent = `v${status.version}`;
  const paused = status.serverPaused === true || status.observationPaused;
  const state = paused ? "paused" : status.link.state;
  stateEl.className = `state ${state}`;
  stateEl.textContent = status.stopped ? "Arrêt d'urgence" : STATES[state].title;
  const why: string[] = [];
  if (status.stopped)
    why.push(
      `Arrêté par ${status.stopped.by} à ${time(status.stopped.at)} : seule l'app approbatrice (OMP Console) relance le poste.`,
    );
  else if (status.serverPaused === true) why.push("Le serveur a mis le poste en pause (OMP Console).");
  if (status.observationPaused) why.push("Ce navigateur est en pause : ni observation ni action.");
  const detail = state === "offline" || state === "unauthorized" ? status.link.detail : "";
  const pending =
    status.pendingApprovals !== null && status.pendingApprovals > 0
      ? `${status.pendingApprovals} action(s) attendent votre approbation.`
      : "";
  stateDetail.textContent = [
    why.length > 0 ? why.join(" ") : `${STATES[state].detail}${detail ? ` (${detail})` : ""}`,
    pending,
  ]
    .filter(Boolean)
    .join(" ");
  approve.hidden = pending === "";
  // Replié par défaut ; à la première lecture, il s'ouvre seul quand quelque chose y attend l'humain.
  if (!unfolded) {
    unfolded = true;
    more.open = (state !== "online" && state !== "connecting") || status.stopped !== null || pending !== "";
  }
  stopButton.disabled = !status.paired;

  currentEl.textContent = status.current
    ? `#${status.current.seq} ${status.current.kind} depuis ${time(status.current.at)} — ${status.current.rationale}`
    : "Aucune.";
  recentEl.replaceChildren(...status.recent.map(actionItem));
  recentEmpty.hidden = status.recent.length > 0;

  observe.checked = !status.observationPaused;
  observe.disabled = !status.paired;
  observeDetail.textContent = status.observationPaused
    ? "En pause sur ce navigateur : rien n'est observé, aucune action n'est reçue ni exécutée."
    : "Observe les sites et les gestes (jamais ce que vous saisissez, jamais les mots de passe), hors sites exclus, et exécute les actions de l'agent.";
  meetingButton.disabled = !status.paired;
  renderMeeting(status.meeting);
}

let refreshing: Promise<PopupStatus | null> | null = null;

async function load(): Promise<PopupStatus | null> {
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

/** Un seul rafraîchissement à la fois : les écritures en rafale n'empilent pas d'appels au serveur. */
function refresh(): Promise<PopupStatus | null> {
  refreshing ??= load().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  showMessage(stopMessage, "Arrêt en cours…");
  void (async () => {
    const stopped = await ask<{ cancelled: number[] }>({ to: "background", type: "emergency-stop" });
    showMessage(
      stopMessage,
      stopped.ok
        ? `Poste arrêté : ${stopped.value.cancelled.length} action(s) annulée(s). La reprise du serveur se fait dans OMP Console.`
        : stopped.error,
      stopped.ok ? "success" : "error",
    );
    await refresh();
  })();
});

approve.addEventListener("click", () => {
  // Le lien d'app s'ouvre par un onglet : Chrome le passe à OMP Console.
  void chrome.tabs.create({ url: CONSOLE_LINK });
});

observe.addEventListener("change", () => {
  void ask({ to: "background", type: "set-observation-paused", paused: !observe.checked }).then(refresh);
});

meetingButton.addEventListener("click", () => {
  meetingButton.disabled = true;
  void (async () => {
    const status = await refresh();
    if (status?.meeting) {
      showMessage(meetingMessage, "Arrêt : les derniers segments sont transcrits…");
      const stopped = await ask({ to: "background", type: "meeting-stop" });
      showMessage(
        meetingMessage,
        stopped.ok ? "Transcription terminée : le résumé se prépare sur le serveur." : stopped.error,
        stopped.ok ? "success" : "error",
      );
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) {
        showMessage(meetingMessage, "Aucun onglet actif à transcrire.", "error");
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
        else showMessage(meetingMessage, started.error, "error");
      }
    }
    meetingButton.disabled = false;
    await refresh();
  })();
});

element("options", HTMLButtonElement).addEventListener("click", () => void chrome.runtime.openOptionsPage());

// ── Demande : posée, relue, confirmée, annulée ou précisée par le service worker ──

const intakeText = element("intake-text", HTMLTextAreaElement);
const intakeSend = element("intake-send", HTMLButtonElement);
const intakeBox = element("intake", HTMLDivElement);
const intakeStatus = element("intake-status", HTMLParagraphElement);
const intakeLines = element("intake-lines", HTMLUListElement);
const intakeNote = element("intake-note", HTMLParagraphElement);
const intakeReply = element("intake-reply", HTMLDivElement);
const intakeAnswerText = element("intake-answer-text", HTMLTextAreaElement);
const intakeAnswer = element("intake-answer", HTMLButtonElement);
const intakeConfirm = element("intake-confirm", HTMLButtonElement);
const intakeCancel = element("intake-cancel", HTMLButtonElement);
const intakeMessage = element("intake-message", HTMLParagraphElement);

let shownIntake: Intake | null = null;

function renderIntake(intake: Intake | null): void {
  shownIntake = intake;
  intakeBox.hidden = intake === null;
  if (intake === null) return;
  const display = describeIntake(intake);
  intakeStatus.textContent = display.status;
  intakeLines.replaceChildren(
    ...display.lines.map((line) => {
      const item = document.createElement("li");
      item.textContent = line;
      return item;
    }),
  );
  intakeNote.textContent = display.note;
  intakeReply.hidden = !display.answer;
  intakeConfirm.hidden = !display.confirm;
  intakeCancel.hidden = !display.cancel;
}

/** Applique la réponse du service worker : la demande, ou le refus en français. */
function applyIntake(reply: Reply<Intake | null>): void {
  if (reply.ok) {
    showMessage(intakeMessage, "");
    renderIntake(reply.value);
  } else showMessage(intakeMessage, reply.error, "error");
}

function loadIntake(): void {
  void ask<Intake | null>({ to: "background", type: "intake-get" }).then(applyIntake);
}

intakeSend.addEventListener("click", () => {
  const text = intakeText.value;
  intakeSend.disabled = true;
  void ask<Intake | null>({ to: "background", type: "intake-post", text })
    .then((reply) => {
      applyIntake(reply);
      if (reply.ok) intakeText.value = "";
    })
    .finally(() => {
      intakeSend.disabled = false;
    });
});

// ── Les deux gestes sur l'onglet actif : la demande part avec la page ──

const pageAsk = element("page-ask", HTMLInputElement);
const pageThread = element("page-thread", HTMLButtonElement);

/** Pose la demande sur l'onglet actif ; `text: null` : « En faire un fil ». */
async function askOnPage(text: string | null): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    showMessage(intakeMessage, "Aucun onglet actif.", "error");
    return;
  }
  pageAsk.disabled = true;
  pageThread.disabled = true;
  const reply = await ask<Intake | null>({ to: "background", type: "intake-page", tabId: tab.id, text });
  applyIntake(reply);
  if (reply.ok) pageAsk.value = "";
  pageAsk.disabled = false;
  pageThread.disabled = false;
}

pageAsk.addEventListener("keydown", (event) => {
  // Entrée envoie la consigne ; pendant une composition (accents, IME), elle la valide seulement.
  if (event.key === "Enter" && !event.isComposing && pageAsk.value.trim() !== "") void askOnPage(pageAsk.value);
});

pageThread.addEventListener("click", () => void askOnPage(null));

intakeAnswer.addEventListener("click", () => {
  if (shownIntake === null) return;
  void ask<Intake | null>({
    to: "background",
    type: "intake-answer",
    id: shownIntake.id,
    text: intakeAnswerText.value,
  }).then((reply) => {
    applyIntake(reply);
    if (reply.ok) intakeAnswerText.value = "";
  });
});

intakeConfirm.addEventListener("click", () => {
  if (shownIntake === null) return;
  void ask<Intake | null>({ to: "background", type: "intake-confirm", id: shownIntake.id }).then(applyIntake);
});

intakeCancel.addEventListener("click", () => {
  if (shownIntake === null) return;
  void ask<Intake | null>({ to: "background", type: "intake-cancel", id: shownIntake.id }).then(applyIntake);
});

// ── Questions en attente : la carte (headline, enjeu, options), puis le schéma de bifurcation en SVG ──

const SVG = "http://www.w3.org/2000/svg";
const questionsBox = element("questions", HTMLElement);
const questionsList = element("questions-list", HTMLDivElement);
const questionsMessage = element("questions-message", HTMLParagraphElement);

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

/** Le schéma dessiné en code : rectangles, arcs et `textContent`, jamais de balisage venu du serveur. */
function schemaSvg(layout: SchemaLayout, answer: (option: string) => void): SVGSVGElement {
  const root = svg("svg", { viewBox: `0 0 ${layout.width} ${layout.height}`, width: "100%", role: "img" });
  root.classList.add("schema");
  for (const link of layout.links) {
    const line = svg("line", { x1: link.x1, y1: link.y1, x2: link.x2, y2: link.y2 });
    line.classList.add("schema-link");
    if (link.recommended) line.classList.add("recommended");
    root.append(line);
  }
  for (const box of layout.boxes) {
    const group = svg("g", {});
    group.classList.add("schema-node", box.kind);
    if (box.recommended) group.classList.add("recommended");
    const rect = svg("rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 });
    const label = svg("text", { x: box.x + SCHEMA_PAD, y: box.y + SCHEMA_PAD });
    box.lines.forEach((line, index) => {
      const span = svg("tspan", {
        x: box.x + SCHEMA_PAD,
        dy: index === 0 ? SCHEMA_LINE_HEIGHT - 3 : SCHEMA_LINE_HEIGHT,
      });
      span.textContent = line;
      label.append(span);
    });
    const title = svg("title", {});
    title.textContent = box.lines.join(" ");
    group.append(title, rect, label);
    const option = box.answer;
    if (option !== null) {
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      group.addEventListener("click", () => answer(option));
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") answer(option);
      });
    }
    root.append(group);
  }
  return root;
}

function questionCard(question: PendingQuestion): HTMLElement {
  const card = document.createElement("article");
  card.className = "question";
  const feature = document.createElement("p");
  feature.className = "muted";
  feature.textContent = question.feature;
  const headline = document.createElement("h3");
  headline.textContent = question.headline;
  card.append(feature, headline);
  if (question.stake !== "") {
    const stake = document.createElement("p");
    stake.textContent = `Enjeu : ${question.stake}`;
    card.append(stake);
  }
  const answer = (option: string) => {
    void ask<PendingQuestion[]>({
      to: "background",
      type: "question-answer",
      runId: question.runId,
      id: question.id,
      answer: option,
    }).then(applyQuestions);
  };
  const options = document.createElement("ul");
  options.className = "options";
  for (const option of question.options) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = option.recommended ? "" : "secondary";
    button.textContent = optionLine(option);
    button.addEventListener("click", () => answer(option.label));
    item.append(button);
    options.append(item);
  }
  card.append(options);
  if (question.schema !== null) card.append(schemaSvg(layoutSchema(question.schema), answer));
  return card;
}

function applyQuestions(reply: Reply<PendingQuestion[]>): void {
  if (!reply.ok) {
    questionsBox.hidden = false;
    showMessage(questionsMessage, reply.error, "error");
    return;
  }
  showMessage(questionsMessage, "");
  questionsBox.hidden = reply.value.length === 0;
  questionsList.replaceChildren(...reply.value.map(questionCard));
}

function loadQuestions(): void {
  void ask<PendingQuestion[]>({ to: "background", type: "questions-get" }).then(applyQuestions);
}

// Le direct : les écritures du service worker qui changent ce que montre le popup le redessinent
// (pas `serverPaused`, que la lecture du statut écrit elle-même : ce serait une boucle).
const LIVE_KEYS: Record<string, true> = {
  current: true,
  recent: true,
  link: true,
  meeting: true,
  settings: true,
  [INTAKE_KEY]: true,
};
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((key) => LIVE_KEYS[key] === true)) void refresh();
});
setInterval(() => {
  void refresh();
  // Une demande en classement est relue jusqu'à son plan, sa question, sa réponse ou son échec.
  if (shownIntake?.state === "classifying") loadIntake();
}, SERVER_REFRESH_MS);

void refresh();
loadIntake();
loadQuestions();
