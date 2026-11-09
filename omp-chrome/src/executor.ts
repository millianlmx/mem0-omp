// L'exécuteur des actions du harness, dans le service worker. Chaque action est d'abord
// validée (`validateAction`) ; les gestes dans la page passent par page/agent.ts, qui
// tranche la garde d'envoi dans la même exécution que le geste (ou sa préparation).
//
// Le CANTONNEMENT est tenu ici, pas par le prompt : lire ou agir dans un onglet qui n'est
// pas de la fenêtre de l'agent rend `needs_approval` tant que l'humain n'a pas approuvé
// CETTE action (`approved`) ; le serveur la garde alors en attente de l'app approbatrice.
// `close` ne vise jamais un onglet de l'utilisateur, même approuvé.
//
// Les GESTES DE CONFIANCE (clic, survol, saisie, touches) passent par CDP (cdp.ts) là où
// l'agent agit déjà — sa fenêtre, ou l'onglet de l'utilisateur pour l'action approuvée — et
// seulement dans un onglet affiché (celui de l'agent est activé dans sa fenêtre, jamais celui
// de l'utilisateur) ; sinon, et si le point visé est recouvert ou illisible, en événements DOM.
//
// La fenêtre de l'agent est créée NON focalisée au premier `open` ; son id vit dans
// `chrome.storage.session` (le service worker peut s'endormir entre deux actions).
// Un arrêt (`signal`) interrompt les attentes (chargement, `wait`, téléchargement) : l'action
// rend `failed` et les sessions CDP sont fermées.

import { attach, detachAll, send } from "./cdp.ts";
import type { ActionOutcome, ActionParams, WorkstationAction } from "./lib/actions.ts";
import { validateAction } from "./lib/actions.ts";
import type { KeyCombo } from "./lib/keys.ts";
import { cdpKeyEvents, parseKeyCombo } from "./lib/keys.ts";
import type { ApprovedGesture } from "./lib/outbound.ts";
import type { FrameSnapshot } from "./lib/snapshot.ts";
import { mergeFrames } from "./lib/snapshot.ts";
import { hostOf, isExcludedHost, stripUrl } from "./lib/url.ts";
import type { PageRequest, Point } from "./page/agent.ts";

const AGENT_WINDOW = "agentWindowId";
const LOAD_TIMEOUT_MS = 15_000;
/** Le délai pour qu'une navigation de l'historique commence (une page en cache n'en a presque pas). */
const NAVIGATION_START_MS = 2_000;
/** Un clic qui doit télécharger : le téléchargement commence dans ce délai, sinon rien n'est parti. */
const DOWNLOAD_START_MS = 10_000;
/** Un téléchargement plus long est annulé. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Le contenu d'un fichier texte téléchargé est rendu au serveur jusqu'à cette taille ; au-delà, ses métadonnées. */
export const MAX_DOWNLOAD_TEXT = 100_000;
/** Un fichier envoyé (`upload`) pèse au plus 10 Mio : la borne du serveur, revérifiée ici. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const WAIT_FOR_POLL_MS = 250;
export const STOPPED = "arrêtée : le poste est à l'arrêt (bouton Stop ou pause de l'extension)";

/** Le fichier qu'une action `upload` joint, tel que le serveur le rend (`GET …/actions/{n}/file`). */
export type UploadFile = { name: string; mime: string; size: number; data: string };

/** Ce que l'exécuteur demande au service worker : le corps de `GET …/actions/{n}/file`, vérifié ici. */
export type ExecutorDeps = { uploadFile?: (seq: number) => Promise<unknown> };

/** La fenêtre de l'agent si elle existe encore, sinon `null`. */
export async function agentWindowId(): Promise<number | null> {
  const stored = (await chrome.storage.session.get(AGENT_WINDOW))[AGENT_WINDOW];
  if (typeof stored !== "number") return null;
  try {
    await chrome.windows.get(stored);
    return stored;
  } catch {
    await chrome.storage.session.remove(AGENT_WINDOW);
    return null;
  }
}

/** Les onglets de la fenêtre de l'agent (vide sans fenêtre) : rapportés au serveur, qui tient le cantonnement. */
export async function agentTabIds(): Promise<number[]> {
  const windowId = await agentWindowId();
  if (windowId === null) return [];
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
}

/** Attend `ms`, ou lève dès l'arrêt (`signal`). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(STOPPED));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop(): void {
      clearTimeout(timer);
      reject(new Error(STOPPED));
    }
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Attend la fin du chargement d'un onglet (15 s au plus : une page lente n'est pas une erreur ; l'arrêt y met fin). */
async function settled(tabId: number, signal: AbortSignal): Promise<chrome.tabs.Tab> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    function done(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal.removeEventListener("abort", done);
      resolve();
    }
    function listener(id: number, change: { status?: string }): void {
      if (id === tabId && change.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    signal.addEventListener("abort", done, { once: true });
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") done();
      })
      .catch(done);
  });
  if (signal.aborted) throw new Error(STOPPED);
  return chrome.tabs.get(tabId);
}

/** Lance une navigation de l'historique (`trigger`), attend qu'elle commence (2 s au plus), puis la fin du chargement. */
async function navigated(tabId: number, signal: AbortSignal, trigger: () => Promise<void>): Promise<chrome.tabs.Tab> {
  let started = false;
  const listener = (id: number, change: { status?: string; url?: string }): void => {
    if (id === tabId && (change.status === "loading" || change.url !== undefined)) started = true;
  };
  chrome.tabs.onUpdated.addListener(listener);
  try {
    await trigger();
    for (let waited = 0; !started && waited < NAVIGATION_START_MS; waited += 50) await sleep(50, signal);
  } finally {
    chrome.tabs.onUpdated.removeListener(listener);
  }
  return settled(tabId, signal);
}

/** L'onglet visé, refusé s'il n'est pas une page web ou s'il est sur un site exclu. */
async function webTab(tabId: number, excluded: readonly string[]): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`onglet ${tabId} introuvable`);
  }
  const host = hostOf(tab.url ?? "");
  if (host === null) throw new Error(`onglet ${tabId} : pas une page web (${(tab.url ?? "").slice(0, 80)})`);
  if (isExcludedHost(host, excluded))
    throw new Error(`onglet ${tabId} : ${host} est un site exclu, l'agent n'y agit pas`);
  return tab;
}

/** La frame et la référence locale d'une référence du snapshot : `f3e2` → frame 3, `e2`. */
function frameOf(ref: string): { frameId: number; ref: string } {
  const match = /^f(\d+)(e\d+)$/.exec(ref);
  return match ? { frameId: Number(match[1]), ref: match[2] as string } : { frameId: 0, ref };
}

/** Ce que l'exécuteur injecte : le module page/agent.js de l'extension, chargé dans le monde isolé de la frame. */
function pageCall(url: string, request: PageRequest): Promise<ActionOutcome> {
  return import(url).then(
    (module: { run(r: PageRequest): ActionOutcome; fetchText(target: string, max: number): Promise<ActionOutcome> }) =>
      request.op === "fetch" ? module.fetchText(request.url, request.max) : module.run(request),
  );
}

/** Exécute la requête dans une frame de l'onglet (la principale par défaut). */
async function inPage(tabId: number, request: PageRequest, frameId = 0): Promise<ActionOutcome> {
  const [first] = await chrome.scripting.executeScript({
    target: frameId === 0 ? { tabId } : { tabId, frameIds: [frameId] },
    func: pageCall,
    args: [chrome.runtime.getURL("page/agent.js"), request],
  });
  return first?.result ?? { outcome: "failed", error: "la page n'a rendu aucun résultat" };
}

/** Exécute la requête dans chaque frame de l'onglet : les résultats, par frame. */
async function inAllFrames(
  tabId: number,
  request: PageRequest,
): Promise<{ frameId: number; outcome: ActionOutcome | undefined }[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: pageCall,
    args: [chrome.runtime.getURL("page/agent.js"), request],
  });
  return results.map((entry) => ({ frameId: entry.frameId, outcome: entry.result }));
}

/** Les données d'un résultat réussi (`result.data`), sinon `undefined`. */
function dataOf(outcome: ActionOutcome | undefined): unknown {
  return outcome?.outcome === "done" ? outcome.result?.data : undefined;
}

async function open(url: string, signal: AbortSignal): Promise<ActionOutcome> {
  const windowId = await agentWindowId();
  let tabId: number | undefined;
  if (windowId === null) {
    const created = await chrome.windows.create({ url, focused: false, type: "normal", width: 1280, height: 900 });
    if (created.id !== undefined) await chrome.storage.session.set({ [AGENT_WINDOW]: created.id });
    tabId = created.tabs?.[0]?.id;
  } else {
    tabId = (await chrome.tabs.create({ windowId, url, active: true })).id;
  }
  if (tabId === undefined) throw new Error("l'onglet de l'agent n'a pas pu être ouvert");
  const tab = await settled(tabId, signal);
  return {
    outcome: "done",
    result: { text: `onglet ${tabId} ouvert : ${tab.title ?? ""} · ${tab.url ?? url}`, data: { tabId } },
  };
}

async function listTabs(excluded: readonly string[]): Promise<ActionOutcome> {
  const agent = await agentWindowId();
  const lines: string[] = [];
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id === undefined) continue;
    const raw = tab.url ?? "";
    const host = hostOf(raw);
    if (host !== null && isExcludedHost(host, excluded)) continue;
    // Les onglets de l'utilisateur : origine + chemin seulement, comme l'observation.
    const url = tab.windowId === agent ? raw : stripUrl(raw);
    if (url === null) continue;
    const owner = tab.windowId === agent ? "agent" : "utilisateur";
    lines.push(`${tab.id} · ${owner} · ${(tab.title ?? "").replace(/\s+/g, " ")} · ${url}`);
  }
  return { outcome: "done", result: { text: lines.join("\n") } };
}

/** Les gestes qui visent un onglet. */
type TabParams = Extract<ActionParams, { tabId: number }>;

/** Ce que l'humain approuverait : le geste, lisible, comme le serveur le décrit (`describeGesture`). */
function gestureOf(params: TabParams): string {
  switch (params.kind) {
    case "navigate":
      return `Aller à ${params.url}`;
    case "snapshot":
      return "Lire";
    case "screenshot":
      return "Capturer";
    case "click":
      return `Cliquer sur ${params.ref}`;
    case "type":
      return `Saisir dans ${params.ref}${params.submit ? " puis valider" : ""}`;
    case "key":
      return `Appuyer sur ${params.key}${params.ref ? ` sur ${params.ref}` : ""}`;
    case "scroll":
      return `Faire défiler de ${params.dy} px`;
    case "close":
      return "Fermer";
    case "select":
      return `Choisir « ${params.option} » dans ${params.ref}`;
    case "hover":
      return `Survoler ${params.ref}`;
    case "back":
      return "Revenir à la page précédente";
    case "forward":
      return "Aller à la page suivante";
    case "reload":
      return "Recharger";
    case "wait_for":
      return `Attendre ${params.text !== null ? `« ${params.text} »` : `${params.role}${params.name ? ` « ${params.name} »` : ""}`}`;
    case "upload":
      return `Joindre le fichier « ${params.file} » à ${params.ref}`;
    case "download":
      return `Télécharger ${params.ref ?? params.url}`;
  }
}

/**
 * Le cantonnement : l'onglet visé (page web, hors sites exclus), s'il est de la fenêtre de
 * l'agent — ou de l'utilisateur ET l'action approuvée par l'humain. Sinon `needs_approval`,
 * sans empreinte (elle n'autorise aucun envoi) : l'action attend l'app approbatrice.
 */
async function confined(
  params: TabParams,
  excluded: readonly string[],
  approved: boolean,
): Promise<{ tab: chrome.tabs.Tab; mine: boolean } | ActionOutcome> {
  const tab = await webTab(params.tabId, excluded);
  const mine = tab.windowId === (await agentWindowId());
  if (mine || approved) return { tab, mine };
  return {
    outcome: "needs_approval",
    approval: {
      summary: `${gestureOf(params)} dans l'onglet ${params.tabId} de l'utilisateur (${stripUrl(tab.url ?? "") ?? ""}) : hors de la fenêtre de l'agent`,
      recipients: [],
      preview: params.kind === "type" ? params.text : "",
      fingerprint: null,
    },
  };
}

async function screenshot(tab: chrome.tabs.Tab, mine: boolean, signal: AbortSignal): Promise<ActionOutcome> {
  if (!tab.active) {
    // Activer un onglet de la fenêtre de l'utilisateur changerait ce qu'il regarde.
    if (!mine) {
      throw new Error(
        `onglet ${tab.id} : capture impossible, il n'est pas affiché (seuls les onglets de la fenêtre de l'agent sont activés pour la capture)`,
      );
    }
    await chrome.tabs.update(tab.id as number, { active: true });
    await sleep(300, signal);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
  return {
    outcome: "done",
    result: { text: `capture de l'onglet ${tab.id} (${tab.title ?? ""})` },
    image: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}

/** Le snapshot de toutes les frames de l'onglet, assemblé (frames de sites exclus écartées). */
async function snapshot(tabId: number, mine: boolean, excluded: readonly string[]): Promise<ActionOutcome> {
  // Les onglets de l'utilisateur : adresses sans query ni fragment, comme `tabs`.
  const results = await inAllFrames(tabId, { op: "snapshot", fullUrl: mine });
  const main = results.find((entry) => entry.frameId === 0)?.outcome;
  if (main === undefined) return { outcome: "failed", error: "la page n'a rendu aucun snapshot" };
  const parts = results.flatMap(({ frameId, outcome }) => {
    const data = dataOf(outcome);
    return typeof data === "object" && data !== null && "tree" in data
      ? [{ frameId, snapshot: data as FrameSnapshot }]
      : [];
  });
  // La frame principale en échec (ou sans snapshot) rend son issue telle quelle.
  if (!parts.some((part) => part.frameId === 0)) return main;
  return { outcome: "done", result: { data: mergeFrames(parts, excluded) } };
}

/**
 * Une session de gestes de confiance pour l'onglet, si l'agent peut s'en servir ici : un
 * onglet affiché (celui de la fenêtre de l'agent est activé ; celui de l'utilisateur, jamais).
 */
async function trusted(tab: chrome.tabs.Tab, mine: boolean): Promise<boolean> {
  if (!tab.active && !mine) return false;
  if (!(await attach(tab.id as number))) return false;
  if (!tab.active) await chrome.tabs.update(tab.id as number, { active: true });
  return true;
}

/** Le point que `locate` a rendu, ou `null` (élément recouvert, frame d'une autre origine). */
function pointOf(outcome: ActionOutcome): Point | null {
  const data = dataOf(outcome);
  if (typeof data !== "object" || data === null || !("point" in data)) return null;
  const point = data.point as Point | null;
  return point !== null && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
}

async function mouse(tabId: number, point: Point, press: boolean): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
  if (!press) return;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(tabId, "Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}

async function keys(tabId: number, combo: KeyCombo): Promise<void> {
  for (const event of cdpKeyEvents(combo)) await send(tabId, "Input.dispatchKeyEvent", event);
}

/** Un clic (ou un survol) de confiance sur la référence ; `null` si le geste doit passer par le DOM. */
async function pointer(
  tab: chrome.tabs.Tab,
  mine: boolean,
  ref: string,
  gate: ApprovedGesture,
  press: boolean,
): Promise<ActionOutcome | null> {
  if (!(await trusted(tab, mine))) return null;
  const target = frameOf(ref);
  const tabId = tab.id as number;
  const located = await inPage(
    tabId,
    { op: "locate", ref: target.ref, gesture: press ? "click" : null, typed: null, prepare: "point", ...gate },
    target.frameId,
  );
  if (located.outcome !== "done") return located;
  const point = pointOf(located);
  if (point === null) return null;
  await mouse(tabId, point, press);
  return { outcome: "done", result: { text: `${press ? "clic sur" : "survol de"} ${ref} (geste de confiance)` } };
}

async function click(tab: chrome.tabs.Tab, mine: boolean, ref: string, gate: ApprovedGesture): Promise<ActionOutcome> {
  const done = await pointer(tab, mine, ref, gate, true);
  if (done !== null) return done;
  const target = frameOf(ref);
  return inPage(tab.id as number, { op: "click", ref: target.ref, ...gate }, target.frameId);
}

async function type(
  tab: chrome.tabs.Tab,
  mine: boolean,
  params: Extract<ActionParams, { kind: "type" }>,
  gate: ApprovedGesture,
): Promise<ActionOutcome> {
  const target = frameOf(params.ref);
  const tabId = tab.id as number;
  if (!(await trusted(tab, mine))) {
    return inPage(
      tabId,
      { op: "type", ref: target.ref, text: params.text, submit: params.submit, ...gate },
      target.frameId,
    );
  }
  const located = await inPage(
    tabId,
    {
      op: "locate",
      ref: target.ref,
      gesture: params.submit ? "type-submit" : null,
      typed: params.text,
      prepare: "select",
      ...gate,
    },
    target.frameId,
  );
  if (located.outcome !== "done") return located;
  // Le contenu sélectionné est remplacé par le texte, ou effacé pour un texte vide.
  if (params.text === "") await keys(tabId, { key: "Backspace", modifiers: [] });
  else await send(tabId, "Input.insertText", { text: params.text });
  if (params.submit) await keys(tabId, { key: "Enter", modifiers: [] });
  return {
    outcome: "done",
    result: { text: `saisi dans ${params.ref}${params.submit ? " puis envoyé" : ""} (geste de confiance)` },
  };
}

async function key(
  tab: chrome.tabs.Tab,
  mine: boolean,
  params: Extract<ActionParams, { kind: "key" }>,
  gate: ApprovedGesture,
): Promise<ActionOutcome> {
  const target = params.ref === null ? { frameId: 0, ref: null } : frameOf(params.ref);
  const tabId = tab.id as number;
  const combo = parseKeyCombo(params.key);
  if (combo === null) throw new Error(`touche hors liste : ${params.key}`);
  if (!(await trusted(tab, mine))) {
    return inPage(tabId, { op: "key", ref: target.ref, key: params.key, ...gate }, target.frameId);
  }
  const located = await inPage(
    tabId,
    {
      op: "locate",
      ref: target.ref,
      gesture: combo.key === "Enter" ? "key-enter" : null,
      typed: null,
      prepare: "focus",
      ...gate,
    },
    target.frameId,
  );
  if (located.outcome !== "done") return located;
  await keys(tabId, combo);
  return { outcome: "done", result: { text: `touche ${params.key} (geste de confiance)` } };
}

/** Attend un texte ou un élément (rôle, nom) dans l'une des frames lisibles de l'onglet. */
async function waitFor(
  tabId: number,
  params: Extract<ActionParams, { kind: "wait_for" }>,
  excluded: readonly string[],
  signal: AbortSignal,
): Promise<ActionOutcome> {
  const deadline = Date.now() + params.timeoutMs;
  for (;;) {
    for (const { frameId, outcome } of await inAllFrames(tabId, {
      op: "find",
      text: params.text,
      role: params.role,
      name: params.name,
    })) {
      const data = dataOf(outcome) as { found?: unknown; origin?: unknown } | undefined;
      if (typeof data?.found !== "string") continue;
      const host = hostOf(String(data.origin ?? ""));
      if (frameId !== 0 && (host === null || isExcludedHost(host, excluded))) continue;
      return {
        outcome: "done",
        result: { text: `trouvé : ${data.found}${frameId === 0 ? "" : ` (frame f${frameId})`}` },
      };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return {
        outcome: "failed",
        error: `wait_for : toujours absent après ${params.timeoutMs} ms (${params.text !== null ? `texte « ${params.text} »` : `rôle ${params.role}`})`,
      };
    }
    await sleep(Math.min(WAIT_FOR_POLL_MS, remaining), signal);
  }
}

async function history(
  tab: chrome.tabs.Tab,
  mine: boolean,
  kind: "back" | "forward" | "reload",
  excluded: readonly string[],
  signal: AbortSignal,
): Promise<ActionOutcome> {
  const tabId = tab.id as number;
  const loaded = await navigated(tabId, signal, async () => {
    try {
      if (kind === "back") await chrome.tabs.goBack(tabId);
      else if (kind === "forward") await chrome.tabs.goForward(tabId);
      else await chrome.tabs.reload(tabId);
    } catch {
      throw new Error(`onglet ${tabId} : aucune page ${kind === "back" ? "précédente" : "suivante"} dans l'historique`);
    }
  });
  const host = hostOf(loaded.url ?? "");
  if (host !== null && isExcludedHost(host, excluded)) {
    return { outcome: "done", result: { text: `onglet ${tabId} : ${host} est un site exclu, l'agent n'y lit rien` } };
  }
  const url = mine ? (loaded.url ?? "") : (stripUrl(loaded.url ?? "") ?? "");
  return { outcome: "done", result: { text: `onglet ${tabId} : ${loaded.title ?? ""} · ${url}` } };
}

async function upload(
  tab: chrome.tabs.Tab,
  params: Extract<ActionParams, { kind: "upload" }>,
  file: UploadFile,
): Promise<ActionOutcome> {
  const decoded = Math.floor((file.data.length * 3) / 4) - (file.data.match(/=+$/)?.[0].length ?? 0);
  if (file.name !== params.file)
    throw new Error(`upload : le serveur a rendu « ${file.name} » au lieu de « ${params.file} »`);
  if (decoded > MAX_UPLOAD_BYTES || file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`upload : « ${file.name} » dépasse ${MAX_UPLOAD_BYTES} octets`);
  }
  const target = frameOf(params.ref);
  return inPage(
    tab.id as number,
    { op: "upload", ref: target.ref, file: { name: file.name, mime: file.mime, data: file.data } },
    target.frameId,
  );
}

/** Le premier téléchargement qui commence (`DOWNLOAD_START_MS` au plus), armé AVANT le geste qui le déclenche. */
function nextDownload(): { started: Promise<number | null>; cancel(): void } {
  let finish: (id: number | null) => void = () => undefined;
  const started = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const timer = setTimeout(() => stop(null), DOWNLOAD_START_MS);
  function listener(item: chrome.downloads.DownloadItem): void {
    stop(item.id);
  }
  function stop(id: number | null): void {
    clearTimeout(timer);
    chrome.downloads.onCreated.removeListener(listener);
    finish(id);
  }
  chrome.downloads.onCreated.addListener(listener);
  return { started, cancel: () => stop(null) };
}

/** Attend la fin du téléchargement (60 s au plus, l'arrêt y met fin) ; un téléchargement abandonné est annulé. */
async function finished(id: number, signal: AbortSignal): Promise<chrome.downloads.DownloadItem> {
  const ended = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(false), DOWNLOAD_TIMEOUT_MS);
    function done(over: boolean): void {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      signal.removeEventListener("abort", abort);
      resolve(over);
    }
    function abort(): void {
      done(false);
    }
    function listener(delta: chrome.downloads.DownloadDelta): void {
      if (delta.id === id && (delta.state?.current === "complete" || delta.state?.current === "interrupted"))
        done(true);
    }
    chrome.downloads.onChanged.addListener(listener);
    signal.addEventListener("abort", abort, { once: true });
    chrome.downloads
      .search({ id })
      .then(([item]) => {
        if (item !== undefined && item.state !== "in_progress") done(true);
      })
      .catch(() => undefined);
  });
  if (!ended) {
    await chrome.downloads.cancel(id).catch(() => undefined);
    if (signal.aborted) throw new Error(STOPPED);
    throw new Error(`téléchargement ${id} abandonné : pas fini après ${DOWNLOAD_TIMEOUT_MS / 1000} s`);
  }
  const [item] = await chrome.downloads.search({ id });
  if (item === undefined) throw new Error(`téléchargement ${id} introuvable`);
  return item;
}

/** Un fichier dont le contenu se lit comme du texte (CSV, JSON, XML, texte brut…). */
function textual(mime: string, name: string): boolean {
  return (
    /^text\/|[/+](json|xml|csv|javascript|x-ndjson|yaml)\b/i.test(mime) ||
    /\.(txt|csv|tsv|json|ndjson|xml|md|ya?ml|log|ics|vcf)$/i.test(name)
  );
}

/** Le texte d'un fichier téléchargé : relu par la page (cookies de la session, `blob:` de la page), sinon par l'extension. */
async function readText(tabId: number, url: string): Promise<{ text: string; cut: boolean } | { error: string }> {
  const read = await inPage(tabId, { op: "fetch", url, max: MAX_DOWNLOAD_TEXT }).catch(() => undefined);
  const data = dataOf(read) as { text?: unknown; cut?: unknown } | undefined;
  if (typeof data?.text === "string") return { text: data.text, cut: data.cut === true };
  if (!/^https?:/i.test(url)) return { error: read?.outcome === "failed" ? read.error : "illisible" };
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const text = await response.text();
    return { text: text.slice(0, MAX_DOWNLOAD_TEXT), cut: text.length > MAX_DOWNLOAD_TEXT };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function download(
  tab: chrome.tabs.Tab,
  mine: boolean,
  params: Extract<ActionParams, { kind: "download" }>,
  gate: ApprovedGesture,
  excluded: readonly string[],
  signal: AbortSignal,
): Promise<ActionOutcome> {
  const tabId = tab.id as number;
  let id: number;
  if (params.url !== null) {
    if (isExcludedHost(hostOf(params.url) ?? "", excluded)) {
      return { outcome: "failed", error: `${hostOf(params.url)} est un site exclu, l'agent n'y télécharge rien` };
    }
    id = await chrome.downloads.download({ url: params.url, saveAs: false, conflictAction: "uniquify" });
  } else {
    const next = nextDownload();
    const clicked = await click(tab, mine, params.ref as string, gate).catch((error: unknown) => {
      next.cancel();
      throw error;
    });
    if (clicked.outcome !== "done") {
      next.cancel();
      return clicked;
    }
    const started = await next.started;
    if (started === null) {
      return { outcome: "failed", error: `aucun téléchargement n'a commencé après le clic sur ${params.ref}` };
    }
    id = started;
  }
  const item = await finished(id, signal);
  if (item.state !== "complete") {
    return { outcome: "failed", error: `téléchargement interrompu : ${item.error ?? "sans détail"}` };
  }
  const name = item.filename.split(/[/\\]/).pop() ?? item.filename;
  const size = item.fileSize > 0 ? item.fileSize : item.bytesReceived;
  const source = item.finalUrl || item.url;
  const file = {
    name,
    path: item.filename,
    mime: item.mime,
    size,
    // Chez l'utilisateur, l'adresse perd query et fragment, comme partout.
    url: mine ? source : (stripUrl(source) ?? ""),
  };
  const text = `fichier « ${name} » téléchargé (${size} octets, ${item.mime || "type inconnu"}) : ${item.filename}`;
  if (!textual(item.mime, name) || size > MAX_DOWNLOAD_TEXT) {
    return { outcome: "done", result: { text, data: { file } } };
  }
  const content = await readText(tabId, source);
  return {
    outcome: "done",
    result: {
      text,
      data:
        "text" in content
          ? { file, content: content.text, ...(content.cut ? { contentCut: true } : {}) }
          : { file, contentError: content.error },
    },
  };
}

async function run(
  params: ActionParams,
  gate: ApprovedGesture,
  excluded: readonly string[],
  signal: AbortSignal,
  file: () => Promise<UploadFile>,
): Promise<ActionOutcome> {
  switch (params.kind) {
    case "decision":
      return { outcome: "failed", error: "une décision est un journal : elle n'est jamais exécutée" };
    case "tabs":
      return listTabs(excluded);
    case "open":
      if (isExcludedHost(hostOf(params.url) ?? "", excluded)) {
        return { outcome: "failed", error: `${hostOf(params.url)} est un site exclu, l'agent n'y va pas` };
      }
      return open(params.url, signal);
    case "wait":
      await sleep(params.ms, signal);
      return { outcome: "done", result: { text: `attendu ${Math.round(params.ms)} ms` } };
    case "close": {
      const tab = await chrome.tabs.get(params.tabId).catch(() => null);
      if (tab === null) throw new Error(`onglet ${params.tabId} introuvable`);
      // Fermer un onglet de l'utilisateur est irréversible pour lui : seule la fenêtre de l'agent, même approuvé.
      if (tab.windowId !== (await agentWindowId())) {
        throw new Error(`onglet ${params.tabId} : l'agent ne ferme que les onglets de sa fenêtre`);
      }
      await chrome.tabs.remove(params.tabId);
      return { outcome: "done", result: { text: `onglet ${params.tabId} fermé` } };
    }
  }
  const target = await confined(params, excluded, gate.approved);
  if ("outcome" in target) return target;
  const { tab, mine } = target;
  switch (params.kind) {
    case "navigate": {
      if (isExcludedHost(hostOf(params.url) ?? "", excluded)) {
        return { outcome: "failed", error: `${hostOf(params.url)} est un site exclu, l'agent n'y va pas` };
      }
      await chrome.tabs.update(params.tabId, { url: params.url });
      const loaded = await settled(params.tabId, signal);
      return {
        outcome: "done",
        result: { text: `onglet ${params.tabId} : ${loaded.title ?? ""} · ${loaded.url ?? params.url}` },
      };
    }
    case "snapshot":
      return snapshot(params.tabId, mine, excluded);
    case "click":
      return click(tab, mine, params.ref, gate);
    case "type":
      return type(tab, mine, params, gate);
    case "key":
      return key(tab, mine, params, gate);
    case "hover": {
      const done = await pointer(tab, mine, params.ref, gate, false);
      if (done !== null) return done;
      const target = frameOf(params.ref);
      return inPage(params.tabId, { op: "hover", ref: target.ref }, target.frameId);
    }
    case "select": {
      const target = frameOf(params.ref);
      return inPage(params.tabId, { op: "select", ref: target.ref, option: params.option }, target.frameId);
    }
    case "scroll":
      return inPage(params.tabId, { op: "scroll", dy: params.dy });
    case "screenshot":
      return screenshot(tab, mine, signal);
    case "back":
    case "forward":
    case "reload":
      return history(tab, mine, params.kind, excluded, signal);
    case "wait_for":
      return waitFor(params.tabId, params, excluded, signal);
    case "upload":
      return upload(tab, params, await file());
    case "download":
      return download(tab, mine, params, gate, excluded, signal);
  }
}

/** Le résultat d'une action (jamais d'exception : une erreur, ou l'arrêt, rend `failed`). */
export async function execute(
  action: WorkstationAction,
  excluded: readonly string[],
  signal: AbortSignal = new AbortController().signal,
  deps: ExecutorDeps = {},
): Promise<ActionOutcome> {
  const checked = validateAction(action.kind, action.params);
  if (!checked.ok) return { outcome: "failed", error: checked.error };
  if (signal.aborted) return { outcome: "failed", error: STOPPED };
  // `fingerprint` seulement : l'empreinte de l'envoi que l'humain a vu, recomparée dans la page.
  const gate: ApprovedGesture = {
    approved: action.approved === true,
    approval: action.approval ? { fingerprint: action.approval.fingerprint } : null,
  };
  const file = async (): Promise<UploadFile> => {
    if (deps.uploadFile === undefined) throw new Error("upload : le fichier ne peut pas être demandé au serveur");
    const body = (await deps.uploadFile(action.seq)) as Partial<UploadFile> | null;
    if (
      typeof body?.name !== "string" ||
      typeof body.mime !== "string" ||
      typeof body.size !== "number" ||
      typeof body.data !== "string" ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)
    ) {
      throw new Error("upload : le serveur n'a pas rendu le fichier attendu");
    }
    return { name: body.name, mime: body.mime, size: body.size, data: body.data };
  };
  try {
    return await run(checked.params, gate, excluded, signal, file);
  } catch (error) {
    return { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  } finally {
    // L'arrêt ferme les sessions de débogage : plus de geste, plus de bannière.
    if (signal.aborted) await detachAll();
  }
}
