// Le service worker de l'extension omp-chrome : observation (visites, interactions,
// tampon persistant envoyé par lots), exécution des actions remises par le document
// offscreen (qui tient le long-poll), pilotage des meetings (capture + transcription),
// le miroir des cookies du profil vers le navigateur du poste sur le VPS (lib/cookie-mirror.ts),
// et l'arrêt d'urgence (bouton Stop du popup) : pause locale, action en cours coupée,
// `POST /v1/workstation/stop` au serveur.
//
// Un service worker MV3 peut mourir à tout instant : tout état vit dans chrome.storage
// (`local` pour les réglages et le tampon d'observations, `session` pour la visite en
// cours, la fenêtre de l'agent, le meeting, l'état de la liaison, l'action en cours, le
// journal des dernières actions que lit le popup et la génération du miroir des cookies),
// et les écouteurs sont posés au premier tour de l'évaluation du module. Seuls les
// changements de cookies pas encore envoyés vivent en mémoire : la copie complète
// périodique du miroir rattrape ceux qu'un arrêt du service worker a perdus.

import { detachAll } from "./cdp.ts";
import { agentTabIds, agentWindowId, execute } from "./executor.ts";
import type { ActionOutcome, WorkstationAction } from "./lib/actions.ts";
import { CookieMirror, type MirrorState } from "./lib/cookie-mirror.ts";
import { HarnessError, type HarnessTarget, harnessCall } from "./lib/harness.ts";
import { INTAKE_KEY, type Intake, settled } from "./lib/intake.ts";
import { type PendingQuestion, pendingQuestions } from "./lib/questions.ts";
import type {
  ActionLog,
  LinkState,
  MeetingState,
  OffscreenConfig,
  PopupStatus,
  Reply,
  Settings,
  ToBackground,
  ToOffscreen,
} from "./lib/messages.ts";
import { ACTION_LOG_KEEP } from "./lib/messages.ts";
import type { Observation } from "./lib/observation.ts";
import {
  MAX_BATCH,
  appendCapped,
  isRawInteraction,
  sanitizeInteraction,
  sanitizeVisit,
  takeBatch,
} from "./lib/observation.ts";
import { pageContext, type PageContext, threadText } from "./lib/page-context.ts";
import { checkStt } from "./lib/stt.ts";
import { hostOf, isExcludedHost, stripUrl } from "./lib/url.ts";
import { identified, loadSettings, saveSettings } from "./store.ts";

const VERSION = chrome.runtime.getManifest().version;
const TICK = "omp-tick";
const OFFSCREEN_URL = "offscreen/offscreen.html";
const BUFFER = "buffer";
/** Une visite longue est coupée : le profil voit le temps passé sans attendre le changement d'onglet. */
const VISIT_CUT_MS = 10 * 60_000;
const IDLE_S = 60;
const MIRROR = "cookieMirror";
/** Les changements de cookies partent au plus 2 s après le premier d'une rafale. */
const MIRROR_FLUSH_MS = 2_000;

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
  return {
    pairing: settings.pairing === null ? null : await identified(settings.pairing, settings.browserLabel),
    stt: settings.stt,
    version: VERSION,
    paused: settings.observationPaused,
    agentTabs: await agentTabIds().catch(() => []),
  };
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
  const { pairing: paired, browserLabel } = await loadSettings();
  if (paired === null) return;
  const pairing = await identified(paired, browserLabel);
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

/** L'action en cours d'exécution : le bouton Stop (ou la pause locale) l'interrompt. */
let running: AbortController | null = null;

async function readRecent(): Promise<ActionLog[]> {
  const stored = await sessionValue("recent");
  // Écrit par logAction seulement.
  return Array.isArray(stored) ? (stored as ActionLog[]) : [];
}

/** L'action en cours (`running`), puis son issue en tête du journal des dernières actions. */
async function logAction(entry: ActionLog): Promise<void> {
  const recent = [entry, ...(await readRecent()).filter((each) => each.seq !== entry.seq)].slice(0, ACTION_LOG_KEEP);
  await chrome.storage.session.set({ recent, current: entry.state === "running" ? entry : null });
}

function detailOf(outcome: ActionOutcome): string {
  if (outcome.outcome === "failed") return outcome.error;
  if (outcome.outcome === "needs_approval") return outcome.approval.summary;
  return "";
}

async function runAction(action: WorkstationAction): Promise<void> {
  const settings = await loadSettings();
  if (settings.pairing === null || !Number.isSafeInteger(action.seq)) return;
  const entry: ActionLog = {
    seq: action.seq,
    kind: String(action.kind),
    rationale: String(action.rationale ?? ""),
    origin: String(action.origin ?? ""),
    state: "running",
    detail: "",
    at: Date.now(),
  };
  const abort = new AbortController();
  // En pause locale, rien ne s'exécute : l'action rend `failed` tout de suite.
  if (settings.observationPaused) abort.abort();
  running = abort;
  await logAction(entry);
  let outcome: ActionOutcome;
  try {
    const pairing = settings.pairing;
    outcome = await execute(action, settings.excluded, abort.signal, {
      // Le fichier d'un `upload`, lu dans le dossier d'envoi du serveur : jamais un chemin du Mac.
      uploadFile: (seq) => harnessCall(pairing, "GET", `/v1/workstation/actions/${seq}/file`),
    });
  } finally {
    if (running === abort) running = null;
  }
  await logAction({ ...entry, state: outcome.outcome, detail: detailOf(outcome), at: Date.now() });
  // Les onglets de la fenêtre de l'agent partent avec le résultat : `open` vient peut-être d'en créer un.
  const agentTabs = await agentTabIds().catch(() => []);
  try {
    await harnessCall(
      await identified(settings.pairing, settings.browserLabel),
      "POST",
      `/v1/workstation/actions/${action.seq}/result`,
      {
        ...outcome,
        agentTabs,
      },
    );
  } catch (error) {
    // 409 : l'action a été annulée (arrêt d'urgence) pendant qu'elle s'exécutait.
    if (!(error instanceof HarnessError && error.status === 409))
      await setLink("offline", `résultat de l'action ${action.seq} non remis : ${message(error)}`);
  }
  await pushConfig();
}

/**
 * L'arrêt d'urgence : la pause locale d'abord (plus de long-poll, plus d'exécution),
 * l'action en cours interrompue, puis le serveur (pause, actions annulées, service de
 * l'agent coupé). La reprise côté serveur appartient à l'approbateur, dans OMP Console.
 */
async function emergencyStop(): Promise<Reply<{ cancelled: number[] }>> {
  await saveSettings({ observationPaused: true });
  running?.abort();
  await detachAll();
  await pushConfig();
  await refocus();
  const { pairing: paired, browserLabel } = await loadSettings();
  if (paired === null) return { ok: true, value: { cancelled: [] } };
  const pairing = await identified(paired, browserLabel);
  try {
    const reply = await harnessCall<{ cancelled?: unknown }>(pairing, "POST", "/v1/workstation/stop", undefined, {
      signal: AbortSignal.timeout(10_000),
    });
    await chrome.storage.session.set({ serverPaused: true });
    const cancelled = Array.isArray(reply?.cancelled) ? reply.cancelled.filter(Number.isSafeInteger) : [];
    return { ok: true, value: { cancelled: cancelled as number[] } };
  } catch (error) {
    return {
      ok: false,
      error: `extension arrêtée, mais le serveur n'a pas reçu l'arrêt : ${message(error)} (réessayez, ou utilisez OMP Console)`,
    };
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
    if ((await readMeeting()) !== null) return { ok: false, error: "une transcription est déjà en cours" };
    const target = await identified(settings.pairing, settings.browserLabel);
    // Une adresse, une clé ou un modèle faux ne se verraient sinon qu'à chaque segment, dans
    // ce popup, et le meeting finirait à « 0 segment transcrit » : on refuse d'emblée.
    try {
      await checkStt(settings.stt);
    } catch (error) {
      return { ok: false, error: `transcription impossible : ${message(error)} (réglages de l'extension)` };
    }
    const startedAt = Date.now();
    let meetingId: string;
    try {
      const created = await harnessCall<{ meeting?: { id?: unknown } }>(target, "POST", "/v1/workstation/meetings", {
        title: request.title,
        url: stripUrl(request.url) ?? "",
        startedAt,
      });
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
      await harnessCall(target, "POST", `/v1/workstation/meetings/${encodeURIComponent(meetingId)}/end`).catch(
        () => undefined,
      );
      return { ok: false, error: `capture de l'onglet refusée : ${message(error)}` };
    }
    const started = await toOffscreen<{ micro: "on" | "refused" }>({
      to: "offscreen",
      type: "capture-start",
      streamId,
      meetingId,
    });
    if (!started.ok) {
      await harnessCall(target, "POST", `/v1/workstation/meetings/${encodeURIComponent(meetingId)}/end`).catch(
        () => undefined,
      );
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
    const { pairing, browserLabel } = await loadSettings();
    if (pairing === null) return stopped;
    try {
      await harnessCall(
        await identified(pairing, browserLabel),
        "POST",
        `/v1/workstation/meetings/${encodeURIComponent(meeting.id)}/end`,
      );
    } catch (error) {
      return { ok: false, error: `fin du meeting non remise au harness : ${message(error)}` };
    }
    return stopped;
  });
}

/** Une erreur de segment : gardée pour le popup et signalée sur l'icône, popup fermé. */
async function meetingError(error: string): Promise<void> {
  const meeting = await readMeeting();
  if (meeting === null) return;
  await chrome.storage.session.set({ meeting: { ...meeting, error } });
  await chrome.action.setBadgeText({ text: "ERR" });
  await chrome.action.setBadgeBackgroundColor({ color: "#e65100" });
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
  let stopped: PopupStatus["stopped"] = null;
  if (settings.pairing !== null) {
    try {
      const server = await harnessCall<{ paused?: unknown; pending?: unknown; stopped?: unknown }>(
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
      const halt = server?.stopped;
      if (typeof halt === "object" && halt !== null && "at" in halt && "by" in halt)
        stopped = { at: Number(halt.at), by: String(halt.by) };
      await chrome.storage.session.set({ serverPaused });
    } catch (error) {
      if (error instanceof HarnessError && (error.status === 401 || error.status === 403)) {
        link = { state: "unauthorized", detail: error.message, at: Date.now() };
      }
    }
  }
  const current = await sessionValue("current");
  return {
    paired: settings.pairing !== null,
    link,
    observationPaused: settings.observationPaused,
    serverPaused,
    stopped,
    pendingApprovals,
    meeting: await readMeeting(),
    // Écrit par logAction seulement.
    current: typeof current === "object" && current !== null ? (current as ActionLog) : null,
    recent: await readRecent(),
    version: VERSION,
  };
}

// ── Demande (popup) ───────────────────────────────────────────────────────

/**
 * Appelle `/v1/intake*` avec l'appairage, présenté avec l'identité de ce navigateur
 * (`X-OMP-Browser`) ; un refus du serveur garde son message français.
 */
async function intakeCall(method: "GET" | "POST", route: string, body?: unknown): Promise<Reply<Intake | null>> {
  const settings = await loadSettings();
  if (settings.pairing === null) return { ok: false, error: "navigateur non appairé : ouvrez les réglages" };
  try {
    const target = await identified(settings.pairing, settings.browserLabel);
    const reply = await harnessCall<{ intake?: Intake }>(target, method, route, body, {
      signal: AbortSignal.timeout(10_000),
    });
    const intake = reply?.intake ?? null;
    // Une demande confirmée ou annulée n'est plus relue à l'ouverture du popup.
    if (intake !== null && settled(intake)) await forgetIntake(intake.id);
    return { ok: true, value: intake };
  } catch (error) {
    if (error instanceof HarnessError && error.status === 404 && route === "/v1/intake")
      return { ok: false, error: "le serveur ne connaît pas encore la Demande : mettez omp-harness à jour" };
    return { ok: false, error: message(error) };
  }
}

async function forgetIntake(id: string): Promise<void> {
  if ((await chrome.storage.local.get(INTAKE_KEY))[INTAKE_KEY] === id) await chrome.storage.local.remove(INTAKE_KEY);
}

/** Pose la demande ; `context` : la page d'où elle part (les deux gestes du popup), une donnée pour le classeur. */
async function postIntake(text: string, context: PageContext | null = null): Promise<Reply<Intake | null>> {
  if (text.trim() === "") return { ok: false, error: "la demande est vide" };
  const body = { text, source: "chrome", ...(context === null ? {} : { context }) };
  const reply = await intakeCall("POST", "/v1/intake", body);
  if (reply.ok && reply.value !== null) await chrome.storage.local.set({ [INTAKE_KEY]: reply.value.id });
  return reply;
}

/** Le texte sélectionné dans l'onglet ; vide quand la page refuse l'injection (boutique d'extensions, PDF). */
async function selectionOf(tabId: number): Promise<string> {
  try {
    const [main] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => getSelection()?.toString() ?? "",
    });
    return typeof main?.result === "string" ? main.result : "";
  } catch {
    return "";
  }
}

/**
 * Un des deux gestes du popup sur l'onglet actif : la demande part avec la page (adresse, titre,
 * sélection). `text: null` : « En faire un fil », au texte généré. Rien ne part d'un site exclu ;
 * hors du web, la consigne part seule et il n'y a pas de fil à faire.
 */
async function postPageIntake(tabId: number, text: string | null): Promise<Reply<Intake | null>> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: "onglet introuvable" };
  }
  const host = hostOf(tab.url ?? "");
  if (host !== null && isExcludedHost(host, (await loadSettings()).excluded))
    return { ok: false, error: `${host} est un site exclu : rien n'en part` };
  const context =
    host === null ? null : pageContext({ url: tab.url ?? "", title: tab.title ?? "" }, await selectionOf(tabId));
  if (text !== null) return postIntake(text, context);
  if (context === null) return { ok: false, error: "cet onglet n'a pas d'adresse web : rien à en faire un fil" };
  return postIntake(threadText(context), context);
}

/** La dernière demande posée depuis ce navigateur, relue au serveur ; `null` s'il n'y en a pas. */
async function readIntake(): Promise<Reply<Intake | null>> {
  const id = (await chrome.storage.local.get(INTAKE_KEY))[INTAKE_KEY];
  if (typeof id !== "string") return { ok: true, value: null };
  const reply = await intakeCall("GET", `/v1/intake/${encodeURIComponent(id)}`);
  if (!reply.ok && reply.error.startsWith("demande inconnue")) await forgetIntake(id);
  return reply;
}

const intakeRoute = (id: string, verb: string) => `/v1/intake/${encodeURIComponent(id)}/${verb}`;

// ── Questions en attente (popup) ──────────────────────────────────────────

/** Les escalades ouvertes de la boîte, lues par leur carte ; un refus du serveur garde son message français. */
async function readQuestions(): Promise<Reply<PendingQuestion[]>> {
  const settings = await loadSettings();
  if (settings.pairing === null) return { ok: true, value: [] };
  try {
    const inbox = await harnessCall<unknown>(settings.pairing, "GET", "/v1/inbox", undefined, {
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: true, value: pendingQuestions(inbox) };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

/** Répond à une escalade du lot (le run reprend quand tout le lot est répondu). */
async function answerQuestion(runId: string, id: number, answer: string): Promise<Reply<PendingQuestion[]>> {
  const settings = await loadSettings();
  if (settings.pairing === null) return { ok: false, error: "navigateur non appairé : ouvrez les réglages" };
  if (answer.trim() === "") return { ok: false, error: "la réponse est vide" };
  try {
    await harnessCall(
      settings.pairing,
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/escalations`,
      { answers: [{ id, answer }] },
      { signal: AbortSignal.timeout(10_000) },
    );
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  return readQuestions();
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
      // La pause locale coupe aussi les actions : l'action en cours, puis le long-poll.
      if (request.paused) {
        running?.abort();
        await detachAll();
      }
      await pushConfig();
      await refocus();
      return OK;
    case "emergency-stop":
      return emergencyStop();
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
    case "intake-post":
      return postIntake(request.text);
    case "intake-page":
      return postPageIntake(request.tabId, request.text);
    case "intake-get":
      return readIntake();
    case "intake-confirm":
      return intakeCall("POST", intakeRoute(request.id, "confirm"), {});
    case "intake-cancel":
      return intakeCall("POST", intakeRoute(request.id, "cancel"), {});
    case "intake-answer":
      if (request.text.trim() === "") return { ok: false, error: "la réponse est vide" };
      return intakeCall("POST", intakeRoute(request.id, "answer"), { text: request.text });
    case "questions-get":
      return readQuestions();
    case "question-answer":
      return answerQuestion(request.runId, request.id, request.answer);
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
  // Un onglet fermé n'est plus à l'agent : le serveur l'apprend au prochain long-poll.
  void pushConfig();
});
chrome.tabs.onCreated.addListener(() => void pushConfig());
chrome.windows.onRemoved.addListener(() => void pushConfig());

// ── Miroir des cookies ────────────────────────────────────────────────────

const mirror = new CookieMirror({
  getAll: () => chrome.cookies.getAll({}),
  // Écrit par `save` seulement : la génération et l'heure de la dernière copie complète.
  load: async () => ((await sessionValue(MIRROR)) as MirrorState | undefined) ?? null,
  save: (state) => chrome.storage.session.set({ [MIRROR]: state }),
});

/** Un échange du miroir avec le harness. Ne lève jamais : un échec se retente au tick suivant. */
async function mirrorWith(work: (target: HarnessTarget) => Promise<void>): Promise<void> {
  const { pairing: paired, browserLabel } = await loadSettings();
  if (paired === null) return;
  try {
    await work(await identified(paired, browserLabel));
  } catch {
    // Serveur injoignable, moli-poste absent ou génération périmée : le tick suivant reprend.
  }
}

let mirrorFlushing = false;
chrome.cookies.onChanged.addListener((change) => {
  // Sans génération rangée, l'envoi abandonne ce changement (miroir éteint ou à recopier en entier).
  mirror.recordChange(change);
  if (mirrorFlushing) return;
  mirrorFlushing = true;
  setTimeout(() => {
    mirrorFlushing = false;
    void mirrorWith((target) => mirror.flush(target));
  }, MIRROR_FLUSH_MS);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TICK) return;
  void (async () => {
    const settings = await loadSettings();
    if (settings.pairing !== null) await ensureOffscreen().catch(() => undefined);
    await refocus(true);
    await flush();
    await mirrorWith((target) => mirror.tick(target));
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
