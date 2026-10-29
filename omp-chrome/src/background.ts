// Le service worker de l'extension omp-chrome : observation (visites, interactions,
// tampon persistant envoyé par lots), exécution des actions remises par le document
// offscreen (qui tient le long-poll), et pilotage des meetings (capture + transcription).
//
// Un service worker MV3 peut mourir à tout instant : tout état vit dans chrome.storage
// (`local` pour les réglages et le tampon d'observations, `session` pour la visite en
// cours, la fenêtre de l'agent, le meeting et l'état de la liaison), et les écouteurs
// sont posés au premier tour de l'évaluation du module.

import { agentWindowId, execute } from "./executor.ts";
import type { WorkstationAction } from "./lib/actions.ts";
import { HarnessError, harnessCall } from "./lib/harness.ts";
import type {
  LinkState,
  MeetingState,
  OffscreenConfig,
  PopupStatus,
  Reply,
  Settings,
  ToBackground,
  ToOffscreen,
} from "./lib/messages.ts";
import type { Observation } from "./lib/observation.ts";
import {
  MAX_BATCH,
  appendCapped,
  isRawInteraction,
  sanitizeInteraction,
  sanitizeVisit,
  takeBatch,
} from "./lib/observation.ts";
import { validateSttUrl } from "./lib/stt.ts";
import { stripUrl } from "./lib/url.ts";
import { loadSettings, saveSettings } from "./store.ts";

const VERSION = chrome.runtime.getManifest().version;
const TICK = "omp-tick";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const BUFFER = "buffer";
/** Une visite longue est coupée : le profil voit le temps passé sans attendre le changement d'onglet. */
const VISIT_CUT_MS = 10 * 60_000;
const IDLE_S = 60;

type Visit = { tabId: number; url: string; title: string; startedAt: number };

/** Une file d'exécution : les tâches d'un même état (tampon, visite, meeting) ne s'entrelacent pas. */
function queue(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  };
}
const inBuffer = queue();
const inVisits = queue();
const inMeeting = queue();

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function sessionValue(key: string): Promise<unknown> {
  return (await chrome.storage.session.get(key))[key];
}

async function setLink(state: LinkState["state"], detail = ""): Promise<void> {
  const link: LinkState = { state, detail, at: Date.now() };
  await chrome.storage.session.set({ link });
}

// ── Document offscreen ────────────────────────────────────────────────────

let creating: Promise<void> | null = null;

async function offscreenConfig(): Promise<OffscreenConfig> {
  const settings = await loadSettings();
  return { pairing: settings.pairing, stt: settings.stt, version: VERSION };
}

async function pushConfig(): Promise<void> {
  const update: ToOffscreen = { to: "offscreen", type: "config", config: await offscreenConfig() };
  await chrome.runtime.sendMessage(update).catch(() => undefined);
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification:
        "Capture l'audio d'un meeting (onglet et micro) pour la transcription locale, et tient la relève des actions du poste.",
    })
    .finally(() => {
      creating = null;
    });
  await creating;
  await pushConfig();
}

async function toOffscreen<T>(request: ToOffscreen): Promise<Reply<T>> {
  await ensureOffscreen();
  try {
    // Réponse du document offscreen de cette extension (offscreen.ts), toujours une Reply.
    const reply = (await chrome.runtime.sendMessage(request)) as Reply<T> | undefined;
    return reply ?? { ok: false, error: "le document offscreen n'a pas répondu" };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

// ── Tampon d'observations ─────────────────────────────────────────────────

async function readBuffer(): Promise<Observation[]> {
  const stored = (await chrome.storage.local.get(BUFFER))[BUFFER];
  // Écrit par ce module seulement (record / flushNow), d'observations déjà nettoyées.
  return Array.isArray(stored) ? (stored as Observation[]) : [];
}

/** Envoie le tampon par lots de 500 au plus ; appelé dans la file du tampon. */
async function flushNow(): Promise<void> {
  const { pairing } = await loadSettings();
  if (pairing === null) return;
  for (let round = 0; round < 10; round++) {
    const { batch, rest } = takeBatch(await readBuffer());
    if (batch.length === 0) return;
    try {
      await harnessCall(
        pairing,
        "POST",
        "/v1/workstation/observations",
        { tz: new Date().getTimezoneOffset(), events: batch },
        { signal: AbortSignal.timeout(15_000) },
      );
      await chrome.storage.local.set({ [BUFFER]: rest });
      await chrome.storage.session.set({ serverPaused: false });
    } catch (error) {
      if (error instanceof HarnessError && error.status === 409) {
        // Le poste est en pause : l'observation est refusée, le tampon est abandonné.
        await chrome.storage.local.set({ [BUFFER]: [] });
        await chrome.storage.session.set({ serverPaused: true });
      } else if (error instanceof HarnessError && (error.status === 401 || error.status === 403)) {
        await setLink("unauthorized", error.message);
      }
      return;
    }
  }
}

function record(events: Observation[]): Promise<void> {
  return inBuffer(async () => {
    if (events.length === 0) return;
    const next = appendCapped(await readBuffer(), events);
    await chrome.storage.local.set({ [BUFFER]: next });
    if (next.length >= MAX_BATCH) await flushNow();
  });
}

const flush = () => inBuffer(flushNow);

/** L'observation est-elle permise maintenant ? (appairée, ni en pause locale, ni en pause serveur) */
async function observing(settings: Settings): Promise<boolean> {
  return settings.pairing !== null && !settings.observationPaused && (await sessionValue("serverPaused")) !== true;
}

// ── Visites ───────────────────────────────────────────────────────────────

async function readVisit(): Promise<Visit | null> {
  const stored = await sessionValue("visit");
  // Écrit par refocus seulement.
  return typeof stored === "object" && stored !== null ? (stored as Visit) : null;
}

/** L'onglet focalisé, si l'utilisateur est actif dans une fenêtre qui n'est pas celle de l'agent. */
async function focusedTab(settings: Settings): Promise<chrome.tabs.Tab | null> {
  if (!(await observing(settings))) return null;
  if ((await chrome.idle.queryState(IDLE_S)) !== "active") return null;
  const win = await chrome.windows.getLastFocused().catch(() => null);
  if (win === null || !win.focused || win.id === undefined || win.id === (await agentWindowId())) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (tab?.id === undefined || stripUrl(tab.url ?? "") === null) return null;
  return tab;
}

/**
 * Recalcule la visite : ferme (et enregistre) celle qui s'achève, ouvre celle de l'onglet
 * focalisé. `cut` coupe une visite longue sans changer d'onglet.
 */
function refocus(cut = false): Promise<void> {
  return inVisits(async () => {
    const now = Date.now();
    const settings = await loadSettings();
    const previous = await readVisit();
    const tab = await focusedTab(settings);
    const sameTab =
      previous !== null && tab?.id === previous.tabId && stripUrl(tab.url ?? "") === stripUrl(previous.url);
    if (sameTab && !(cut && now - previous.startedAt >= VISIT_CUT_MS)) {
      if (tab.title !== undefined && tab.title !== previous.title) {
        await chrome.storage.session.set({ visit: { ...previous, title: tab.title } });
      }
      return;
    }
    if (previous !== null) {
      const visit = sanitizeVisit(
        { at: previous.startedAt, url: previous.url, title: previous.title, durationMs: now - previous.startedAt },
        settings.excluded,
      );
      if (visit !== null) void record([visit]);
    }
    const next: Visit | null =
      tab?.id !== undefined ? { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "", startedAt: now } : null;
    await chrome.storage.session.set({ visit: next });
  });
}

// ── Interactions ──────────────────────────────────────────────────────────

async function observe(raw: unknown, sender: chrome.runtime.MessageSender): Promise<void> {
  const tab = sender.tab;
  if (tab === undefined || sender.frameId !== 0 || !isRawInteraction(raw)) return;
  const settings = await loadSettings();
  if (!(await observing(settings))) return;
  // Jamais les onglets de la fenêtre de l'agent : ce sont ses gestes, pas ceux de l'utilisateur.
  if (tab.windowId === (await agentWindowId())) return;
  // L'adresse et le titre viennent du navigateur, pas de la page.
  const interaction = sanitizeInteraction(
    { ...raw, url: tab.url ?? raw.url, title: tab.title ?? raw.title },
    settings.excluded,
  );
  if (interaction !== null) await record([interaction]);
}

// ── Actions ───────────────────────────────────────────────────────────────

async function runAction(action: WorkstationAction): Promise<void> {
  const settings = await loadSettings();
  if (settings.pairing === null || !Number.isSafeInteger(action.seq)) return;
  const outcome = await execute(action, settings.excluded);
  try {
    await harnessCall(settings.pairing, "POST", `/v1/workstation/actions/${action.seq}/result`, outcome);
  } catch (error) {
    await setLink("offline", `résultat de l'action ${action.seq} non remis : ${message(error)}`);
  }
}

// ── Meetings ──────────────────────────────────────────────────────────────

async function readMeeting(): Promise<MeetingState | null> {
  const stored = await sessionValue("meeting");
  // Écrit par startMeeting / meetingError seulement.
  return typeof stored === "object" && stored !== null ? (stored as MeetingState) : null;
}

async function badge(recording: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: recording ? "REC" : "" });
  if (recording) await chrome.action.setBadgeBackgroundColor({ color: "#c62828" });
}

function startMeeting(request: { tabId: number; title: string; url: string }): Promise<Reply<MeetingState>> {
  return inMeeting(async (): Promise<Reply<MeetingState>> => {
    const settings = await loadSettings();
    if (settings.pairing === null)
      return { ok: false, error: "extension non appairée : collez le code omp1: dans les réglages" };
    const stt = validateSttUrl(settings.stt.url);
    if (!stt.ok) return { ok: false, error: `transcription : ${stt.error}` };
    if ((await readMeeting()) !== null) return { ok: false, error: "une transcription est déjà en cours" };
    const startedAt = Date.now();
    let meetingId: string;
    try {
      const created = await harnessCall<{ meeting?: { id?: unknown } }>(
        settings.pairing,
        "POST",
        "/v1/workstation/meetings",
        {
          title: request.title,
          url: stripUrl(request.url) ?? "",
          startedAt,
        },
      );
      const id = created?.meeting?.id;
      if (typeof id !== "string" || id === "") return { ok: false, error: "le harness n'a pas rendu de meeting" };
      meetingId = id;
    } catch (error) {
      return { ok: false, error: `meeting non créé : ${message(error)}` };
    }
    // L'identifiant du flux se demande ICI, pas dans le popup : demandé par le popup, il
    // est lié à son document et l'offscreen ne peut pas l'ouvrir (« Requested device not
    // found ») ; il expire aussi en quelques secondes, donc juste avant de le consommer.
    // L'ouverture du popup sur l'onglet (activeTab) autorise le service worker à le demander.
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: request.tabId });
    } catch (error) {
      await harnessCall(
        settings.pairing,
        "POST",
        `/v1/workstation/meetings/${encodeURIComponent(meetingId)}/end`,
      ).catch(() => undefined);
      return { ok: false, error: `capture de l'onglet refusée : ${message(error)}` };
    }
    const started = await toOffscreen<{ micro: "on" | "refused" }>({
      to: "offscreen",
      type: "capture-start",
      streamId,
      meetingId,
    });
    if (!started.ok) {
      await harnessCall(
        settings.pairing,
        "POST",
        `/v1/workstation/meetings/${encodeURIComponent(meetingId)}/end`,
      ).catch(() => undefined);
      return started;
    }
    const meeting: MeetingState = {
      id: meetingId,
      tabId: request.tabId,
      title: request.title,
      startedAt,
      micro: started.value.micro,
      error: "",
    };
    await chrome.storage.session.set({ meeting });
    await badge(true);
    return { ok: true, value: meeting };
  });
}

function stopMeeting(): Promise<Reply> {
  return inMeeting(async (): Promise<Reply> => {
    const meeting = await readMeeting();
    if (meeting === null) return { ok: true, value: undefined };
    // Les derniers segments sont transcrits et postés AVANT la fin : le digest les voit.
    const stopped = await toOffscreen<undefined>({ to: "offscreen", type: "capture-stop" });
    await chrome.storage.session.set({ meeting: null });
    await badge(false);
    const { pairing } = await loadSettings();
    if (pairing === null) return stopped;
    try {
      await harnessCall(pairing, "POST", `/v1/workstation/meetings/${encodeURIComponent(meeting.id)}/end`);
    } catch (error) {
      return { ok: false, error: `fin du meeting non remise au harness : ${message(error)}` };
    }
    return stopped;
  });
}

async function meetingError(error: string): Promise<void> {
  const meeting = await readMeeting();
  if (meeting !== null) await chrome.storage.session.set({ meeting: { ...meeting, error } });
}

// ── Statut (popup) ────────────────────────────────────────────────────────

async function status(): Promise<PopupStatus> {
  const settings = await loadSettings();
  const stored = await sessionValue("link");
  // Écrit par setLink seulement.
  let link: LinkState =
    typeof stored === "object" && stored !== null
      ? (stored as LinkState)
      : { state: settings.pairing === null ? "unpaired" : "connecting", detail: "", at: 0 };
  if (settings.pairing === null) link = { state: "unpaired", detail: "", at: Date.now() };
  let serverPaused: boolean | null = null;
  let pendingApprovals: number | null = null;
  if (settings.pairing !== null) {
    try {
      const server = await harnessCall<{ paused?: unknown; pending?: unknown }>(
        settings.pairing,
        "GET",
        "/v1/workstation",
        undefined,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      serverPaused = server?.paused === true;
      pendingApprovals = typeof server?.pending === "number" ? server.pending : null;
      await chrome.storage.session.set({ serverPaused });
    } catch (error) {
      if (error instanceof HarnessError && (error.status === 401 || error.status === 403)) {
        link = { state: "unauthorized", detail: error.message, at: Date.now() };
      }
    }
  }
  return {
    paired: settings.pairing !== null,
    link,
    observationPaused: settings.observationPaused,
    serverPaused,
    pendingApprovals,
    meeting: await readMeeting(),
    version: VERSION,
  };
}

// ── Messages ──────────────────────────────────────────────────────────────

function isToBackground(value: unknown): value is ToBackground {
  return typeof value === "object" && value !== null && "to" in value && value.to === "background" && "type" in value;
}

const OK: Reply = { ok: true, value: undefined };

async function handle(request: ToBackground, sender: chrome.runtime.MessageSender): Promise<Reply<unknown>> {
  // Un script de contenu (une page web) ne peut que rapporter une interaction ; tout le
  // reste n'est accepté que des pages de l'extension elle-même.
  const fromExtension = sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(chrome.runtime.getURL(""));
  if (request.type === "observe") {
    await observe(request.interaction, sender);
    return OK;
  }
  if (!fromExtension) return { ok: false, error: "message refusé : il ne vient pas d'une page de l'extension" };
  switch (request.type) {
    case "offscreen-ready":
      return { ok: true, value: await offscreenConfig() };
    case "poll-state":
      await setLink(request.state, request.detail);
      return OK;
    case "execute":
      await runAction(request.action);
      return OK;
    case "status":
      return { ok: true, value: await status() };
    case "set-observation-paused":
      await saveSettings({ observationPaused: request.paused });
      await refocus();
      return OK;
    case "meeting-start":
      return startMeeting(request);
    case "meeting-stop":
      return stopMeeting();
    case "meeting-ended":
      await stopMeeting();
      return OK;
    case "meeting-error":
      await meetingError(request.error);
      return OK;
    case "settings-changed": {
      const settings = await loadSettings();
      if (settings.pairing !== null) await ensureOffscreen();
      await pushConfig();
      await refocus();
      return OK;
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isToBackground(request)) return undefined;
  handle(request, sender).then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: message(error) }));
  return true;
});

// ── Événements du navigateur ──────────────────────────────────────────────

chrome.tabs.onActivated.addListener(() => void refocus());
chrome.windows.onFocusChanged.addListener(() => void refocus());
chrome.idle.onStateChanged.addListener(() => void refocus());
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (tab.active && (change.url !== undefined || change.title !== undefined)) void refocus();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void readMeeting().then((meeting) => {
    if (meeting?.tabId === tabId) void stopMeeting();
  });
  void refocus();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK) return;
  void (async () => {
    const settings = await loadSettings();
    if (settings.pairing !== null) await ensureOffscreen().catch(() => undefined);
    await refocus(true);
    await flush();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void loadSettings().then((settings) => {
    if (settings.pairing === null) void chrome.runtime.openOptionsPage();
  });
});

chrome.runtime.onStartup.addListener(() => void badge(false));

void (async () => {
  // Un lot part au plus toutes les 30 s (période minimale d'une alarme MV3).
  if ((await chrome.alarms.get(TICK)) === undefined) await chrome.alarms.create(TICK, { periodInMinutes: 0.5 });
  chrome.idle.setDetectionInterval(IDLE_S);
  const settings = await loadSettings();
  if (settings.pairing !== null) await ensureOffscreen().catch(() => undefined);
})();
